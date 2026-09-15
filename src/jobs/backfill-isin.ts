import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { backfillInstrumentIsins, downloadEquityMaster } from '../sources/bhavcopy.js';
import { isMainModule } from '../util/main-module.js';
import type { Purpose } from '../config/env.js';

/** Reads only DATABASE_URL. No secrets, no external messaging. */
export const ENV_PURPOSES: Purpose[] = [];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ENV_PURPOSES);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

  const { rows: master, report } = await downloadEquityMaster();
  console.log(`equity master: ${report.totalRows} EQ symbols from ${report.date}`);

  const { filled } = await backfillInstrumentIsins(db, master);
  console.log(`backfilled ISIN: ${filled} instruments updated`);

  await db.close();
}