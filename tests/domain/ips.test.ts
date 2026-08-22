import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { currentIps, installIps, ipsClause, IPS_V1_TEXT } from '../../src/domain/ips.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('IPS v1', () => {
  it('carries every clause 3.1 through 3.10', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(IPS_V1_TEXT).toContain(`## 3.${n} `);
    }
  });

  it('states the never-events verbatim', () => {
    expect(IPS_V1_TEXT).toMatch(/F&O/);
    expect(IPS_V1_TEXT).toMatch(/leverage/i);
    expect(IPS_V1_TEXT).toMatch(/default action is no action/);
  });

  it('installs as version 1 and is idempotent for identical text', async () => {
    expect(await installIps(db)).toEqual({ version: 1, created: true });
    expect(await installIps(db)).toEqual({ version: 1, created: false });
    const rows = await db.query<{ n: string }>('select count(*) as n from ips_versions');
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('returns the current version with its effective date', async () => {
    await installIps(db, { effectiveAt: '2026-08-12T00:00:00+05:30' });
    const ips = await currentIps(db);
    expect(ips.version).toBe(1);
    expect(ips.fullText).toBe(IPS_V1_TEXT);
  });

  it('extracts a single clause for recommendation citations', () => {
    const clause = ipsClause(IPS_V1_TEXT, '3.5');
    expect(clause).toMatch(/single stock/i);
    expect(clause).not.toMatch(/## 3\.6/);
  });

  it('throws on an unknown clause rather than citing nothing', () => {
    expect(() => ipsClause(IPS_V1_TEXT, '3.99')).toThrow(/3\.99/);
  });
});