import type { Db } from '../db/client.js';

const AMFI_DAILY_URL = 'https://www.amfiindia.com/spages/NAVAll.txt';
const AMFI_HISTORY_BASE = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx';

function normalizeIsin(raw: string | undefined): string | null {
  const v = raw?.trim() ?? '';
  return v === '' || v === '-' ? null : v;
}

export interface NavRow {
  schemeCode: string;
  isinDivPayout: string | null;
  isinDivReinvestment: string | null;
  schemeName: string;
  nav: number;
  repurchasePrice: number | null;
  salePrice: number | null;
  date: string;
}

export interface AmfiReport {
  date: string;
  totalRows: number;
  inserted: number;
  updated: number;
  unknownSchemes: string[];
  errors: string[];
}

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

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/plain, text/csv, */*',
        },
      });
      if (response.status === 404) {
        throw new SourceError('NOT_FOUND', `AMFI file not found: ${url}`, false);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError!;
}

export function parseNavText(text: string): NavRow[] {
  const lines = text.trim().split('\n');
  const rows: NavRow[] = [];
  
  for (const line of lines) {
    const parts = line.split(';');
    if (parts.length < 7) continue;
    
    const schemeCode = parts[0]?.trim() ?? '';
    if (!schemeCode || isNaN(Number(schemeCode))) continue;

    const isinDivPayout = normalizeIsin(parts[1]);
    const isinDivReinvestment = normalizeIsin(parts[2]);
    const schemeName = parts[3]?.trim() ?? '';

    // AMFI changed the daily file layout: it now inserts "Plan;Option"
    // between Scheme Name and Net Asset Value. Index 4 is numeric in the
    // legacy layout (nav) and free text in the current one (plan name),
    // which disambiguates the two formats per row.
    const legacyNav = parseFloat(parts[4] ?? '');
    let nav: number;
    let repurchasePrice: number | null = null;
    let salePrice: number | null = null;
    if (!isNaN(legacyNav)) {
      nav = legacyNav;
      repurchasePrice = parts[5] ? parseFloat(parts[5]) : null;
      salePrice = parts[6] ? parseFloat(parts[6]) : null;
    } else {
      nav = parseFloat(parts[6] ?? '');
    }
    const date = parts[7]?.trim() ?? new Date().toISOString().slice(0, 10);

    if (isNaN(nav) || nav <= 0) continue;
    
    rows.push({
      schemeCode,
      isinDivPayout,
      isinDivReinvestment,
      schemeName,
      nav,
      repurchasePrice,
      salePrice,
      date,
    });
  }
  
  return rows;
}

/**
 * AMFI's historical NAV report.
 *
 * This split on COMMA and read columns 0, 1, 2 as scheme code, NAV and date. AMFI serves
 * the file SEMICOLON-delimited with eight columns, NAV at index 6 and date at 7, so the
 * parser returned nothing at all for the real report — and the fixture behind its test
 * had been written to match the parser (`Scheme Code,NAV,Date`) rather than the source,
 * so the test passed. The same failure the index bhavcopy parser carried.
 *
 * Columns are found by header name rather than position: the historical report and the
 * daily NAVAll.txt order them differently (history puts the ISINs after Plan/Option),
 * and a positional reader silently mixes up the two.
 *
 * Returns `NavRow`, the same shape the daily file yields, so `ingestNavs` resolves both
 * through one path.
 */
export function parseNavHistory(text: string): NavRow[] {
  const lines = text.trim().split('\n').map((l) => l.replace(/\r$/, ''));
  const header = lines.findIndex((l) => l.toLowerCase().startsWith('scheme code;'));
  if (header === -1) return [];

  const cols = lines[header]!.split(';').map((h) => h.trim().toLowerCase());
  const at = (match: (h: string) => boolean): number => cols.findIndex(match);
  const iCode = at((h) => h === 'scheme code');
  const iName = at((h) => h.includes('name'));
  const iPayout = at((h) => h.includes('isin') && h.includes('payout'));
  const iReinvest = at((h) => h.includes('isin') && h.includes('reinvest'));
  const iNav = at((h) => h.includes('net asset value') || h === 'nav');
  const iDate = at((h) => h === 'date');
  if (iCode === -1 || iNav === -1 || iDate === -1) return [];

  const rows: NavRow[] = [];
  for (const line of lines.slice(header + 1)) {
    // The report interleaves AMC and scheme-category banners between data lines.
    if (!line.includes(';')) continue;
    const parts = line.split(';');
    if (parts.length <= Math.max(iCode, iNav, iDate)) continue;

    const schemeCode = parts[iCode]?.trim() ?? '';
    const nav = parseFloat(parts[iNav] ?? '');
    const date = parts[iDate]?.trim() ?? '';
    if (!schemeCode || !date || !Number.isFinite(nav) || nav <= 0) continue;

    rows.push({
      schemeCode,
      isinDivPayout: iPayout === -1 ? null : normalizeIsin(parts[iPayout]),
      isinDivReinvestment: iReinvest === -1 ? null : normalizeIsin(parts[iReinvest]),
      schemeName: iName === -1 ? '' : (parts[iName]?.trim() ?? ''),
      nav,
      repurchasePrice: null,
      salePrice: null,
      date,
    });
  }
  return rows;
}

export async function downloadDailyNav(): Promise<{ rows: NavRow[]; report: AmfiReport }> {
  const today = new Date().toISOString().slice(0, 10);
  const report: AmfiReport = {
    date: today,
    totalRows: 0,
    inserted: 0,
    updated: 0,
    unknownSchemes: [],
    errors: [],
  };

  try {
    const response = await fetchWithRetry(AMFI_DAILY_URL);
    const text = await response.text();
    const rows = parseNavText(text);
    report.totalRows = rows.length;
    return { rows, report };
  } catch (e) {
    if (e instanceof SourceError && e.code === 'NOT_FOUND') {
      return { rows: [], report };
    }
    throw e;
  }
}

/**
 * Every scheme's NAV between two dates, as `dd-MMM-yyyy`.
 *
 * The previous signature took a scheme code and passed it as `&sc=`, which AMFI ignores:
 * the response is the full ~15MB report either way. Callers filter by instrument, which
 * `ingestNavs` already does when it resolves ISIN and scheme code against `instruments`.
 */
export async function downloadNavHistory(
  fromDate: string,
  toDate: string,
): Promise<{ rows: NavRow[]; report: AmfiReport }> {
  const url = `${AMFI_HISTORY_BASE}?frmdt=${fromDate}&todt=${toDate}`;
  const report: AmfiReport = {
    date: new Date().toISOString().slice(0, 10),
    totalRows: 0, inserted: 0, updated: 0, unknownSchemes: [], errors: [],
  };
  try {
    const rows = parseNavHistory(await (await fetchWithRetry(url)).text());
    report.totalRows = rows.length;
    return { rows, report };
  } catch (e) {
    if (e instanceof SourceError && e.code === 'NOT_FOUND') return { rows: [], report };
    throw e;
  }
}

export async function ingestNavs(
  db: Db,
  rows: NavRow[],
  asOf: string,
): Promise<{ inserted: number; updated: number; unknownSchemes: string[] }> {
  const unknownSchemes: string[] = [];

  // Since we only have a small number of MF instruments in our database,
  // query all MF instruments directly instead of filtering by massive AMFI lists.
  const instruments = await db.query<{ id: string; isin: string | null; scheme_code: string | null }>(
    `select id, isin, scheme_code from instruments where kind = 'MF'`,
  );

  const instrumentMap = new Map<string, string>();
  for (const inst of instruments) {
    if (inst.isin) instrumentMap.set(inst.isin, inst.id);
    if (inst.scheme_code) instrumentMap.set(inst.scheme_code, inst.id);
  }

  let inserted = 0;

  for (const row of rows) {
    const instrumentId = instrumentMap.get(row.isinDivReinvestment ?? '') 
      || instrumentMap.get(row.isinDivPayout ?? '')
      || instrumentMap.get(row.schemeCode);
    
    if (!instrumentId) {
      unknownSchemes.push(`${row.schemeName} (${row.schemeCode})`);
      continue;
    }

    const navMicros = Math.round(row.nav * 1_000_000);

    const result = await db.query<{ instrument_id: string; nav_date: string }>(
      `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
       values ($1, $2, $3, 'amfi', $4)
       on conflict (instrument_id, nav_date) do update set
         nav_micros = excluded.nav_micros,
         as_of = excluded.as_of
       returning instrument_id, nav_date`,
      [instrumentId, row.date, Math.round(row.nav * 1_000_000), asOf],
    );
    
    if (result.length > 0) {
      inserted++;
    }
  }

  return { inserted, updated: 0, unknownSchemes };
}

/**
 * One scheme in AMFI's daily file, with the SEBI category it is filed under.
 *
 * `NAVAll.txt` interleaves two kinds of heading line among the data: a scheme-type
 * heading (`Open Ended Schemes(Equity Scheme - Mid Cap Fund)`) and an AMC name
 * (`Axis Mutual Fund`). Every data row belongs to the last scheme-type heading above
 * it, which is how the whole market gets classified without a paid source.
 */
export interface UniverseRow {
  schemeCode: string;
  isin: string | null;
  schemeName: string;
  plan: string;
  option: string;
  nav: number;
  /** Canonical, e.g. `Equity Scheme - Mid Cap Fund`. */
  category: string;
}

/**
 * AMFI writes the same category two ways — `Equity Scheme - Mid Cap Fund` and
 * `Equity Schemes - Mid Cap Fund` both appear in one file, splitting Mid Cap into a
 * 20-fund group and a 13-fund group. Normalising is what makes a category a cohort.
 */
export function canonicalCategory(heading: string): string {
  const inner = heading.replace(/^[^(]*[(]/, '').replace(/[)]\s*$/, '').trim();
  return inner.replace(/Schemes\b/gi, 'Scheme').replace(/\s+/g, ' ').trim();
}

/** Every scheme in the daily file, with its category. */
export function parseNavUniverse(text: string): UniverseRow[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const rows: UniverseRow[] = [];
  let category = '';

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (!line.includes(';')) {
      // A scheme-type heading carries the bracketed category; an AMC name does not.
      if (/Schemes?\s*[(]/.test(line)) category = canonicalCategory(line);
      continue;
    }
    const p = line.split(';');
    if (p.length < 8 || p[0] === 'Scheme Code') continue;

    // The current layout is Code;ISIN;ISIN;Name;Plan;Option;NAV;Date. The legacy one put
    // NAV at index 4 and carried no Plan or Option, so it cannot be classified this way.
    const nav = parseFloat(p[6] ?? '');
    if (!Number.isFinite(nav) || nav <= 0) continue;

    rows.push({
      schemeCode: (p[0] ?? '').trim(),
      isin: normalizeIsin(p[1]) ?? normalizeIsin(p[2]),
      schemeName: (p[3] ?? '').trim(),
      plan: (p[4] ?? '').trim(),
      option: (p[5] ?? '').trim(),
      nav,
      category,
    });
  }
  return rows;
}

/**
 * The investable slice: Direct plan, growth option.
 *
 * Regular plans carry a distributor trail the owner does not pay, and an IDCW option is
 * a different instrument with a different NAV series — recommending a switch into one
 * because it looked cheap would be recommending the wrong security.
 *
 * `Cumulative` is ICICI's word for Growth on its index funds, and excluding it would
 * drop the owner's own `MF:ICICI-NIFTY50-IDX` from its cohort.
 */
export function isDirectGrowth(r: UniverseRow): boolean {
  return /direct/i.test(r.plan) && /growth|cumulative/i.test(r.option);
}
