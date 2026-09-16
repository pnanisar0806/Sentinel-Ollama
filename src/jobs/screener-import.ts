import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { importScreener } from '../sources/screener.js';
import { fetchScreen, importScreenRows, parseScreenPaste } from '../sources/screener-screen.js';
import { readFileSync } from 'node:fs';
import { isMainModule } from '../util/main-module.js';

/** This job imports screener.in data — either from a CSV file or a live screen URL. */
export const ENV_PURPOSES: Purpose[] = [];

/** Import from a screener.in CSV file (legacy path). */
export async function screenerImportCsv(
  db: Db,
  csvPath: string,
  opts: { asOf?: string; filename?: string } = {},
): Promise<{ uploadedId: number; inserted: number; createdInstruments: number; warnings: string[] }> {
  const csvText = readFileSync(csvPath, 'utf8');
  const result = await importScreener(db, csvText, opts);
  // The legacy CSV spec is unverified against a real export; it never promotes.
  return { ...result, createdInstruments: 0 };
}

/** Import by scraping a screener.in screen URL (HTML). */
export async function screenerImportScreen(
  db: Db,
  screenUrl: string,
  opts: { asOf?: string; maxPages?: number } = {},
): Promise<{ uploadedId: number; inserted: number; createdInstruments: number; warnings: string[] }> {
  const result = await fetchScreen(screenUrl, { maxPages: opts.maxPages ?? 100 });
  const importResult = await importScreenRows(db, result.rows, {
    ...(opts.asOf !== undefined ? { asOf: opts.asOf } : {}),
    screenUrl,
  });
  return {
    ...importResult,
    warnings: [...result.warnings, ...importResult.warnings],
  };
}

/** Import a pasted screen table or the signed-in CSV export (tab- or comma-separated). */
export async function screenerImportPaste(
  db: Db,
  text: string,
  opts: { asOf?: string; filename?: string } = {},
): Promise<{ uploadedId: number; inserted: number; createdInstruments: number; warnings: string[] }> {
  const { rows, warnings } = parseScreenPaste(text);
  // Paste rows carry no slug, so resolution is name-only and nothing is ever
  // created from a paste. The filename keys idempotency (re-pasting the same
  // export on the same as-of replaces that upload).
  const importResult = await importScreenRows(db, rows, {
    ...(opts.asOf !== undefined ? { asOf: opts.asOf } : {}),
    screenUrl: opts.filename ?? 'screener-paste',
  });
  return { ...importResult, warnings: [...warnings, ...importResult.warnings] };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage:');
    console.error('  pnpm screener:import <csv-path> [--as-of=YYYY-MM-DD]');
    console.error('  pnpm screener:import --screen <screen-url> [--as-of=YYYY-MM-DD] [--pages=N]');
    console.error('  pnpm screener:import --paste <pasted-table-file> [--as-of=YYYY-MM-DD]');
    process.exit(1);
  }

  const isScreen = args.includes('--screen');
  const isPaste = args.includes('--paste');
  const positional = args.filter(a => !a.startsWith('--'));

  const asOfArg = args.find(a => a.startsWith('--as-of='));
  const asOf = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);

  const pagesArg = args.find(a => a.startsWith('--pages='));
  const maxPages = pagesArg ? Number(pagesArg.split('=')[1]) : 100;

  const env = loadEnv(process.env, ENV_PURPOSES);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

  try {
    const asOfFinal: string = asOf ?? new Date().toISOString().slice(0, 10);
    let result;
    if (isPaste) {
      const pastePath = positional[0];
      if (!pastePath) {
        console.error('Error: --paste requires a file path argument');
        process.exit(1);
      }
      const text = readFileSync(pastePath, 'utf8');
      const filename = pastePath.includes('/') || pastePath.includes('\\')
        ? pastePath.split(/[\\/]/).pop()!
        : pastePath;
      result = await screenerImportPaste(db, text, { asOf: asOfFinal, filename: `screener-paste:${filename}` });
    } else if (isScreen) {
      const screenUrl = positional[0];
      if (!screenUrl) {
        console.error('Error: --screen requires a URL argument');
        process.exit(1);
      }
      console.log(`Fetching screen: ${screenUrl}`);
      result = await screenerImportScreen(db, screenUrl, { asOf: asOfFinal, maxPages });
      if (result.createdInstruments > 0) {
        console.log(`Promoted ${result.createdInstruments} new companies into the instruments universe`);
      }
    } else {
      const csvPath = positional[0];
      if (!csvPath) {
        console.error('Error: provide a CSV file path or use --screen <url>');
        process.exit(1);
      }
      result = await screenerImportCsv(db, csvPath, { asOf: asOfFinal });
    }
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
