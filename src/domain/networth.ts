import type { Db } from '../db/client.js';
import { addP, subP, type Paise } from '../money/paise.js';
import type { Account } from '../seed/seed-data.js';

/**
 * Mirrors the `instruments.kind` check constraint in `migrations/0001_phase0.sql`,
 * 'LOAN' included. The plan's union omitted LOAN, which meant a LOAN row would fall
 * through `classify` to EQUITY and be summed into ASSETS. See `classify`.
 */
export type InstrumentKind =
  | 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'CASH' | 'EPF' | 'RSU' | 'GOLD' | 'LOAN';
export type AssetClass = 'EQUITY' | 'DEBT' | 'GOLD' | 'CASH';

export interface Position {
  instrumentId: string;
  kind: InstrumentKind;
  account: Account;
  valuePaise: Paise;
  /** NULL = unknown cost (FR-02). Never 0, never rendered as Rs 0. */
  avgCostPaise: Paise | null;
  assetClass: AssetClass;
  issuer: string | null;
  /** PRD 3.5 single-sector cap. NULL where the instrument carries no sector. */
  sector: string | null;
  isEmployer: boolean;
  asOf: string;
  source: string;
}

/** Debt-like instruments that are not BOND/EPF by kind. EPF is ballast, not equity. */
const DEBT_INSTRUMENTS = new Set(['NSE:LIQUIDBEES']);
const DEBT_FUND_HINT = /liquid|debt|arbitrage|gilt|bond/i;

/**
 * PRD 3.3 asset-class mapping. GOLD/CASH by kind; BOND and EPF are DEBT; pooled
 * vehicles (MF, ETF) fall to DEBT on a name hint or an explicit id, else EQUITY.
 *
 * The name hint covers ETFs as well as MFs — `NSE:LIQUIDBEES` ('Liquid ETF') is DEBT
 * for that reason as well as by the explicit id, so neither route is load-bearing alone.
 */
export function classify(kind: InstrumentKind, instrumentId: string, name: string): AssetClass {
  if (kind === 'LOAN') {
    throw new Error(`instrument ${instrumentId} is a LOAN and has no asset class`);
  }
  if (kind === 'GOLD') return 'GOLD';
  if (kind === 'CASH') return 'CASH';
  if (kind === 'BOND' || kind === 'EPF') return 'DEBT';
  if (DEBT_INSTRUMENTS.has(instrumentId)) return 'DEBT';
  if ((kind === 'MF' || kind === 'ETF') && DEBT_FUND_HINT.test(name)) return 'DEBT';
  return 'EQUITY';
}

interface HoldingRow {
  instrument_id: string;
  kind: InstrumentKind;
  name: string;
  account: Account;
  /** PGlite hands bigint columns back as JS numbers, not strings (MEMORY.md). */
  value_paise: string | number | bigint;
  avg_cost_paise: string | number | bigint | null;
  issuer: string | null;
  sector: string | null;
  is_employer: boolean;
  /** timestamptz comes back as a Date from PGlite, as a string from postgres-js. */
  as_of: string | Date;
  source: string;
}

const toPaise = (v: string | number | bigint): Paise => BigInt(v) as Paise;

/**
 * One position set = the latest snapshot from each source, merged. A stale source
 * still contributes its last-known rows; the staleness engine (Task 12) is what
 * flags them — silently dropping them would understate net worth.
 */
export async function loadPositions(db: Db, businessDate?: string): Promise<Position[]> {
  const rows = await db.query<HoldingRow>(
    `with latest as (
       select distinct on (s.source) s.id, s.source
       from snapshots s
       where ($1::date is null or s.business_date <= $1::date)
       order by s.source, s.business_date desc, s.taken_at desc
     )
     select h.instrument_id, i.kind, i.name, h.account, h.value_paise, h.avg_cost_paise,
            i.issuer, i.sector, i.is_employer, h.as_of, h.source
     from holdings h
     join latest l on l.id = h.snapshot_id
     join instruments i on i.id = h.instrument_id`,
    [businessDate ?? null],
  );

  return rows.map((r) => ({
    instrumentId: r.instrument_id,
    kind: r.kind,
    account: r.account,
    valuePaise: toPaise(r.value_paise),
    avgCostPaise: r.avg_cost_paise === null ? null : toPaise(r.avg_cost_paise),
    assetClass: classify(r.kind, r.instrument_id, r.name),
    issuer: r.issuer,
    sector: r.sector,
    isEmployer: r.is_employer,
    asOf: r.as_of instanceof Date ? r.as_of.toISOString() : String(r.as_of),
    source: r.source,
  }));
}

export interface NetWorth {
  assetsPaise: Paise;
  liabilitiesPaise: Paise;
  netPaise: Paise;
  byAccount: Map<Account, Paise>;
  byAssetClass: Map<AssetClass, Paise>;
}

export function netWorth(positions: Position[], liabilitiesPaise: Paise): NetWorth {
  const byAccount = new Map<Account, Paise>();
  const byAssetClass = new Map<AssetClass, Paise>();

  for (const p of positions) {
    byAccount.set(p.account, addP(byAccount.get(p.account) ?? (0n as Paise), p.valuePaise));
    byAssetClass.set(
      p.assetClass,
      addP(byAssetClass.get(p.assetClass) ?? (0n as Paise), p.valuePaise),
    );
  }

  const assetsPaise = addP(...positions.map((p) => p.valuePaise));
  return {
    assetsPaise,
    liabilitiesPaise,
    netPaise: subP(assetsPaise, liabilitiesPaise),
    byAccount,
    byAssetClass,
  };
}

interface LiabilityRow {
  closing_paise: string | number | bigint;
}

/**
 * Closing balance of every loan in the CASCADE scenario as at `asOfMonth`.
 *
 * A plain `where period_month <= $1` returns NOTHING for a loan whose schedule starts
 * after that month, which reports the loan as fully repaid and overstates net worth by
 * its whole balance. Today's cascade starts every loan together so the window is easy to
 * fall outside of, not hard. The lateral fall back to `loans.outstanding_paise` keeps an
 * unscheduled (or not-yet-scheduled) loan counted at its last known balance.
 */
export async function outstandingLiabilities(db: Db, asOfMonth: string): Promise<Paise> {
  const rows = await db.query<LiabilityRow>(
    `select coalesce(latest.closing_paise, l.outstanding_paise) as closing_paise
     from loans l
     left join lateral (
       select ls.closing_paise
       from loan_schedule ls
       where ls.loan_id = l.id and ls.scenario = 'CASCADE' and ls.period_month <= $1::date
       order by ls.period_month desc
       limit 1
     ) latest on true`,
    [asOfMonth],
  );
  return addP(...rows.map((r) => toPaise(r.closing_paise)));
}
