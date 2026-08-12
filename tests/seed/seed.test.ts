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
