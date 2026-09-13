import { inflateRawSync } from 'node:zlib';
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

const NSE_EQUITY_BASE = 'https://archives.nseindia.com/content/historical/EQUITIES';
const NSE_INDEX_BASE = 'https://archives.nseindia.com/content/historical/EQUITIES'; // indices also under EQUITIES

export interface BhavcopyRow {
  isin: string;
  symbol: string;
  series: string;
  close: number;
  prevClose: number;
  tradeDate: string;
}

export interface IndexBhavcopyRow {
  seriesCode: string;
  close: number;
  tradeDate: string;
}

export interface BhavcopyReport {
  date: string;
  totalRows: number;
  inserted: number;
  updated: number;
  unknownSymbols: string[];
  errors: string[];
}

function formatNseDate(date: Date): { year: string; month: string; day: string } {
  const year = date.getFullYear().toString();
  const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const day = date.getDate().toString().padStart(2, '0');
  return { year, month, day };
}

function buildEquityUrl(date: Date): string {
  const { year, month, day } = formatNseDate(date);
  return `${NSE_EQUITY_BASE}/${year}/${month}/cm${day}${month}${year}bhav.csv.zip`;
}

function buildIndexUrl(date: Date): string {
  const { year, month, day } = formatNseDate(date);
  return `${NSE_INDEX_BASE}/${year}/${month}/ind${day}${month}${year}.zip`;
}

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/zip, application/octet-stream, */*',
        },
      });
      if (response.status === 404) {
        throw new SourceError('NOT_FOUND', `NSE file not found: ${url}`, false);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (e) {
      // A 404 is the answer, not a hiccup: `retryable` existed and was ignored, so a
      // non-trading day cost three round trips before reporting the same thing.
      if (e instanceof SourceError && !e.retryable) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError!;
}

function parseCsv(text: string): string[][] {
  const lines = text.trim().split('\n');
  return lines.map(line => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  });
}

/**
 * Extracts the first entry of a single-file ZIP with `node:zlib` — NSE serves
 * `.csv.zip`, and this is the whole reason a dependency is not needed for it.
 *
 * Handles the two methods NSE uses (stored and deflate). When the local header carries no
 * compressed size (a streamed archive with a data descriptor), the payload runs to the
 * central directory, so we scan for its signature rather than guessing a length.
 */
export function unzipFirstEntry(buf: Buffer): string {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new SourceError('BAD_ZIP', 'not a zip archive', false);
  }
  const method = buf.readUInt16LE(8);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  let size = buf.readUInt32LE(18);
  if (size === 0) {
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start);
    size = (cd === -1 ? buf.length : cd) - start;
  }
  const data = buf.subarray(start, start + size);
  if (method === 0) return data.toString('utf8');
  if (method !== 8) throw new SourceError('BAD_ZIP', `unsupported zip method ${method}`, false);
  return inflateRawSync(data).toString('utf8');
}

/**
 * Downloads and parses one day's NSE equity bhavcopy.
 *
 * A non-trading day answers 404 and returns zero rows without raising — that is a calendar
 * fact, not a failure. Anything else propagates to `runSync`'s step contract (PRD §8.2).
 *
 * PROVISIONING: the archive URL and CSV column names are verified against live NSE at
 * provisioning time, not here — see the README checklist. If NSE moves the path, this
 * raises a loud SYNC_FAILURE rather than degrading quietly.
 */
export async function downloadBhavcopy(dateIso: string): Promise<{ rows: BhavcopyRow[]; report: BhavcopyReport }> {
  const report: BhavcopyReport = {
    date: dateIso, totalRows: 0, inserted: 0, updated: 0, unknownSymbols: [], errors: [],
  };
  try {
    const response = await fetchWithRetry(buildEquityUrl(new Date(`${dateIso}T00:00:00Z`)));
    const rows = parseEquityBhavcopy(unzipFirstEntry(Buffer.from(await response.arrayBuffer())), dateIso);
    report.totalRows = rows.length;
    return { rows, report };
  } catch (e) {
    if (e instanceof SourceError && e.code === 'NOT_FOUND') return { rows: [], report };
    throw e;
  }
}

/** The index series for the same day — the benchmark every relative-strength number needs. */
export async function downloadIndexSeries(dateIso: string): Promise<{ rows: IndexBhavcopyRow[]; report: BhavcopyReport }> {
  const report: BhavcopyReport = {
    date: dateIso, totalRows: 0, inserted: 0, updated: 0, unknownSymbols: [], errors: [],
  };
  try {
    const response = await fetchWithRetry(buildIndexUrl(new Date(`${dateIso}T00:00:00Z`)));
    const rows = parseIndexBhavcopy(unzipFirstEntry(Buffer.from(await response.arrayBuffer())), dateIso);
    report.totalRows = rows.length;
    return { rows, report };
  } catch (e) {
    if (e instanceof SourceError && e.code === 'NOT_FOUND') return { rows: [], report };
    throw e;
  }
}

export function parseEquityBhavcopy(csvText: string, tradeDate: string): BhavcopyRow[] {
  const parsed = parseCsv(csvText);
  if (parsed.length < 2) return [];
  
  const headerRow = parsed[0];
  if (!headerRow) return [];
  const headers = headerRow.map(h => h.trim().toLowerCase());
  const rows: BhavcopyRow[] = [];
  
  // Expected columns: SYMBOL, SERIES, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE, TOTTRDQTY, TOTTRDVAL, TIMESTAMP, ISIN
  const symbolIdx = headers.indexOf('symbol');
  const seriesIdx = headers.indexOf('series');
  const closeIdx = headers.indexOf('close');
  const prevCloseIdx = headers.indexOf('prevclose');
  const isinIdx = headers.indexOf('isin');
  
  if (symbolIdx === -1 || seriesIdx === -1 || closeIdx === -1 || isinIdx === -1) {
    throw new Error(`Missing required columns in bhavcopy CSV. Headers: ${headers.join(', ')}`);
  }
  
  for (let i = 1; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row) continue;
    const maxIdx = Math.max(symbolIdx, seriesIdx, closeIdx, prevCloseIdx, isinIdx);
    if (row.length <= maxIdx) continue;
    
    const series = row[seriesIdx] ?? '';
    // Only EQ series
    if (series !== 'EQ') continue;
    
    const isin = row[isinIdx] ?? '';
    if (!isin || isin === '-') continue;
    
    const close = parseFloat(row[closeIdx] ?? '0');
    const prevClose = prevCloseIdx >= 0 ? parseFloat(row[prevCloseIdx] ?? '0') : 0;
    
    if (isNaN(close) || close <= 0) continue;
    
    rows.push({
      isin: isin.trim(),
      symbol: (row[symbolIdx] ?? '').trim(),
      series,
      close,
      prevClose,
      tradeDate,
    });
  }
  
  return rows;
}

export function parseIndexBhavcopy(csvText: string, tradeDate: string): IndexBhavcopyRow[] {
  const parsed = parseCsv(csvText);
  if (parsed.length < 2) return [];
  
  const headerRow = parsed[0];
  if (!headerRow) return [];
  const headers = headerRow.map(h => h.trim().toLowerCase());
  const rows: IndexBhavcopyRow[] = [];
  
  // Index bhavcopy columns: Index Name, Index Date, Open, High, Low, Close, ...
  const nameIdx = headers.findIndex(h => h.includes('index') && h.includes('name'));
  const closeIdx = headers.indexOf('close');
  
  if (nameIdx === -1 || closeIdx === -1) return [];
  
  for (let i = 1; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row) continue;
    if (row.length <= Math.max(nameIdx, closeIdx)) continue;
    
    const name = (row[nameIdx] ?? '').trim();
    const close = parseFloat(row[closeIdx] ?? '0');
    
    if (isNaN(close) || close <= 0) continue;
    
    // Filter for indices we track
    const trackedIndices = ['NIFTY 500', 'NIFTY 50', 'NIFTY NEXT 50', 'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250'];
    if (!trackedIndices.some(idx => name.toUpperCase().includes(idx.toUpperCase()))) continue;
    
    rows.push({
      seriesCode: name,
      close,
      tradeDate,
    });
  }
  
  return rows;
}

export async function ingestPrices(
  db: Db,
  equityRows: BhavcopyRow[],
  indexRows: IndexBhavcopyRow[],
  asOf: string,
): Promise<{ equityInserted: number; indexInserted: number; unknownSymbols: string[] }> {
  const unknownSymbols: string[] = [];
  let equityInserted = 0;
  let indexInserted = 0;
  
  // Map ISINs to instrument_ids for our watchlist + holdings
  const isins = [...new Set(equityRows.map(r => r.isin))];
  if (isins.length === 0) {
    return { equityInserted: 0, indexInserted: 0, unknownSymbols: [] };
  }
  
  const placeholders = isins.map((_, i) => `$${i + 1}`).join(',');
  const instrumentMap = new Map<string, string>();
  
  const instruments = await db.query<{ id: string; isin: string }>(
    `select id, isin from instruments where isin in (${placeholders})`,
    isins,
  );
  
  for (const inst of instruments) {
    instrumentMap.set(inst.isin, inst.id);
  }
  
  // Insert equity prices for known instruments
  for (const row of equityRows) {
    const instrumentId = instrumentMap.get(row.isin);
    if (!instrumentId) {
      unknownSymbols.push(`${row.symbol} (${row.isin})`);
      continue;
    }
    
    const closePaise = Math.round(row.close * 100);
    const prevClosePaise = row.prevClose > 0 ? Math.round(row.prevClose * 100) : null;
    
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, prev_close_paise, source, as_of)
       values ($1, $2, $3, $4, 'nse-bhavcopy', $5)
       on conflict (instrument_id, trade_date) do update set
         close_paise = excluded.close_paise,
         prev_close_paise = excluded.prev_close_paise,
         as_of = excluded.as_of`,
      [instrumentId, row.tradeDate, closePaise, prevClosePaise, asOf],
    );
    equityInserted++;
  }
  
  // Insert index prices
  for (const row of indexRows) {
    await db.query(
      `insert into index_prices_eod (series_code, trade_date, close_paise, source, as_of)
       values ($1, $2, $3, 'nse-index-bhavcopy', $4)
       on conflict (series_code, trade_date) do update set
         close_paise = excluded.close_paise,
         as_of = excluded.as_of`,
      [row.seriesCode, row.tradeDate, Math.round(row.close * 100), asOf],
    );
    indexInserted++;
  }
  
  return { equityInserted, indexInserted, unknownSymbols };
}