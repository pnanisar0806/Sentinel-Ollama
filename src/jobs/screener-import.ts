import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { importScreener } from '../sources/screener.js';
import { readFileSync } from 'node:fs';
import { isMainModule } from '../util/main-module.js';

/** This job reads a screener.in CSV file and imports it. */
export const ENV_PURPOSES: Purpose[] = [];

export async function screenerImport(
  db: Db,
  csvPath: string,
  opts: { asOf?: string; filename?: string } = {}
): Promise<{ uploadedId: number; inserted: number; warnings: string[] }> {
  const csvText = readFileSync(csvPath, 'utf8');
  return importScreener(db, csvText, opts);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: pnpm screener:import <csv-path> [--as-of YYYY-MM-DD]');
    process.exit(1);
  }

  const csvPath = args[0];
  const asOfArg = args.find(a => a.startsWith('--as-of='));
  const asOf = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);

  const env = loadEnv(process.env, ENV_PURPOSES);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

try {
    const asOfFinal: string = asOf ?? new Date().toISOString().slice(0, 10);
    // @ts-ignore - importScreener types not resolved correctly due to verbatimModuleSyntax
    const result = await importScreener(db, csvPath, { asOf: asOfFinal });
    console.log(`Imported ${result.inserted} records into upload ${result.uploadedId}`);
    if (result.warnings.length) {
      console.warn('Warnings:', result.warnings.join('; '));
    }
  } catch (e) {
    console.error('Import failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await db.close();
  }
}