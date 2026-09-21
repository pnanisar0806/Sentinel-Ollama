import type { Db } from '../db/client.js';
import { addP, subP, formatInr, type Paise } from '../money/paise.js';
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
  /** Human-readable name from the instruments table — what /holdings renders. */
  name: string;
  kind: InstrumentKind;
  account: Account;
  valuePaise: Paise;
  /** NULL = unknown cost (FR-02). Never 0, never rendered as Rs 0. */
  avgCostPaise: Paise | null;
  assetClass: AssetClass;
  issuer: string | null;
  /** PRD 3.5 single-sector cap. NULL where the instrument carries no sector. */
  sector: string | null;
  /** FR-31: a non-INR position cannot be valued in rupees while FX is stale. */
  currency: string;
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
  currency: string;
  issuer: string | null;
  sector: string | null;
  is_employer: boolean;
  /** timestamptz comes back as a Date from PGlite, as a string from postgres-js. */
  as_of: string | Date;
  source: string;
  canonical_id: string | null;
}

const toPaise = (v: string | number | bigint): Paise => BigInt(v) as Paise;

/**
 * Reconciliation key: (canonical_id, account). If canonical_id is null, fall back to instrument_id.
 * This is the C-A supersession rule: live source wins per canonical key; seed fills gaps;
 * fallback to seed when live stops reporting.
 */
/**
 * Sources that publish a WHOLE broker account rather than a sample of one, and are
 * therefore authoritative for every account they touch.
 *
 * Authority is DECLARED, never inferred from "this source emitted a row". Inferring it
 * is unsafe: a source reporting one zerodha holding would retire the seed's NIFTYBEES,
 * GOLDBEES and LIQUIDBEES and the money would simply vanish. `RemoteIndmoneySource`
 * qualifies because it aggregates a broker's full book and throws on `holding_error`
 * rather than writing a partial one. Anything else falls back to identity matching.
 */
const ACCOUNT_AUTHORITATIVE_SOURCES = new Set(['indmoney']);

function reconcileKey(row: HoldingRow): string {
  return `${row.canonical_id ?? row.instrument_id}|${row.account}`;
}

/**
 * One position set = the latest snapshot from each source, merged with C-A reconciliation.
 *
 * Reconciliation rules (owner decision 2026-08-23):
 * 1. The live source (indmoney) wins per (canonical_id, account) when present.
 * 2. Seed (manual-seed) fills gaps for instruments no live source reports.
 * 3. If a live source previously reported an instrument but stops, fall back to seed.
 *
 * Within a single source, NO deduplication — each source manages its own aggregation
 * (INDmoney aggregates in RemoteIndmoneySource).
 *
 * That rule holds only while exactly ONE live portfolio source exists. A second live
 * source covering an account the first already aggregates is summed, not merged: adding
 * Kite alongside INDmoney double-counted the Zerodha account by Rs 14,72,851 before it
 * was retired (2026-09-07). Any new live source must either cover disjoint accounts or
 * arrive with an explicit precedence rule.
 *
 * A stale source still contributes its last-known rows; the staleness engine (Task 12)
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
     select h.instrument_id, i.kind, i.name, h.account, h.value_paise,
            coalesce(h.avg_cost_paise, oc.cost_paise) as avg_cost_paise,
            coalesce(cn.curated_name, i.name) as name,
            i.currency, i.issuer, i.sector, i.is_employer, h.as_of, h.source, i.canonical_id
     from holdings h
     join latest l on l.id = h.snapshot_id
     join instruments i on i.id = h.instrument_id
     left join lateral (
       -- Owner-ingested cost basis (source 'owner-telegram') lives as an open lot and
       -- must survive daily re-syncs: holdings are replaced per snapshot, lots are not.
       -- The NEWEST open lot wins; a closed lot is disposal history, never cost input.
       select l.cost_paise
       from lots l
       where l.instrument_id = h.instrument_id
         and l.account = h.account
         and l.closed_on is null
       order by l.as_of desc, l.acquired_on desc
       limit 1
     ) oc on true
     left join lateral (
       -- Curated display name: when a live row shares a canonical identity with an
       -- owner-verified instrument (BOND:/MF:/NSE:/EPF:/US: ids are seed-created),
       -- prefer the seed's name. This is what turns INDmoney's stale 'Indiabulls
       -- Housing Finance' back into 'Sammaan Capital 9% 26-Sep-2026'. CASH is exempt:
       -- the seed's generic 'Savings account' is LESS informative than the live
       -- 'HDFC Bank (XX6652)'.
       select c.name as curated_name
       from instruments c
       where c.canonical_id = i.canonical_id
         and c.id <> i.id
         and c.kind <> 'CASH'
         and c.id ~ '^(BOND|MF|NSE|EPF|US):'
       order by c.id
       limit 1
     ) cn on true`,
    [businessDate ?? null],
  );

  // First pass: which ACCOUNTS a live source reports at all, plus the per-key and
  // per-canonical matches used to carry owner-verified cost across a supersession.
  const liveAccounts = new Set<string>();
  const liveKeys = new Set<string>();
  const liveCanonicals = new Set<string>();
  for (const r of rows) {
    if (r.source !== 'manual-seed') {
      if (ACCOUNT_AUTHORITATIVE_SOURCES.has(r.source)) liveAccounts.add(r.account);
      liveKeys.add(reconcileKey(r));
      if (r.canonical_id) liveCanonicals.add(r.canonical_id);
    }
  }

  /**
   * Supersession is PER ACCOUNT (2026-09-20), not per instrument.
   *
   * A live source publishes a whole broker account, not a sampling of it: INDmoney is
   * authoritative for zerodha, indmoney, bank, epf and groww, and knows nothing about
   * fidelity. So once it reports ANY row for an account, every seed row for that
   * account is superseded — the seed is the bootstrap, and live has taken over.
   *
   * This replaces three identity heuristics that each failed differently. Matching by
   * (canonical, account) missed rows the seed had labelled with a guessed broker.
   * Matching by canonical alone missed CASH:SAVINGS, whose canonical
   * `CASH:SAVINGS_HDFC_FEDERAL` matches neither live bank row (both carry a NULL
   * canonical_id) — it was double counting Rs 1,63,000 of cash, and that inflated
   * figure was what the owner's 10% cash ceiling was judged against. And a lump
   * placeholder can NEVER match a constituent set, which is why `BASKET_PLACEHOLDERS`
   * had to name the residue and the INDmoney basket by hand — a list that needs a new
   * entry every time a placeholder is invented. Account coverage needs none.
   *
   * `US:NOW` survives, correctly: the Fidelity RSU is on an account no live source
   * reports, which is exactly what a gap-fill is.
   *
   * When the retiring seed row carried an owner-verified cost and its live twin has
   * none (the bond face-value trap), that cost is CARRIED OVER to the survivor —
   * verified data must not die with a superseded row.
   */
  interface Entry { pos: Position; row: HoldingRow }
  const entries: Entry[] = [];
  const orphanedSeedCost = new Map<string, Paise>();

  for (const r of rows) {
    const key = reconcileKey(r);
    if (r.source === 'manual-seed') {
      const covered = liveAccounts.has(r.account)
        || liveKeys.has(key)
        || (r.canonical_id ? liveCanonicals.has(r.canonical_id) : false);
      if (covered) {
        // A seed row dropped by account coverage that ALSO had no identity match is the
        // one case where money could silently vanish: live owns the account but never
        // reported this holding. RemoteIndmoneySource throws on a partial book rather
        // than writing one, so this should not happen — say so loudly if it ever does.
        const identityMatched = liveKeys.has(key)
          || (r.canonical_id ? liveCanonicals.has(r.canonical_id) : false);
        if (!identityMatched) {
          console.error(
            `seed row ${r.instrument_id} (${r.account}, ${formatInr(toPaise(r.value_paise))}) ` +
            'dropped because a live source owns that account, but no live row matches it — ' +
            'verify the live book is complete for that account',
          );
        }
        if (r.avg_cost_paise !== null) {
          orphanedSeedCost.set(r.canonical_id ?? r.instrument_id, toPaise(r.avg_cost_paise));
        }
        continue;
      }
    }
    entries.push({
      row: r,
      pos: {
        instrumentId: r.instrument_id,
        name: r.name,
        kind: r.kind,
        account: r.account,
        valuePaise: toPaise(r.value_paise),
        avgCostPaise: r.avg_cost_paise === null ? null : toPaise(r.avg_cost_paise),
        assetClass: classify(r.kind, r.instrument_id, r.name),
        currency: r.currency,
        issuer: r.issuer,
        sector: r.sector,
        isEmployer: r.is_employer,
        asOf: r.as_of instanceof Date ? r.as_of.toISOString() : String(r.as_of),
        source: r.source,
      },
    });
  }

  // Cost carryover happens only onto LIVE survivors — a surviving seed twin keeps its
  // own cost untouched.
  if (orphanedSeedCost.size) {
    for (const e of entries) {
      if (e.row.source === 'manual-seed' || e.pos.avgCostPaise !== null) continue;
      const canon = e.row.canonical_id;
      if (canon && orphanedSeedCost.has(canon)) {
        e.pos.avgCostPaise = orphanedSeedCost.get(canon)!;
        orphanedSeedCost.delete(canon);
      }
    }
  }

  return entries.map((e) => e.pos);
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