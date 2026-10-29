import { BENCHMARK, type IndexFundChoice, type IndexFundRow } from '../sources/index-funds.js';

/** Spec §4.4 (owner, 2026-10-29): a same-index challenger must be at least 0.10 points a year cheaper. */
export const INDEX_SWITCH_MIN_BPS = 10;

const pts = (bps: number): string => (bps / 100).toFixed(2);

/**
 * Pure. `chooseIndexFund` ranks the same-index peers; this only decides whether its top clears
 * the bar against the held fund. `indmoneyFundId` may carry the `IND:` prefix.
 */
export function indexChallenger(
  held: { indmoneyFundId: string | null; expenseRatioBps: number | null },
  choice: IndexFundChoice,
): { challenger: IndexFundRow | null; reason: string } {
  const top = choice.top;
  if (top === null) {
    // Peers on record but none eligible (e.g. every US fund closed to SIPs) is not "no peers".
    if (choice.notProposed.length === 0) return { challenger: null, reason: 'no same-index peers on record' };
    return { challenger: null, reason: `no eligible same-index fund: ${[...new Set(choice.notProposed.map((n) => n.why))].join('; ')}` };
  }
  if (held.indmoneyFundId?.replace(/^IND:/, '') === top.indmoneyFundId) {
    return { challenger: null, reason: `already the cheapest eligible ${BENCHMARK[choice.fundType].label} fund` };
  }
  if (held.expenseRatioBps === null) return { challenger: null, reason: 'expense ratio unknown' };
  const gap = held.expenseRatioBps - top.expenseRatioBps!; // ranked rows always carry one
  if (gap <= 0) return { challenger: null, reason: 'no eligible same-index fund is cheaper' };
  if (gap < INDEX_SWITCH_MIN_BPS) {
    return {
      challenger: null,
      reason: `cheapest same-index fund is ${pts(gap)} points cheaper, short of the ${pts(INDEX_SWITCH_MIN_BPS)}-point bar`,
    };
  }
  return {
    challenger: top,
    reason: `${top.name} costs ${pts(top.expenseRatioBps!)}% a year against ${pts(held.expenseRatioBps)}%, ${pts(gap)} points cheaper`,
  };
}
