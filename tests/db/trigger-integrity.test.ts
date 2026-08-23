import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Review item 36: the guard function is declared `create or replace`, so a later
 * migration could redefine `sentinel_append_only()` as a no-op and every append-only
 * table on the branch would silently start accepting UPDATE and DELETE. The triggers
 * would still be listed in pg_trigger, and the schema tests that only probe for
 * trigger existence would stay green.
 */
describe('the append-only guard cannot be quietly replaced', () => {
  it('is defined exactly once across all migrations', () => {
    const defs = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => {
        const text = readFileSync(migrationsDir + f, 'utf8');
        return [...text.matchAll(/create\s+(or\s+replace\s+)?function\s+sentinel_append_only/gi)]
          .map(() => f);
      });
    expect(defs).toHaveLength(1);
  });

  it('defines the lots guard exactly once too', () => {
    // Same hazard, same protection. `create or replace` on a guard function means a
    // later migration can neuter it without touching a single trigger.
    const defs = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => [
        ...readFileSync(migrationsDir + f, 'utf8')
          .matchAll(/create\s+(?:or\s+replace\s+)?function\s+sentinel_lots_immutable/gi),
      ].map(() => f));
    expect(defs).toHaveLength(1);
  });

  it('still raises — behaviour, not just presence', async () => {
    // The existence check above is structural. This one proves the function a live
    // database actually holds refuses the write, which is what the guarantee means.
    await expect(db.query('delete from audit_log')).rejects.toThrow(/append-only/);
  });

  it('every append-only trigger is present in pg_trigger', async () => {
    const rows = await db.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal order by tgname`,
    );
    const names = rows.map((r) => r.tgname);
    for (const expected of [
      'audit_log_append_only', 'audit_log_truncate_only',
      'snapshots_append_only', 'snapshots_truncate_only',
      'ips_versions_append_only', 'ips_versions_truncate_only',
      'bucket_flows_append_only', 'bucket_flows_truncate_only',
      'lots_immutable_update', 'lots_immutable_delete', 'lots_truncate_only',
    ]) {
      expect(names).toContain(expected);
    }
  });
});
