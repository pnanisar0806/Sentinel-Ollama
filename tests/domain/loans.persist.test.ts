import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('persistSchedules', () => {
  it('stores both NATURAL and CASCADE scenarios and replaces on re-run', async () => {
    await persistSchedules(db, '2026-09-01');
    const scenarios = await db.query<{ scenario: string }>(
      'select distinct scenario from loan_schedule order by scenario',
    );
    expect(scenarios.map((s) => s.scenario)).toEqual(['CASCADE', 'NATURAL']);

    const before = Number(
      (await db.query<{ n: string }>('select count(*) as n from loan_schedule'))[0]!.n,
    );
    await persistSchedules(db, '2026-09-01');
    const after = Number(
      (await db.query<{ n: string }>('select count(*) as n from loan_schedule'))[0]!.n,
    );
    expect(after).toBe(before);
  });
});
