import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import {
  downloadDailyNav, downloadNavHistory, ingestNavs, parseNavUniverse, type NavRow,
} from '../sources/amfi.js';
import {
  candidatesIn, categoriesHeld, loadUniverse, persistUniverse, stampHeldCategories,
} from '../domain/mf-universe.js';
import { monthBounds, monthsBack, amfiDate } from './backfill-navs.js';
import { isMainModule } from '../util/main-module.js';
import { indmoneySource } from './sync.js';
import { RemoteIndmoneySource } from '../sources/indmoney.js';
import type { McpClient } from '../sources/mcp-client.js';
import {
  fetchAllInCategory, INDMONEY_CATEGORY_SLUG, isoFromIndmoneyDate, resolvePeerToAmfi,
} from '../sources/mf-peers.js';
import {
  aumCroreToPaise, expensePctToBps, persistMfMetadata,
} from '../domain/mf-metadata.js';

/**
 * Builds the `mf_switch` candidate universe and gives it enough NAV history to score.
 *
 * Two deliberate narrowings, both about cost rather than correctness:
 *
 * **Only the categories the owner holds.** There is no sense ranking a small-cap fund
 * the owner has no exposure to against a flexi cap they do.
 *
 * **Month-end NAVs only, for candidates.** Consistency is measured over rolling
 * 12-MONTH windows, so a month-end series is all the engine reads. Daily rows for ~150
 * candidates over 31 months would be ~90,000 inserts against the pooler for numbers
 * nothing looks at. Held funds keep their daily series, which `backfill-navs` writes.
 */
export interface UniverseReport {
  categories: string[];
  candidates: number;
  created: number;
  skippedHeld: number;
  monthsFetched: number;
  navsInserted: number;
  /** Held instruments given AMFI's category. */
  stamped: number;
}

/** The last trading day's row per instrument in a month's report. */
export function monthEndRows(rows: readonly NavRow[], wanted: ReadonlySet<string>): NavRow[] {
  const best = new Map<string, NavRow>();
  for (const r of rows) {
    const isin = r.isinDivPayout ?? r.isinDivReinvestment;
    if (isin === null || !wanted.has(isin)) continue;
    // AMFI dates are `dd-MMM-yyyy`, which does not sort, so compare the parsed day.
    const day = Date.parse(r.date);
    const held = best.get(isin);
    if (held === undefined || day > Date.parse(held.date)) best.set(isin, r);
  }
  return [...best.values()];
}

export async function buildMfUniverse(
  db: Db,
  opts: { months: number; endMonth: string; pauseMs?: number },
): Promise<UniverseReport> {
  const daily = await downloadDailyNav();
  const universeRows = parseNavUniverse(
    // `downloadDailyNav` parses; the universe needs the raw text for its headings, so
    // it is fetched once more here rather than threading the text through both.
    await (await fetch('https://www.amfiindia.com/spages/NAVAll.txt', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })).text(),
  );
  void daily;

  // Record AMFI's category on the holdings first: without it a held fund has no
  // cohort and drops out of the switch evaluation entirely.
  const stamped = await stampHeldCategories(db, universeRows);
  const categories = await categoriesHeld(db, universeRows);
  const candidates = candidatesIn(universeRows, categories);
  const { created, skippedHeld } = await persistUniverse(db, candidates);

  const isins = new Set((await loadUniverse(db)).map((c) => c.isin));
  let monthsFetched = 0;
  let navsInserted = 0;
  const pauseMs = opts.pauseMs ?? 1_000;

  for (const month of monthsBack(opts.endMonth, opts.months)) {
    const { from, to } = monthBounds(month);
    const { rows } = await downloadNavHistory(amfiDate(from), amfiDate(to));
    if (rows.length === 0) continue;
    const ends = monthEndRows(rows, isins);
    if (ends.length === 0) continue;
    const ingested = await ingestNavs(db, ends, `${to}T12:00:00Z`);
    monthsFetched += 1;
    navsInserted += ingested.inserted;
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }

  return {
    categories, candidates: candidates.length, created, skippedHeld,
    monthsFetched, navsInserted, stamped,
  };
}

/**
 * Gives the candidates the cost and size the holdings already have.
 *
 * Without it a cohort scores the holding 35 points ahead of everything else purely
 * because only the holding has INDmoney metadata — a comparison that always says hold,
 * for a reason that has nothing to do with the funds.
 *
 * INDmoney's fund id is not an AMFI scheme code and its payload carries no ISIN, so
 * each listing is matched to a scheme by NAV fingerprint against AMFI's file for the
 * peer's OWN nav_date. Anything that does not match is left without metadata rather
 * than guessed at.
 */
export async function enrichUniverse(
  db: Db,
  client: McpClient,
  categories: readonly string[],
): Promise<{ matched: number; unmatched: string[] }> {
  const universe = await loadUniverse(db);
  const bySchemeCode = new Map(universe.map((u) => [u.schemeCode, u]));
  const asOf = new Date().toISOString().slice(0, 10);

  let matched = 0;
  const unmatched: string[] = [];
  const historyFor = new Map<string, NavRow[]>();

  for (const category of categories) {
    const slug = INDMONEY_CATEGORY_SLUG[category];
    if (slug === undefined) continue;
    const peers = await fetchAllInCategory(client, slug);

    for (const peer of peers) {
      if (peer.navDate === null) { unmatched.push(peer.name); continue; }
      // One download per distinct quote date, not per fund.
      let rows = historyFor.get(peer.navDate);
      if (rows === undefined) {
        const iso = isoFromIndmoneyDate(peer.navDate);
        rows = iso === null ? [] : (await downloadNavHistory(amfiDate(iso), amfiDate(iso))).rows;
        historyFor.set(peer.navDate, rows);
      }
      const hit = resolvePeerToAmfi(peer, rows);
      const candidate = hit === null ? undefined : bySchemeCode.get(hit.schemeCode);
      if (candidate === undefined) { unmatched.push(peer.name); continue; }

      await persistMfMetadata(db, [{
        instrumentId: candidate.instrumentId,
        asOf,
        expenseRatioBps: peer.expenseRatioPct === null ? null : expensePctToBps(peer.expenseRatioPct),
        aumPaise: peer.aumCrore === null ? null : aumCroreToPaise(peer.aumCrore),
        category,
        benchmarkName: null,
      }]);
      matched += 1;
    }
  }
  return { matched, unmatched };
}

export const ENV_PURPOSES: Purpose[] = [];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, []);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

  const arg = (n: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const months = Number(arg('months') ?? 30);
  const endMonth = arg('end') ?? new Date().toISOString().slice(0, 7);

  const report = await buildMfUniverse(db, { months, endMonth });
  console.log(`universe: ${report.candidates} candidates in ${report.categories.length} categories`);
  console.log(`  ${report.categories.join(' | ')}`);
  console.log(`  ${report.created} instruments created, ${report.skippedHeld} already held`);
  console.log(`  ${report.navsInserted} month-end NAVs over ${report.monthsFetched} months`);
  console.log(`  ${report.stamped} holdings given AMFI's category`);

  // Cost and size for the candidates. Without it the holding is 35 points ahead of the
  // whole cohort for having metadata, and every verdict is HOLD for the wrong reason.
  const source = await indmoneySource(db, env);
  if (source instanceof RemoteIndmoneySource) {
    const enriched = await enrichUniverse(db, source.client, report.categories);
    console.log(`  ${enriched.matched} candidates priced, ${enriched.unmatched.length} unmatched`);
  } else {
    console.error('candidate cost/size skipped: INDmoney is on the file fallback');
  }
  await db.close();
}
