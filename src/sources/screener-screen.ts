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
  // Screener labels the 5Y growth columns "Profit/Sales growth 5Years" (tooltip)
  // and renders them as "Profit Var 5Yrs %" / "Sales Var 5Yrs %" (visible text).
  'Profit growth 5Years':     'Profit 5Y CAGR',
  'Sales growth 5Years':      'Sales 5Y CAGR',
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
  /** True when the 5Y average FCF is positive; null when screener has no figure. */
  fcfPos5y: boolean | null;
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
  const text = stripTags(s)
    .replace(/\s+Rs\.Cr\.$/, '')
    .replace(/\s+Rs\.$/, '')
    .replace(/\s+%$/, '')
    .trim();
  // Visible header text can be either the short form or a spaced alias
  return TEXT_ALIAS[text] ?? text;
}

/** Aliases for visible (tooltip-less) header text that differs from the canonical key. */
const TEXT_ALIAS: Record<string, string> = {
  'Debt / Eq': 'D/E',
  'Profit Var 5Yrs': 'Profit 5Y CAGR',
  'Sales Var 5Yrs': 'Sales 5Y CAGR',
  'Free Cash Flow 5Yrs': 'FCF 5Y',
  'EPS 12M': 'EPS',
};

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
    // "Free Cash Flow 5Yrs Rs.Cr." is the 5Y average. A positive average is the
    // proxy we can get from a single screener column for fcf_pos_5y (spread across
    // several years, an accrued negative is visible risk).
    const fcfAverage = parseNumber(columns['FCF 5Y']);
    const fcfPos5y = fcfAverage === null ? null : fcfAverage > 0;

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
      fcfPos5y,
    });
  }

  if (rows.length === 0) {
    warnings.push('No data rows found (no tr with data-row-company-id)');
  }

  return { rows, headers, warnings };
}

/**
 * Parse a pasted or exported screener screen table.
 *
 * The owner's signed-in screen view exposes the growth columns that the public
 * page omits (Free Cash Flow 5Yrs / Profit Var 5Yrs / Sales Var 5Yrs). The CSV
 * export carries them too, but it requires a login; a copy-pasted table is the
 * working route. Delimited-table input (tab-separated paste OR the screen's
 * comma-separated CSV export, detected from the first line) repeats the header
 * row every ~15 rows (one per screen page) and empty cells come through as empty
 * fields, so the parser must (a) reset column mappings on every header line and
 * (b) treat short rows as trailing-empty, never as misaligned.
 *
 * Rows carry no URL slug — only the display name — so identity resolution is
 * name-only, handled by `slugToInstrumentId`'s name fallback.
 */
export function parseScreenPaste(text: string): ScreenParseResult {
  const warnings: string[] = [];
  const rows: ParsedScreenRow[] = [];
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  let headers: string[] = [];
  let seenHeader = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line.split(delimiter).map(c => c.trim());
    const first = cells[0] ?? '';

    if (first === 'S.No.' || first === 'Seq.') {
      // Header line (repeats every screen page, i.e. every ~15 rows).
      // First two cells are S.No. / Company; the rest are metric columns.
      headers = cells.map((c, i) => (i < 2 ? c : normalizeHeader(c)));
      seenHeader = true;
      continue;
    }
    if (!seenHeader) {
      warnings.push('Data row before any header — skipping');
      continue;
    }
    if (!/^\d+\.?$/.test(first)) {
      warnings.push(`Non-header, non-data row skipped: ${line.slice(0, 40)}`);
      continue;
    }
    const name = cells[1] ?? '';
    if (!name) {
      warnings.push(`Row ${first}: no company name, skipping`);
      continue;
    }

    // Map data cells to metric columns starting at index 2 (past S.No./Company).
    // A row shorter than the header means trailing columns were empty.
    const columns: Record<string, string> = {};
    for (let i = 2; i < cells.length && i < headers.length; i++) {
      columns[headers[i] ?? `col_${i}`] = cells[i] ?? '';
    }

    const pe = parseNumber(columns['P/E']);
    const marketCap = parseNumber(columns['Mar Cap']);
    const divYieldPct = parseNumber(columns['Div Yld']);
    const rocePct = parseNumber(columns['ROCE']);
    const roePct = parseNumber(columns['ROE']);
    const deRatio = parseNumber(columns['D/E']);
    const cmp = parseNumber(columns['CMP']) ?? 0;
    const fcfAverage = parseNumber(columns['FCF 5Y']);
    const fcfPos5y = fcfAverage === null ? null : fcfAverage > 0;

    rows.push({
      name,
      slug: '',
      columns,
      cmp,
      pe,
      marketCap,
      divYieldPct,
      rocePct,
      roePct,
      deRatio,
      fcfPos5y,
    });
  }

  if (rows.length === 0 && seenHeader) {
    warnings.push('No data rows found (header present but no numbered rows)');
  }

  return { rows, headers, warnings };
}

/**
 * Fetch all pages of a screener.in screen URL.
 * Screens are paginated with ?page=N (25 rows per page).
 * Stops when a page returns fewer than 25 data rows or maxPages is reached.
 * maxPages is only a safety valve against a runaway loop: real screens end on a
 * short page long before it (the owner's sentinel screen spans 17 pages, not 10),
 * so the default of 100 keeps the short-page break the real terminator.
 */
export async function fetchScreen(
  screenUrl: string,
  opts: { maxPages?: number; delayMs?: number } = {},
): Promise<ScreenParseResult & { pagesFetched: number }> {
  const maxPages = opts.maxPages ?? 100;
  const delayMs = opts.delayMs ?? 1500;
  const allRows: ParsedScreenRow[] = [];
  const allWarnings: string[] = [];
  let headers: string[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    // Screens can carry their own query string (`raw/?query=...`), so the page param must
    // be set INTO the URL, never appended to a stripped base — the old `base + '?page=N'`
    // lost `query=` on page 2 for every such screen.
    const url = new URL(screenUrl);
    url.searchParams.set('page', String(page));
    const pageUrl = url.toString();

    const resp = await fetch(pageUrl, {
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

/** Strip common company suffixes for fuzzy matching. */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|inc|corp|corporation|company|co|india|industries|inds|lab|labs|pharma|engg|engineering|motors|insurance|finance|financial|holdings|group|intl|international)\b\.?/g, '')
    .replace(/[&.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  // Try exact lowercase match first
  const [fuzzy] = await db.query<{ id: string }>(
    `SELECT id FROM instruments WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name],
  );
  if (fuzzy) return fuzzy.id;

  // Check screener_name_aliases table (manual mapping from CSV display names)
  const [alias] = await db.query<{ instrument_id: string }>(
    `SELECT instrument_id FROM screener_name_aliases WHERE csv_name = $1`,
    [name],
  );
  if (alias) return alias.instrument_id;

  // Relaxed: strip common suffixes from both sides and compare
  const normalizedInput = normalizeCompanyName(name);
  if (normalizedInput !== name) {
    const rows = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM instruments`,
    );
    for (const row of rows) {
      if (normalizeCompanyName(row.name) === normalizedInput) {
        return row.id;
      }
    }
  }

  // Further relaxed: check if input is a prefix of instrument name (or vice versa)
  // Guard: require non-trivial name to avoid empty-string matching everything
  if (name.trim().length >= 3) {
    const [prefixMatch] = await db.query<{ id: string }>(
      `SELECT id FROM instruments
       WHERE LOWER(name) LIKE LOWER($1) || '%'
          OR LOWER($1) LIKE LOWER(name) || '%'
       LIMIT 1`,
      [name],
    );
    if (prefixMatch) return prefixMatch.id;
  }

  // Last resort: slug in any instrument ID.
  // Guard: a 2-char slug like "ID" from /company/id/<n>/ links must not
  // substring-match real ids (e.g. NSE:LIQUIDBEES contains "ID").
  if (slug.length >= 3) {
    const [any] = await db.query<{ id: string }>(
      `SELECT id FROM instruments WHERE id LIKE '%' || $1 || '%' LIMIT 1`,
      [slug],
    );
    return any?.id ?? null;
  }
  return null;
}

/**
 * Create the instrument identity a screen row points at. A screener slug is real
 * market identity — usually the NSE symbol — so this is not an invented ticker:
 * the row carries the company's true name and the id is keyed to its exchange
 * listing. ISIN is deliberately left NULL here; it is filled only later from the
 * NSE EQUITY_L master (never invented). The metadata mark `screener-cohort`
 * records where the identity came from. Screener's /company/id/<n>/ links produce
 * degenerate slugs ("ID", no symbol) and are never promoted.
 */
async function ensureScreenInstrument(
  db: Db,
  slug: string,
  name: string,
): Promise<string | null> {
  if (slug.length < 3) return null;
  const id = `NSE:${slug}`;
  await db.query(
    `insert into instruments (id, kind, name, currency, exchange, metadata)
     values ($1, 'EQUITY', $2, 'INR', 'NSE', '{"source":"screener-cohort"}'::jsonb)
     on conflict (id) do nothing`,
    [id, name],
  );
  return id;
}

/**
 * Import parsed screen rows into fundamentals table.
 * Returns the upload ID, count of inserted rows, count of instrument identities
 * created for previously unknown screen companies, and any warnings.
 */
export async function importScreenRows(
  db: Db,
  rows: ParsedScreenRow[],
  opts: { asOf?: string; screenUrl?: string } = {},
): Promise<{ uploadedId: number; inserted: number; createdInstruments: number; warnings: string[] }> {
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
  let createdInstruments = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    let instrumentId = await slugToInstrumentId(db, row.slug, row.name);
    if (!instrumentId) {
      // Cohort promotion: a screen row names a real company, so its identity is
      // created (exchange-keyed, ISIN filled later by the master). This is how
      // the watchlist candidate pool grows beyond the owner's held securities.
      instrumentId = await ensureScreenInstrument(db, row.slug, row.name);
      if (instrumentId) {
        createdInstruments++;
      } else {
        warnings.push(`Unknown instrument (not created): ${row.name} (${row.slug})`);
        continue;
      }
    }
    if (seen.has(instrumentId)) {
      warnings.push(`Duplicate instrument row skipped: ${row.name} (${row.slug})`);
      continue;
    }
    seen.add(instrumentId);

    const rawJson = JSON.stringify(row.columns);

    await db.query(
      `INSERT INTO fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, fcf_pos_5y, red_flags, as_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        uploadId,
        instrumentId,
        rawJson,
        row.rocePct ?? null,
        row.deRatio ?? null,
        row.fcfPos5y ?? null,
        // Red flags are owner-reviewed per-company at shortlist time (never a
        // screen import input), so the column stays NULL here.
        null,
      ],
    );
    inserted++;
  }

  return { uploadedId: uploadId, inserted, createdInstruments, warnings };
}
