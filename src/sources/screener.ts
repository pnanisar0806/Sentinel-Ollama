import type { Db } from '../db/client.js';

class SourceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/**
 * Pinned column contract for a screener.in export.
 *
 * ⚠️ THIS SPEC DOES NOT MATCH A REAL SCREENER EXPORT. Checked against a live logged-in
 * screen on 2026-09-13: the actual result table reads `S.No. | Company | CMP Rs. | P/E |
 * Mar Cap Rs.Cr. | Div Yld % | NP Qtr Rs.Cr. | Qtr Profit Var % | Sales Qtr Rs.Cr. |
 * Qtr Sales Var % | ROCE % | Debt / Eq`. Only `P/E` overlaps with the names below, so a
 * real export parsed against this spec yields a warning per row and no data at all.
 *
 * Screener has an "EDIT COLUMNS" control, so several of the missing fields (ROE, P/B, EPS,
 * 5-year CAGRs, promoter holding) can be added to a screen — but `Symbol`, `Industry`,
 * `FCF 5Y` and `Red Flags` have no native equivalent, and the quality gate reads the last
 * two. The instrument mapping also assumes a ticker column that the export does not have;
 * screener identifies a row by company NAME.
 *
 * Left in place deliberately rather than guessed at a second time: the resolution is one
 * real exported file from the owner's account, which is the standing live-test item.
 */
export const SCREENER_COLUMNS = [
  'Name',                    // Company name
  'Symbol',                  // NSE symbol (e.g., RELIANCE)
  'Industry',                // Industry classification
  'Current Price',           // Current market price
  'Market Cap',              // Market capitalization
  'P/E',                     // Price to Earnings
  'P/B',                     // Price to Book
  'Div Yield %',             // Dividend yield
  'ROCE %',                  // Return on Capital Employed
  'ROE %',                   // Return on Equity
  'Debt to Equity',          // Debt/Equity ratio
  'EPS',                     // Earnings per share
  'Sales 5Y CAGR %',         // 5-year sales CAGR
  'Profit 5Y CAGR %',        // 5-year profit CAGR
  'FCF 5Y',                  // Free cash flow 5Y (positive/negative)
  'Red Flags',               // Count of red flags
  'Promoter Holding %',      // Promoter shareholding
  'FII Holding %',           // FII shareholding
  'DII Holding %',           // DII shareholding
] as const;

export interface ScreenerRow {
  name: string;
  symbol: string;
  industry: string;
  currentPrice: number;
  marketCap: number;
  peRatio: number | null;
  pbRatio: number | null;
  divYieldPct: number | null;
  rocePct: number | null;
  roePct: number | null;
  deRatio: number | null;
  eps: number | null;
  sales5yCagr: number | null;
  profit5yCagr: number | null;
  fcfPos5y: boolean | null;
  redFlags: number | null;
  promoterHoldingPct: number | null;
  fiiHoldingPct: number | null;
  diiHoldingPct: number | null;
  raw: Record<string, string>;
}

export interface ScreenerParseResult {
  records: ScreenerRow[];
  warnings: string[];
}

function parseNumber(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, '').replace(/%/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'na') return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function parseBool(s: string | undefined): boolean | null {
  if (!s) return null;
  const cleaned = s.trim().toLowerCase();
  if (!cleaned || cleaned === '-' || cleaned === 'na') return null;
  return cleaned === 'true' || cleaned === 'yes' || cleaned === '1' || cleaned === 'positive';
}

export function parseScreenerCsv(text: string): ScreenerParseResult {
  const lines = text.trim().split('\n');
  if (lines.length < 2) {
    return { records: [], warnings: ['Empty or header-only CSV'] };
  }

  const headerLine = lines[0];
  if (!headerLine) return { records: [], warnings: ['Empty CSV'] };
  const headers = headerLine.split(',').map(h => h.trim());
  const records: ScreenerRow[] = [];
  const warnings: string[] = [];

  // Check for missing required columns
  for (const req of ['Name', 'Symbol']) {
    if (!headers.includes(req)) {
      warnings.push(`Missing required column: ${req}`);
    }
  }

  // Warn about extra columns not in pinned contract
  const extraCols = headers.filter(h => !SCREENER_COLUMNS.includes(h as typeof SCREENER_COLUMNS[number]));
  if (extraCols.length > 0) {
    warnings.push(`Extra columns ignored: ${extraCols.join(', ')}`);
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length !== headers.length) {
      warnings.push(`Row ${i}: column count mismatch (expected ${headers.length}, got ${parts.length})`);
      continue;
    }

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (!header) continue;
      const val = parts[j];
      row[header] = val?.trim() ?? '';
    }

    // Skip rows with missing name or symbol
    if (!row['Name'] || !row['Symbol']) {
      warnings.push(`Row ${i}: missing name or symbol`);
      continue;
    }

    const record: ScreenerRow = {
      name: row['Name'],
      symbol: row['Symbol'],
      industry: row['Industry'] ?? '',
      currentPrice: parseNumber(row['Current Price']) ?? 0,
      marketCap: parseNumber(row['Market Cap']) ?? 0,
      peRatio: parseNumber(row['P/E']),
      pbRatio: parseNumber(row['P/B']),
      divYieldPct: parseNumber(row['Div Yield %']),
      rocePct: parseNumber(row['ROCE %']),
      roePct: parseNumber(row['ROE %']),
      deRatio: parseNumber(row['Debt to Equity']),
      eps: parseNumber(row['EPS']),
      sales5yCagr: parseNumber(row['Sales 5Y CAGR %']),
      profit5yCagr: parseNumber(row['Profit 5Y CAGR %']),
      fcfPos5y: parseBool(row['FCF 5Y']),
      redFlags: parseNumber(row['Red Flags']) ?? 0,
      promoterHoldingPct: parseNumber(row['Promoter Holding %']),
      fiiHoldingPct: parseNumber(row['FII Holding %']),
      diiHoldingPct: parseNumber(row['DII Holding %']),
      raw: row,
    };

    records.push(record);
  }

  return { records, warnings };
}

export async function importScreener(
  db: Db,
  csvText: string,
  opts: { filename?: string; asOf?: string } = {}
): Promise<{ uploadedId: number; inserted: number; warnings: string[] }> {
  const { records, warnings } = parseScreenerCsv(csvText);
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const filename = opts.filename ?? `screener-${asOf}.csv`;

  // Check if upload already exists (idempotent on as_of + filename)
  const existingUpload = await db.query<{ id: number }>(
    `select id from screener_uploads where as_of = $1 and filename = $2`,
    [asOf, filename],
  );
  let uploadId: number;
  if (existingUpload.length > 0) {
    uploadId = existingUpload[0]!.id;
    // Clear existing fundamentals for this upload to allow re-import
    await db.query(`delete from fundamentals where upload_id = $1`, [uploadId]);
  } else {
    const [upload] = await db.query<{ id: number }>(
      `insert into screener_uploads (as_of, filename, source) values ($1, $2, 'screener-in') returning id`,
      [asOf, filename],
    );
    uploadId = upload!.id;
  }

  // Map symbols to instrument_ids
  // The screener CSV uses symbols like "RELIANCE" but instruments table has IDs like "NSE:RELIANCE"
  // We need to find instruments where the ID ends with ":" + symbol
  const symbols = [...new Set(records.map(r => r.symbol))];
  const conditions = symbols.map((_, i) => `id LIKE '%:' || $${i + 1}`).join(' OR ');
  const instruments = await db.query<{ id: string }>(
    `select id from instruments where ${conditions}`,
    symbols,
  );
  // Build mapping from symbol (e.g., RELIANCE) to instrument_id (e.g., NSE:RELIANCE)
  const symbolToId = new Map<string, string>();
  for (const inst of instruments) {
    const parts = inst.id.split(':');
    if (parts.length === 2 && parts[1]) {
      symbolToId.set(parts[1], inst.id);
    }
    // Also allow direct match if the full ID matches a symbol
    if (symbols.includes(inst.id)) {
      symbolToId.set(inst.id, inst.id);
    }
  }
  // Also add direct matches for any symbols that exactly match an instrument ID
  for (const sym of symbols) {
    if (!symbolToId.has(sym)) {
      const direct = await db.query<{ id: string }>(
        `select id from instruments where id = $1`,
        [sym],
      );
      if (direct.length > 0 && direct[0]) {
        symbolToId.set(sym, direct[0]!.id);
      }
    }
  }

  let inserted = 0;
  for (const r of records) {
    const instrumentId = symbolToId.get(r.symbol);
    if (!instrumentId) {
      warnings.push(`Unknown symbol in screener: ${r.symbol} (${r.name})`);
      continue;
    }

    const rawJson = JSON.stringify(r.raw);

    await db.query(
      `insert into fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, fcf_pos_5y, red_flags)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (upload_id, instrument_id) do update set
         data = excluded.data,
         roce_pct = excluded.roce_pct,
         de_ratio = excluded.de_ratio,
         fcf_pos_5y = excluded.fcf_pos_5y,
         red_flags = excluded.red_flags`,
      [
        uploadId,
        instrumentId,
        rawJson,
        r.rocePct ?? null,
        r.deRatio ?? null,
        r.fcfPos5y ?? null,
        r.redFlags ?? null,
      ],
    );
    inserted++;
  }

  return { uploadedId: uploadId, inserted, warnings };
}