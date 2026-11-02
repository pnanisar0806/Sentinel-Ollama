/**
 * A cap-at-N% rule's percent, typed by the owner, to integer basis points — exactly, never
 * through a float: "12.5" → 1250. At most two decimals; above 0 and at most 100.
 */
export function capBps(text: string): number {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new Error(`"${text.trim()}" is not a percentage with at most two decimals`);
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (bps < 1 || bps > 10000) throw new Error('a cap must be above 0% and at most 100%');
  return bps;
}
