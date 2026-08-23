import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { installIps, currentIps, IPS_V1_TEXT } from '../../src/domain/ips.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const versions = () =>
  db.query<{ version: number }>('select version from ips_versions order by version');
const auditRows = () =>
  db.query<{ entity_id: string }>("select entity_id from audit_log where entity = 'ips'");

/**
 * Review item 28. The two inserts ran unwrapped, and `audit_log` refuses UPDATE — and
 * since migration 0004 `ips_versions` refuses UPDATE and DELETE too. So a failure
 * between them left an IPS version with no audit row that can never be corrected: not
 * back-filled in place, not removed. This is the text shown to the owner at a -20%
 * drawdown, so its provenance record has to be all-or-nothing.
 */
describe('installIps is atomic', () => {
  it('writes the version and its audit row together', async () => {
    const { version, created } = await installIps(db);
    expect(created).toBe(true);
    expect((await versions()).map((v) => Number(v.version))).toEqual([version]);
    expect((await auditRows()).map((a) => a.entity_id)).toEqual([String(version)]);
  });

  it('leaves no version behind when the audit insert fails', async () => {
    const breakOn = (inner: Db): Db => ({
      ...inner,
      query: async (sql: string, params?: unknown[]) => {
        if (/insert into audit_log/i.test(sql)) throw new Error('audit write failed');
        return inner.query(sql, params);
      },
      withTransaction: (fn) => inner.withTransaction((tx) => fn(breakOn(tx))),
    });

    await expect(installIps(breakOn(db))).rejects.toThrow(/audit write failed/);

    // Neither row survives. An orphaned version could never be cleaned up: ips_versions
    // is append-only, so there is no DELETE available to fix it afterwards.
    expect(await versions()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });
});

describe('installIps is idempotent', () => {
  it('does not create a second version for unchanged text', async () => {
    const first = await installIps(db);
    const second = await installIps(db);

    expect(second.created).toBe(false);
    expect(second.version).toBe(first.version);
    expect(await versions()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('survives a concurrent install rather than colliding on the version number', async () => {
    // Every job start calls installIps. Two jobs starting together both read the same
    // tip and both compute version = N + 1, which is a primary key collision.
    const results = await Promise.allSettled([installIps(db), installIps(db)]);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
    expect(await versions()).toHaveLength(1);
  });

  it('creates a new version when the text genuinely changes', async () => {
    await installIps(db);
    await db.query(
      `insert into ips_versions (version, full_text, effective_at)
       values (2, 'amended policy text', now())`,
    );
    const back = await installIps(db);
    expect(back.created).toBe(true);
    expect(back.version).toBe(3);
    expect((await currentIps(db)).fullText).toBe(IPS_V1_TEXT);
  });
});
