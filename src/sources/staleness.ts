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

/** Sources that are expected to have data in the current schema. */
const KNOWN_PORTFOLIO_SOURCES = ['manual-seed', 'kite', 'indmoney', 'composite'] as const;
const KNOWN_FX_SOURCES = ['frankfurter'] as const;
const KNOWN_MARKET_SOURCES = ['amfi', 'bhavcopy', 'screener'] as const;

export interface StalenessRow {
  source: string;
  asOf: string;
  ageHours: number;
  limitHours: number;
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

  // Portfolio sources from holdings
  for (const source of [...KNOWN_PORTFOLIO_SOURCES, ...holdingsMap.keys()]) {
    const asOf = holdingsMap.get(source);
    const limitHours = LIMIT_BY_SOURCE[source] ?? FRESHNESS_HOURS.portfolio!;
    if (asOf) {
      const ageHours = (nowMs - Date.parse(asOf)) / 3_600_000;
      results.push({ source, asOf, ageHours, limitHours, stale: ageHours > limitHours });
    } else {
      // Source known but no data yet — treat as stale
      results.push({
        source,
        asOf: '1970-01-01T00:00:00.000Z',
        ageHours: Infinity,
        limitHours,
        stale: true,
      });
    }
  }

  // FX sources from fx_rates
  for (const source of [...KNOWN_FX_SOURCES, ...fxMap.keys()]) {
    const asOf = fxMap.get(source);
    const limitHours = LIMIT_BY_SOURCE[source] ?? FRESHNESS_HOURS.fx!;
    if (asOf) {
      const ageHours = (nowMs - Date.parse(asOf)) / 3_600_000;
      results.push({ source, asOf, ageHours, limitHours, stale: ageHours > limitHours });
    } else {
      results.push({
        source,
        asOf: '1970-01-01T00:00:00.000Z',
        ageHours: Infinity,
        limitHours,
        stale: true,
      });
    }
  }

  // Market data sources (no tables yet) — always reported, stale if no data
  for (const source of KNOWN_MARKET_SOURCES) {
    const limitHours = LIMIT_BY_SOURCE[source]!;
    results.push({
      source,
      asOf: '1970-01-01T00:00:00.000Z',
      ageHours: Infinity,
      limitHours,
      stale: true,
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
        [row.source, JSON.stringify(row)],
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

/** FR-31: instruments whose data is stale may not feed recommendation generation. */
export function blockedInstruments(rows: StalenessRow[], positions: Position[]): string[] {
  const staleSources = new Set(rows.filter((r) => r.stale).map((r) => r.source));
  return [
    ...new Set(
      positions.filter((p) => staleSources.has(p.source)).map((p) => p.instrumentId),
    ),
  ].sort();
}