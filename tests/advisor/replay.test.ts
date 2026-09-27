import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { replayAt, replayWindow } from '../../src/advisor/replay.js';

/**
 * Phase 2.5 Task 5. A replay shows what the advisor could have known at a cutoff: data
 * that existed by then, both by its economic date and by when it ARRIVED. It writes only
 * replay_runs, calls no model and no network, and is deterministic.
 */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:X', 'EQUITY', 'X Ltd', 'INR')`);
});

async function news(id: string, published: string, received: string): Promise<number> {
  const [r] = await db.query<{ id: string }>(
    `insert into news_events (dedupe_key, instrument_id, scope, event_type, headline, published_at, received_at, as_of, source)
     values ($1, 'NSE:X', 'instrument', 'results', $1, $2, $3, $3, 'bse') returning id`, [id, published, received]);
  return Number(r!.id);
}
async function sentiment(eventId: number, polarity: string, at: string): Promise<void> {
  await db.query(
    `insert into event_sentiment (event_id, polarity, materiality, summary, model, prompt_version, schema_version, classified_at, as_of)
     values ($1, $2, 'HIGH', 's', 'm', 'p', 's', $3, $3)`, [eventId, polarity, at]);
}
async function score(d: string, composite: number): Promise<void> {
  await db.query(`insert into signal_scores (instrument_id, score_date, composite, quality_passed) values ('NSE:X', $1, $2, true)`, [d, composite]);
}

describe('point in time', () => {
  it('cannot see news published after the cutoff', async () => {
    await news('a', '2026-08-10T10:00:00Z', '2026-08-10T12:00:00Z');
    await news('b', '2026-09-10T10:00:00Z', '2026-09-10T12:00:00Z');
    const r = await replayAt(db, '2026-08-31');
    expect(r.news.map((n) => n.headline)).toEqual(['a']);
    await db.close();
  });

  it('cannot see news that arrived after the cutoff, even if it is dated before it', async () => {
    // A late backfill: published in August, fetched in September.
    await news('late', '2026-08-10T10:00:00Z', '2026-09-27T12:00:00Z');
    expect((await replayAt(db, '2026-08-31')).news).toEqual([]);
    expect((await replayAt(db, '2026-09-30')).news).toHaveLength(1);
    await db.close();
  });

  it('uses the classification known at the cutoff, not a later revision', async () => {
    const id = await news('a', '2026-08-10T10:00:00Z', '2026-08-10T12:00:00Z');
    await sentiment(id, 'POSITIVE', '2026-08-11T00:00:00Z');
    await sentiment(id, 'NEGATIVE', '2026-09-15T00:00:00Z');
    expect((await replayAt(db, '2026-08-31')).news[0]!.polarity).toBe('POSITIVE');
    expect((await replayAt(db, '2026-09-30')).news[0]!.polarity).toBe('NEGATIVE');
    await db.close();
  });

  it('takes engine scores dated on or before the cutoff only', async () => {
    await score('2026-08-20', 72);
    await score('2026-09-20', 91);
    expect((await replayAt(db, '2026-08-31')).scores).toEqual([{ instrumentId: 'NSE:X', scoreDate: '2026-08-20', composite: 72 }]);
    await db.close();
  });
});

describe('the replay run', () => {
  it('is deterministic, writes only replay_runs, and says what it could not reconstruct', async () => {
    await news('a', '2026-08-10T10:00:00Z', '2026-08-10T12:00:00Z');
    await score('2026-08-20', 72);
    const first = await replayWindow(db, { from: '2026-08-01', to: '2026-09-30', now: new Date('2026-09-27T00:00:00Z') });
    const second = await replayWindow(db, { from: '2026-08-01', to: '2026-09-30', now: new Date('2026-09-28T00:00:00Z') });
    expect(second.result).toEqual(first.result);
    expect(second.datasetHash).toBe(first.datasetHash);
    const [n] = await db.query<{ n: string }>(`select count(*) n from replay_runs`);
    expect(Number(n!.n)).toBe(2);
    expect(first.coverage.unreconstructable).toEqual(expect.arrayContaining([expect.stringMatching(/rails/)]));
    await db.close();
  });

  it('changes its dataset hash when the evidence changes', async () => {
    await news('a', '2026-08-10T10:00:00Z', '2026-08-10T12:00:00Z');
    const before = await replayWindow(db, { from: '2026-08-01', to: '2026-08-31', now: new Date('2026-09-27T00:00:00Z') });
    await news('b', '2026-08-12T10:00:00Z', '2026-08-12T12:00:00Z');
    const after = await replayWindow(db, { from: '2026-08-01', to: '2026-08-31', now: new Date('2026-09-27T00:00:00Z') });
    expect(after.datasetHash).not.toBe(before.datasetHash);
    await db.close();
  });
});
