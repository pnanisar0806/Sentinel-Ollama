import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { TEXT_MODEL, VISION_MODEL_CHAIN } from '../../src/config/models.js';
import { DEFAULT_NARRATION_MODEL } from '../../src/sources/llm-narration.js';
import { DEFAULT_LLM_MODEL } from '../../src/sources/llm-extract.js';
import {
  applyWatchlistProposals,
  proposeWatchlist,
  watchlistCandidates,
  type WatchlistCandidate,
} from '../../src/sources/llm-watchlist.js';

const AS_OF = '2026-09-13';
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const candidates: WatchlistCandidate[] = [
  { instrumentId: 'NSE:AAA', name: 'Alpha Ltd', sector: 'IT' },
  { instrumentId: 'NSE:BBB', name: 'Beta Ltd', sector: 'Banking' },
];

const respond = (content: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;

describe('project model configuration (owner decision 2026-09-13)', () => {
  it('uses the finance-tuned Ling model for every text job', () => {
    expect(TEXT_MODEL).toBe('inclusionai/ling-3.0-flash-fin:free');
    expect(DEFAULT_NARRATION_MODEL).toBe(TEXT_MODEL);
  });

  it('keeps the text-only model out of the vision chain, led by the proven gemma pool', () => {
    // ling-3.0-flash-fin is text-only per OpenRouter's catalogue; putting it in front of a
    // screenshot would 400 on every statement upload. Owner decision 2026-09-13: extraction
    // uses the previously-tuned gemma-led chain again (the Ling VL trial was retired).
    expect(VISION_MODEL_CHAIN).not.toContain(TEXT_MODEL);
    expect(VISION_MODEL_CHAIN[0]).toBe('google/gemma-4-31b-it:free');
    expect(DEFAULT_LLM_MODEL).toBe(VISION_MODEL_CHAIN[0]);
  });
});

describe('proposeWatchlist', () => {
  it('returns the shortlist the model chose from the pool it was offered', async () => {
    const picks = await proposeWatchlist({
      apiKey: 'k',
      fetchImpl: respond('{"picks":[{"instrumentId":"NSE:AAA","reason":"IT bellwether worth watching"}]}'),
      candidates,
    });
    expect(picks).toEqual([{ instrumentId: 'NSE:AAA', reason: 'IT bellwether worth watching' }]);
  });

  it('drops a ticker the model invented instead of creating an instrument', async () => {
    const picks = await proposeWatchlist({
      apiKey: 'k',
      fetchImpl: respond(
        '{"picks":[{"instrumentId":"NSE:GHOST","reason":"does not exist"},{"instrumentId":"NSE:BBB","reason":"real"}]}',
      ),
      candidates,
    });
    expect(picks.map((p) => p.instrumentId)).toEqual(['NSE:BBB']);
  });

  it('tolerates prose around the JSON, and honours the limit', async () => {
    const picks = await proposeWatchlist({
      apiKey: 'k',
      limit: 1,
      fetchImpl: respond(
        'Here you go:\n{"picks":[{"instrumentId":"NSE:AAA","reason":"one"},{"instrumentId":"NSE:BBB","reason":"two"}]}\nHope that helps.',
      ),
      candidates,
    });
    expect(picks).toHaveLength(1);
  });

  it('returns nothing rather than throwing when there is no key or the call fails', async () => {
    expect(await proposeWatchlist({ candidates, fetchImpl: respond('{}') })).toEqual([]);
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await proposeWatchlist({ apiKey: 'k', fetchImpl: failing, candidates })).toEqual([]);
    const garbage = respond('not json at all');
    expect(await proposeWatchlist({ apiKey: 'k', fetchImpl: garbage, candidates })).toEqual([]);
  });

  it('drops a pick with no reasoning', async () => {
    const picks = await proposeWatchlist({
      apiKey: 'k',
      fetchImpl: respond('{"picks":[{"instrumentId":"NSE:AAA","reason":"   "}]}'),
      candidates,
    });
    expect(picks).toEqual([]);
  });
});

describe('watchlistCandidates', () => {
  it('offers neither what the owner holds nor what is already watched (§6.1)', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const pool = (await watchlistCandidates(db, AS_OF)).map((c) => c.instrumentId);

    const held = await db.query<{ instrument_id: string }>(`select distinct instrument_id from holdings`);
    for (const h of held) expect(pool).not.toContain(h.instrument_id);

    const watched = await db.query<{ instrument_id: string }>(
      `select instrument_id from watchlist where removed_on is null`,
    );
    expect(watched.length).toBeGreaterThan(0);
    for (const w of watched) expect(pool).not.toContain(w.instrument_id);
  });
});

describe('applyWatchlistProposals', () => {
  it('records provenance as llm-advisor and is safe to re-run', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const [candidate] = await watchlistCandidates(db, AS_OF);
    if (candidate === undefined) return; // seed leaves no free instrument; nothing to assert

    const proposals = [{ instrumentId: candidate.instrumentId, reason: 'proposed by the model' }];
    expect(await applyWatchlistProposals(db, proposals, AS_OF)).toBe(1);
    expect(await applyWatchlistProposals(db, proposals, AS_OF)).toBe(0);

    const [row] = await db.query<{ source: string; reason: string }>(
      `select source, reason from watchlist where instrument_id = $1 and added_on = $2`,
      [candidate.instrumentId, AS_OF],
    );
    expect(row!.source).toBe('llm-advisor');
    expect(row!.reason).toBe('proposed by the model');
  });
});
