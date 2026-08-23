import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

/**
 * PRD hard constraint: audit immutability is enforced by triggers (UPDATE, DELETE
 * AND TRUNCATE) plus RLS. The branch shipped triggers on 2 of the tables that need
 * them: `update ips_versions`, `delete from bucket_flows` and `delete from lots`
 * were all allowed. ips_versions holds the text shown to the owner at a -20%
 * drawdown; bucket_flows is a signed money ledger; lots is the FIFO cost basis.
 */
const APPEND_ONLY = [
  // A no-op UPDATE still fires a `for each statement` trigger, so these assertions
  // do not depend on fixture rows — but the column has to exist, or the planner
  // errors before the trigger ever runs.
  { table: 'audit_log', column: 'actor' },
  { table: 'snapshots', column: 'source' },
  { table: 'ips_versions', column: 'diff' },
  { table: 'bucket_flows', column: 'note' },
] as const;

describe('append-only tables refuse every mutation path', () => {
  it.each(APPEND_ONLY)('$table refuses UPDATE, DELETE and TRUNCATE', async ({ table, column }) => {
    await expect(db.query(`update ${table} set ${column} = ${column}`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from ${table}`)).rejects.toThrow(/append-only/);
    // CASCADE so the FK check does not error first: a referenced table refuses
    // TRUNCATE on FK grounds, which would hide whether the trigger fires at all.
    await expect(db.query(`truncate ${table} cascade`)).rejects.toThrow(/append-only/);
  });

  it('covers every table the PRD calls an audit surface', () => {
    // Guards against a table being added to the schema and quietly left unprotected.
    expect(new Set(APPEND_ONLY.map((t) => t.table))).toEqual(
      new Set(['audit_log', 'snapshots', 'ips_versions', 'bucket_flows']),
    );
  });
});

describe('lots is immutable except for its disposal marker', () => {
  const insertLot = () =>
    db.query<{ id: string }>(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, as_of, source)
       values ('NSE:NIFTYBEES','zerodha','2026-01-01',10,100000,now(),'manual-seed')
       returning id`,
    );

  beforeEach(async () => {
    await db.query(
      `insert into instruments (id, kind, name, currency)
       values ('NSE:NIFTYBEES','ETF','Nippon Nifty BeES','INR')`,
    );
  });

  it('allows closing a lot — that is the FIFO disposal lifecycle', async () => {
    const [lot] = await insertLot();
    await expect(
      db.query('update lots set closed_on = $1 where id = $2', ['2026-06-01', lot!.id]),
    ).resolves.toBeDefined();
  });

  it('refuses to rewrite cost basis, quantity or acquisition date', async () => {
    const [lot] = await insertLot();
    await expect(
      db.query('update lots set cost_paise = 1 where id = $1', [lot!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query('update lots set quantity = 1 where id = $1', [lot!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query('update lots set acquired_on = $1 where id = $2', ['2020-01-01', lot!.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses DELETE and TRUNCATE outright', async () => {
    await insertLot();
    await expect(db.query('delete from lots')).rejects.toThrow(/immutable|append-only/);
    await expect(db.query('truncate lots')).rejects.toThrow(/immutable|append-only/);
  });
});

describe('row level security', () => {
  /**
   * The PRD constraint is triggers PLUS RLS in Supabase. Migrations are the only
   * path to Supabase, and RLS appeared in exactly one comment — so it would never
   * have been applied. Enabling with no policy denies anon/authenticated outright;
   * the service role the jobs use bypasses RLS.
   */
  it('is enabled on every table in the schema', async () => {
    const rows = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
        where schemaname = 'public' and tablename <> 'schema_migrations'`,
    );
    expect(rows.length).toBeGreaterThan(15);
    const unprotected = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    expect(unprotected).toEqual([]);
  });
});
