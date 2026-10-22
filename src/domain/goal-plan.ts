/**
 * Goal tracker (spec 2026-10-21-goal-plan-design §4, §11, §12). The ONLY module outside
 * the reporting surface that reads goal status (spec §7): nothing in the normal plan may
 * import it — `tests/architecture/no-catch-up.test.ts` enforces that. It proposes; it
 * never sizes, gates or sells.
 *
 * Every date hangs off `nowIso` in the IST month. All money is real (today's) bigint paise.
 */
import type { Db } from '../db/client.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { formatInr, rupees, type Paise } from '../money/paise.js';
import { loadPositions, type Position } from './networth.js';
import { addTarget } from './alloc-engine.js';
import { BUCKETS, bucketStatuses } from './buckets.js';
import { computeFICorpusBand } from './funded-status.js';
import { railPaise, validGoalCeilingPct } from './rail-values.js';
import { istDate, istMonth } from './sips.js';
import {
  firstMonthReaching, levelMonthlyToClose, newMoneyMix, potsTotal, project, realRates,
  type Mix, type Pots, type Rates,
} from './goal-math.js';

export type GoalId = 'FI' | 'HOUSE' | 'EMERGENCY' | 'EDUCATION';
export interface GoalCard {
  id: GoalId; name: string; targetPaise: bigint; targetLabel: string;
  /** NULL = unknown (an unknown NOW price), never ₹0. */
  balancePaise: bigint | null;
  balanceParts: { label: string; paise: bigint | null }[];
  /** Central scenario, at the target date. */
  projectedPaise: bigint | null;
  verdict: 'ON_TRACK' | 'SHORT' | 'NOT_STARTED' | 'UNKNOWN';
  /** 0n when on track. */
  shortMonthlyPaise: bigint | null;
  /** Calendar year the target is first reached at today's pace; null = not by 2100. */
  finishYear: { central: number | null; pessimistic: number | null; optimistic: number | null };
  assumptions: string[];
  reason: string | null;
}
export interface GoalTracker {
  asOf: string; monthlyBudgetPaise: bigint;
  /** `goal_setaside_monthly_paise`: budget reserved for house and emergency, so never FI's. */
  goalSetAsidePaise: bigint;
  cards: GoalCard[]; fiPots: Pots | null;
}

const SCENARIOS = ['central', 'pessimistic', 'optimistic'] as const;
const ZERO: Pots = { equity: 0n, debt: 0n, gold: 0n, cash: 0n };
const ALL_DEBT: Mix = { equityBps: 0, debtBps: 10_000, goldBps: 0 };
/** 10% nominal step-up (`sipStepUp`, `salaryStepUp`) less 6% inflation = 4% real. */
const STEP_UP_BPS = Math.round(ASSUMPTIONS.sipStepUp * 10_000);
const GROWTH_BPS = STEP_UP_BPS - Math.round(ASSUMPTIONS.inflation * 10_000);
/** IPS §3.3's equity ceiling: the normal plan's new-money mix. */
const IPS_EQUITY_CEILING_PCT = 60;
/** The highest equity share `newMoneyMix` allows with gold at its 7.5% band middle. */
const MAX_EQUITY_PCT = 92;
const EPF_MONTHLY = rupees(ASSUMPTIONS.epfMonthlyContributionInr) as bigint;
const FI_YEAR = ASSUMPTIONS.ownerBirthYear + ASSUMPTIONS.fiTargetAge;
const PRICE_MAX_AGE_DAYS = 7;
const FINISH_HORIZON_YEAR = 2100;

const monthIndex = (ym: string): number => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return y * 12 + m - 1;
};
const pct = (b: number) => `${b / 100}%`;
const lakhs = (p: bigint) => formatInr(p as Paise, { compact: true });

/**
 * FI's two contribution streams (budget into the new-money mix, EPF into debt) stepped
 * together a month at a time, so the finish month is exact for the two-stream sum.
 * `goal-math` has no multi-stream option; one-month `project` calls with the step-up
 * replicated here reproduce its schedule. A linear scan, not a bisection: the cash pot's
 * negative real rate means the total need not be monotone. `shockAtMonth` applies the crash
 * to the budget stream at that month, as `project` does (the EPF stream holds no equity).
 */
export function fiFirstMonth(
  start: Pots, budget: bigint, epf: bigint, mix: Mix, rates: Rates, target: bigint, max: number, shockAtMonth?: number,
): number | null {
  let a = start;
  let b = ZERO;
  for (let m = 0; m <= max; m++) {
    if (potsTotal(a) + potsTotal(b) >= target) return m;
    if (m > 0 && m % 12 === 0) {
      budget += (budget * BigInt(GROWTH_BPS)) / 10_000n;
      epf += (epf * BigInt(GROWTH_BPS)) / 10_000n;
    }
    a = project(a, { months: 1, monthlyPaise: budget, mix, growthBps: 0, rates, ...(m === shockAtMonth ? { shockAtMonth: 0 } : {}) });
    b = project(b, { months: 1, monthlyPaise: epf, mix: ALL_DEBT, growthBps: 0, rates });
  }
  return null;
}

/** FI's central-style endpoint: both streams projected `months` ahead and summed. */
function fiProjected(start: Pots, budget: bigint, mix: Mix, months: number, rates: Rates): bigint {
  const opts = (monthlyPaise: bigint, m: Mix) => ({ months, monthlyPaise, mix: m, growthBps: GROWTH_BPS, rates });
  return potsTotal(project(start, opts(budget, mix))) + potsTotal(project(ZERO, opts(EPF_MONTHLY, ALL_DEBT)));
}

/** RSU value from the latest held quantity × the latest NOW close (already INR). Never `value_paise`. */
async function rsuValue(db: Db, today: string): Promise<{ part: GoalCard['balanceParts'][number] | null; reason: string | null }> {
  // Only each source's latest snapshot counts, as in `loadPositions`: a newer snapshot that
  // drops the RSU means it is no longer held, not that an older quantity still stands.
  const [h] = await db.query<{ instrument_id: string; quantity: string }>(
    `with latest as (
       select distinct on (s.source) s.id, s.business_date, s.taken_at
         from snapshots s where s.business_date <= $1::date
        order by s.source, s.business_date desc, s.taken_at desc
     )
     select h.instrument_id, h.quantity::text as quantity
       from holdings h join instruments i on i.id = h.instrument_id join latest s on s.id = h.snapshot_id
      where i.kind = 'RSU'
      order by s.business_date desc, s.taken_at desc limit 1`, [today]);
  if (!h) return { part: null, reason: null };
  const [p] = await db.query<{ trade_date: string; close_paise: string; value: string }>(
    `select trade_date::text as trade_date, close_paise::text as close_paise,
            floor($2::numeric * close_paise)::text as value
       from prices_eod where instrument_id = $1 order by trade_date desc limit 1`,
    [h.instrument_id, h.quantity]);
  const qty = String(Number(h.quantity));
  if (!p) return { part: { label: `${qty} ServiceNow shares: no price`, paise: null }, reason: 'No ServiceNow price' };
  const age = Math.round((Date.parse(today) - Date.parse(p.trade_date)) / 86_400_000);
  const label = `${qty} ServiceNow shares @ ${formatInr(BigInt(p.close_paise) as Paise)} (close ${p.trade_date})`;
  if (age > PRICE_MAX_AGE_DAYS) return { part: { label, paise: null }, reason: `ServiceNow price is ${age} days old` };
  return { part: { label, paise: BigInt(p.value) }, reason: null };
}

const fiBudgetOf = (budget: bigint, setAside: bigint) => (budget > setAside ? budget - setAside : 0n);

const finishYears = (nowIdx: number, at: (s: typeof SCENARIOS[number]) => number | null): GoalCard['finishYear'] => {
  const year = (s: typeof SCENARIOS[number]) => { const m = at(s); return m === null ? null : Math.floor((nowIdx + m) / 12); };
  return { central: year('central'), pessimistic: year('pessimistic'), optimistic: year('optimistic') };
};

/**
 * The owner-signed `goal_equity_ceiling_pct` rail (spec §9, §11.3). A stored value outside
 * 60–92 is an error, never clamped: the web shows the plan as unavailable.
 */
async function signedCeiling(db: Db): Promise<number> {
  const pct = Number(await railPaise(db, 'goal_equity_ceiling_pct'));
  if (!validGoalCeilingPct(pct)) throw new Error(`goal_equity_ceiling_pct ${pct} is outside 60–92`);
  return pct;
}

/** `signedCeilingPct` defaults to the rail; `loadGoalPlan` passes the value it read so both agree. */
export async function loadGoalTracker(db: Db, nowIso: string, signedCeilingPct?: number): Promise<GoalTracker> {
  const A = ASSUMPTIONS;
  const ceilingPct = signedCeilingPct ?? await signedCeiling(db);
  const fiMix = newMoneyMix(ceilingPct);
  const today = istDate(nowIso);
  const nowIdx = monthIndex(istMonth(nowIso));
  const monthsTo = (year: number) => year * 12 - nowIdx;
  const maxMonths = monthsTo(FINISH_HORIZON_YEAR);
  const central = realRates('central');
  // FI's gap is closed with new money in the new-money mix: its blended central rate, floored.
  const blendBps = Math.floor((central.equityBps * fiMix.equityBps + central.debtBps * fiMix.debtBps + central.goldBps * fiMix.goldBps) / 10_000);
  const ratesLine = `Real returns: equity ${pct(central.equityBps)}, debt ${pct(central.debtBps)}, gold ${pct(central.goldBps)}, cash ${pct(central.cashBps)}`;

  const flows = new Map((await bucketStatuses(db)).map((b) => [b.id, (b.balancePaise ?? 0n) as bigint]));
  const flow = (id: 'B2' | 'B3' | 'B4') => flows.get(id) ?? 0n;
  const monthlyBudgetPaise = await railPaise(db, 'monthly_budget_paise');
  const goalSetAsidePaise = await railPaise(db, 'goal_setaside_monthly_paise');
  // FI gets the budget less the house/emergency set-aside, which goes to B2/B3, not the new-money mix.
  const fiBudget = fiBudgetOf(monthlyBudgetPaise, goalSetAsidePaise);

  // ── FI ──────────────────────────────────────────────────────────────────────────────
  const positions = (await loadPositions(db, today)).filter((p) => p.kind !== 'RSU');
  let fiPots: Pots | null = null;
  const fiTarget = computeFICorpusBand().floorPaise as bigint;
  const fiCard: GoalCard = {
    id: 'FI', name: BUCKETS.B1.name, targetPaise: fiTarget, targetLabel: `${lakhs(fiTarget)} real by ${FI_YEAR}`,
    balancePaise: null, balanceParts: [], projectedPaise: null, verdict: 'UNKNOWN', shortMonthlyPaise: null,
    finishYear: { central: null, pessimistic: null, optimistic: null },
    assumptions: [], reason: 'No holdings snapshot',
  };
  if (positions.length > 0) {
    const gross: Pots = { ...ZERO };
    for (const p of positions) gross[p.assetClass.toLowerCase() as keyof Pots] += p.valuePaise;
    // Bucket money sits in bank accounts until invested: out of cash first, then debt, equity, gold;
    // anything still owed is surfaced in `reason`, never dropped.
    let owed = flow('B2') + flow('B3') + flow('B4');
    const pots = { ...gross };
    for (const k of ['cash', 'debt', 'equity', 'gold'] as const) {
      const take = owed < pots[k] ? owed : pots[k];
      pots[k] -= take;
      owed -= take;
    }
    fiPots = pots;
    const mix = fiMix;
    const months = monthsTo(FI_YEAR);
    const projected = fiProjected(pots, fiBudget, mix, months, central);
    Object.assign(fiCard, {
      balancePaise: potsTotal(pots),
      balanceParts: [
        { label: 'Holdings excluding the ServiceNow RSU', paise: potsTotal(gross) },
        { label: 'Less house, emergency and education money', paise: potsTotal(pots) - potsTotal(gross) },
      ],
      projectedPaise: projected,
      verdict: projected >= fiTarget ? 'ON_TRACK' : 'SHORT',
      shortMonthlyPaise: levelMonthlyToClose(fiTarget - projected, months, blendBps),
      finishYear: finishYears(nowIdx, (s) => fiFirstMonth(pots, fiBudget, EPF_MONTHLY, mix, realRates(s), fiTarget, maxMonths)),
      reason: owed > 0n ? `House, emergency and education money exceeds the holdings by ${formatInr(owed as Paise)}` : null,
    });
  }
  fiCard.assumptions = [
    `Budget ${formatInr(fiBudget as Paise)}/month`
      + (goalSetAsidePaise > 0n ? ` (after the ${formatInr(goalSetAsidePaise as Paise)} house and emergency set-aside)` : '')
      + `: equity ${pct(fiMix.equityBps)}`
      + (ceilingPct > IPS_EQUITY_CEILING_PCT ? ` (owner-signed goal ceiling; IPS §3.3 is ${IPS_EQUITY_CEILING_PCT}%)` : '')
      + `, gold ${pct(fiMix.goldBps)}, debt the rest`,
    `EPF ${formatInr(rupees(A.epfMonthlyContributionInr))}/month into debt`,
    `Both contributions grow ${pct(GROWTH_BPS)} real a year (${pct(STEP_UP_BPS)} nominal)`,
    ratesLine,
    `₹/month short: the gap closed with new money at ${pct(blendBps)} real (the new-money mix, central rates)`,
    `Target: FI floor at ${pct(Math.round(A.swrFloor * 10_000))} withdrawal; ServiceNow RSU counts toward the house`,
  ];

  // ── House and education share one rule: a flow balance grown at one rate, no contributions.
  const lumpCard = (o: {
    id: GoalId; name: string; target: bigint; year: number; balance: bigint | null;
    parts: GoalCard['balanceParts']; rate: 'debtBps' | 'equityBps'; reason: string | null; assumptions: string[];
  }): GoalCard => {
    const base = {
      id: o.id, name: o.name, targetPaise: o.target, targetLabel: `${lakhs(o.target)} real by ${o.year}`,
      balanceParts: o.parts, assumptions: o.assumptions,
    };
    if (o.balance === null) {
      return { ...base, balancePaise: null, projectedPaise: null, verdict: 'UNKNOWN', shortMonthlyPaise: null,
        finishYear: { central: null, pessimistic: null, optimistic: null }, reason: o.reason };
    }
    const months = monthsTo(o.year);
    const start: Pots = o.rate === 'debtBps' ? { ...ZERO, debt: o.balance } : { ...ZERO, equity: o.balance };
    const projected = potsTotal(project(start, { months, monthlyPaise: 0n, mix: ALL_DEBT, growthBps: 0, rates: central }));
    return {
      ...base, balancePaise: o.balance, projectedPaise: projected,
      verdict: projected >= o.target ? 'ON_TRACK' : 'SHORT',
      shortMonthlyPaise: levelMonthlyToClose(o.target - projected, months, central[o.rate]),
      finishYear: finishYears(nowIdx, (s) =>
        firstMonthReaching(start, o.target, { monthlyPaise: 0n, mix: ALL_DEBT, growthBps: 0, rates: realRates(s) }, maxMonths)),
      reason: null,
    };
  };

  const rsu = await rsuValue(db, today);
  const houseParts = [{ label: 'House fund (B2) money', paise: flow('B2') }, ...(rsu.part ? [rsu.part] : [])];
  const house = lumpCard({
    id: 'HOUSE', name: BUCKETS.B2.name, target: BUCKETS.B2.targetPaise!, year: A.houseTargetYear,
    balance: houseParts.some((p) => p.paise === null) ? null : houseParts.reduce((s, p) => s + p.paise!, 0n),
    parts: houseParts, rate: 'debtBps', reason: rsu.reason,
    assumptions: [`Grows at the debt real rate, ${pct(central.debtBps)}; no new money`,
      'Vested, held ServiceNow shares at the latest close; future vests not counted'],
  });

  // ── Emergency: no growth; gap spread over the IST months left through the target month.
  const emTarget = BUCKETS.B3.targetPaise! as bigint;
  const em = flow('B3');
  const monthsLeft = Math.max(1, monthIndex(A.emergencyTargetMonth) - nowIdx + 1);
  const emGap = emTarget - em;
  const emYear = em >= emTarget ? Math.floor(nowIdx / 12) : null; // no growth: reached now or never
  const emergency: GoalCard = {
    id: 'EMERGENCY', name: BUCKETS.B3.name, targetPaise: emTarget,
    targetLabel: `${lakhs(emTarget)} by ${A.emergencyTargetMonth}`,
    balancePaise: em, balanceParts: [{ label: 'Emergency fund (B3) money', paise: em }],
    projectedPaise: em, verdict: em >= emTarget ? 'ON_TRACK' : 'SHORT',
    // Rounded up to the rupee, as `levelMonthlyToClose` is.
    shortMonthlyPaise: emGap <= 0n ? 0n : ((emGap + BigInt(monthsLeft) * 100n - 1n) / (BigInt(monthsLeft) * 100n)) * 100n,
    finishYear: { central: emYear, pessimistic: emYear, optimistic: emYear },
    assumptions: ['No growth: a savings account', `${monthsLeft} month(s) left including this one`],
    reason: null,
  };

  // ── Education: inactive before January of the child's arrival year.
  const edTarget = BUCKETS.B4.targetPaise! as bigint;
  const ed = flow('B4');
  const edAssumptions = [`Grows at the equity real rate, ${pct(central.equityBps)}`,
    `Starts January ${A.childArrivalYear}`];
  const education: GoalCard = Math.floor(nowIdx / 12) < A.childArrivalYear
    ? {
      id: 'EDUCATION', name: BUCKETS.B4.name, targetPaise: edTarget,
      targetLabel: `${lakhs(edTarget)} real by ${A.educationEndYear}`,
      balancePaise: ed, balanceParts: [{ label: 'Education (B4) money', paise: ed }],
      projectedPaise: null, verdict: 'NOT_STARTED',
      shortMonthlyPaise: levelMonthlyToClose(edTarget - ed, (A.educationEndYear - A.childArrivalYear) * 12, central.equityBps),
      finishYear: { central: null, pessimistic: null, optimistic: null },
      assumptions: edAssumptions, reason: null,
    }
    : lumpCard({
      id: 'EDUCATION', name: BUCKETS.B4.name, target: edTarget, year: A.educationEndYear, balance: ed,
      parts: [{ label: 'Education (B4) money', paise: ed }], rate: 'equityBps', reason: null, assumptions: edAssumptions,
    });

  return { asOf: nowIso, monthlyBudgetPaise, goalSetAsidePaise, cards: [fiCard, house, emergency, education], fiPots };
}

// ── Goal plan (spec §5, §6, §11.3–4, §12 Q1). Proposes only: a budget raise (with the goal
// set-aside for house/emergency) or a signed rebalance equity ceiling (FI only). No type here can express a sale.

type LegClass = 'EQUITY' | 'DEBT' | 'GOLD' | 'CASH';
export interface MoneyRoute {
  goal: GoalId; extraMonthlyPaise: bigint;
  /** 'YYYY-MM' the route begins; null = this month. A future route is not in the totals. */
  startsOn: string | null;
  /**
   * False only for a route that starts later. FI and started education raise the budget;
   * house and emergency raise the budget AND `goal_setaside_monthly_paise` by the same
   * amount, so the normal plan's envelope is unchanged and the money reaches B2/B3.
   */
  signable: boolean;
  legs: { assetClass: LegClass; instrumentId: string | null; label?: string; paise: bigint }[];
}
export interface RiskDisclosure {
  band: string;
  crashLossPaise: { normal: bigint; goal: bigint };
  fiYearAfterCrash: { normal: number | null; goal: number | null };
  aboveBudgetSource: string;
}
export interface RiskRoute { equityPct: number; closes: boolean; disclosure: RiskDisclosure }
export interface GoalPlan {
  money: MoneyRoute[]; totalExtraMonthlyPaise: bigint; proposedBudgetPaise: bigint;
  /** Current set-aside + every signable house and emergency extra. */
  proposedSetAsidePaise: bigint;
  risk: RiskRoute | null; signedCeilingPct: number;
}

const ALL_EQUITY: Mix = { equityBps: 10_000, debtBps: 0, goldBps: 0 };
const EMERGENCY_ACCOUNT = 'IDFC First savings account';
/** Owner decision 2026-10-22: house money goes to this fund, never the LIQUIDBEES debt default. */
export const HOUSE_FUND = 'Edelweiss Arbitrage Fund (Direct Growth)';

/** Legs in mix proportion, floored to the rupee; the remainder goes to the largest leg. */
function legsFor(extra: bigint, mix: Mix, positions: readonly Position[]): MoneyRoute['legs'] {
  const legs = ([['EQUITY', mix.equityBps], ['DEBT', mix.debtBps], ['GOLD', mix.goldBps]] as const)
    .filter(([, b]) => b > 0)
    .map(([assetClass, b]) => ({ assetClass, instrumentId: addTarget(positions, assetClass), paise: ((extra * BigInt(b)) / 1_000_000n) * 100n, b }));
  const largest = legs.reduce((x, y) => (y.b > x.b ? y : x));
  largest.paise += extra - legs.reduce((s, l) => s + l.paise, 0n);
  return legs.map(({ b: _b, ...l }) => l);
}

export function buildGoalPlan(t: GoalTracker, positions: Position[], signedCeilingPct: number): GoalPlan {
  const A = ASSUMPTIONS;
  const nowIdx = monthIndex(istMonth(t.asOf));
  const educationStart = `${A.childArrivalYear}-01`;
  const goalMix: Record<'FI' | 'EDUCATION', Mix> = { FI: newMoneyMix(signedCeilingPct), EDUCATION: ALL_EQUITY };
  const houseId = positions.find((p) => /edelweiss arbitrage/i.test(p.name))?.instrumentId ?? null;

  const money: MoneyRoute[] = [];
  for (const c of t.cards) {
    const later = c.id === 'EDUCATION' && c.verdict === 'NOT_STARTED';
    if (!(c.verdict === 'SHORT' || later) || !c.shortMonthlyPaise || c.shortMonthlyPaise <= 0n) continue;
    money.push({
      goal: c.id, extraMonthlyPaise: c.shortMonthlyPaise, startsOn: later ? educationStart : null,
      signable: !later,
      // The emergency fund is a savings account, not an investment: no addTarget, no instrument.
      legs: c.id === 'EMERGENCY'
        ? [{ assetClass: 'CASH', instrumentId: null, label: EMERGENCY_ACCOUNT, paise: c.shortMonthlyPaise }]
        : c.id === 'HOUSE'
        ? [{ assetClass: 'DEBT', instrumentId: houseId, label: HOUSE_FUND, paise: c.shortMonthlyPaise }]
        : legsFor(c.shortMonthlyPaise, goalMix[c.id], positions),
    });
  }
  const totalExtraMonthlyPaise = money.filter((r) => r.signable).reduce((s, r) => s + r.extraMonthlyPaise, 0n);
  const proposedSetAsidePaise = t.goalSetAsidePaise + money
    .filter((r) => r.signable && (r.goal === 'HOUSE' || r.goal === 'EMERGENCY'))
    .reduce((s, r) => s + r.extraMonthlyPaise, 0n);

  let risk: RiskRoute | null = null;
  const fi = t.cards.find((c) => c.id === 'FI');
  if (fi?.verdict === 'SHORT' && t.fiPots) {
    const pots = t.fiPots;
    const central = realRates('central');
    const budget = fiBudgetOf(t.monthlyBudgetPaise, t.goalSetAsidePaise);
    const reaches = (p: number) => fiProjected(pots, budget, newMoneyMix(p), FI_YEAR * 12 - nowIdx, central) >= fi.targetPaise;
    let equityPct = MAX_EQUITY_PCT;
    let closes = false;
    for (let p = signedCeilingPct + 1; p <= MAX_EQUITY_PCT; p++) {
      if (reaches(p)) { equityPct = p; closes = true; break; }
    }
    const H = A.crashHorizonMonths;
    // The shock's loss: the budget stream with and without it at month H (EPF holds no equity).
    const crashLoss = (p: number) => {
      const o = { months: H + 1, monthlyPaise: budget, mix: newMoneyMix(p), growthBps: GROWTH_BPS, rates: central };
      return potsTotal(project(pots, o)) - potsTotal(project(pots, { ...o, shockAtMonth: H }));
    };
    const yearAfterCrash = (p: number) => {
      const m = fiFirstMonth(pots, budget, EPF_MONTHLY, newMoneyMix(p), central, fi.targetPaise,
        FINISH_HORIZON_YEAR * 12 - nowIdx, H);
      return m === null ? null : Math.floor((nowIdx + m) / 12);
    };
    risk = {
      equityPct, closes,
      disclosure: {
        band: `equity ${equityPct}% of new money vs ${IPS_EQUITY_CEILING_PCT}% ceiling, IPS §3.3`,
        crashLossPaise: { normal: crashLoss(IPS_EQUITY_CEILING_PCT), goal: crashLoss(equityPct) },
        fiYearAfterCrash: { normal: yearAfterCrash(IPS_EQUITY_CEILING_PCT), goal: yearAfterCrash(equityPct) },
        aboveBudgetSource: 'a raise you would set in your monthly budget update',
      },
    };
  }

  return {
    money, totalExtraMonthlyPaise, proposedBudgetPaise: t.monthlyBudgetPaise + totalExtraMonthlyPaise, proposedSetAsidePaise,
    risk, signedCeilingPct,
  };
}

export async function loadGoalPlan(db: Db, nowIso: string): Promise<{ tracker: GoalTracker; plan: GoalPlan }> {
  const signedCeilingPct = await signedCeiling(db);
  const tracker = await loadGoalTracker(db, nowIso, signedCeilingPct);
  const positions = await loadPositions(db, istDate(nowIso));
  return { tracker, plan: buildGoalPlan(tracker, positions, signedCeilingPct) };
}
