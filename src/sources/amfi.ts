import type { Db } from '../db/client.js';

const AMFI_DAILY_URL = 'https://www.amfiindia.com/spages/NAVAll.txt';
const AMFI_HISTORY_BASE = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx';

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

export interface NavHistoryRow {
  schemeCode: string;
  nav: number;
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
    
    const isinDivPayout = parts[1]?.trim() ?? null;
    const isinDivReinvestment = parts[2]?.trim() ?? null;
    const schemeName = parts[3]?.trim() ?? '';
    const nav = parseFloat(parts[4] ?? '0');
    const repurchasePrice = parts[5] ? parseFloat(parts[5]) : null;
    const salePrice = parts[6] ? parseFloat(parts[6]) : null;
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

export function parseNavHistory(text: string): NavHistoryRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  
  const rows: NavHistoryRow[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    
    const schemeCode = parts[0]?.trim() ?? '';
    const nav = parseFloat(parts[1] ?? '0');
    const date = parts[2]?.trim() ?? '';
    
    if (!schemeCode || isNaN(nav) || nav <= 0 || !date) continue;
    
    rows.push({ schemeCode, nav, date });
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

export async function downloadHistory(schemeCode: string, fromDate: string, toDate: string): Promise<{ rows: NavHistoryRow[]; report: AmfiReport }> {
  const url = `${AMFI_HISTORY_BASE}?frmdt=${fromDate}&todt=${toDate}&tp=1&sc=${schemeCode}`;
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
    const response = await fetchWithRetry(url);
    const text = await response.text();
    const rows = parseNavHistory(text);
    report.totalRows = rows.length;
    return { rows, report };
  } catch (e) {
    if (e instanceof SourceError && e.code === 'NOT_FOUND') {
      return { rows: [], report };
    }
    throw e;
  }
}

export async function ingestNavs(
  db: Db,
  rows: NavRow[],
  asOf: string,
): Promise<{ inserted: number; updated: number; unknownSchemes: string[] }> {
  const unknownSchemes: string[] = [];
  let inserted = 0;
  let updated = 0;

  // Map scheme codes to instrument_ids for our holdings + watchlist
  const schemeCodes = [...new Set(rows.map(r => r.schemeCode))];
  if (schemeCodes.length === 0) {
    return { inserted: 0, updated: 0, unknownSchemes: [] };
  }

  const placeholders = schemeCodes.map((_, i) => `$${i + 1}`).join(',');
  const instrumentMap = new Map<string, string>();

  const instruments = await db.query<{ id: string; isin: string; scheme_code: string | null }>(
    `select id, isin, scheme_code from instruments 
     where kind = 'MF' and (
       isin in (${placeholders}) 
       or scheme_code in (${schemeCodes.map((_, i) => `$${i + 1 + schemeCodes.length}`).join(',')})
     )`,
    [...schemeCodes, ...schemeCodes],
  );

  for (const inst of instruments) {
    if (inst.isin) instrumentMap.set(inst.isin, inst.id);
    if (inst.scheme_code) instrumentMap.set(inst.scheme_code, inst.id);
  }

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
      [instrumentId, row.date, navMicros, asOf],
    );
    
    if (result.length > 0) {
      // Check if it was an insert or update by checking if we got a new id
      // For simplicity, count as inserted
      inserted++;
    }
  }

  return { inserted, updated, unknownSchemes };
}