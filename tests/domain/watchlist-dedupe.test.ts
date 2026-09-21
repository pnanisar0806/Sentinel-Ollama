import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { applyWatchlistProposals } from '../../src/sources/llm-watchlist.js';
import { loadEngineInputs } from '../../src/domain/engine.js';

/**
 * Production carried 80 live watchlist rows for 73 instruments. `watchlist`'s primary
 * key is `(instrument_id, added_on)`, so the proposer's `on conflict do nothing` caught
 * only a same-day re-add; on any later date `llm-advisor` inserted a second live row for
 * a name `advisor` already watched. `loadEngineInputs` then scored those seven names
 * twice, which double-weights them in any ranking and can put one instrument in front of
 * the owner as two separate ideas.
 *
 * `watchlist` is append-only, so the duplicate rows already written cannot be removed.
 * Both ends are fixed: the proposer stops creating them, and the engine scores each
 * instrument once regardless of what the table holds.
 */
describe('a name already watched is not watched twice', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency)
       values ('NSE:X', 'EQUITY', 'X Ltd', 'INR') on conflict (id) do nothing`,
    );
    await db.query(
      `insert into watchlist (instrument_id, added_on, source, reason)
       values ('NSE:X', date '2026-01-15', 'advisor', 'owner pick')`,
    );
  });

  const live = async () => {
    const rows = await db.query<{ n: string }>(
      `select count(*) as n from watchlist
        where instrument_id = 'NSE:X' and removed_on is null`,
    );
    return Number(rows[0]!.n);
  };

  it('refuses a proposal for a name with a live row, on a later date', async () => {
    const written = await applyWatchlistProposals(
      db, [{ instrumentId: 'NSE:X', reason: 'llm likes it' } as never], '2026-09-16',
    );
    expect(written).toBe(0);
    expect(await live()).toBe(1);
    await db.close();
  });

  it('still refuses a same-day re-add', async () => {
    await applyWatchlistProposals(
      db, [{ instrumentId: 'NSE:X', reason: 'again' } as never], '2026-01-15',
    );
    expect(await live()).toBe(1);
    await db.close();
  });

  it('accepts a name that was watched and then removed', async () => {
    await db.query(
      `insert into instruments (id, kind, name, currency)
       values ('NSE:Y', 'EQUITY', 'Y Ltd', 'INR') on conflict (id) do nothing`,
    );
    await db.query(
      `insert into watchlist (instrument_id, added_on, removed_on, source, reason)
       values ('NSE:Y', date '2025-01-01', date '2025-06-01', 'advisor', 'dropped')`,
    );
    const written = await applyWatchlistProposals(
      db, [{ instrumentId: 'NSE:Y', reason: 'back in favour' } as never], '2026-09-16',
    );
    // A re-add after a removal is a real decision, not a duplicate.
    expect(written).toBe(1);
    await db.close();
  });

  it('accepts a genuinely new name', async () => {
    await db.query(
      `insert into instruments (id, kind, name, currency)
       values ('NSE:Z', 'EQUITY', 'Z Ltd', 'INR') on conflict (id) do nothing`,
    );
    const written = await applyWatchlistProposals(
      db, [{ instrumentId: 'NSE:Z', reason: 'new idea' } as never], '2026-09-16',
    );
    expect(written).toBe(1);
    await db.close();
  });

  it('scores an instrument once even when the table already holds two live rows', async () => {
    // The seven rows already in production cannot be deleted — the table is append-only.
    await db.query(
      `insert into watchlist (instrument_id, added_on, source, reason)
       values ('NSE:X', date '2026-09-16', 'llm-advisor', 'duplicate already written')`,
    );
    const inputs = await loadEngineInputs(db, '2026-09-21', { gsecYieldPct: 6.8 });
    const ids = inputs.candidates.map((c) => c.instrumentId);
    expect(ids.filter((v) => v === 'NSE:X')).toHaveLength(1);
    await db.close();
  });
});
