import { resolveTicker } from './statement-tickers.js';

/**
 * The ONE owner-facing line-number ordering: /holdings renders it and /cost resolves
 * against it. Two divergent orderings made `/cost 2` write to a different instrument
 * than line 2 displayed (live-test finding, 2026-08-25). Shared by the Telegram bot
 * and the web import flow so both stay on the same numbering.
 */
export function displayOrder<T extends { name?: string | null; instrumentId: string }>(
  positions: T[],
): T[] {
  return [...positions].sort((a, b) =>
    (a.name || a.instrumentId).localeCompare(b.name || b.instrumentId),
  );
}

/**
 * Resolves where a proposal's cost should land. A known statement ticker is
 * AUTHORITATIVE — the model's `line` guess flips nondeterministically on
 * near-identical names (TMCV/TMPV wrote three wrong lots on 2026-08-25), while the
 * ticker map is owner-verified. The line anchors only holdings the map doesn't know.
 */
export function resolveProposalTarget(
  p: { name?: string | null; line: number | null },
  positions: { instrumentId: string; account: string }[],
): { instrumentId: string | null; account: string | null } {
  const byTicker = p.name ? resolveTicker(p.name) : undefined;
  if (byTicker) {
    const pos = positions.find((q) => q.instrumentId === byTicker);
    if (pos) return { instrumentId: pos.instrumentId, account: pos.account };
  }
  if (p.line === null || p.line < 0 || p.line >= positions.length) {
    return { instrumentId: null, account: null };
  }
  const pos = positions[p.line]!;
  return { instrumentId: pos.instrumentId, account: pos.account };
}