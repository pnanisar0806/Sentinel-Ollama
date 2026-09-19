import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// 0008 and 0009 each carry two migrations. Both pairs are order-independent --
// neither member depends on the other, both need only `instruments` from 0001 --
// and renaming a migration that has already been applied makes it read as
// unapplied and re-run, so these names stay. New collisions are not allowed:
// runMigrations sorts on the whole filename, so a duplicate prefix hands the
// ordering to whatever follows the underscore.
const LEGACY_DUPLICATE_PREFIXES = new Set(['0008', '0009']);

async function migrationPrefixes(): Promise<Map<string, string[]>> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = file.slice(0, 4);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  return byPrefix;
}

describe('migration numbering', () => {
  it('has no duplicate prefixes beyond the documented legacy pairs', async () => {
    const collisions = [...(await migrationPrefixes())]
      .filter(([prefix, files]) => files.length > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix))
      .map(([, files]) => files.join(' + '));
    expect(collisions).toEqual([]);
  });

  it('keeps the legacy exception list honest', async () => {
    const byPrefix = await migrationPrefixes();
    for (const prefix of LEGACY_DUPLICATE_PREFIXES) {
      // If a legacy pair is ever renumbered, drop it from the set rather than
      // leaving a stale exemption that would hide a fresh collision.
      expect(byPrefix.get(prefix)?.length, `prefix ${prefix}`).toBe(2);
    }
  });
});

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

  it('applies multi-statement migration files', async () => {
    const db = await openDb();
    await runMigrations(db);
    const tempDir = await mkdtemp(join(tmpdir(), 'sentinel-test-'));
    const migrationFile = join(tempDir, '0001_multi.sql');
    await writeFile(
      migrationFile,
      `create table multi_a (id int primary key);
create table multi_b (id int primary key);
insert into multi_a values (42);`,
    );
    const applied = await runMigrations(db, tempDir);
    expect(applied).toContain('0001_multi.sql');
    const rowsA = await db.query<{ id: number }>('select id from multi_a');
    const rowsB = await db.query<{ id: number }>('select id from multi_b');
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.id).toBe(42);
    expect(rowsB).toHaveLength(0);
    await db.close();
  });

  it('does not record a migration if it fails', async () => {
    const db = await openDb();
    await runMigrations(db);
    const tempDir = await mkdtemp(join(tmpdir(), 'sentinel-test-'));
    const migrationFile = join(tempDir, '0002_invalid.sql');
    await writeFile(migrationFile, 'select * from nonexistent_table; create table valid_table (id int);');
    await expect(runMigrations(db, tempDir)).rejects.toThrow();
    const recorded = await db.query<{ name: string }>(
      "select name from schema_migrations where name = '0002_invalid.sql'",
    );
    expect(recorded).toHaveLength(0);
    await db.close();
  });

  it('withTransaction rolls back on error and propagates rejection', async () => {
    const db = await openDb();
    await runMigrations(db);
    const error = new Error('intentional test error');
    await expect(
      db.withTransaction(async (tx) => {
        await tx.exec('create table tx_test (id int primary key)');
        await tx.query('insert into tx_test values ($1)', [42]);
        throw error;
      }),
    ).rejects.toBe(error);
    // Verify table does not exist (rollback worked)
    await expect(db.query('select * from tx_test')).rejects.toThrow();
    await db.close();
  });
});
