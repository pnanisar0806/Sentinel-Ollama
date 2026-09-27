import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { isRevisionDay, proposeRevision, removalCandidates } from '../../src/advisor/watchlist.js';
import { decideWatchlistLine } from '../../src/domain/watchlist-signoff.js';
import { loadProposals } from '../../src/advisor/proposals.js';

/**
 * Phase 2.5 Task 9. A quarterly watchlist revision is a proposal the owner signs line by
 * line. Additions come from real screened companies; removals from real evidence on the
 * watched name, never from too little history. `watchlist` is append-only, so a removal
 * is an event in `watchlist_removals`, read through the `watchlist_effective` view.
 */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name, currency, sector) values
    ('NSE:GOOD', 'EQUITY', 'Good Co', 'INR', 'Industrials'),
    ('NSE:BAD', 'EQUITY', 'Bad Co', 'INR', 'Industrials'),
    ('NSE:NEW', 'EQUITY', 'New Co', 'INR', 'Industrials'),
    ('NSE:THIN', 'EQUITY', 'Thin Co', 'INR', 'Industrials')`);
  await db.query(`insert into watchlist (instrument_id, added_on, source, reason) values
    ('NSE:GOOD', '2026-01-01', 'owner', 'r'), ('NSE:BAD', '2026-01-01', 'owner', 'r'), ('NSE:THIN', '2026-01-01', 'owner', 'r')`);
  const [u] = await db.query<{ id: string }>(`insert into screener_uploads (as_of, filename, source) values ('2026-08-20', 'q.csv', 'screener-in') returning id`);
  await db.query(`insert into fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, red_flags, as_of) values
    ($1, 'NSE:GOOD', '{}', 25, 0.2, 0, '2026-08-20'),
    ($1, 'NSE:BAD', '{}', 8, 2.5, 1, '2026-08-20'),
    ($1, 'NSE:NEW', '{}', 30, 0.1, 0, '2026-08-20')`, [u!.id]);
});

describe('when it runs', () => {
  it('runs on the first weekday on or after the 20th of Feb, May, Aug and Nov', () => {
    expect(isRevisionDay('2026-11-20')).toBe(true);   // Friday
    expect(isRevisionDay('2026-02-20')).toBe(true);   // Friday
    expect(isRevisionDay('2027-02-20')).toBe(false);  // Saturday
    expect(isRevisionDay('2027-02-22')).toBe(true);   // the Monday after
    expect(isRevisionDay('2026-10-20')).toBe(false);  // not a revision month
    expect(isRevisionDay('2026-11-23')).toBe(false);  // already ran on the 20th
  });
});

describe('what it proposes', () => {
  it('removes a watched name that failed the quality gate, and never one it cannot judge', async () => {
    const r = await removalCandidates(db);
    expect(r.map((x) => x.instrumentId)).toEqual(['NSE:BAD']);
    expect(r[0]!.reason).toMatch(/ROCE 8/);
    await db.close();
  });

  it('proposes once per quarter, with additions only from screened names not already watched', async () => {
    const reply = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ picks: [{ instrumentId: 'NSE:NEW', reason: 'durable' }] }) } }] }) })) as unknown as typeof fetch;
    const first = await proposeRevision(db, { asOf: '2026-11-20', apiKey: 'k', fetchImpl: reply });
    const again = await proposeRevision(db, { asOf: '2026-11-25', apiKey: 'k', fetchImpl: reply });
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    const [p] = await loadProposals(db, 'WATCHLIST_REVISION');
    const lines = (p!.payload as { lines: { op: string; instrumentId: string }[] }).lines;
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'ADD', instrumentId: 'NSE:NEW' }),
      expect.objectContaining({ op: 'REMOVE', instrumentId: 'NSE:BAD' }),
    ]));
    await db.close();
  });
});

describe('signing line by line', () => {
  it('applies only accepted lines; a removal is an event the effective view honours', async () => {
    const reply = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ picks: [{ instrumentId: 'NSE:NEW', reason: 'durable' }] }) } }] }) })) as unknown as typeof fetch;
    const id = (await proposeRevision(db, { asOf: '2026-11-20', apiKey: 'k', fetchImpl: reply }))!;
    const lines = ((await loadProposals(db, 'WATCHLIST_REVISION'))[0]!.payload as { lines: { op: string }[] }).lines;
    const add = lines.findIndex((l) => l.op === 'ADD');
    const remove = lines.findIndex((l) => l.op === 'REMOVE');
    await decideWatchlistLine(db, id, remove, true, '2026-11-21');
    await decideWatchlistLine(db, id, add, false, '2026-11-21');
    const live = await db.query<{ instrument_id: string }>(`select instrument_id from watchlist_effective where removed_on is null order by 1`);
    expect(live.map((r) => r.instrument_id)).toEqual(['NSE:GOOD', 'NSE:THIN']);
    await expect(decideWatchlistLine(db, id, remove, true, '2026-11-21')).rejects.toThrow(/already/);
    expect((await loadProposals(db, 'WATCHLIST_REVISION'))[0]!.status).toBe('SIGNED');
    await db.close();
  });
});
