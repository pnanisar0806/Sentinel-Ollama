import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

let db: Db;
beforeAll(async () => {
  db = await openDb();
  await runMigrations(db);
});

const REQUIRED_TABLES = [
  'instruments', 'snapshots', 'holdings', 'lots', 'buckets', 'bucket_flows',
  'milestones', 'rsu_grants', 'rsu_vests', 'loans', 'loan_schedule',
  'ips_versions', 'fx_rates', 'incidents', 'settings_rails', 'audit_log',
];

describe('phase 0 schema', () => {
  it('creates every required table', async () => {
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of REQUIRED_TABLES) expect(names).toContain(t);
  });

  it('refuses updates and deletes on audit_log', async () => {
    await db.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('test', '1', 'CREATED', 'agent', '{}'::jsonb)`,
    );
    await expect(db.query(`update audit_log set action = 'X'`)).rejects.toThrow();
    await expect(db.query(`delete from audit_log`)).rejects.toThrow();
    await expect(db.query(`truncate audit_log`)).rejects.toThrow();
  });

  it('refuses truncate on snapshots', async () => {
    await expect(db.query(`truncate snapshots`)).rejects.toThrow();
  });

  it('requires as_of and source on every holdings row', async () => {
    // Create test fixtures: a real snapshot and instrument
    const [snapshot] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ('2026-08-12', 'test')
       returning id`,
    );
    await db.query(
      `insert into instruments (id, kind, name) values ('TEST:INST', 'EQUITY', 'Test Instrument')`,
    );

    // Test that omitting as_of fails
    await expect(
      db.query(
        `insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, source)
         values ($1, 'TEST:INST', 1.0, 1000, 'test', 'test')`,
        [snapshot!.id],
      ),
    ).rejects.toThrow();

    // Test that omitting source fails
    await expect(
      db.query(
        `insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of)
         values ($1, 'TEST:INST', 1.0, 1000, 'test', now())`,
        [snapshot!.id],
      ),
    ).rejects.toThrow();

    // Test that including both succeeds
    await expect(
      db.query(
        `insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
         values ($1, 'TEST:INST', 1.0, 1000, 'test', now(), 'test')`,
        [snapshot!.id],
      ),
    ).resolves.toBeDefined();
  });

  it('stores money as bigint paise without precision loss', async () => {
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source)
       values ('USDINR', '2026-08-12', 95300000, 'seed')`,
    );
    const [row] = await db.query<{ rate_micros: string }>(
      `select rate_micros from fx_rates where pair = 'USDINR'`,
    );
    expect(String(row!.rate_micros)).toBe('95300000');
  });
});
