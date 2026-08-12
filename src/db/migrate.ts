import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';
import { openDb } from './client.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Applies every unapplied .sql file in name order. Returns names newly applied. */
export async function runMigrations(db: Db, dir = DEFAULT_DIR): Promise<string[]> {
  await db.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now())`,
  );

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    // Wrap migration apply + bookkeeping in a transaction for atomicity
    await db.exec('begin');
    try {
      await db.exec(sql);
      await db.query('insert into schema_migrations (name) values ($1)', [file]);
      await db.exec('commit');
      newlyApplied.push(file);
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  }
  return newlyApplied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await openDb();
  try {
    const applied = await runMigrations(db);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  } finally {
    await db.close();
  }
}
