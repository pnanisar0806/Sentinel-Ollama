import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

describe('migration runner', () => {
  it('applies migrations once and is idempotent', async () => {
    const db = await openDb();
    const first = await runMigrations(db);
    expect(first).toContain('0000_bootstrap.sql');

    const second = await runMigrations(db);
    expect(second).toEqual([]);

    const rows = await db.query<{ name: string }>(
      'select name from schema_migrations order by name',
    );
    expect(rows.map((r) => r.name)).toContain('0000_bootstrap.sql');
    await db.close();
  });

  it('round-trips parameters and bigint columns', async () => {
    const db = await openDb();
    await runMigrations(db);
    await db.query('create table t (id int primary key, amount bigint)');
    await db.query('insert into t values ($1, $2)', [1, '123456789012']);
    const rows = await db.query<{ amount: string }>('select amount from t where id = $1', [1]);
    expect(String(rows[0]!.amount)).toBe('123456789012');
    await db.close();
  });
});
