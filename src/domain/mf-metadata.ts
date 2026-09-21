import type { Db } from '../db/client.js';

/**
 * Fund facts that are not a NAV.
 *
 * `rankMfs` weights consistency 40 / expense 20 / tenure 15 / aum 15 / style 10. Four of
 * those five had no column in the schema, so a ranking would have silently scored 60 of
 * 100 as zero. INDmoney supplies expense ratio and AUM; tenure and style drift it does
 * not, and they stay absent rather than proxied.
 *
 * Worth knowing before reading much into the AUM leg: `rankMfs` ramps AUM from 100 to
 * 2,000 crore, and every fund the owner holds is between 17,254 and 148,429 crore. All
 * six therefore score the full 15, so AUM does not separate them at all — **expense is
 * the only one of the two that changes the ordering.**
 */
export interface MfMetadata {
  instrumentId: string;
  asOf: string;
  /** Basis points. INDmoney reports percent, so this is that × 100. */
  expenseRatioBps: number | null;
  aumPaise: bigint | null;
  category: string | null;
  benchmarkName: string | null;
}

/** 1 crore rupees = 1e7 rupees = 1e9 paise. */
export const CRORE_PAISE = 1_000_000_000n;

/**
 * INDmoney's `aum` is in RUPEES CRORE. Verified 2026-09-21 against known fund sizes
 * (ICICI Nifty 50 Index 17,254 cr, HDFC Mid Cap 108,325 cr, PPFC 148,429 cr) rather than
 * inferred from the field name — a unit error here would be invisible and would score
 * every fund identically.
 */
export function aumCroreToPaise(crore: number): bigint | null {
  if (!Number.isFinite(crore) || crore <= 0) return null;
  return BigInt(Math.round(crore)) * CRORE_PAISE;
}

/** INDmoney reports the expense ratio as a percent: 0.69 means 69bps. */
export function expensePctToBps(pct: number): number | null {
  if (!Number.isFinite(pct) || pct < 0) return null;
  return Math.round(pct * 100);
}

/** Idempotent per (instrument, as_of): a re-run the same day adds nothing. */
export async function persistMfMetadata(
  db: Db,
  rows: readonly MfMetadata[],
  source = 'indmoney',
): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const inserted = await db.query<{ id: string }>(
      `insert into mf_metadata
         (instrument_id, as_of, expense_ratio_bps, aum_paise, category, benchmark_name, source)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (instrument_id, as_of) do nothing
       returning id`,
      [r.instrumentId, r.asOf, r.expenseRatioBps,
       r.aumPaise === null ? null : r.aumPaise.toString(),
       r.category, r.benchmarkName, source],
    );
    if (inserted.length > 0) written += 1;
  }
  return written;
}

/**
 * The most recent metadata per instrument.
 *
 * Resolved through `canonical_id`, not the raw instrument id: AMFI and INDmoney key the
 * same fund differently, the seed `MF:*` rows carry the ISIN while the live `IND:*` rows
 * do not, and per-account supersession retires the seed rows from `positions`. Looking
 * up by raw id would miss whichever side the caller happens to hold.
 */
export async function loadMfMetadata(db: Db): Promise<Map<string, MfMetadata>> {
  const rows = await db.query<{
    instrument_id: string; canonical_id: string | null; as_of: string | Date;
    expense_ratio_bps: number | null; aum_paise: string | number | null;
    category: string | null; benchmark_name: string | null;
  }>(
    `select distinct on (m.instrument_id)
            m.instrument_id, i.canonical_id, m.as_of, m.expense_ratio_bps,
            m.aum_paise, m.category, m.benchmark_name
       from mf_metadata m
       join instruments i on i.id = m.instrument_id
      order by m.instrument_id, m.as_of desc`,
  );

  const out = new Map<string, MfMetadata>();
  for (const r of rows) {
    const value: MfMetadata = {
      instrumentId: r.instrument_id,
      asOf: r.as_of instanceof Date ? r.as_of.toISOString().slice(0, 10) : String(r.as_of),
      expenseRatioBps: r.expense_ratio_bps,
      aumPaise: r.aum_paise === null ? null : BigInt(r.aum_paise),
      category: r.category,
      benchmarkName: r.benchmark_name,
    };
    out.set(r.instrument_id, value);
    // Keyed under the canonical id too, so a caller holding either side of the
    // MF:* / IND:* pair finds it.
    if (r.canonical_id !== null && !out.has(r.canonical_id)) out.set(r.canonical_id, value);
  }
  return out;
}
