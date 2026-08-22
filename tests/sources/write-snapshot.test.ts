import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import { writeSnapshot } from '../../src/sources/types.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('writeSnapshot', () => {
  it('upserts instruments it has never seen and writes holdings with as_of/source', async () => {
    const { rows, asOf } = await new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json').fetch();
    await writeSnapshot(db, 'indmoney', '2026-08-12', rows, asOf);

    const result = await db.query<{ n: string }>('select count(*) as n from instruments');
    expect(Number(result[0]!.n)).toBe(3);
    const holdings = await db.query<{ as_of: string; source: string }>(
      'select as_of, source from holdings',
    );
    expect(holdings).toHaveLength(3);
    expect(holdings.every((h) => h.source === 'indmoney')).toBe(true);
  });

  it('replaces the same source+date snapshot instead of double-counting', async () => {
    const { rows, asOf } = await new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json').fetch();
    await writeSnapshot(db, 'indmoney', '2026-08-12', rows, asOf);
    await writeSnapshot(db, 'indmoney', '2026-08-12', rows, asOf);
    const result = await db.query<{ n: string }>('select count(*) as n from holdings');
    expect(Number(result[0]!.n)).toBe(3);
  });
});