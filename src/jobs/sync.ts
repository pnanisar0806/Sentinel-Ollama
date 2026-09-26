import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { persistSchedules } from '../domain/loans.js';
import { installIps } from '../domain/ips.js';
import { persistVests, projectVests } from '../domain/rsu.js';
import { FIDELITY_SOURCE } from '../seed/seed-rsu-actual.js';
import { FileIndmoneySource, RemoteIndmoneySource } from '../sources/indmoney.js';
import { McpClient } from '../sources/mcp-client.js';
import { fetchBalanceSnapshot } from '../sources/balances.js';
import { persistBalanceSnapshot } from '../domain/balance-history.js';
import { fetchMfDetails } from '../sources/indmoney.js';
import { recordDrawdown } from '../domain/drawdown.js';
import { recordNowCloses } from '../sources/now-history.js';
import { recordRatingFilings } from '../sources/credit-ratings.js';
import { applyIndustries, downloadIndustries } from '../sources/nse-industry.js';
import {
  aumCroreToPaise, expensePctToBps, persistMfMetadata, type MfMetadata,
} from '../domain/mf-metadata.js';
import { ensureAccessToken, discoverMetadata, loadClientSecret, ReauthRequired } from '../sources/oauth.js';
import { fetchUsdInr } from '../sources/fx.js';
import { rateMicros } from '../money/fx.js';
import { assessStaleness, raiseIncidents } from '../sources/staleness.js';
import { writeSnapshot, type Source } from '../sources/types.js';
import { downloadBhavcopy, downloadIndexSeries, ingestPrices, type BhavcopyRow, type IndexBhavcopyRow } from '../sources/bhavcopy.js';
import { downloadDailyNav, ingestNavs, type NavRow } from '../sources/amfi.js';
import { isTradingDay } from '../seed/seed-holidays.js';
import { isMainModule } from '../util/main-module.js';
import type { Purpose } from '../config/env.js';

/**
 * This job reads DATABASE_URL and INDMONEY_SNAPSHOT_PATH.
 * It messages nobody and decrypts nothing, so it demands no purpose. Wiring
 * RemoteIndmoneySource (which reads stored OAuth tokens) adds 'crypto' here.
 */
export const ENV_PURPOSES: Purpose[] = [];

const INDMONEY_ISSUER = 'https://mcp.indmoney.com';
const INDMONEY_MCP_URL = 'https://mcp.indmoney.com/mcp';
const INDMONEY_SCOPES = ['portfolio:read'] as const;

/** What the FX step returns. Injected so the sync is testable without a network. */
export type FxFetcher = () => Promise<{ rate: number; asOf: string; source: string }>;

/** EOD quote fetchers. Injected for the same reason as FX: no network in the suite. */
export type PriceFetcher = (tradeDate: string) => Promise<{ equity: BhavcopyRow[]; index: IndexBhavcopyRow[] }>;
export type NavFetcher = () => Promise<{ rows: NavRow[] }>;

export async function runSync(
  db: Db,
  opts: {
    now: string;
    sources: Source[];
    fetchFx?: FxFetcher;
    fetchPrices?: PriceFetcher;
    fetchNavs?: NavFetcher;
  },
): Promise<{ synced: string[]; failed: { source: string; error: string }[] }> {
  const businessDate = opts.now.slice(0, 10);
  const synced: string[] = [];
  const failed: { source: string; error: string }[] = [];

  /** PRD §8.2: one failing input never aborts the healthy ones, and never degrades silently. */
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      await db.query(
        `update incidents set resolved_at = now()
         where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [name],
      );
      synced.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ source: name, error: message });

      const open = await db.query<{ id: string }>(
        `select id from incidents where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [name],
      );
      // Second consecutive failure escalates: never degrade silently (PRD §8.2).
      const severity = open.length > 0 ? 'BLOCK' : 'WARN';
      await db.query(
        `insert into incidents (kind, severity, subject, detail) values ('SYNC_FAILURE',$1,$2,$3)`,
        [severity, name, message],
      );
    }
  };

  for (const source of opts.sources) {
    await step(source.name, async () => {
      const { rows, asOf } = await source.fetch();
      await writeSnapshot(db, source.name, businessDate, rows, asOf);
    });
  }

  // Nothing wrote fx_rates, so `frankfurter` was permanently stale and held an open
  // BLOCK incident: the digest printed red STALE lines after a SUCCESSFUL sync.
if (opts.fetchFx) {
    await step('frankfurter', async () => {
      const { rate, asOf, source } = await opts.fetchFx!();
      await db.query(
        `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR',$1,$2,$3)
         on conflict (pair, as_of) do update set rate_micros = excluded.rate_micros,
                                                  source = excluded.source`,
        [asOf, rateMicros(rate).toString(), source],
      );
    });
  }

  // EOD quotes, AFTER the portfolio sources and BEFORE anything that reads a price:
  // the engine values what the portfolio holds, so prices land first.
  //
  // These steps used to be placeholders that did nothing and then reported success —
  // the exact silent degradation PRD 8.2 forbids. A missing fetcher is now an explicit
  // skip on stderr, and the staleness engine still ages the table either way.
  if (opts.fetchPrices) {
    await step('nse-bhavcopy', async () => {
      if (!(await isTradingDay(db, businessDate))) {
        console.error(`nse-bhavcopy skipped: ${businessDate} is not an NSE trading day`);
        return;
      }
      const { equity, index } = await opts.fetchPrices!(businessDate);
      const report = await ingestPrices(db, equity, index, opts.now);
      if (report.unknownSymbols.length > 0) {
        console.error(`nse-bhavcopy: ${report.unknownSymbols.length} unmapped symbols ignored`);
      }
    });
  } else {
    console.error('nse-bhavcopy skipped: no price fetcher wired');
  }

  if (opts.fetchNavs) {
    await step('amfi', async () => {
      if (!(await isTradingDay(db, businessDate))) {
        console.error(`amfi skipped: ${businessDate} is not an NSE trading day`);
        return;
      }
      const { rows } = await opts.fetchNavs!();
      const report = await ingestNavs(db, rows, opts.now);
      if (report.unknownSchemes.length > 0) {
        console.error(`amfi: ${report.unknownSchemes.length} unmapped scheme codes ignored`);
      }
    });
  } else {
    console.error('amfi skipped: no NAV fetcher wired');
  }

  await persistSchedules(db, `${businessDate.slice(0, 7)}-01`);

  // A grant with tranches from the owner's statement already has its real schedule. The
  // model's uniform quarters would add vests that do not exist beside it.
  const grants = await db.query<{ id: string; granted_on: string | Date; units: string; note: string }>(
    `select id, granted_on, units, note from rsu_grants g
      where not exists (select 1 from rsu_vests v where v.grant_id = g.id and v.source = $1)`,
    [FIDELITY_SOURCE],
  );
  await persistVests(
    db,
    projectVests(
      grants.map((g) => ({
        id: g.id,
        grantedOn: g.granted_on instanceof Date ? g.granted_on.toISOString().slice(0, 10) : g.granted_on,
        units: Number(g.units),
        note: g.note,
      })),
      {
        priceUsd: ASSUMPTIONS.seedNowPriceUsd,
        usdInr: ASSUMPTIONS.seedUsdInr,
        from: businessDate,
        to: `${Number(businessDate.slice(0, 4)) + 5}-12-31`,
      },
    ),
  );

  await raiseIncidents(db, await assessStaleness(db, opts.now));
  return { synced, failed };
}

/**
 * Prefer the live OAuth MCP source; fall back to the owner-refreshed file.
 *
 * RemoteIndmoneySource, McpClient and ensureAccessToken had NO production caller —
 * sync wired the file source only, so Tasks 11A and 11B were unreachable in
 * production. The fallback is deliberate and loud: an expired grant must degrade to
 * the last file snapshot (which the staleness engine then ages) rather than abort the
 * whole sync, but it says so on stderr rather than switching silently.
 */
export async function indmoneySource(
  db: Db,
  env: { indmoneySnapshotPath: string; tokenEncryptionKey: string | undefined },
): Promise<Source> {
  const fileSource = new FileIndmoneySource(env.indmoneySnapshotPath);
  if (!env.tokenEncryptionKey) return fileSource;

  try {
    const key = Buffer.from(env.tokenEncryptionKey, 'base64');

    // The client id is written by `pnpm indmoney:login` (dynamic registration). Reading
    // it from the DB rather than a new env var keeps one source of truth and one less
    // secret on the deployment surface.
    const [registration] = await db.query<{ client_id: string }>(
      'select client_id from oauth_clients where provider = $1', ['indmoney'],
    );
    if (!registration?.client_id) {
      throw new ReauthRequired('indmoney', 'no registered OAuth client');
    }

    const md = await discoverMetadata(INDMONEY_ISSUER);
    const clientSecret = await loadClientSecret(db, 'indmoney', key);

    const client = new McpClient({
      url: INDMONEY_MCP_URL,
      // Exactly the tools this source calls. McpClient requires a non-empty list, and
      // widening it here is what would make an order tool reachable.
      //
      // `networth_snapshot` was added for the daily balance capture. It is read-only —
      // it returns balances and liabilities and names no order surface — and it rides
      // this client rather than a second OAuth path. Every addition to this list is a
      // deliberate widening of what the process can invoke: read-only tools only, and
      // never anything that could place, modify or cancel an order.
      allowedTools: [
        'networth_holdings', 'networth_snapshot', 'get_mf_funds_details',
        'get_mf_by_category',
      ],
      getToken: () => ensureAccessToken(db, 'indmoney', {
        md, clientId: registration.client_id, key, allowedScopes: INDMONEY_SCOPES,
        ...(clientSecret ? { clientSecret } : {}),
      }),
    });
    return new RemoteIndmoneySource({ client });
  } catch (error) {
    const why = error instanceof ReauthRequired ? error.message
      : error instanceof Error ? error.message : String(error);
    console.error(`INDmoney live sync unavailable (${why}); falling back to ${env.indmoneySnapshotPath}`);
    return fileSource;
  }
}

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ENV_PURPOSES);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const sources: Source[] = [await indmoneySource(db, env)];

  const result = await runSync(db, {
    now: new Date().toISOString(),
    sources,
    fetchFx: () => fetchUsdInr(),
    fetchPrices: async (tradeDate) => {
      const [{ rows: equity }, { rows: index }] = await Promise.all([
        downloadBhavcopy(tradeDate),
        downloadIndexSeries(tradeDate),
      ]);
      return { equity, index };
    },
    fetchNavs: () => downloadDailyNav(),
  });
  console.log(`synced: ${result.synced.join(', ') || 'none'}`);
  if (result.failed.length) {
    console.error(`failed: ${result.failed.map((f) => `${f.source} (${f.error})`).join('; ')}`);
  }

  // Daily balance capture for the realised-surplus series. It rides the sync because the
  // OAuth path is already open here and sync already runs every day.
  //
  // Isolated in its own try/catch on purpose, in both directions: a failed capture must
  // not fail the portfolio sync, and the capture is what the surplus trend is made of, so
  // a silent skip would be worse than a loud one. None of it can be backfilled.
  const indmoney = sources.find((s): s is RemoteIndmoneySource => s instanceof RemoteIndmoneySource);
  if (!indmoney) {
    console.error('balance capture skipped: INDmoney is on the file fallback, which carries no balances');
  } else {
    try {
      const rows = await fetchBalanceSnapshot(indmoney.client);
      const asOf = new Date().toISOString().slice(0, 10);
      const inserted = await persistBalanceSnapshot(db, asOf, rows, 'indmoney');
      console.log(`balances ${asOf}: ${inserted} new of ${rows.length} (0 new = already captured today)`);
    } catch (error) {
      console.error(`balance capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Sector, from NSE's free index constituent list. The screener's Industry column
  // needs a paid subscription and neither Kite nor INDmoney carries a sector at all.
  // Refreshed every sync because index membership changes; a failure must not fail the
  // portfolio sync.
  try {
    const industries = await downloadIndustries();
    const applied = await applyIndustries(db, industries);
    console.log(`sectors: ${applied.updated} instruments set from ${industries.length} NSE rows`);
  } catch (error) {
    console.error(`sector refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // MF metadata. Expense ratio and AUM are 35 of `rankMfs`'s 100 points and exist
  // nowhere else; tenure and style drift INDmoney does not carry and they stay absent.
  // Like the balance capture, a failure here must not fail the portfolio sync.
  if (indmoney) {
    try {
      const funds = await db.query<{ id: string; fund_id: string }>(
        `select id, replace(id, 'IND:', '') as fund_id from instruments
          where kind = 'MF' and id like 'IND:%'`,
      );
      const details = await fetchMfDetails(indmoney.client, funds.map((f) => f.fund_id));
      const byFund = new Map(funds.map((f) => [f.fund_id, f.id]));
      const asOf = new Date().toISOString().slice(0, 10);
      const rows: MfMetadata[] = [];
      for (const d of details) {
        const instrumentId = byFund.get(d.fundId);
        if (instrumentId === undefined) continue;
        rows.push({
          instrumentId,
          asOf,
          expenseRatioBps: d.expenseRatioPct === null ? null : expensePctToBps(d.expenseRatioPct),
          aumPaise: d.aumCrore === null ? null : aumCroreToPaise(d.aumCrore),
          category: d.category,
          benchmarkName: d.benchmarkName,
        });
      }
      const inserted = await persistMfMetadata(db, rows);
      console.log(`mf metadata ${asOf}: ${inserted} new of ${rows.length} (0 new = already captured today)`);
    } catch (error) {
      console.error(`mf metadata capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // IPS §3.8: rating actions on the issuers of held bonds, from BSE Reg 30 filings.
  // Two months back each run, so a missed day is caught up; idempotent on BSE's id.
  try {
    const r = await recordRatingFilings(db, { months: 2 });
    console.log(`credit ratings: ${r.written} new filing(s)`);
    if (r.unwatched.length > 0) {
      console.error(`credit ratings: bonds held from UNWATCHED issuers ${r.unwatched.join(', ')} `
        + '- add them to ISSUER_BSE_SCRIP');
    }
  } catch (error) {
    console.error(`credit rating fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ServiceNow closes, so the drawdown includes the RSU (~23% of the book). Before the
  // drawdown, so today's close is in the series. A failure leaves the RSU out of today's
  // point rather than failing the sync.
  try {
    const now = await recordNowCloses(db, { range: '1mo' });
    console.log(`NOW closes: ${now.written} new, latest ${now.latest ?? 'n/a'}`);
  } catch (error) {
    console.error(`NOW close fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // FR-34/35: the drawdown the rails read. Nothing wrote `portfolio_drawdown` before
  // 2026-09-24, so the 15% no-loosening rule and the 20% §3.10 protocol never fired.
  // Runs after the day's snapshot so today's book is in the series.
  try {
    const dd = await recordDrawdown(db);
    console.log(`drawdown: ${dd.written} day(s) recorded; latest ${dd.latest?.drawdownPct ?? 'n/a'}% `
      + `below the ${dd.latest?.peakDate ?? 'n/a'} peak`);
  } catch (error) {
    console.error(`drawdown record failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await db.close();
  if (result.synced.length === 0) process.exitCode = 1;
}