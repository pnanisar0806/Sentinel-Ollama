/** Pure display helpers for the payday entry, the HDFC stale warning and /cashflow (open list #10/#29). */
import { formatInr, type Paise } from '../../src/money/paise.js';
import type { BalanceAge, Cycle, PaydayDue } from '../../src/domain/cashflow.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-27 → 27-Nov */
export const dayLabel = (on: string): string => `${Number(on.slice(8, 10))}-${MONTHS[Number(on.slice(5, 7)) - 1]}`;
/** 2026-11 → November 2026 style short label: Nov 2026 */
export const monthShort = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** A known amount, or "unknown" — never ₹0 for an unknown. */
export const moneyOrUnknown = (p: bigint | null): string => (p === null ? 'unknown' : formatInr(p as Paise));

/** Average of the newest three cycles (newest first); null until all three are known. */
export function avg3(cycles: Cycle[], pick: (c: Cycle) => bigint | null): bigint | null {
  const last = cycles.slice(0, 3).map(pick);
  if (last.length < 3 || last.some((v) => v === null)) return null;
  return (last as bigint[]).reduce((s, v) => s + v, 0n) / 3n;
}

/**
 * /advisor (open list #28, gap 2): the measured surplus beside the budget. Facts only: it
 * names the difference and never proposes a budget or changes a rail.
 */
export function surplusVsBudget(cycles: Cycle[], budgetPaise: bigint | null, sipsPaise: bigint | null): string {
  const avg = avg3(cycles, (c) => c.surplusPaise);
  if (avg === null) {
    const known = cycles.slice(0, 3).filter((c) => c.surplusPaise !== null).length;
    return `Your real surplus appears here once Cash flow has three known pay cycles (${known} so far).`;
  }
  const m = moneyOrUnknown;
  let out = `Average surplus over the last 3 pay cycles: ${m(avg)}. Monthly budget: ${m(budgetPaise)}, of which SIPs ${m(sipsPaise)}.`;
  if (budgetPaise === null) return out;
  if (avg > budgetPaise) out += ` About ${m(avg - budgetPaise)} a month of surplus is outside the budget and stays in the bank. Changing the budget is your call, on Overview.`;
  else if (avg < budgetPaise) out += ` The budget is ${m(budgetPaise - avg)} more than the average surplus.`;
  return out;
}

/** The Overview line asking for a payday entry; null when none is due. */
export function paydayDueText(d: PaydayDue): string | null {
  if (!d.due) return null;
  const last = d.lastOn === null ? '' : ` Last entry: ${dayLabel(d.lastOn)}.`;
  return `Payday for ${monthShort(d.month)}: enter the salary credited and the HDFC balance right after it.${last}`;
}

/** The warning when INDmoney has not refreshed the HDFC balance; null when it is fresh or unknown. */
export function staleBankText(a: BalanceAge | null): string | null {
  if (a === null || !a.stale) return null;
  return `HDFC balance ${formatInr(a.amountPaise as Paise)} is unchanged since ${dayLabel(a.lastChangedOn)} (${a.daysUnchanged} days). ` +
    'INDmoney refreshes it only when you open its app: open INDmoney and pull to refresh, and the next sync picks it up.';
}

/** The /log hint under the HDFC field: INDmoney's figure, for reference only. */
export function hdfcHint(a: BalanceAge | null): string | null {
  if (a === null) return null;
  const since = a.daysUnchanged === 0 ? 'changed today' : `unchanged since ${dayLabel(a.lastChangedOn)}`;
  return `INDmoney shows ${formatInr(a.amountPaise as Paise)}, ${since}: for reference only.`;
}
