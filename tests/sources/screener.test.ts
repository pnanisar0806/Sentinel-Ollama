import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { seedWatchlist } from '../../src/seed/seed-watchlist.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScreenerCsv, importScreener } from '../../src/sources/screener.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '../fixtures/screener');

let db: Db;

beforeAll(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-09-11' });
  await seedWatchlist(db);
});

afterAll(async () => {
  await db.close();
});

describe('parseScreenerCsv', () => {
it('parses the sample CSV and returns records', () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'screener_sample.csv'), 'utf8');
    const { records, warnings } = parseScreenerCsv(csv);
    
    expect(records.length).toBe(35);
    expect(warnings.length).toBe(0);

    // Spot check: Reliance
    const reliance = records.find(r => r.symbol === 'RELIANCE');
    expect(reliance).toBeDefined();
    expect(reliance!.currentPrice).toBe(2865.50);
    expect(reliance!.peRatio).toBe(28.5);
    expect(reliance!.rocePct).toBe(15.2);
    expect(reliance!.deRatio).toBe(0.45);
    expect(reliance!.fcfPos5y).toBe(true);
    expect(reliance!.redFlags).toBe(0);

    // Zomato - loss-making, negative ROCE
    const zomato = records.find(r => r.symbol === 'ZOMATO');
    expect(zomato).toBeDefined();
    expect(zomato!.rocePct).toBe(-5.2);
    expect(zomato!.fcfPos5y).toBe(true);
    expect(zomato!.redFlags).toBe(1);

    // Paytm - negative ROCE, red flags
    const paytm = records.find(r => r.symbol === 'PAYTM');
    expect(paytm).toBeDefined();
    expect(paytm!.rocePct).toBe(-12.5);
    expect(paytm!.fcfPos5y).toBe(true);
    expect(paytm!.redFlags).toBe(2);

    // Mutation check: changing expected ROCE makes test fail
    expect(reliance!.rocePct).toBe(15.2);
    expect(reliance!.rocePct).not.toBe(14.0);
  });

  it('handles missing/extra columns gracefully', () => {
    const csv = `Name,Symbol,ExtraCol
Test Co,TEST,extra
`;
    const { records, warnings } = parseScreenerCsv(csv);
    expect(warnings.some(w => w.includes('Extra columns'))).toBe(true);
    expect(records.length).toBe(1);
    expect(records[0]?.symbol).toBe('TEST');
  });

  it('skips rows with missing symbol', () => {
    const csv = `Name,Symbol
Test Co,
`;
    const { records, warnings } = parseScreenerCsv(csv);
    expect(records.length).toBe(0);
    expect(warnings.some(w => w.includes('missing name or symbol'))).toBe(true);
  });

  it('mutation check: extra column warning', () => {
    const csv = `Name,Symbol,Current Price,ExtraMetric
Test Co,TEST,100,extra
`;
    const { warnings } = parseScreenerCsv(csv);
    expect(warnings.some(w => w.includes('Extra columns ignored'))).toBe(true);
  });
});

describe('importScreener', () => {
  it('imports screener CSV and inserts fundamentals', async () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'screener_sample.csv'), 'utf8');
    const result = await importScreener(db, csv, { asOf: '2026-09-11', filename: 'test.csv' });

    expect(result.inserted).toBeGreaterThan(30);
    expect(result.uploadedId).toBeGreaterThan(0);

    // Verify data in fundamentals table
    const count = await db.query<{ n: string }>(
      'select count(*) as n from fundamentals where upload_id = $1',
      [result.uploadedId],
    );
    expect(Number(count[0]!.n)).toBe(result.inserted);

    // Verify typed columns are populated
    const reliance = await db.query<{ roce_pct: string; de_ratio: string; fcf_pos_5y: boolean; red_flags: number }>(
      `select f.roce_pct, f.de_ratio, f.fcf_pos_5y, f.red_flags
       from fundamentals f
       join instruments i on i.id = f.instrument_id
       where f.upload_id = $1 and i.id = 'NSE:RELIANCE'`,
      [result.uploadedId],
    );
    expect(reliance.length).toBe(1);
    expect(Number(reliance[0]!.roce_pct)).toBe(15.2);
    expect(Number(reliance[0]!.de_ratio)).toBe(0.45);
    expect(reliance[0]!.fcf_pos_5y).toBe(true);
    expect(reliance[0]!.red_flags).toBe(0);
  });

  it('idempotent - re-importing same asOf+filename does not duplicate', async () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'screener_sample.csv'), 'utf8');
    const r1 = await importScreener(db, csv, { asOf: '2026-09-12', filename: 'idem.csv' });
    const r2 = await importScreener(db, csv, { asOf: '2026-09-12', filename: 'idem.csv' });

    expect(r1.uploadedId).toBe(r2.uploadedId);
    // Re-import processes all records (upsert), so inserted count equals record count
    // One record (POLICYBZR) has no matching instrument in seed data
    expect(r2.inserted).toBe(35);
    expect(r2.warnings.some(w => w.includes('already active'))).toBe(false);
  });

  it('tracks unknown symbols as warnings', async () => {
    const csv = `Name,Symbol,Current Price,Market Cap,P/E,P/B,Div Yield %,ROCE %,ROE %,Debt to Equity,EPS,Sales 5Y CAGR %,Profit 5Y CAGR %,FCF 5Y,Red Flags,Promoter Holding %,FII Holding %,DII Holding %
Unknown Co,UNKNOWN,100,1000,10,1,1,15,12,0.5,5,10,12,positive,0,50,10,5
`;
    const result = await importScreener(db, csv, { asOf: '2026-09-13', filename: 'unknown.csv' });
    expect(result.warnings.some(w => w.includes('UNKNOWN'))).toBe(true);
    expect(result.inserted).toBe(0);
  });

  it('mutation check: screener data from fixture matches known values', async () => {
    const csv = readFileSync(join(FIXTURE_DIR, 'screener_sample.csv'), 'utf8');
    const result = await importScreener(db, csv, { asOf: '2026-09-14', filename: 'mutate.csv' });

    const tcs = await db.query<{ roce_pct: string; de_ratio: string; fcf_pos_5y: boolean }>(
      `select f.roce_pct, f.de_ratio, f.fcf_pos_5y
       from fundamentals f
       join instruments i on i.id = f.instrument_id
       where f.upload_id = $1 and i.id = 'NSE:TCS'`,
      [result.uploadedId],
    );
    expect(tcs.length).toBe(1);
    expect(Number(tcs[0]!.roce_pct)).toBe(48.5);
    expect(Number(tcs[0]!.de_ratio)).toBe(0.05);
    expect(tcs[0]!.fcf_pos_5y).toBe(true);
  });
});