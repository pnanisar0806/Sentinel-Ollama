/** Pure display helpers for the payday entry, the HDFC stale warning and /cashflow (open list #10/#29). */
import { formatInr, type Paise } from '../../src/money/paise.js';
import type { BalanceAge, PaydayDue } from '../../src/domain/cashflow.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-27 → 27-Nov */
export const dayLabel = (on: string): string => `${Number(on.slice(8, 10))}-${MONTHS[Number(on.slice(5, 7)) - 1]}`;
/** 2026-11 → November 2026 style short label: Nov 2026 */
export const monthShort = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** A known amount, or "unknown" — never ₹0 for an unknown. */
export const moneyOrUnknown = (p: bigint | null): string => (p === null ? 'unknown' : formatInr(p as Paise));

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
