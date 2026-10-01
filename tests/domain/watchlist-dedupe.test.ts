import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { recordProposal } from '../../src/advisor/proposals.js';
import { decideWatchlistLine } from '../../src/domain/watchlist-signoff.js';
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

  /**
   * The only way a name now joins the watchlist: the owner accepts an ADD line of a
   * quarterly revision (the manual `watchlist:propose` that wrote straight in was retired
   * 2026-10-01). Returns how many live rows the acceptance added.
   */
  const acceptAdd = async (instrumentId: string, on: string): Promise<number> => {
    const before = await db.query(`select 1 from watchlist where instrument_id = $1`, [instrumentId]);
    const id = await recordProposal(db, {
      kind: 'WATCHLIST_REVISION', payload: { quarter: `q-${Math.random()}`, lines: [{ op: 'ADD', instrumentId, name: instrumentId, reason: 'r' }] },
      inputSnapshot: {}, evidenceIds: [], model: null, promptVersion: 'p', schemaVersion: 's', asOf: `${on}T00:00:00Z`,
    });
    await decideWatchlistLine(db, id, 0, true, on);
    const after = await db.query(`select 1 from watchlist where instrument_id = $1`, [instrumentId]);
    return after.length - before.length;
  };

  const live = async () => {
    const rows = await db.query<{ n: string }>(
      `select count(*) as n from watchlist
        where instrument_id = 'NSE:X' and removed_on is null`,
    );
    return Number(rows[0]!.n);
  };

  it('refuses an accepted add for a name with a live row, on a later date', async () => {
    const written = await acceptAdd('NSE:X', '2026-09-16');
    expect(written).toBe(0);
    expect(await live()).toBe(1);
    await db.close();
  });

  it('still refuses a same-day re-add', async () => {
    await acceptAdd('NSE:X', '2026-01-15');
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
    const written = await acceptAdd('NSE:Y', '2026-09-16');
    // A re-add after a removal is a real decision, not a duplicate.
    expect(written).toBe(1);
    await db.close();
  });

  it('accepts a genuinely new name', async () => {
    await db.query(
      `insert into instruments (id, kind, name, currency)
       values ('NSE:Z', 'EQUITY', 'Z Ltd', 'INR') on conflict (id) do nothing`,
    );
    const written = await acceptAdd('NSE:Z', '2026-09-16');
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
