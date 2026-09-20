import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { alreadyCleanedUpFor, recordCleanupRun } from '../../src/jobs/cleanup.js';

/**
 * `pnpm cleanup` is newly scheduled, and `persistRecommendation` is a bare INSERT into
 * an append-only table: a second run on one business date writes duplicate advisory
 * rows that nothing can delete. Same guard and same reason as the weekly report's.
 */
describe('cleanup idempotence', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
  });

  it('reports not-yet-run before the first run', async () => {
    expect(await alreadyCleanedUpFor(db, '2026-09-20')).toBe(false);
    await db.close();
  });

  it('reports already-run once recorded, and keeps dates independent', async () => {
    await recordCleanupRun(db, '2026-09-20', 3);
    expect(await alreadyCleanedUpFor(db, '2026-09-20')).toBe(true);
    expect(await alreadyCleanedUpFor(db, '2026-09-21')).toBe(false);
    await db.close();
  });

  it('leaves an audit row carrying the date and how many persisted', async () => {
    await recordCleanupRun(db, '2026-09-20', 3);
    const [row] = await db.query<{ entity: string; actor: string; payload: unknown }>(
      "select entity, actor, payload from audit_log where entity = 'cleanup'",
    );
    expect(row).toMatchObject({ entity: 'cleanup', actor: 'agent' });
    // jsonb must arrive as an object, not a double-encoded JSON string.
    expect(row!.payload).toMatchObject({ asOf: '2026-09-20', persisted: 3 });
    await db.close();
  });
});
