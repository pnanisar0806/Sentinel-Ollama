import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  buildGoalPlan, fiFirstMonth, loadGoalPlan, type GoalCard, type GoalId, type GoalTracker,
} from '../../src/domain/goal-plan.js';
import { newMoneyMix, potsTotal, project, realRates, type Pots } from '../../src/domain/goal-math.js';
import { computeFICorpusBand } from '../../src/domain/funded-status.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import type { Position } from '../../src/domain/networth.js';
import { rupees, type Paise } from '../../src/money/paise.js';

const NOW = '2026-10-21T06:00:00Z'; // IST October 2026
const NOW_IDX = 2026 * 12 + 9;
const FI_YEAR = ASSUMPTIONS.ownerBirthYear + ASSUMPTIONS.fiTargetAge;
const FI_MONTHS = FI_YEAR * 12 - NOW_IDX;
const TARGET = computeFICorpusBand().floorPaise as bigint;
const BUDGET = rupees(50_000) as bigint;
const SET_ASIDE = rupees(5_000) as bigint;
const EPF = rupees(ASSUMPTIONS.epfMonthlyContributionInr) as bigint;
const CENTRAL = realRates('central');
const GROWTH = Math.round((ASSUMPTIONS.sipStepUp - ASSUMPTIONS.inflation) * 10_000);
const H = ASSUMPTIONS.crashHorizonMonths;
const ZERO: Pots = { equity: 0n, debt: 0n, gold: 0n, cash: 0n };

/** FI short at 60%, closed by a share a few points above it (probed: 63%). */
const SHORT_POTS: Pots = { equity: rupees(12_400_000), debt: rupees(3_000_000), gold: rupees(200_000), cash: 0n };
/** Far short: no share up to 92% closes it. */
const FAR_POTS: Pots = { equity: rupees(1_000_000), debt: rupees(3_000_000), gold: rupees(200_000), cash: 0n };

/** The model's own central FI projection at 2050, two streams, derived independently of goal-plan.ts. */
const closesAt = (pots: Pots, pct: number) =>
  potsTotal(project(pots, { months: FI_MONTHS, monthlyPaise: BUDGET, mix: newMoneyMix(pct), growthBps: GROWTH, rates: CENTRAL }))
  + potsTotal(project(ZERO, { months: FI_MONTHS, monthlyPaise: EPF, mix: { equityBps: 0, debtBps: 10_000, goldBps: 0 }, growthBps: GROWTH, rates: CENTRAL }))
  >= TARGET;

const goal = (id: GoalId, verdict: GoalCard['verdict'], short: bigint | null): GoalCard => ({
  id, name: id, targetPaise: id === 'FI' ? TARGET : rupees(1_000_000), targetLabel: '', balancePaise: 0n,
  balanceParts: [], projectedPaise: 0n, verdict, shortMonthlyPaise: short,
  finishYear: { central: null, pessimistic: null, optimistic: null }, assumptions: [], reason: null,
});

function tracker(o: { fi?: GoalCard['verdict']; fiPots?: Pots | null; house?: GoalCard['verdict']; edu?: GoalCard['verdict']; emergency?: GoalCard['verdict']; setAside?: bigint } = {}): GoalTracker {
  const fi = o.fi ?? 'SHORT';
  const house = o.house ?? 'SHORT';
  return {
    asOf: NOW, monthlyBudgetPaise: BUDGET, goalSetAsidePaise: o.setAside ?? 0n, fiPots: o.fiPots === undefined ? SHORT_POTS : o.fiPots,
    cards: [
      goal('FI', fi, fi === 'SHORT' ? rupees(12_345) : fi === 'ON_TRACK' ? 0n : null),
      goal('HOUSE', house, house === 'SHORT' ? rupees(23_457) : 0n),
      goal('EMERGENCY', o.emergency ?? 'ON_TRACK', o.emergency === 'SHORT' ? rupees(150_000) : 0n),
      goal('EDUCATION', o.edu ?? 'NOT_STARTED', rupees(9_999)),
    ],
  };
}

const pos = (instrumentId: string, name: string, kind: Position['kind'], assetClass: Position['assetClass'], value: number): Position => ({
  instrumentId, name, kind, account: 'x' as Position['account'], valuePaise: rupees(value) as Paise, avgCostPaise: null,
  assetClass, issuer: null, sector: null, currency: 'INR', isEmployer: false, asOf: NOW, source: 'test',
});
const POSITIONS: Position[] = [
  pos('NSE:JUNIORBEES', 'Nifty Next 50 ETF', 'ETF', 'EQUITY', 100),
  pos('NSE:NIFTYBEES', 'Nifty 50 ETF', 'ETF', 'EQUITY', 900),
  pos('NSE:INFY', 'Infosys', 'EQUITY', 'EQUITY', 5_000),
  pos('NSE:GOLDBEES', 'Gold ETF', 'GOLD', 'GOLD', 300),
  pos('MF:LIQUID', 'Some liquid fund', 'MF', 'DEBT', 400),
];

describe('goal plan: money routes', () => {
  const plan = buildGoalPlan(tracker(), POSITIONS, 60);
  const route = (id: GoalId) => plan.money.find((r) => r.goal === id);

  it('every route\'s legs sum exactly to its extra, and no leg is negative', () => {
    expect(plan.money.length).toBeGreaterThan(0);
    for (const r of plan.money) {
      expect(r.legs.reduce((s, l) => s + l.paise, 0n)).toBe(r.extraMonthlyPaise);
      for (const l of r.legs) {
        expect(l.paise).toBeGreaterThan(0n);
        expect(l.paise % 100n).toBe(0n); // whole rupees
      }
    }
  });

  it('FI splits by the new-money mix at the signed ceiling; the rounding remainder goes to the largest leg', () => {
    const fi = route('FI')!;
    const mix = newMoneyMix(60);
    const extra = fi.extraMonthlyPaise;
    const floor = (b: number) => ((extra * BigInt(b)) / 1_000_000n) * 100n; // down to the rupee
    const remainder = extra - floor(mix.equityBps) - floor(mix.goldBps) - floor(mix.debtBps);
    expect(remainder).toBeGreaterThan(0n); // the fixture's odd paise really exercise the rule
    expect(fi.legs).toEqual([
      { assetClass: 'EQUITY', instrumentId: 'NSE:NIFTYBEES', paise: floor(mix.equityBps) + remainder },
      { assetClass: 'DEBT', instrumentId: 'MF:LIQUID', paise: floor(mix.debtBps) },
      { assetClass: 'GOLD', instrumentId: 'NSE:GOLDBEES', paise: floor(mix.goldBps) },
    ]);
  });

  it('a short emergency fund is one CASH leg into the IDFC First savings account, no instrument', () => {
    const em = buildGoalPlan(tracker({ emergency: 'SHORT' }), POSITIONS, 60).money.find((r) => r.goal === 'EMERGENCY')!;
    expect(em.legs).toEqual([
      { assetClass: 'CASH', instrumentId: null, label: 'IDFC First savings account', paise: rupees(150_000) },
    ]);
  });

  it('owner 2026-10-22: house is one DEBT leg into Edelweiss Arbitrage, unlinked when not held, never LIQUIDBEES', () => {
    const label = 'Edelweiss Arbitrage Fund (Direct Growth)';
    // POSITIONS holds another debt fund (MF:LIQUID) — the house leg must not pick it, nor the LIQUIDBEES default.
    expect(route('HOUSE')!.legs).toEqual([{ assetClass: 'DEBT', instrumentId: null, label, paise: rupees(23_457) }]);
    const none = buildGoalPlan(tracker(), [], 60).money.find((r) => r.goal === 'HOUSE')!;
    expect(none.legs).toEqual([{ assetClass: 'DEBT', instrumentId: null, label, paise: rupees(23_457) }]);
    expect(none.legs.map((l) => l.instrumentId)).not.toContain('NSE:LIQUIDBEES');
    const held = [...POSITIONS, pos('MF:EDEL-ARB', 'Edelweiss Arbitrage Fund - Direct Growth', 'MF', 'DEBT', 50)];
    const linked = buildGoalPlan(tracker(), held, 60).money.find((r) => r.goal === 'HOUSE')!;
    expect(linked.legs).toEqual([{ assetClass: 'DEBT', instrumentId: 'MF:EDEL-ARB', label, paise: rupees(23_457) }]);
    // Real look-alikes: the held Edelweiss 2033 bond, and a Regular plan of the same fund.
    const bond = pos('BOND:EDELWEISS-2033', 'Edelweiss Financial 10.45% 26-Oct-2033', 'BOND', 'DEBT', 50);
    const regular = pos('MF:EDEL-ARB-REG', 'Edelweiss Arbitrage Fund - Regular Growth', 'MF', 'DEBT', 50);
    for (const decoys of [[bond], [regular], [bond, regular]]) {
      const r = buildGoalPlan(tracker(), [...POSITIONS, ...decoys], 60).money.find((x) => x.goal === 'HOUSE')!;
      expect(r.legs).toEqual([{ assetClass: 'DEBT', instrumentId: null, label, paise: rupees(23_457) }]);
    }
    const withBond = buildGoalPlan(tracker(), [bond, ...held], 60).money.find((x) => x.goal === 'HOUSE')!;
    expect(withBond.legs[0]!.instrumentId).toBe('MF:EDEL-ARB');
  });

  it('education all equity from 2028', () => {
    const ed = route('EDUCATION')!;
    expect(ed.startsOn).toBe(`${ASSUMPTIONS.childArrivalYear}-01`);
    expect(ed.legs).toEqual([{ assetClass: 'EQUITY', instrumentId: 'NSE:NIFTYBEES', paise: rupees(9_999) }]);
  });

  it('Review Focus 3: a met goal has no route', () => {
    expect(route('EMERGENCY')).toBeUndefined();
    const met = buildGoalPlan(tracker({ fi: 'ON_TRACK', house: 'ON_TRACK', edu: 'ON_TRACK' }), POSITIONS, 60);
    expect(met.money).toEqual([]);
    expect(met.totalExtraMonthlyPaise).toBe(0n);
    expect(met.proposedBudgetPaise).toBe(BUDGET);
    expect(met.proposedSetAsidePaise).toBe(0n);
  });

  it('education before 2028 is not signable, so not in the total or the proposed budget', () => {
    expect(route('EDUCATION')!.signable).toBe(false);
    expect(plan.totalExtraMonthlyPaise).toBe(route('FI')!.extraMonthlyPaise + route('HOUSE')!.extraMonthlyPaise);
    expect(plan.proposedBudgetPaise).toBe(BUDGET + route('FI')!.extraMonthlyPaise + route('HOUSE')!.extraMonthlyPaise);
  });

  it('brief 2026-10-22: house and emergency are signable via the goal set-aside; future education is not', () => {
    const t = tracker({ emergency: 'SHORT', edu: 'SHORT', setAside: SET_ASIDE });
    const p = buildGoalPlan(t, POSITIONS, 60);
    expect(Object.fromEntries(p.money.map((r) => [r.goal, r.signable])))
      .toEqual({ FI: true, HOUSE: true, EMERGENCY: true, EDUCATION: true });
    // Derived from the tracker cards, not from the routes under test.
    const short = (id: GoalId) => t.cards.find((c) => c.id === id)!.shortMonthlyPaise!;
    expect(p.totalExtraMonthlyPaise).toBe(short('FI') + short('HOUSE') + short('EMERGENCY') + short('EDUCATION'));
    expect(p.proposedBudgetPaise).toBe(BUDGET + short('FI') + short('HOUSE') + short('EMERGENCY') + short('EDUCATION'));
    expect(p.proposedSetAsidePaise).toBe(t.goalSetAsidePaise + short('HOUSE') + short('EMERGENCY'));
    expect(p.totalExtraMonthlyPaise).toBe(p.money.filter((r) => r.signable).reduce((s, r) => s + r.extraMonthlyPaise, 0n));
  });

  it('a house SHORT route alone is signable, and only house money joins the set-aside', () => {
    const t = tracker({ setAside: SET_ASIDE });
    const p = buildGoalPlan(t, POSITIONS, 60);
    const house = t.cards.find((c) => c.id === 'HOUSE')!.shortMonthlyPaise!;
    expect(p.money.find((r) => r.goal === 'HOUSE')!.signable).toBe(true);
    expect(p.proposedSetAsidePaise).toBe(SET_ASIDE + house);
    expect(p.proposedBudgetPaise).toBe(BUDGET + house + t.cards.find((c) => c.id === 'FI')!.shortMonthlyPaise!);
  });

  it('an UNKNOWN FI (no pots) gets neither a money route nor a risk route', () => {
    const p = buildGoalPlan(tracker({ fi: 'UNKNOWN', fiPots: null }), POSITIONS, 60);
    expect(p.money.find((r) => r.goal === 'FI')).toBeUndefined();
    expect(p.risk).toBeNull();
  });
});

describe('goal plan: risk route', () => {
  it('is absent when FI is ON_TRACK', () => {
    expect(buildGoalPlan(tracker({ fi: 'ON_TRACK' }), POSITIONS, 60).risk).toBeNull();
  });

  it('the found equityPct closes at the current budget, and equityPct − 1 does not', () => {
    const risk = buildGoalPlan(tracker(), POSITIONS, 60).risk!;
    expect(risk.closes).toBe(true);
    expect(risk.equityPct).toBeGreaterThan(60);
    expect(closesAt(SHORT_POTS, risk.equityPct)).toBe(true);
    expect(closesAt(SHORT_POTS, risk.equityPct - 1)).toBe(false);
  });

  it('searches above an already-signed ceiling, never at or below it', () => {
    // 63% closes this fixture, so a search starting from 60 would wrongly offer it.
    expect(closesAt(SHORT_POTS, 63)).toBe(true);
    const risk = buildGoalPlan(tracker(), POSITIONS, 68).risk!;
    expect(risk.equityPct).toBe(69);
    expect(risk.disclosure.band).toBe('equity 69% of new money vs 60% ceiling, IPS §3.3');
  });

  it('closes = false at 92% when no share closes it', () => {
    expect(closesAt(FAR_POTS, 92)).toBe(false);
    const risk = buildGoalPlan(tracker({ fiPots: FAR_POTS }), POSITIONS, 60).risk!;
    expect(risk).toMatchObject({ equityPct: 92, closes: false });
  });

  it('the disclosure names the band, the crash losses and the above-budget source', () => {
    const { disclosure: d, equityPct } = buildGoalPlan(tracker(), POSITIONS, 60).risk!;
    expect(d.band).toBe(`equity ${equityPct}% of new money vs 60% ceiling, IPS §3.3`);
    expect(d.aboveBudgetSource).toBe('a raise you would set in your monthly budget update');
    // The equity pot at month H before the shock, times the drop.
    const pot = (pct: number) =>
      project(SHORT_POTS, { months: H + 1, monthlyPaise: BUDGET, mix: newMoneyMix(pct), growthBps: GROWTH, rates: CENTRAL }).equity;
    const keep = BigInt(10_000 - Math.round(ASSUMPTIONS.crashEquityDrop * 10_000));
    expect(d.crashLossPaise.normal).toBe(pot(60) - (pot(60) * keep) / 10_000n);
    expect(d.crashLossPaise.goal).toBe(pot(equityPct) - (pot(equityPct) * keep) / 10_000n);
    expect(d.crashLossPaise.goal).toBeGreaterThanOrEqual(d.crashLossPaise.normal);
  });

  it('fiYearAfterCrash is computed with the shock: removing it changes the year', () => {
    const { disclosure: d, equityPct } = buildGoalPlan(tracker(), POSITIONS, 60).risk!;
    const year = (pct: number, shock?: number) => {
      const m = fiFirstMonth(SHORT_POTS, BUDGET, EPF, newMoneyMix(pct), CENTRAL, TARGET, 2100 * 12 - NOW_IDX, shock);
      return m === null ? null : Math.floor((NOW_IDX + m) / 12);
    };
    expect(d.fiYearAfterCrash.goal).toBe(year(equityPct, H));
    expect(d.fiYearAfterCrash.normal).toBe(year(60, H));
    expect(d.fiYearAfterCrash.goal).not.toBe(year(equityPct));
    expect(d.fiYearAfterCrash.goal).not.toBeNull();
  });
});

describe('loadGoalPlan', () => {
  it('reads the signed ceiling from settings_rails, 60 when absent', async () => {
    const db = await openDb();
    await runMigrations(db);
    expect((await loadGoalPlan(db, NOW)).plan.signedCeilingPct).toBe(60);
    await db.query(`insert into settings_rails (key, value) values ('goal_equity_ceiling_pct', '68'::jsonb)`);
    const { tracker: t, plan } = await loadGoalPlan(db, NOW);
    expect(plan.signedCeilingPct).toBe(68);
    expect(plan.proposedBudgetPaise).toBe(t.monthlyBudgetPaise + plan.totalExtraMonthlyPaise);
    await db.close();
  });

  it('throws on a stored ceiling outside 60–92 rather than clamping it', async () => {
    const db = await openDb();
    await runMigrations(db);
    for (const v of ['59', '95']) {
      await db.query(`insert into settings_rails (key, value) values ('goal_equity_ceiling_pct', $1::jsonb)
                      on conflict (key) do update set value = excluded.value`, [v]);
      await expect(loadGoalPlan(db, NOW)).rejects.toThrow(`goal_equity_ceiling_pct ${v} is outside 60–92`);
    }
    await db.close();
  });
});
