import type { Db } from '../db/client.js';
import type { Position } from '../domain/networth.js';
import { isTradingDay } from '../seed/seed-holidays.js';

/** PRD §8.2 freshness policy, in hours. Fundamentals = one quarter. */
export const FRESHNESS_HOURS: Record<string, number> = {
  prices: 24,
  navs: 48,
  fundamentals: 90 * 24,
  fx: 48,
  portfolio: 36,
};

/** Every portfolio source shares the 36h portfolio limit unless listed otherwise. */
const LIMIT_BY_SOURCE: Record<string, number> = {
  fx: FRESHNESS_HOURS.fx!,
  amfi: FRESHNESS_HOURS.navs!,
  bhavcopy: FRESHNESS_HOURS.prices!,
  screener: FRESHNESS_HOURS.fundamentals!,
};

/** Sentinel value for a source that has never produced a row. */
const NEVER = '1970-01-01T00:00:00.000Z';

/** Sources that are expected to have data in the current schema.
 *
 * `composite` was removed on 2026-09-20: nothing in the codebase ever wrote it, so it
 * held a permanently open incident reading "last updated never" since 2026-08-24. It
 * was a name from the Phase 0 snapshot comment for merging Kite with INDmoney, and Kite
 * is retired. An incident that can never clear only teaches the owner to ignore
 * incidents. */
const KNOWN_PORTFOLIO_SOURCES = ['manual-seed', 'indmoney'] as const;
const KNOWN_FX_SOURCES = ['frankfurter'] as const;
const KNOWN_MARKET_SOURCES = ['amfi', 'bhavcopy', 'screener'] as const;

/**
 * Sources that only publish on a trading day. Their freshness is measured against the
 * market calendar, not the wall clock.
 *
 * A wall-clock limit is unsatisfiable for these by construction. NSE closes Friday and
 * publishes nothing until Monday, so a 24h limit on `bhavcopy` marks it stale from
 * Saturday morning onward and FR-31 blocks every equity, ETF and bond position for the
 * whole weekend. On 2026-09-20 that was 39 instruments — and `weekly.yml` runs the deep
 * report at 04:30 UTC on SUNDAY, so the recommendation pipeline was hobbled on the exact
 * day it ran. A Friday holiday such as 2026-10-02 extends the outage to four days.
 *
 * The question is therefore "is there data for the most recent COMPLETED trading
 * session", not "is the newest row younger than N hours".
 */
const TRADING_CALENDAR_SOURCES = new Set(['bhavcopy', 'amfi', 'frankfurter']);

/** How many completed trading days a calendar source may lag before it is stale. 0 means
 *  it must carry the most recent completed session. */
export const TRADING_DAY_TOLERANCE = 0;

/**
 * The most recent completed trading session at `nowIso`.
 *
 * Strictly before today, because a session that is still open (or whose close has not
 * been published yet) cannot be required. Bounded at 14 days so a mis-seeded holiday
 * table cannot spin forever; exceeding that is itself a fault worth surfacing as stale.
 */
export async function lastCompletedTradingDay(db: Db, nowIso: string): Promise<string> {
  const cursor = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`);
  for (let i = 0; i < 14; i += 1) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.toISOString().slice(0, 10);
    if (await isTradingDay(db, day)) return day;
  }
  return cursor.toISOString().slice(0, 10);
}

/**
 * `unimplemented` is deliberately NOT `stale`. amfi/bhavcopy/screener have no
 * ingestion path in Phase 0, so calling them stale printed red warnings after a
 * SUCCESSFUL sync and kept a BLOCK incident permanently open — which trains the owner
 * to ignore the loudest safety signal in the product. An unbuilt feature and rotten
 * data are different problems and must read differently.
 */
export type SourceState = 'fresh' | 'stale' | 'unimplemented';

export interface StalenessRow {
  source: string;
  asOf: string;
  ageHours: number;
  limitHours: number;
  state: SourceState;
  /** Convenience mirror of `state === 'stale'`. Never true for an unimplemented source. */
  stale: boolean;
}

/**
 * Returns the latest as_of per source from holdings (portfolio sources).
 * PGlite returns date columns as Date objects; normalize to ISO string.
 */
export async function getLatestHoldingsAsOf(db: Db): Promise<Map<string, string>> {
  const rows = await db.query<{ source: string; as_of: string | Date }>(
    `select source, max(as_of) as as_of from holdings group by source`,
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    const asOf = r.as_of instanceof Date ? r.as_of.toISOString() : r.as_of;
    map.set(r.source, asOf);
  }
  return map;
}

/**
 * Returns the latest as_of per source from fx_rates (FX sources).
 * as_of is a date column (not timestamptz), so we treat it as midnight UTC.
 */
async function getLatestFxAsOf(db: Db): Promise<Map<string, string>> {
  const rows = await db.query<{ source: string; as_of: string | Date }>(
    `select source, max(as_of) as as_of from fx_rates group by source`,
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    const asOf = r.as_of instanceof Date ? r.as_of.toISOString() : r.as_of;
    // fx_rates.as_of is a date (no time), treat as start of day UTC
    map.set(r.source, asOf);
  }
  return map;
}

/**
 * Returns the latest as_of for prices_eod (bhavcopy source).
 * trade_date is a date column; we use the max trade_date with its as_of.
 */
async function getLatestPricesAsOf(db: Db): Promise<string | undefined> {
  const rows = await db.query<{ as_of: string | Date }>(
    // NSE rows only. `prices_eod` also carries the ServiceNow closes (source `yahoo`),
    // and counting them would make a dead NSE feed read as current.
    `select max(as_of) as as_of from prices_eod where source = 'nse-bhavcopy'`,
  );
  if (rows.length === 0 || rows[0]?.as_of === null) return undefined;
  const asOf = rows[0]!.as_of;
  return asOf instanceof Date ? asOf.toISOString() : asOf;
}

/**
 * Returns the latest as_of for navs (amfi source).
 */
async function getLatestNavsAsOf(db: Db): Promise<string | undefined> {
  const rows = await db.query<{ as_of: string | Date }>(
    `select max(as_of) as as_of from navs`,
  );
  if (rows.length === 0 || rows[0]?.as_of === null) return undefined;
  const asOf = rows[0]!.as_of;
  return asOf instanceof Date ? asOf.toISOString() : asOf;
}

/**
 * Returns the latest as_of for fundamentals (screener source).
 */
async function getLatestFundamentalsAsOf(db: Db): Promise<string | undefined> {
  const rows = await db.query<{ as_of: string | Date }>(
    `select max(as_of) as as_of from fundamentals`,
  );
  if (rows.length === 0 || rows[0]?.as_of === null) return undefined;
  const asOf = rows[0]!.as_of;
  return asOf instanceof Date ? asOf.toISOString() : asOf;
}

/**
 * Assesses staleness for all known sources.
 * - Portfolio sources (indmoney, manual-seed) from holdings, on a wall-clock limit
 * - Trading-calendar sources (bhavcopy, amfi, frankfurter) against the last session
 * - FX sources (frankfurter) from fx_rates
 * - Market sources (bhavcopy from prices_eod, amfi from navs, screener from fundamentals)
 */
export async function assessStaleness(db: Db, now: string): Promise<StalenessRow[]> {
  const nowMs = Date.parse(now);
  // Computed once: every calendar source is measured against the same session.
  const lastSession = await lastCompletedTradingDay(db, now);

  const holdingsMap = await getLatestHoldingsAsOf(db);
  const fxMap = await getLatestFxAsOf(db);
  const pricesAsOf = await getLatestPricesAsOf(db);
  const navsAsOf = await getLatestNavsAsOf(db);
  const fundamentalsAsOf = await getLatestFundamentalsAsOf(db);

  const results: StalenessRow[] = [];

  const assess = (
    source: string,
    asOf: string | undefined,
    defaultLimit: number,
  ): StalenessRow => {
    const limitHours = LIMIT_BY_SOURCE[source] ?? defaultLimit;
    if (asOf === undefined) {
      return {
        source, asOf: NEVER, ageHours: Infinity, limitHours,
        state: 'stale', stale: true,
      };
    }
    const ageHours = (nowMs - Date.parse(asOf)) / 3_600_000;

    // A trading-calendar source is fresh when it carries the most recent COMPLETED
    // session, however many wall-clock hours ago that was. Friday's close read on a
    // Sunday is 58h old and perfectly current; there has been no session since.
    const stale = TRADING_CALENDAR_SOURCES.has(source)
      ? asOf.slice(0, 10) < lastSession
      : ageHours > limitHours;

    return { source, asOf, ageHours, limitHours, state: stale ? 'stale' : 'fresh', stale };
  };

  // A source can be BOTH in the known list and present in the data. Iterating
  // `[...KNOWN, ...map.keys()]` as a list emitted it twice; the tests used .find(),
  // so the duplicates were invisible.
  for (const source of new Set([...KNOWN_PORTFOLIO_SOURCES, ...holdingsMap.keys()])) {
    results.push(assess(source, holdingsMap.get(source), FRESHNESS_HOURS.portfolio!));
  }

  for (const source of new Set([...KNOWN_FX_SOURCES, ...fxMap.keys()])) {
    results.push(assess(source, fxMap.get(source), FRESHNESS_HOURS.fx!));
  }

  // bhavcopy from prices_eod table (Phase 1 Task 3)
  results.push(assess('bhavcopy', pricesAsOf, FRESHNESS_HOURS.prices!));

  // amfi from navs table (Phase 1 Task 4)
  results.push(assess('amfi', navsAsOf, FRESHNESS_HOURS.navs!));

  // screener from fundamentals (Phase 1 Task 6 built the ingestion path, so it is
  // assessed like any other source — `unimplemented` would now hide a real drought)
  results.push(assess('screener', fundamentalsAsOf, FRESHNESS_HOURS.fundamentals!));

  return results;
}

/**
 * Opens one incident per newly-stale source and resolves those that recovered.
 * Loud failure is the contract (PRD §8.2): silent degradation is the failure mode
 * this whole engine exists to prevent.
 */
export async function raiseIncidents(db: Db, rows: StalenessRow[]): Promise<number> {
  let opened = 0;

  for (const row of rows) {
    const open = await db.query<{ id: string }>(
      `select id from incidents
       where kind = 'STALE_DATA' and subject = $1 and resolved_at is null`,
      [row.source],
    );

    if (row.stale && open.length === 0) {
      await db.query(
        `insert into incidents (kind, severity, subject, detail)
         values ('STALE_DATA', 'BLOCK', $1, $2)`,
        [row.source, `${row.source} last updated ${row.ageHours === Infinity ? 'never' : row.ageHours.toFixed(1)}h ago (limit ${row.limitHours}h)`],
      );
      await db.query(
        `insert into audit_log (entity, entity_id, action, actor, payload)
         values ('incident', $1, 'STALE_DATA_OPENED', 'agent', $2::jsonb)`,
          [row.source, row],
      );
      opened++;
    }

    if (!row.stale && open.length > 0) {
      await db.query(
        `update incidents set resolved_at = now()
         where kind = 'STALE_DATA' and subject = $1 and resolved_at is null`,
        [row.source],
      );
    }
  }

  return opened;
}

/**
 * FR-31: an instrument may not feed recommendation generation while any input needed
 * to value it is stale.
 *
 * This used to intersect stale sources with `positions.map(p => p.source)` — which is
 * always a PORTFOLIO source — so stale FX, NAVs or prices could never block anything.
 * The half of FR-31 that actually gates recommendations was blind, and the suite
 * encoded the false negative as expected behaviour.
 *
 * Inputs checked for each position:
 *   - the portfolio source that supplied the position
 *   - FX, for any position not denominated in INR (without a rate it has no rupee value)
 *   - NAV, for MF positions
 *   - Price (bhavcopy), for equity/ETF/bond positions (non-MF, non-CASH, non-EPF)
 *   - Fundamentals, for equity positions (screening/quality gate)
 */
export function blockedInstruments(rows: StalenessRow[], positions: Position[]): string[] {
  const staleSources = new Set(rows.filter((r) => r.stale).map((r) => r.source));
  const fxStale = rows.some((r) => r.stale && FX_SOURCE_NAMES.has(r.source));
  const navStale = staleSources.has('amfi');
  const priceStale = staleSources.has('bhavcopy');
  const fundamentalsStale = staleSources.has('screener');

  return [
    ...new Set(
      positions
        .filter((p) => {
          // Portfolio source stale
          if (staleSources.has(p.source)) return true;
          // FX stale for non-INR
          if (fxStale && p.currency !== 'INR') return true;
          // NAV stale for MF
          if (navStale && p.kind === 'MF') return true;
          // Price stale for equity/ETF/bond (non-MF, non-CASH, non-EPF, non-RSU, non-GOLD, non-LOAN)
          if (priceStale && ['EQUITY', 'ETF', 'BOND'].includes(p.kind)) return true;
          // Fundamentals stale for equity (quality gate)
          if (fundamentalsStale && p.kind === 'EQUITY') return true;
          return false;
        })
        .map((p) => p.instrumentId),
    ),
  ].sort();
}

const FX_SOURCE_NAMES = new Set<string>(KNOWN_FX_SOURCES);
