import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { downloadNavHistory, ingestNavs, type NavRow } from '../sources/amfi.js';
import { isMainModule } from '../util/main-module.js';

/**
 * Backfills `navs` from AMFI's historical report.
 *
 * `sync` writes one day, which is right for a daily job and useless as history. The MF
 * consistency score — 40 of the 100 points in `rankMfs`, its single largest weight —
 * reads rolling 12-month NAV windows, and `consistencyRatio` returns 0 outright when
 * there are fewer points than the window. The table held four days, so every fund
 * scored 0 and MF ranking could not distinguish any two funds.
 *
 * AMFI serves the whole market per request and ignores `&sc=`, so a month costs one
 * ~15MB download whether we want one scheme or all of them. `ingestNavs` then keeps
 * only the schemes matching an instrument. Requests are therefore chunked by month, not
 * by fund.
 */
export interface NavBackfillReport {
  /** Month ranges fetched, as 'YYYY-MM'. */
  fetched: string[];
  /** Months already holding NAVs for every MF instrument, so not re-fetched. */
  skipped: string[];
  /** Months AMFI served no usable row for. */
  empty: string[];
  inserted: number;
}

export interface NavBackfillOptions {
  /** Most recent month to cover, 'YYYY-MM'. */
  endMonth: string;
  /** How many months back to cover, including `endMonth`. */
  months: number;
  pauseMs?: number;
  /** Injected in tests; production downloads the real report. */
  fetchMonth?: (fromDate: string, toDate: string) => Promise<NavRow[]>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** AMFI takes and returns `dd-MMM-yyyy`, never ISO. */
export function amfiDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

/** First and last day of a 'YYYY-MM', as ISO. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** `count` months ending at `endMonth`, oldest first. */
export function monthsBack(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Months that already hold at least one NAV for every MF instrument we track. */
async function coveredMonths(db: Db): Promise<Set<string>> {
  const [tracked] = await db.query<{ n: string }>(
    `select count(*) as n from instruments where kind = 'MF'
       and (isin is not null or scheme_code is not null)`,
  );
  const need = Number(tracked?.n ?? 0);
  if (need === 0) return new Set();
  const rows = await db.query<{ month: string }>(
    `select to_char(nav_date, 'YYYY-MM') as month
       from navs group by 1 having count(distinct instrument_id) >= $1`,
    [need],
  );
  return new Set(rows.map((r) => r.month));
}

export async function backfillNavs(
  db: Db,
  opts: NavBackfillOptions,
): Promise<NavBackfillReport> {
  const fetchMonth = opts.fetchMonth
    ?? (async (from: string, to: string) => (await downloadNavHistory(from, to)).rows);
  const pauseMs = opts.pauseMs ?? 1_000;

  const report: NavBackfillReport = { fetched: [], skipped: [], empty: [], inserted: 0 };
  const covered = await coveredMonths(db);

  for (const month of monthsBack(opts.endMonth, opts.months)) {
    if (covered.has(month)) { report.skipped.push(month); continue; }

    const { from, to } = monthBounds(month);
    const rows = await fetchMonth(amfiDate(from), amfiDate(to));
    if (rows.length === 0) { report.empty.push(month); continue; }

    // `as_of` is the month covered, not the moment of the backfill: stamping `now`
    // would let a backfill alone make FR-31 read a dead AMFI feed as fresh.
    const ingested = await ingestNavs(db, rows, `${to}T12:00:00Z`);
    report.fetched.push(month);
    report.inserted += ingested.inserted;

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

  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  // The consistency score needs 12 monthly points plus a window to roll over, so 24
  // months is the first depth at which it says anything. 30 leaves slack.
  const months = Number(arg('months') ?? 30);
  const endMonth = arg('end') ?? new Date().toISOString().slice(0, 7);

  const report = await backfillNavs(db, { endMonth, months });
  console.log(
    `nav backfill: ${report.fetched.length} months fetched, ${report.skipped.length} `
    + `already held, ${report.empty.length} served nothing`,
  );
  console.log(`  ${report.inserted} NAV rows`);
  if (report.empty.length > 0) console.log(`  no data: ${report.empty.join(', ')}`);
  await db.close();
}
