import type { Db } from '../db/client.js';
import type { McpClient } from './mcp-client.js';
import {
  amfiDate, downloadNavHistory, isDirectGrowth, parseNavUniverse, type NavRow, type UniverseRow,
} from './amfi.js';
import { fetchAllInCategory, isoFromIndmoneyDate, resolvePeerToAmfi } from './mf-peers.js';
import { fetchMfDetails } from './indmoney.js';
import { aumCroreToPaise, expensePctToBps } from '../domain/mf-metadata.js';
import { universeInstrumentId } from '../domain/mf-universe.js';
import { sipMoveFunds } from '../domain/owner-log.js';
import { instrumentMeta } from '../domain/owner-sales.js';

/**
 * Spec §8.1 / Decision 11: the new US and Nifty Next 50 index fund. The owner keeps the
 * funds held there but tops neither up, so new money needs a new fund; this reads the
 * candidates daily and ranks the Direct Growth plans open to SIPs. Fund-switch spec §4.4:
 * Nifty 50 funds are read the same way, as same-index peers for a held Nifty 50 fund
 * (`src/domain/index-switch.ts`).
 *
 * Verified live 2026-10-26 (tests/fixtures/indmoney-index-funds-2026-10-26.json):
 *  - `get_mf_by_category` carries `sip_allowed`; every `global-index-funds` row was false.
 *  - No field in `get_mf_by_category` or `get_mf_funds_details` (baseline or
 *    `fund_performance`) carries tracking error, so `tracking_error_bps` stays null.
 */
export type IndexFundType = 'US' | 'NEXT50' | 'NIFTY50';

export const INDEX_FUND_SLUGS: Record<IndexFundType, string> = {
  NIFTY50: 'nifty-50-index-funds', // fund-switch spec §4.4: same-index peers for a held Nifty 50 fund
  NEXT50: 'nifty-next-50-index-funds',
  US: 'global-index-funds',
};

const SOURCE = 'indmoney-mcp';

export interface IndexFundRow {
  fundType: IndexFundType;
  indmoneyFundId: string;
  name: string;
  benchmarkName: string | null;
  /** null = plan not verified as Direct Growth. */
  amfiSchemeCode: string | null;
  expenseRatioBps: number | null;
  aumPaise: bigint | null;
  trackingErrorBps: number | null;
  /** null = INDmoney silent. */
  sipAllowed: boolean | null;
  asOf: string;
  source: string;
}

interface AmfiDeps {
  /** Every scheme in AMFI's daily file, with plan and option. */
  amfiUniverse?: () => Promise<UniverseRow[]>;
  /** AMFI's NAVs for one ISO day — the fingerprint is only valid on INDmoney's own nav date. */
  amfiNavOn?: (isoDate: string) => Promise<NavRow[]>;
}

const defaultUniverse = async (): Promise<UniverseRow[]> => parseNavUniverse(
  await (await fetch('https://www.amfiindia.com/spages/NAVAll.txt', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  })).text(),
);
const defaultNavOn = async (iso: string): Promise<NavRow[]> =>
  (await downloadNavHistory(amfiDate(iso), amfiDate(iso))).rows;

/**
 * Reads both category listings, each fund's benchmark, and joins each fund to its AMFI
 * Direct Growth scheme by NAV fingerprint. Only Direct Growth rows are offered to the
 * matcher, so an IDCW twin at the same NAV can never be picked. Idempotent per day.
 */
export async function recordIndexFundCandidates(
  db: Db, client: McpClient, asOf: string, deps: AmfiDeps = {},
): Promise<{ stored: number }> {
  // Downloaded only once a listing has needed it, so an INDmoney failure costs no AMFI fetch.
  let directGrowth: Map<string, UniverseRow> | null = null;
  const navOn = deps.amfiNavOn ?? defaultNavOn;
  const navCache = new Map<string, NavRow[]>();

  let stored = 0;
  for (const fundType of ['NEXT50', 'US', 'NIFTY50'] as const) {
    // The tool takes 1–20 per page.
    const peers = await fetchAllInCategory(client, INDEX_FUND_SLUGS[fundType], 20);
    const benchmark = new Map<string, string | null>();
    for (let i = 0; i < peers.length; i += 10) { // get_mf_funds_details: at most 10 per call
      for (const d of await fetchMfDetails(client, peers.slice(i, i + 10).map((p) => p.fundId))) {
        benchmark.set(d.fundId, d.benchmarkName);
      }
    }
    for (const p of peers) {
      const iso = p.navDate === null ? null : isoFromIndmoneyDate(p.navDate);
      let schemeCode: string | null = null;
      if (iso !== null) {
        directGrowth ??= new Map((await (deps.amfiUniverse ?? defaultUniverse)())
          .filter(isDirectGrowth).map((u) => [u.schemeCode, u]));
        const dg = directGrowth;
        if (!navCache.has(iso)) navCache.set(iso, (await navOn(iso)).filter((r) => dg.has(r.schemeCode)));
        schemeCode = resolvePeerToAmfi(p, navCache.get(iso)!)?.schemeCode ?? null;
      }
      const aum = p.aumCrore === null ? null : aumCroreToPaise(p.aumCrore);
      const inserted = await db.query<{ id: string }>(
        `insert into index_fund_candidates
           (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code, expense_ratio_bps,
            aum_paise, tracking_error_bps, sip_allowed, as_of, source)
         values ($1,$2,$3,$4,$5,$6,$7,null,$8,$9,$10)
         on conflict (indmoney_fund_id, as_of) do nothing
         returning id`,
        [fundType, p.fundId, p.name, benchmark.get(p.fundId) ?? null, schemeCode,
         p.expenseRatioPct === null ? null : expensePctToBps(p.expenseRatioPct),
         aum === null ? null : aum.toString(), p.sipAllowed ?? null, asOf, SOURCE],
      );
      stored += inserted.length;
    }
  }
  await registerIndexChallengers(db, directGrowth);
  return { stored };
}

/**
 * Fund switch §4.4: each ranked same-index fund becomes an `MFU:<scheme>` instrument — the id
 * `loadFundMoves` names — so a SIP move to it can be logged on /log. Idempotent; follows
 * `persistUniverse`, and a fund the owner already holds keeps its own instrument.
 *
 * `metadata.category` is the AMFI category `logSipMove` reads on the held fund of the same index:
 * AMFI files index funds under more than one heading, so the peer's own heading could refuse a
 * like-for-like move. The real gate is `metadata.indexType`, which `logSipMove` also checks.
 * Batch B §3: a lump sum may open an index type no held fund tracks, so with no held fund of that
 * index the picks are registered under the ranked row's own AMFI category (left unset if AMFI was not read).
 */
async function registerIndexChallengers(db: Db, amfi: ReadonlyMap<string, UniverseRow> | null): Promise<void> {
  const { rows } = await loadIndexFundRows(db);
  const owned = await db.query<{ id: string }>(`select id from instruments where kind = 'MF' and id not like 'MFU:%'`);
  const categoryOf = new Map<string, string>();
  for (const f of await sipMoveFunds(db, owned.map((r) => r.id))) {
    if (f.category !== null && f.indexType !== null && !categoryOf.has(f.indexType)) categoryOf.set(f.indexType, f.category);
  }
  for (const fundType of Object.keys(INDEX_FUND_SLUGS) as IndexFundType[]) {
    const choice = chooseIndexFund(rows, fundType);
    if (choice.top === null) continue;
    for (const r of [choice.top, ...choice.alternatives]) {
      const code = r.amfiSchemeCode!; // ranked rows are verified Direct Growth schemes
      const isin = amfi?.get(code)?.isin ?? null;
      const category = categoryOf.get(fundType) ?? (amfi?.get(code)?.category || null);
      const held = await db.query(
        `select 1 from instruments where id not like 'MFU:%' and (scheme_code = $1 or isin = $2)`, [code, isin]);
      if (held.length > 0) continue;
      await db.query(
        `insert into instruments (id, kind, name, currency, isin, scheme_code, metadata)
         values ($1, 'MF', $2, 'INR', $3, $4, $5::jsonb)
         on conflict (id) do update set name = excluded.name, isin = coalesce(excluded.isin, instruments.isin),
           metadata = coalesce(${instrumentMeta('instruments')}, '{}'::jsonb) || excluded.metadata`,
        // An object, not JSON.stringify: postgres-js stores a stringified param as a jsonb string.
        [universeInstrumentId(code), r.name, isin, code, {
          // An unknown category is left out, so the merge keeps one stored on an earlier day.
          indexChallenger: true, ...(category === null ? {} : { category }), indexType: fundType, benchmark: r.benchmarkName, asOf: r.asOf, source: r.source,
        }]);
    }
  }
}

/** Per fund type, the rows of its latest `as_of`: a failed US listing never blanks a fresh Next 50. */
export async function loadIndexFundRows(db: Db): Promise<{ asOf: string | null; rows: IndexFundRow[] }> {
  const rows = await db.query<{
    fund_type: IndexFundType; indmoney_fund_id: string; name: string; benchmark_name: string | null;
    amfi_scheme_code: string | null; expense_ratio_bps: number | null; aum_paise: string | null;
    tracking_error_bps: number | null; sip_allowed: boolean | null; as_of: string; source: string;
  }>(
    `select fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code, expense_ratio_bps,
            aum_paise::text as aum_paise, tracking_error_bps, sip_allowed, as_of::text as as_of, source
       from index_fund_candidates
      where (fund_type, as_of) in (select fund_type, max(as_of) from index_fund_candidates group by fund_type)
      order by id`,
  );
  return {
    asOf: rows.reduce<string | null>((a, r) => (a === null || r.as_of > a ? r.as_of : a), null),
    rows: rows.map((r) => ({
      fundType: r.fund_type, indmoneyFundId: r.indmoney_fund_id, name: r.name, benchmarkName: r.benchmark_name,
      amfiSchemeCode: r.amfi_scheme_code, expenseRatioBps: r.expense_ratio_bps,
      aumPaise: r.aum_paise === null ? null : BigInt(r.aum_paise), trackingErrorBps: r.tracking_error_bps,
      sipAllowed: r.sip_allowed, asOf: r.as_of, source: r.source,
    })),
  };
}

export interface IndexFundChoice {
  fundType: IndexFundType;
  top: IndexFundRow | null;
  alternatives: IndexFundRow[];
  notProposed: { row: IndexFundRow; why: string }[];
  trackingErrorAvailable: boolean;
  reason: string | null;
}

export const BENCHMARK: Record<IndexFundType, { re: RegExp; label: string }> = {
  // Anchored: Nifty 500, Next 50, Equal Weight, Value 20 and Shariah are other indices. Live
  // 2026-10-28 every nifty-50-index-funds fund reported "Nifty 50 TR INR". An unlisted spelling
  // shows as "tracks X, not Nifty 50" — visible, never silently ranked.
  NIFTY50: { re: /^nifty 50(?: tr inr| tri| total return(?: index)?)?$/i, label: 'Nifty 50' },
  NEXT50: { re: /nifty next 50/i, label: 'Nifty Next 50' },
  US: { re: /s&p 500|nasdaq[- ]?100/i, label: 'S&P 500 or NASDAQ-100' },
};

const CLOSED = 'closed to new SIPs on INDmoney';
const NONE_OPEN: Record<IndexFundType, string> = {
  US: 'no eligible fund is open to SIPs (RBI overseas limit)',
  NEXT50: 'no eligible fund is open to SIPs',
  NIFTY50: 'no eligible fund is open to SIPs',
};
const NONE_ELIGIBLE = 'no eligible fund — see Not proposed';

/**
 * Pure. Eligible: the benchmark matches, the plan is a verified AMFI Direct Growth scheme,
 * and INDmoney says SIPs are open. Ranked by expense ratio, then tracking error (only when an
 * eligible row has one), then AUM descending. A row missing a value the ranking uses is shown
 * with why, never ranked as if the value were 0.
 */
export function chooseIndexFund(rows: IndexFundRow[], fundType: IndexFundType): IndexFundChoice {
  const notProposed: IndexFundChoice['notProposed'] = [];
  const eligible: IndexFundRow[] = [];
  const { re, label } = BENCHMARK[fundType];
  for (const r of rows.filter((x) => x.fundType === fundType)) {
    const why = r.benchmarkName === null ? 'benchmark unknown'
      : !re.test(r.benchmarkName) ? `tracks ${r.benchmarkName}, not ${label}`
      : r.amfiSchemeCode === null ? 'plan not verified as Direct Growth'
      : r.sipAllowed === null ? 'INDmoney does not say whether SIPs are open'
      : r.sipAllowed !== true ? CLOSED
      : null;
    if (why === null) eligible.push(r); else notProposed.push({ row: r, why });
  }
  const trackingErrorAvailable = eligible.some((r) => r.trackingErrorBps !== null);
  const ranked: IndexFundRow[] = [];
  for (const r of eligible) {
    const why = r.expenseRatioBps === null ? 'no expense ratio on record'
      : trackingErrorAvailable && r.trackingErrorBps === null ? 'no tracking error on record'
      : r.aumPaise === null ? 'no AUM on record'
      : null;
    if (why === null) ranked.push(r); else notProposed.push({ row: r, why });
  }
  ranked.sort((a, b) => a.expenseRatioBps! - b.expenseRatioBps!
    || (trackingErrorAvailable ? a.trackingErrorBps! - b.trackingErrorBps! : 0)
    || (a.aumPaise! === b.aumPaise! ? 0 : a.aumPaise! > b.aumPaise! ? -1 : 1)
    || a.indmoneyFundId.localeCompare(b.indmoneyFundId));
  return {
    fundType,
    top: ranked[0] ?? null,
    alternatives: ranked.slice(1, 3),
    notProposed,
    trackingErrorAvailable,
    reason: ranked.length > 0 ? null : noneReason(fundType, notProposed),
  };
}

/** The SIP wording only when every fund tracking the right index is closed to SIPs; else the rows say why. */
function noneReason(fundType: IndexFundType, notProposed: IndexFundChoice['notProposed']): string {
  const { re } = BENCHMARK[fundType];
  const inBenchmark = notProposed.filter((n) => n.row.benchmarkName !== null && re.test(n.row.benchmarkName));
  return inBenchmark.length > 0 && inBenchmark.every((n) => n.why === CLOSED) ? NONE_OPEN[fundType] : NONE_ELIGIBLE;
}
