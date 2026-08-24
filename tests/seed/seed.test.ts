import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const count = async (t: string) =>
  Number((await db.query<{ n: string }>(`select count(*) as n from ${t}`))[0]!.n);

describe('seed job', () => {
  it('writes instruments, holdings, loans, buckets, milestones and grants', async () => {
    await seed(db, { asOf: '2026-08-12' });
    expect(await count('instruments')).toBeGreaterThan(15);
    expect(await count('holdings')).toBeGreaterThan(15);
    expect(await count('loans')).toBe(3);
    expect(await count('buckets')).toBe(4);
    expect(await count('milestones')).toBe(2);
    expect(await count('rsu_grants')).toBe(6);
  });

  // The isin column exists in the schema but went unwritten until the bonds were verified.
  // Task 11B's INDmoney mapper matches on ISIN, so an unpopulated column would surface as a
  // silent mapping miss there rather than as a failure here.
  it('persists ISINs for the instruments that declare one', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const rows = await db.query<{ id: string; isin: string | null }>(
      'select id, isin from instruments where isin is not null order by id',
    );
    expect(rows.map((r) => [r.id, r.isin])).toEqual([
      ['BOND:EDELWEISS-2033', 'INE532F07EK1'],
      ['BOND:SAMMAAN-2026', 'INE148I07GL3'],
      ['BOND:SAMMAAN-2029', 'INE148I07TX1'],
    ]);
  });

  it('re-seeding updates ISIN in place rather than leaving it stale', async () => {
    await seed(db, { asOf: '2026-08-12' });
    await db.query(`update instruments set isin = 'WRONG' where id = 'BOND:SAMMAAN-2026'`);
    await seed(db, { asOf: '2026-08-12' });
    const [row] = await db.query<{ isin: string }>(
      `select isin from instruments where id = 'BOND:SAMMAAN-2026'`,
    );
    expect(row!.isin).toBe('INE148I07GL3');
  });

  it('is idempotent - re-seeding does not duplicate holdings', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const before = await count('holdings');
    await seed(db, { asOf: '2026-08-12' });
    expect(await count('holdings')).toBe(before);
  });

  it('records the seeding in the audit log', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const rows = await db.query<{ action: string; actor: string }>(
      `select action, actor from audit_log where entity = 'seed'`,
    );
    expect(rows[0]).toMatchObject({ action: 'SEEDED', actor: 'system' });
  });
});
