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
 * Canonical column names extracted from screener.in HTML `data-tooltip` attributes.
 * The screen's EDIT COLUMNS controls which of these appear — the parser handles
 * any subset.
 */
export const COLUMN_MAP: Record<string, string> = {
  'Current Price':            'CMP',
  'Price to Earning':         'P/E',
  'Market Capitalization':    'Mar Cap',
  'Dividend yield':           'Div Yld',
  'Net Profit latest quarter': 'NP Qtr',
  'YOY Quarterly profit growth': 'Qtr Profit Var',
  'Sales latest quarter':     'Sales Qtr',
  'YOY Quarterly sales growth': 'Qtr Sales Var',
  'Return on capital employed': 'ROCE',
  'Return on equity':         'ROE',
  'Average return on equity 3Years': 'ROE 3Yr',
  'Average return on equity 5Years': 'ROE 5Yr',
  'Debt to equity':           'D/E',
  'Historical Price to Book Value 5Years': 'P/B',
  'EPS':                      'EPS',
  'Sales 5Years CAGR':        'Sales 5Y CAGR',
  'Profit 5Years CAGR':       'Profit 5Y CAGR',
  'Free cash flow 5Years':    'FCF 5Y',
  'Red Flags':                'Red Flags',
  'Promoter Holding':         'Promoter Holding',
  'Pledged percentage':       'Pledged %',
};

export interface ParsedScreenRow {
  /** Company display name as shown on screener.in */
  name: string;
  /** URL slug extracted from the <a href="/company/SLUG/"> — typically the NSE symbol */
  slug: string;
  /** All column values keyed by short name (e.g. 'CMP', 'P/E', 'ROCE') */
  columns: Record<string, string>;
  /** Numeric convenience accessors for the columns the engine reads */
  cmp: number;
  pe: number | null;
  marketCap: number | null;
  divYieldPct: number | null;
  rocePct: number | null;
  roePct: number | null;
  deRatio: number | null;
}

export interface ScreenParseResult {
  rows: ParsedScreenRow[];
  headers: string[];
  warnings: string[];
}

function parseNumber(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, '').replace(/%/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'na') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Strip HTML tags and collapse whitespace — used for header text that may contain <span>. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** Strip unit suffixes from header text (e.g. "CMP Rs." → "CMP", "ROCE %" → "ROCE"). */
function normalizeHeader(s: string): string {
  return stripTags(s)
    .replace(/\s+Rs\.Cr\.$/, '')
    .replace(/\s+Rs\.$/, '')
    .replace(/\s+%$/, '')
    .trim();
}

/**
 * Parse a single page of screener.in HTML table into structured rows.
 *
 * The HTML structure is:
 * ```html
 * <table class="data-table ...">
 *   <tr>
 *     <th data-tooltip="Price to Earning" ...><a>P/E</a></th>
 *     ...
 *   </tr>
 *   <tr data-row-company-id="123">
 *     <td class="text">1.</td>
 *     <td class="text"><a href="/company/SLUG/">Company Name</a></td>
 *     <td>7518.00</td><td>30.86</td>...
 *   </tr>
 * ```
 */
export function parseScreenHtml(html: string): ScreenParseResult {
  const warnings: string[] = [];
  const rows: ParsedScreenRow[] = [];

  // --- Extract headers from <th> tags ---
  // Match: <th data-tooltip="TOOLTIP" ...>...<a ...>VISIBLE<...</a>...</th>
  // Capture only direct text of <a> (before any child <span> or other tags).
  const thPattern = /<th\b[^>]*?(?:data-tooltip="([^"]*)")?[^>]*>[\s\S]*?<a[^>]*>\s*([^<]+?)(?:\s*<|$)/gi;
  const rawHeaders: Array<{ tooltip: string; text: string }> = [];
  let thMatch: RegExpExecArray | null;
  while ((thMatch = thPattern.exec(html)) !== null) {
    const tooltip = (thMatch[1] ?? '').trim();
    const text = unescapeHtml(thMatch[2] ?? '');
    rawHeaders.push({ tooltip, text });
  }

  if (rawHeaders.length === 0) {
    return { rows: [], headers: [], warnings: ['No <th> headers found — not a screener table?'] };
  }

  // Build header list: use tooltip (canonical) when available, else normalized text
  const headers: string[] = rawHeaders.map(h => {
    if (h.tooltip) return COLUMN_MAP[h.tooltip] ?? normalizeHeader(h.tooltip);
    return normalizeHeader(h.text);
  });

  // --- Extract data rows ---
  // Match each <tr> that has data-row-company-id
  const rowPattern = /<tr\s+data-row-company-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const companyId = rowMatch[1];
    const rowHtml = rowMatch[2];
    if (rowHtml === undefined) continue;

    // Extract company name and slug from <a href="/company/SLUG/"> or <a href="/company/SLUG/consolidated/">
    const linkMatch = /<a\s+href="\/company\/([^/]+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    const slugRaw = linkMatch?.[1];
    const nameRaw = linkMatch?.[2];
    if (!slugRaw || !nameRaw) {
      warnings.push(`Row ${companyId}: no company link found, skipping`);
      continue;
    }
    const slug = slugRaw.toUpperCase();
    const name = unescapeHtml(nameRaw);

    // Extract all <td> values
    const tdPattern = /<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/gi;
    const values: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdPattern.exec(rowHtml)) !== null) {
      const cell = tdMatch?.[1];
      if (cell !== undefined) values.push(unescapeHtml(cell));
    }

    // First td is S.No., second is Company name (already extracted), rest are data columns
    // The data values start at index 2 (after S.No. and Company)
    const dataValues = values.slice(2);

    // Build column map (skip S.No. and Company name columns)
    const columns: Record<string, string> = {};
    for (let i = 0; i < dataValues.length && i + 2 < rawHeaders.length; i++) {
      const headerKey = headers[i + 2] ?? rawHeaders[i + 2]?.tooltip ?? `col_${i}`;
      columns[headerKey] = dataValues[i] ?? '';
    }

    const pe = parseNumber(columns['P/E']);
    const marketCap = parseNumber(columns['Mar Cap']);
    const divYieldPct = parseNumber(columns['Div Yld']);
    const rocePct = parseNumber(columns['ROCE']);
    const roePct = parseNumber(columns['ROE']);
    const deRatio = parseNumber(columns['D/E']);
    const cmp = parseNumber(columns['CMP']) ?? 0;

    rows.push({
      name,
      slug,
      columns,
      cmp,
      pe,
      marketCap,
      divYieldPct,
      rocePct,
      roePct,
      deRatio,
    });
  }

  if (rows.length === 0) {
    warnings.push('No data rows found (no tr with data-row-company-id)');
  }

  return { rows, headers, warnings };
}

/**
 * Fetch all pages of a screener.in screen URL.
 * Screens are paginated with ?page=N (25 rows per page).
 * Stops when a page returns fewer than 25 data rows or maxPages is reached.
 */
export async function fetchScreen(
  screenUrl: string,
  opts: { maxPages?: number; delayMs?: number } = {},
): Promise<ScreenParseResult & { pagesFetched: number }> {
  const maxPages = opts.maxPages ?? 10;
  const delayMs = opts.delayMs ?? 1500;
  const allRows: ParsedScreenRow[] = [];
  const allWarnings: string[] = [];
  let headers: string[] = [];
  let pagesFetched = 0;

  const base = screenUrl.replace(/[?#].*$/, '');
  const separator = screenUrl.includes('?') ? '&' : '?';

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? screenUrl : `${base}${separator}page=${page}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!resp.ok) {
      throw new SourceError('SCREENER_HTTP', `screener.in returned ${resp.status} for page ${page}`, resp.status >= 500);
    }

    const html = await resp.text();

    // Sanity: if the HTML doesn't look like a screen page, stop
    if (!html.includes('data-table')) {
      allWarnings.push(`Page ${page}: no data-table found, stopping pagination`);
      break;
    }

    const parsed = parseScreenHtml(html);
    allWarnings.push(...parsed.warnings.map(w => `Page ${page}: ${w}`));

    if (parsed.rows.length === 0) break;
    if (headers.length === 0 && parsed.headers.length > 0) {
      headers = parsed.headers;
    }

    allRows.push(...parsed.rows);
    pagesFetched++;

    // If fewer than 25 rows, this is the last page
    if (parsed.rows.length < 25) break;

    // Politeness delay between pages
    if (page < maxPages) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { rows: allRows, headers, warnings: allWarnings, pagesFetched };
}

/**
 * Map a screener slug (e.g. "PGHH") to an instrument_id in the DB.
 * Screener slugs are typically the NSE symbol.
 * Falls back to fuzzy name match if slug lookup fails.
 */
export async function slugToInstrumentId(
  db: Db,
  slug: string,
  name: string,
): Promise<string | null> {
  // Primary: slug is usually the NSE symbol
  const nseId = `NSE:${slug}`;
  const [exact] = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE id = $1`,
    [nseId],
  );
  if (exact) return exact.id;

  // Secondary: try BSE
  const bseId = `BSE:${slug}`;
  const [bse] = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE id = $1`,
    [bseId],
  );
  if (bse) return bse.id;

  // Fallback: name-based fuzzy match
  const [fuzzy] = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name],
  );
  if (fuzzy) return fuzzy.id;

  // Last resort: slug in any instrument ID
  const [any] = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE id LIKE '%' || $1 || '%' LIMIT 1`,
    [slug],
  );
  return any?.id ?? null;
}

/**
 * Import parsed screen rows into fundamentals table.
 * Returns the upload ID, count of inserted rows, and any warnings.
 */
export async function importScreenRows(
  db: Db,
  rows: ParsedScreenRow[],
  opts: { asOf?: string; screenUrl?: string } = {},
): Promise<{ uploadedId: number; inserted: number; warnings: string[] }> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const screenUrl = opts.screenUrl ?? 'screener-screen';
  const warnings: string[] = [];

  // Check for existing upload (idempotent on as_of + filename)
  const existing = await db.query<{ id: number }>(
    `SELECT id FROM screener_uploads WHERE as_of = $1 AND filename = $2`,
    [asOf, screenUrl],
  );

  let uploadId: number;
  if (existing.length > 0) {
    uploadId = existing[0]!.id;
    // Clear old fundamentals for this upload (fundamentals allows DELETE)
    await db.query(`DELETE FROM fundamentals WHERE upload_id = $1`, [uploadId]);
  } else {
    const [upload] = await db.query<{ id: number }>(
      `INSERT INTO screener_uploads (as_of, filename, source)
       VALUES ($1, $2, 'screener-screen')
       RETURNING id`,
      [asOf, screenUrl],
    );
    uploadId = upload!.id;
  }

  let inserted = 0;
  for (const row of rows) {
    const instrumentId = await slugToInstrumentId(db, row.slug, row.name);
    if (!instrumentId) {
      warnings.push(`Unknown instrument: ${row.name} (${row.slug})`);
      continue;
    }

    const rawJson = JSON.stringify(row.columns);

    await db.query(
      `INSERT INTO fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, as_of)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        uploadId,
        instrumentId,
        rawJson,
        row.rocePct ?? null,
        row.deRatio ?? null,
      ],
    );
    inserted++;
  }

  return { uploadedId: uploadId, inserted, warnings };
}
