import type { Db } from '../db/client.js';
import type { Position } from '../domain/networth.js';

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

/** Sources that are expected to have data in the current schema. */
const KNOWN_PORTFOLIO_SOURCES = ['manual-seed', 'kite', 'indmoney', 'composite'] as const;
const KNOWN_FX_SOURCES = ['frankfurter'] as const;
const KNOWN_MARKET_SOURCES = ['amfi', 'bhavcopy', 'screener'] as const;

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
async function getLatestHoldingsAsOf(db: Db): Promise<Map<string, string>> {
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
 * Assesses staleness for all known sources.
 * - Portfolio sources (kite, indmoney, manual-seed, composite) from holdings
 * - FX sources (frankfurter) from fx_rates
 * - Market sources (amfi, bhavcopy, screener) — no tables yet, reported as stale if no data
 */
export async function assessStaleness(db: Db, now: string): Promise<StalenessRow[]> {
  const nowMs = Date.parse(now);

  const holdingsMap = await getLatestHoldingsAsOf(db);
  const fxMap = await getLatestFxAsOf(db);

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
    const stale = ageHours > limitHours;
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

  // No table, no ingestion path: report the gap honestly rather than as rotten data.
  for (const source of KNOWN_MARKET_SOURCES) {
    results.push({
      source,
      asOf: NEVER,
      ageHours: Infinity,
      limitHours: LIMIT_BY_SOURCE[source]!,
      state: 'unimplemented',
      stale: false,
    });
  }

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
 * Two inputs are checked today:
 *   - the portfolio source that supplied the position
 *   - FX, for any position not denominated in INR (without a rate it has no rupee value)
 *
 * NAV and price sources are `unimplemented` in Phase 0, so they do not block. When an
 * ingestion path exists they become `stale`-capable and belong here too.
 */
export function blockedInstruments(rows: StalenessRow[], positions: Position[]): string[] {
  const staleSources = new Set(rows.filter((r) => r.stale).map((r) => r.source));
  const fxStale = rows.some((r) => r.stale && FX_SOURCE_NAMES.has(r.source));

  return [
    ...new Set(
      positions
        .filter((p) => staleSources.has(p.source) || (fxStale && p.currency !== 'INR'))
        .map((p) => p.instrumentId),
    ),
  ].sort();
}

const FX_SOURCE_NAMES = new Set<string>(KNOWN_FX_SOURCES);
