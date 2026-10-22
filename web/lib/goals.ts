/** Pure display and proposal helpers for the goal tracker and goal plan (spec 2026-10-21 §4, §6, §9). */
import { formatInr, type Paise } from '../../src/money/paise.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import type { GoalCard, MoneyRoute, RiskRoute } from '../../src/domain/goal-plan.js';
import type { Tone } from './ui';
import { istDateTime, type PendingRailChange } from '../../src/domain/controls.js';
import { BUDGET_RAIL_NAMES, pendingBudgetRail } from '../../src/domain/rail-values.js';

export const EDUCATION_START = ASSUMPTIONS.childArrivalYear;

/** Verdict badges: text carries the meaning, colour only reinforces it. */
export const VERDICT: Record<GoalCard['verdict'], { tone: Tone; label: string }> = {
  ON_TRACK: { tone: 'green', label: 'on track' }, SHORT: { tone: 'amber', label: 'short' },
  NOT_STARTED: { tone: 'gray', label: `starts ${EDUCATION_START}` }, UNKNOWN: { tone: 'red', label: 'unknown' },
};

export const inr = (p: bigint) => formatInr(p as Paise);

/** A null balance is unknown, never ₹0. */
export const balanceText = (c: Pick<GoalCard, 'balancePaise'>) => (c.balancePaise === null ? 'unknown' : inr(c.balancePaise));

const year = (y: number | null) => (y === null ? 'after 2100' : String(y));

/** The finish-year band: "2041 (2038–2047)". */
export const finishBand = (f: GoalCard['finishYear']) =>
  `${year(f.central)} (${year(f.pessimistic)}–${year(f.optimistic)})`;

const reaches = (y: number | null) => (y === null ? "not reached by 2100 at today's pace" : `reaches it in ${y} at today's pace`);

/** One line per goal: the Overview card and each tracker card's headline. An unknown amount is never ₹0. */
export function verdictLine(c: GoalCard): string {
  const short = c.shortMonthlyPaise === null ? 'short by an unknown amount a month' : `${inr(c.shortMonthlyPaise)}/month short`;
  switch (c.verdict) {
    case 'ON_TRACK': return `on track · reaches it in ${year(c.finishYear.central)}`;
    // The emergency fund does not grow: a finish year says nothing, the target date does.
    case 'SHORT': return c.id === 'EMERGENCY' ? `${short} to reach ${c.targetLabel}` : `${short} · ${reaches(c.finishYear.central)}`;
    case 'NOT_STARTED': return c.shortMonthlyPaise === null
      ? `starts ${EDUCATION_START}; the monthly amount from then to reach ${c.targetLabel} is unknown`
      : `starts ${EDUCATION_START}; ${inr(c.shortMonthlyPaise)}/month from then to reach ${c.targetLabel}`;
    case 'UNKNOWN': return `unknown: ${c.reason ?? 'no data'}`;
  }
}

/**
 * House and emergency routes: money for B2/B3. Signing raises the budget and the goal
 * set-aside together; the owner still moves the money and logs it.
 */
export function setAsideLine(m: MoneyRoute, goal: string, names: ReadonlyMap<string, string>): string {
  const where = m.legs.map((l) => l.label ?? (l.instrumentId ? names.get(l.instrumentId) ?? l.instrumentId : `a ${l.assetClass.toLowerCase()} fund`));
  return `Set aside ${inr(m.extraMonthlyPaise)}/month into ${where.join(' and ')} and log it to the ${goal} on /log.`;
}

export interface RailProposal {
  key: 'monthly_budget_paise' | 'tactical_monthly_paise' | 'goal_equity_ceiling_pct' | 'goal_setaside_monthly_paise';
  value: number; note: string;
}

/**
 * "Raise budget by ₹X" (controller ruling 2): budget = current + X. `setAside.extra` is the
 * house/emergency part of X: the set-aside rises by it too, so that part never reaches the
 * envelope. The set-aside is proposed FIRST: the budget raise is a loosening and may be
 * refused, and a set-aside without its budget raise only shrinks the envelope (the safe side).
 * The tactical cap is raised to budget − SIPs − set-aside only when it would bind on the
 * investable part; with the SIP total unknown it cannot be checked.
 */
export function budgetRaise(extra: bigint, budget: bigint, tactical: bigint, sipTotal: bigint | null, goal: string,
  setAside: { current: bigint; extra: bigint } = { current: 0n, extra: 0n })
  : { proposals: RailProposal[]; tacticalUnchecked: boolean } {
  const note = `Goal plan: extra money for ${goal}`;
  const next = budget + extra;
  const nextSetAside = setAside.current + setAside.extra;
  const investable = extra > setAside.extra;
  const proposals: RailProposal[] = setAside.extra > 0n
    ? [{ key: 'goal_setaside_monthly_paise', value: Number(nextSetAside), note: `Goal plan: set aside for ${goal}` }]
    : [];
  proposals.push({ key: 'monthly_budget_paise', value: Number(next), note });
  if (investable && sipTotal !== null && tactical < next - sipTotal - nextSetAside) {
    proposals.push({ key: 'tactical_monthly_paise', value: Number(next - sipTotal - nextSetAside), note });
  }
  return { proposals, tacticalUnchecked: investable && sipTotal === null };
}

/** The risk disclosure (spec §6) as text: rendered on /advisor and sent as the rail change's note. */
export function disclosureLines(r: RiskRoute): string[] {
  const d = r.disclosure;
  return [
    `Band broken: ${d.band}.`,
    `A 2008-grade crash (equity −50%) within ${ASSUMPTIONS.crashHorizonMonths / 12} years loses ${inr(d.crashLossPaise.goal)} on this plan vs ${inr(d.crashLossPaise.normal)} on the normal plan.`,
    `FI year if that crash lands within ${ASSUMPTIONS.crashHorizonMonths / 12} years: ${year(d.fiYearAfterCrash.goal)} on this plan vs ${year(d.fiYearAfterCrash.normal)} on the normal plan.`,
    `Above-budget money would come from ${d.aboveBudgetSource}.`,
    'The rebalance dilutes equity only above this share of the whole portfolio; raising it never triggers a sale.',
    ...(r.closes ? [] : [`Even at ${r.equityPct}% equity the FI gap does not fully close at the current budget.`]),
  ];
}

/**
 * A pending rail change hides the goal-plan buttons that would replace it (`propose_rail`
 * upserts the pending value and restarts its 48 hours). Null = the action is exposed.
 */
export function pendingBlocks(pending: readonly PendingRailChange[]): { budget: string | null; ceiling: string | null } {
  const b = pendingBudgetRail(pending);
  const ceiling = pending.find((c) => c.key === 'goal_equity_ceiling_pct');
  return {
    budget: b ? `A ${BUDGET_RAIL_NAMES[b.key]} change to ${inr(BigInt(b.proposed))} activates ${istDateTime(b.activatesAt)}. Raise again after it activates.` : null,
    ceiling: ceiling ? `Equity ceiling change to ${ceiling.proposed}% activates ${istDateTime(ceiling.activatesAt)}.` : null,
  };
}
