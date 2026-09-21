import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import {
  downloadBhavcopy, downloadIndexSeries, ingestPrices,
  type BhavcopyRow, type IndexBhavcopyRow,
} from '../sources/bhavcopy.js';
import { isTradingDay } from '../seed/seed-holidays.js';
import { isMainModule } from '../util/main-module.js';

/**
 * Backfills `prices_eod` and `index_prices_eod` over past trading days.
 *
 * `sync` writes one day, which is right for a daily job and useless as history. The
 * tables held four trading days and no index rows at all, so the satellite composite
 * scored 0 on trend for every name — the best candidate reached 39.8 against a MEDIUM
 * threshold of 70 and the recommender could not fire on anything. A 200-day moving
 * average needs 200 sessions on record; nothing but a backfill produces them.
 *
 * Nothing here is new ingest. `downloadBhavcopy`, `downloadIndexSeries` and
 * `ingestPrices` already exist and are what `sync` calls; this only drives them over a
 * range of dates.
 */
export interface BackfillReport {
  /** Days fetched this run. */
  fetched: string[];
  /** Days already complete on both tables, so not re-fetched. */
  skipped: string[];
  /** Days NSE served nothing for — almost always a holiday our calendar does not carry. */
  empty: string[];
  equityInserted: number;
  indexInserted: number;
}

export interface BackfillOptions {
  /** Most recent date to consider, inclusive. */
  endIso: string;
  /** How many trading days back to cover. */
  days: number;
  /** Politeness gap between days. This is a public archive, not a metered API. */
  pauseMs?: number;
  /** Injected in tests; production uses the two real downloaders. */
  fetchDay?: (dateIso: string) => Promise<{ equity: BhavcopyRow[]; index: IndexBhavcopyRow[] }>;
}

/** The `count` most recent trading days ending at `endIso`, newest first. */
export async function tradingDaysBack(db: Db, endIso: string, count: number): Promise<string[]> {
  const out: string[] = [];
  const cursor = new Date(`${endIso}T00:00:00Z`);
  // Trading days run ~69% of calendar days, so 3x plus a margin always reaches `count`
  // while still terminating if the holiday table ever marks a long stretch closed.
  for (let guard = 0; out.length < count && guard < count * 3 + 30; guard++) {
    const iso = cursor.toISOString().slice(0, 10);
    if (await isTradingDay(db, iso)) out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

/** Trade dates already carrying BOTH equity and index rows. */
async function completeDays(db: Db): Promise<Set<string>> {
  const rows = await db.query<{ d: string }>(
    `select trade_date::text as d from prices_eod
     intersect
     select trade_date::text as d from index_prices_eod`,
  );
  return new Set(rows.map((r) => r.d));
}

export async function backfillPrices(db: Db, opts: BackfillOptions): Promise<BackfillReport> {
  const fetchDay = opts.fetchDay ?? (async (dateIso: string) => {
    const [{ rows: equity }, { rows: index }] = await Promise.all([
      downloadBhavcopy(dateIso),
      downloadIndexSeries(dateIso),
    ]);
    return { equity, index };
  });
  const pauseMs = opts.pauseMs ?? 300;

  const report: BackfillReport = {
    fetched: [], skipped: [], empty: [], equityInserted: 0, indexInserted: 0,
  };
  const done = await completeDays(db);

  // Oldest first, so an interrupted run leaves a contiguous series rather than islands.
  const days = (await tradingDaysBack(db, opts.endIso, opts.days)).reverse();

  for (const day of days) {
    // A day with equity rows but no index rows is NOT complete — that is exactly the
    // state the tables were found in, and skipping on equity alone would preserve it.
    if (done.has(day)) { report.skipped.push(day); continue; }

    const { equity, index } = await fetchDay(day);
    if (equity.length === 0 && index.length === 0) {
      report.empty.push(day);
      continue;
    }

    // `as_of` is the session, not the moment of the backfill. Stamping these rows with
    // `now` would make FR-31 read the feed as fresh off a backfill alone, hiding a daily
    // sync that has stopped running.
    const ingested = await ingestPrices(db, equity, index, `${day}T12:00:00Z`);
    report.fetched.push(day);
    report.equityInserted += ingested.equityInserted;
    report.indexInserted += ingested.indexInserted;

    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return report;
}

/** Downloads only; needs DATABASE_URL and nothing else. */
export const ENV_PURPOSES: Purpose[] = [];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, []);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

  const arg = (name: string): string | undefined => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split('=')[1];
  };
  // 260 trading days is a year — enough for the 200DMA the trend leg needs, with slack.
  const days = Number(arg('days') ?? 260);
  const endIso = arg('end') ?? new Date().toISOString().slice(0, 10);

  const report = await backfillPrices(db, { endIso, days });
  console.log(
    `backfill: ${report.fetched.length} days fetched, ${report.skipped.length} already held, `
    + `${report.empty.length} served nothing`,
  );
  console.log(`  ${report.equityInserted} equity rows, ${report.indexInserted} index rows`);
  if (report.empty.length > 0) {
    console.log(`  no data (likely unlisted holidays): ${report.empty.join(', ')}`);
  }
  await db.close();
}
