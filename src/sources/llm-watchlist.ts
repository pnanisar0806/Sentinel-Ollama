import type { Db } from '../db/client.js';
import { OPENROUTER_CHAT_URL, TEXT_MODEL } from '../config/models.js';

/**
 * LLM watchlist shortlisting (owner decision 2026-09-13).
 *
 * The owner's standing rule still holds: the watchlist is advisor-owned and every change
 * is a PROPOSAL surfaced in the weekly report for sign-off — nothing here auto-mutates a
 * live universe behind him. What changed is who drafts the shortlist.
 *
 * The division of labour that keeps PRD §6.7 intact: the model proposes *names* and a
 * sentence of reasoning; the engine decides everything that carries a number. Quality
 * gate, composite score, sizing, caps and staleness blocking all run afterwards on real
 * fundamentals and real closes, so a name the model likes for a bad reason still has to
 * clear the same bars as any other.
 *
 * Two hard limits, both enforced here rather than trusted to the prompt:
 *   1. A proposal must name an instrument that ALREADY EXISTS in `instruments`. The model
 *      cannot conjure a ticker into the portfolio's identity space (FR-02 in spirit).
 *   2. A held name is never proposed — §6.1 keeps holdings out of the satellite BUY set.
 *
 * When a screener cohort has been imported, it is passed in as the candidate pool and the
 * model is choosing *from real data*. Without one it proposes from its own knowledge, and
 * `source = 'llm-advisor'` records that provenance on every row it creates.
 */

export const WATCHLIST_PROMPT = [
  'You are shortlisting Indian listed equities for a single long-term investor to WATCH.',
  'This is a watchlist, not a buy list: a separate deterministic engine scores every name',
  'afterwards on real fundamentals and prices, and it — not you — decides what is recommended.',
  'Rules, without exception:',
  '- Choose ONLY from the candidate list given to you. Do not add a ticker that is not in it.',
  '- Do NOT state a price, a target, a valuation, a score or a rank. One sentence of thesis.',
  '- Prefer durable businesses with a reason to be watched now; avoid penny stocks.',
  '- No derivatives, no leverage, no unlisted names.',
  'Return STRICT JSON only: {"picks":[{"instrumentId":"NSE:XXX","reason":"..."}]}',
].join('\n');

export interface WatchlistProposal {
  instrumentId: string;
  reason: string;
}

export interface WatchlistCandidate {
  instrumentId: string;
  name: string;
  sector: string | null;
}

export interface ProposeWatchlistDeps {
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: typeof fetch;
  candidates: WatchlistCandidate[];
  /** How many names to shortlist. */
  limit?: number;
}

/**
 * Candidate pool: every instrument we can identify that the owner does not already hold
 * and that is not already on the watchlist. Prefers names carrying a screener row, since
 * those are the ones the engine can actually score.
 */
export async function watchlistCandidates(db: Db, asOf: string): Promise<WatchlistCandidate[]> {
  return db.query<WatchlistCandidate>(
    `select i.id as "instrumentId", i.name, i.sector
       from instruments i
      where i.kind in ('EQUITY', 'ETF')
        and not exists (
          select 1 from holdings h where h.instrument_id = i.id
        )
        and not exists (
          select 1 from watchlist w
           where w.instrument_id = i.id
             and w.added_on <= $1 and (w.removed_on is null or w.removed_on > $1)
        )
      order by (select count(*) from fundamentals f where f.instrument_id = i.id) desc, i.id`,
    [asOf],
  );
}

/**
 * Returns the model's shortlist, filtered to candidates it was actually offered.
 * Returns `[]` rather than throwing when there is no key or the call fails — a shortlist
 * is a proposal, and failing to produce one is not an error worth stopping a job for.
 */
export async function proposeWatchlist(deps: ProposeWatchlistDeps): Promise<WatchlistProposal[]> {
  if (!deps.apiKey || deps.candidates.length === 0) return [];
  const doFetch = deps.fetchImpl ?? fetch;
  const offered = new Map(deps.candidates.map((c) => [c.instrumentId, c]));

  try {
    const res = await doFetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: deps.model ?? TEXT_MODEL,
        messages: [
          { role: 'system', content: WATCHLIST_PROMPT },
          {
            role: 'user',
            content:
              `Shortlist at most ${deps.limit ?? 40} of these candidates:\n` +
              deps.candidates
                .map((c) => `${c.instrumentId} — ${c.name}${c.sector === null ? '' : ` (${c.sector})`}`)
                .join('\n'),
          },
        ],
      }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { picks?: { instrumentId?: string; reason?: string }[] };

    const seen = new Set<string>();
    const picks: WatchlistProposal[] = [];
    for (const p of parsed.picks ?? []) {
      const id = p.instrumentId;
      // A hallucinated ticker is dropped, not created. The model chooses from the pool
      // or it does not choose.
      if (id === undefined || !offered.has(id) || seen.has(id)) continue;
      const reason = (p.reason ?? '').trim();
      if (reason === '') continue;
      seen.add(id);
      picks.push({ instrumentId: id, reason });
      if (picks.length >= (deps.limit ?? 40)) break;
    }
    return picks;
  } catch {
    return [];
  }
}

/**
 * Records proposals as watchlist rows tagged `llm-advisor`, so the weekly report can show
 * them as awaiting sign-off and the audit trail always says who drafted a name.
 * `watchlist` is append-only, so a re-run adds nothing on conflict.
 */
export async function applyWatchlistProposals(
  db: Db,
  proposals: readonly WatchlistProposal[],
  addedOn: string,
): Promise<number> {
  let written = 0;
  for (const p of proposals) {
    // `watchlist`'s primary key is (instrument_id, added_on), so `on conflict` caught
    // only a same-day re-add. On any later date this inserted a SECOND live row for a
    // name already watched, and production reached 80 live rows for 73 instruments —
    // the engine then scored those seven twice. The guard is "already live", not
    // "already keyed". A name watched and since removed is a real decision and is
    // still accepted.
    const rows = await db.query<{ instrument_id: string }>(
      `insert into watchlist (instrument_id, added_on, source, reason)
       select $1, $2::date, 'llm-advisor', $3
        where not exists (
          select 1 from watchlist
           where instrument_id = $1 and (removed_on is null or removed_on > $2::date)
        )
       returning instrument_id`,
      [p.instrumentId, addedOn, p.reason],
    );
    written += rows.length;
  }
  return written;
}
