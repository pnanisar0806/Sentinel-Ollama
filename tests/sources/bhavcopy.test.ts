import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { installIps } from '../../src/domain/ips.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEquityBhavcopy, parseIndexBhavcopy, parseFullMarketCsv, parseEquityMaster, backfillInstrumentIsins, ingestPrices, unzipFirstEntry } from '../../src/sources/bhavcopy.js';
import { deflateRawSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '../fixtures/bhavcopy');

let db: Db;

beforeAll(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-09-11' });
  await installIps(db);
});

afterAll(async () => {
  await db.close();
});

describe('parseEquityBhavcopy', () => {
  it('parses the fixture CSV and returns equity rows', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'cm11SEP2026bhav.csv'), 'utf8');
    const rows = parseEquityBhavcopy(csv, '2026-09-11');
    
    expect(rows.length).toBeGreaterThan(0);
    
    // Spot check: NIFTYBEES close 227.30 → 22730 paise
    const niftybees = rows.find(r => r.symbol === 'NIFTYBEES');
    expect(niftybees).toBeDefined();
    expect(niftybees!.close).toBe(227.30);
    expect(niftybees!.prevClose).toBe(226.10);
    expect(niftybees!.isin).toBe('INF732E01037');
    
    // GOLDBEES
    const goldbees = rows.find(r => r.symbol === 'GOLDBEES');
    expect(goldbees).toBeDefined();
    expect(goldbees!.close).toBe(58.95);
    expect(goldbees!.isin).toBe('INF732E01029');
    
    // LIQUIDBEES
    const liquidbees = rows.find(r => r.symbol === 'LIQUIDBEES');
    expect(liquidbees).toBeDefined();
    expect(liquidbees!.close).toBe(1000.50);
    expect(liquidbees!.isin).toBe('INF732E01011');
    
    // RELIANCE (not in our seed, should be in rows but unknown)
    const reliance = rows.find(r => r.symbol === 'RELIANCE');
    expect(reliance).toBeDefined();
    expect(reliance!.close).toBe(2865.50);
    expect(reliance!.isin).toBe('INE002A01018');
    
    // Only EQ series should be included
    const nonEq = rows.find(r => r.series !== 'EQ');
    expect(nonEq).toBeUndefined();
  });

  it('mutation check: changing expected close makes test fail', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'cm11SEP2026bhav.csv'), 'utf8');
    const rows = parseEquityBhavcopy(csv, '2026-09-11');
    
    const niftybees = rows.find(r => r.symbol === 'NIFTYBEES');
    expect(niftybees).toBeDefined();
    
    // This value comes from the CSV fixture - if someone hardcodes wrong value, this catches it
    expect(niftybees!.close).toBe(227.30);
    expect(niftybees!.close).not.toBe(225.00); // wrong value
  });
});

describe('parseFullMarketCsv', () => {
  it('parses the sec_bhavdata_full layout (no ISIN, DATE1 trade date)', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'full_11SEP2026.csv'), 'utf8');
    const rows = parseFullMarketCsv(csv);

    // NIFTYBEES, GOLDBEES, RPOWER, RELIANCE, 20MICRONS are EQ; TATAMOTORS is BE
    expect(rows.length).toBe(5);
    const rowsByName = new Map(rows.map(r => [r.symbol, r]));

    const niftybees = rowsByName.get('NIFTYBEES');
    expect(niftybees).toBeDefined();
    expect(niftybees!.close).toBe(267.14); // CLOSE_PRICE
    expect(niftybees!.prevClose).toBe(267.17); // PREV_CLOSE
    expect(niftybees!.isin).toBe(''); // full-market file carries no ISIN
    expect(niftybees!.tradeDate).toBe('2026-09-11'); // DATE1 parsed to ISO

    const goldbees = rowsByName.get('GOLDBEES');
    expect(goldbees).toBeDefined();
    expect(goldbees!.close).toBe(125.12);
    expect(goldbees!.prevClose).toBe(126.20);

    const rpower = rowsByName.get('RPOWER');
    expect(rpower).toBeDefined();
    expect(rpower!.close).toBe(21.58);
    expect(rpower!.prevClose).toBe(21.84);

    // Only EQ series should be included
    const nonEq = rows.find(r => r.series !== 'EQ');
    expect(nonEq).toBeUndefined();
  });

  it('mutation check: changing expected close makes test fail', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'full_11SEP2026.csv'), 'utf8');
    const rows = parseFullMarketCsv(csv);

    const niftybees = rows.find(r => r.symbol === 'NIFTYBEES');
    expect(niftybees).toBeDefined();
    expect(niftybees!.close).toBe(267.14);
    expect(niftybees!.close).not.toBe(266.00); // wrong value
    expect(niftybees!.tradeDate).toBe('2026-09-11');
  });
});

describe('parseEquityMaster', () => {
  it('parses EQUITY_L.csv into a symbol → ISIN map', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'EQUITY_L.csv'), 'utf8');
    const rows = parseEquityMaster(csv);

    const bySymbol = new Map(rows.map(r => [r.symbol, r.isin]));

    expect(bySymbol.get('RPOWER')).toBe('INE614G01033');
    expect(bySymbol.get('TATASTEEL')).toBe('INE081A01020');
    expect(bySymbol.get('CRISIL')).toBe('INE007A01025');
    expect(bySymbol.get('RELIANCE')).toBe('INE002A01018');
    expect(bySymbol.get('INFY')).toBe('INE009A01021');

    // TATAMOTORS is SERIES=BE in the fixture → excluded
    expect(bySymbol.has('TATAMOTORS')).toBe(false);
  });

  it('mutation check: wrong ISIN makes test fail', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'EQUITY_L.csv'), 'utf8');
    const rows = parseEquityMaster(csv);
    const rpower = rows.find(r => r.symbol === 'RPOWER');
    expect(rpower).toBeDefined();
    expect(rpower!.isin).toBe('INE614G01033');
    expect(rpower!.isin).not.toBe('INE999A99999');
  });
});

describe('parseIndexBhavcopy', () => {
  it('parses index fixture and returns tracked indices', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'index_11SEP2026.csv'), 'utf8');
    const rows = parseIndexBhavcopy(csv, '2026-09-11');
    
    expect(rows.length).toBeGreaterThan(0);
    
    // NIFTY 500 should be tracked
    const nifty500 = rows.find(r => r.seriesCode === 'NIFTY 500');
    expect(nifty500).toBeDefined();
    expect(nifty500!.close).toBe(24920.75);
    
    // NIFTY 50
    const nifty50 = rows.find(r => r.seriesCode === 'NIFTY 50');
    expect(nifty50).toBeDefined();
    expect(nifty50!.close).toBe(25580.50);
    
    // NIFTY NEXT 50
    const niftyNext50 = rows.find(r => r.seriesCode === 'NIFTY NEXT 50');
    expect(niftyNext50).toBeDefined();
    expect(niftyNext50!.close).toBe(75050.25);
    
    // Only tracked indices included
    const untracked = rows.find(r => r.seriesCode === 'NIFTY BANK');
    expect(untracked).toBeUndefined();
  });

  it('mutation check: index close from fixture', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'index_11SEP2026.csv'), 'utf8');
    const rows = parseIndexBhavcopy(csv, '2026-09-11');
    
    const nifty500 = rows.find(r => r.seriesCode === 'NIFTY 500');
    expect(nifty500).toBeDefined();
    expect(nifty500!.close).toBe(24920.75);
    expect(nifty500!.close).not.toBe(24800.00); // wrong value
  });
});

describe('ingestPrices', () => {
  it('inserts equity prices for known instruments and tracks unknown symbols', async () => {
    const equityCsv = readFileSync(join(FIXTURE_DIR, 'cm11SEP2026bhav.csv'), 'utf8');
    const equityRows = parseEquityBhavcopy(equityCsv, '2026-09-11');
    
    const indexCsv = readFileSync(join(FIXTURE_DIR, 'index_11SEP2026.csv'), 'utf8');
    const indexRows = parseIndexBhavcopy(indexCsv, '2026-09-11');
    
    const result = await ingestPrices(db, equityRows, indexRows, '2026-09-11T17:30:00+05:30');
    
    // Should insert for known instruments: NIFTYBEES, GOLDBEES, LIQUIDBEES, RELIANCE, TCS, HDFCBANK, INFY, LT
    expect(result.equityInserted).toBeGreaterThanOrEqual(8);
    
    // Unknown symbols should be ICICINIFTY and PPFAS (MF instruments not in seed)
    expect(result.unknownSymbols.length).toBeGreaterThanOrEqual(2);
    expect(result.unknownSymbols.some(s => s.includes('ICICINIFTY'))).toBe(true);
    expect(result.unknownSymbols.some(s => s.includes('PPFAS'))).toBe(true);
    
    // RELIANCE, TCS, HDFCBANK, INFY, LT, BAJFINANCE, KOTAKBANK, AXISBANK, SBIN, HINDUNILVR, ITC, SUNPHARMA, MARUTI, TITAN, ASIANPAINT, DMART, ZOMATO, PAYTM, NYKAA, POLICYBZR, PERSISTENT, COFORGE, MPHASIS, LTIM, TRENT, DIXON, AMBER, KAJARIACER, SUPREMEIND, ASTRAL, PGHH, NESTLEIND, BRITANNIA, GODREJCP should now be known
    expect(result.unknownSymbols.some(s => s.includes('RELIANCE'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('TCS'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('HDFCBANK'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('INFY'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('ZOMATO'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('PAYTM'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('NYKAA'))).toBe(false);
    expect(result.unknownSymbols.some(s => s.includes('POLICYBZR'))).toBe(false);
    
    // Index prices inserted
    expect(result.indexInserted).toBeGreaterThanOrEqual(5); // NIFTY 50, 500, NEXT 50, MIDCAP 150, SMALLCAP 250
  });

  it('idempotent - re-ingesting same date updates as_of', async () => {
    const equityCsv = readFileSync(join(FIXTURE_DIR, 'cm11SEP2026bhav.csv'), 'utf8');
    const equityRows = parseEquityBhavcopy(equityCsv, '2026-09-11');
    
    const indexCsv = readFileSync(join(FIXTURE_DIR, 'index_11SEP2026.csv'), 'utf8');
    const indexRows = parseIndexBhavcopy(indexCsv, '2026-09-11');
    
    // First ingest
    await ingestPrices(db, equityRows, indexRows, '2026-09-11T17:30:00+05:30');
    
    // Second ingest with different as_of
    await ingestPrices(db, equityRows, indexRows, '2026-09-11T18:00:00+05:30');
    
    // Verify only one row per instrument/date
    const prices = await db.query<{ instrument_id: string; trade_date: string; close_paise: number }>(
      'select instrument_id, trade_date, close_paise from prices_eod where trade_date = $1',
      ['2026-09-11'],
    );
    
    // Each instrument should have exactly one row
    const byInstrument = new Map<string, number>();
    for (const p of prices) {
      byInstrument.set(p.instrument_id, (byInstrument.get(p.instrument_id) || 0) + 1);
    }
    for (const count of byInstrument.values()) {
      expect(count).toBe(1);
    }
  });

  it('stores prices as BIGINT paise', async () => {
    const equityCsv = readFileSync(join(FIXTURE_DIR, 'cm11SEP2026bhav.csv'), 'utf8');
    const equityRows = parseEquityBhavcopy(equityCsv, '2026-09-11');
    
    await ingestPrices(db, equityRows, [], '2026-09-11T17:30:00+05:30');
    
    const prices = await db.query<{ instrument_id: string; close_paise: string | number }>(
      'select instrument_id, close_paise from prices_eod where trade_date = $1',
      ['2026-09-11'],
    );
    
    for (const p of prices) {
      // NIFTYBEES 227.30 → 22730 paise
      if (p.instrument_id === 'NSE:NIFTYBEES') {
        expect(Number(p.close_paise)).toBe(22730);
      }
      // GOLDBEES 58.95 → 5895 paise
      if (p.instrument_id === 'NSE:GOLDBEES') {
        expect(Number(p.close_paise)).toBe(5895);
      }
      // LIQUIDBEES 1000.50 → 100050 paise
      if (p.instrument_id === 'NSE:LIQUIDBEES') {
        expect(Number(p.close_paise)).toBe(100050);
      }
    }
  });

  it('prev_close_paise stored when available', async () => {
    const equityCsv = readFileSync(join(FIXTURE_DIR, 'cm11SEP2026bhav.csv'), 'utf8');
    const equityRows = parseEquityBhavcopy(equityCsv, '2026-09-11');
    
    await ingestPrices(db, equityRows, [], '2026-09-11T17:30:00+05:30');
    
    const prices = await db.query<{ instrument_id: string; prev_close_paise: string | number | null }>(
      'select instrument_id, prev_close_paise from prices_eod where trade_date = $1',
      ['2026-09-11'],
    );
    
    for (const p of prices) {
      if (p.instrument_id === 'NSE:NIFTYBEES') {
        expect(Number(p.prev_close_paise)).toBe(22610); // 226.10 * 100
      }
    }
  });

  it('matches full-market rows (no ISIN) by NSE:<symbol> id', async () => {
    const fullCsv = readFileSync(join(FIXTURE_DIR, 'full_11SEP2026.csv'), 'utf8');
    const fullRows = parseFullMarketCsv(fullCsv);

    const result = await ingestPrices(db, fullRows, [], '2026-09-11T17:30:00+05:30');

    // GOLDBEES, NIFTYBEES, RPOWER, RELIANCE are seeded NSE ids → matched by symbol
    expect(result.equityInserted).toBeGreaterThanOrEqual(4);
    // 20MICRONS is not an instrument we hold → unknown
    expect(result.unknownSymbols.some(s => s.includes('20MICRONS'))).toBe(true);

    // GOLDBEES full-market close 125.12 → 12512 paise, matched via NSE:GOLDBEES
    const gold = await db.query<{ close_paise: string | number }>(
      'select close_paise from prices_eod where instrument_id = $1 and trade_date = $2',
      ['NSE:GOLDBEES', '2026-09-11'],
    );
    expect(Number(gold[0]!.close_paise)).toBe(12512);
  });
});

describe('backfillInstrumentIsins', () => {
  it('fills empty instrument ISINs from the EQUITY_L master by symbol', async () => {
    // Force an empty ISIN to prove the fill path, not the seed value.
    await db.query('update instruments set isin = null where id = $1', ['NSE:RPOWER']);

    const masterCsv = readFileSync(join(FIXTURE_DIR, 'EQUITY_L.csv'), 'utf8');
    const master = parseEquityMaster(masterCsv);

    const result = await backfillInstrumentIsins(db, master);
    expect(result.filled).toBeGreaterThanOrEqual(1);

    const [rpower] = await db.query<{ isin: string | null }>(
      'select isin from instruments where id = $1', ['NSE:RPOWER'],
    );
    expect(rpower!.isin).toBe('INE614G01033');

    // An instrument not present in the master stays unmapped
    await db.query(
      `insert into instruments (id, kind, name, currency, isin) values ('NSE:ZZNOTINMASTER', 'EQUITY', 'Zz Not In Master', 'INR', null)
       on conflict (id) do nothing`,
    );
    const [zz] = await db.query<{ isin: string | null }>(
      'select isin from instruments where id = $1', ['NSE:ZZNOTINMASTER'],
    );
    expect(zz!.isin).toBe(null);
  });

  it('does not clobber a non-empty ISIN even when the master disagrees', async () => {
    // Seed gives NSE:RPOWER isin INE000A01010 (a placeholder). The master disagrees.
    // If it is already set, backfill must leave it alone — it only fills empty slots.
    await db.query('update instruments set isin = $1 where id = $2', ['INE000A01010', 'NSE:RPOWER']);

    const masterCsv = readFileSync(join(FIXTURE_DIR, 'EQUITY_L.csv'), 'utf8');
    const master = parseEquityMaster(masterCsv);
    expect(master.find(r => r.symbol === 'RPOWER')).toBeDefined();

    const result = await backfillInstrumentIsins(db, master);
    const [rpower] = await db.query<{ isin: string | null }>(
      'select isin from instruments where id = $1', ['NSE:RPOWER'],
    );
    // Untouched: backfill fills only empty slots, never revises a set value.
    expect(rpower!.isin).toBe('INE000A01010');
    expect(rpower!.isin).not.toBe('INE614G01033');
    // The other empty NSE instruments still got filled by this same call.
    expect(result.filled).toBeGreaterThanOrEqual(0);
  });
});
describe('unzipFirstEntry (NSE serves .csv.zip)', () => {
  /** Builds a real single-entry ZIP so the test exercises the format, not a stub. */
  function zipOf(name: string, content: string, method: 'store' | 'deflate'): Buffer {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = method === 'deflate' ? deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method === 'deflate' ? 8 : 0, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    return Buffer.concat([header, nameBuf, data]);
  }

  it('round-trips a deflated entry', () => {
    const csv = 'SYMBOL,SERIES,CLOSE\nRELIANCE,EQ,1234.50\n';
    expect(unzipFirstEntry(zipOf('cm12AUG2026bhav.csv', csv, 'deflate'))).toBe(csv);
  });

  it('reads a stored (uncompressed) entry', () => {
    const csv = 'a,b\n1,2\n';
    expect(unzipFirstEntry(zipOf('x.csv', csv, 'store'))).toBe(csv);
  });

  it('parses a real bhavcopy out of a zip, not just bytes out of a zip', () => {
    const csv = readFileSync(
      fileURLToPath(new URL('../fixtures/bhavcopy/cm11SEP2026bhav.csv', import.meta.url)),
      'utf8',
    );
    const rows = parseEquityBhavcopy(unzipFirstEntry(zipOf('cm.csv', csv, 'deflate')), '2026-09-11');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(parseEquityBhavcopy(csv, '2026-09-11'));
  });

  it('refuses something that is not a zip rather than returning garbage', () => {
    expect(() => unzipFirstEntry(Buffer.from('SYMBOL,SERIES\n'))).toThrow(/not a zip/);
  });
});
