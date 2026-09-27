import { openDb } from '../db/client.js';
import { recordNews } from '../sources/news.js';
import { isMainModule } from '../util/main-module.js';

/**
 * On-demand recovery for the daily news step in sync.ts (same function, wider window):
 * `pnpm news -- --days=90` backfills after an outage. Not scheduled separately.
 */
if (isMainModule(import.meta.url)) {
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30);
  const db = await openDb();
  const r = await recordNews(db, { days });
  console.log(`news: ${r.stored} new material event(s), ${r.companies} companies, ${r.failed} failed, ${r.unresolved} unresolved`);
  await db.close();
}
