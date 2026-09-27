import type { Db } from '../db/client.js';
import { proposeWatchlist, watchlistCandidates } from '../sources/llm-watchlist.js';
import { FINANCE_SECTORS, QUALITY } from '../domain/engine.js';
import { loadProposals, recordProposal } from './proposals.js';

/**
 * Quarterly watchlist revision (Phase 2.5 Task 9) — a PROPOSAL the owner signs line by
 * line; nothing here changes the watchlist (the sign-off service does, outside src/advisor).
 *
 * Timing (owner, 2026-09-27): the first weekday on or after the 20th of Feb, May, Aug and
 * Nov — after the 45-day results-filing deadline, so fundamentals include the latest quarter.
 *
 * Additions: the model shortlists from screened companies (a fundamentals row) that are
 * neither held nor watched. Removals: a watched name whose LATEST screened fundamentals fail
 * the §6 quality gate or carry a red flag. A name with no fundamentals is not judged —
 * too little evidence is not a failure.
 */

const REVISION_MONTHS = new Set([2, 5, 8, 11]);

export function isRevisionDay(dateIso: string): boolean {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (!REVISION_MONTHS.has(d.getUTCMonth() + 1) || d.getUTCDate() < 20) return false;
  const weekday = (x: Date) => x.getUTCDay() !== 0 && x.getUTCDay() !== 6;
  if (!weekday(d)) return false;
  // The first weekday on or after the 20th: every day from the 20th up to today is a weekend.
  for (let day = 20; day < d.getUTCDate(); day++) {
    if (weekday(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)))) return false;
  }
  return true;
}

const quarterOf = (dateIso: string): string => `${dateIso.slice(0, 4)}-Q${Math.ceil(Number(dateIso.slice(5, 7)) / 3)}`;

export interface RevisionLine { op: 'ADD' | 'REMOVE'; instrumentId: string; name: string; reason: string }

export async function removalCandidates(db: Db): Promise<RevisionLine[]> {
  const rows = await db.query<{ instrument_id: string; name: string; sector: string | null; roce_pct: string | null; de_ratio: string | null; red_flags: number | null; as_of: string }>(
    `select distinct on (f.instrument_id) f.instrument_id, i.name, i.sector, f.roce_pct::text, f.de_ratio::text, f.red_flags, f.as_of::text
       from fundamentals f join instruments i on i.id = f.instrument_id
      where f.instrument_id in (select instrument_id from watchlist_effective where removed_on is null)
      order by f.instrument_id, f.as_of desc`,
  );
  const out: RevisionLine[] = [];
  for (const r of rows) {
    const why: string[] = [];
    if (r.roce_pct !== null && Number(r.roce_pct) < QUALITY.minRocePct) why.push(`ROCE ${Number(r.roce_pct)}% below ${QUALITY.minRocePct}%`);
    const finance = (FINANCE_SECTORS as readonly string[]).includes(r.sector ?? '');
    if (!finance && r.de_ratio !== null && Number(r.de_ratio) > QUALITY.maxDeRatio) why.push(`debt/equity ${Number(r.de_ratio)} above ${QUALITY.maxDeRatio}`);
    if ((r.red_flags ?? 0) > QUALITY.maxRedFlags) why.push(`${r.red_flags} red flag(s)`);
    if (why.length > 0) out.push({ op: 'REMOVE', instrumentId: r.instrument_id, name: r.name, reason: `${why.join('; ')} (fundamentals as of ${r.as_of})` });
  }
  return out;
}

/** Drafts this quarter's revision; null if one already exists for the quarter. */
export async function proposeRevision(
  db: Db, opts: { asOf: string; apiKey: string | undefined; model?: string | undefined; fetchImpl?: typeof fetch },
): Promise<number | null> {
  const quarter = quarterOf(opts.asOf);
  const existing = (await loadProposals(db, 'WATCHLIST_REVISION', 200)).find((p) => p.payload['quarter'] === quarter);
  if (existing) return null;

  const screened = new Set((await db.query<{ instrument_id: string }>(`select distinct instrument_id from fundamentals`)).map((r) => r.instrument_id));
  const pool = (await watchlistCandidates(db, opts.asOf)).filter((c) => screened.has(c.instrumentId));
  const names = new Map(pool.map((c) => [c.instrumentId, c.name]));
  const picks = await proposeWatchlist({
    apiKey: opts.apiKey, candidates: pool, limit: 10,
    ...(opts.model ? { model: opts.model } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const lines: RevisionLine[] = [
    ...picks.map((p) => ({ op: 'ADD' as const, instrumentId: p.instrumentId, name: names.get(p.instrumentId) ?? p.instrumentId, reason: p.reason })),
    ...(await removalCandidates(db)),
  ];
  return recordProposal(db, {
    kind: 'WATCHLIST_REVISION',
    payload: { quarter, lines, additionsUnavailable: picks.length === 0 && pool.length > 0 ? 'no model key or no usable shortlist' : null },
    inputSnapshot: { pool: pool.map((c) => c.instrumentId) }, evidenceIds: [],
    model: opts.apiKey ? (opts.model ?? 'default') : null, promptVersion: 'watchlist-v1', schemaVersion: 'watchlist-schema-v1',
    asOf: `${opts.asOf}T00:00:00Z`,
  });
}
