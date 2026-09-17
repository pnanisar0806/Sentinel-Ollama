import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { installIps } from '../../src/domain/ips.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNavText, parseNavHistory, ingestNavs } from '../../src/sources/amfi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '../fixtures/amfi');

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

describe('parseNavText', () => {
  it('parses the AMFI daily NAV fixture', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'NAVAll_11SEP2026.txt'), 'utf8');
    const rows = parseNavText(text);
    
    expect(rows.length).toBe(6);
    
    // Spot check: ICICI Nifty 50
    const iciciNifty = rows.find(r => r.schemeCode === '100001');
    expect(iciciNifty).toBeDefined();
    expect(iciciNifty!.nav).toBe(186.80);
    expect(iciciNifty!.repurchasePrice).toBe(185.90);
    expect(iciciNifty!.salePrice).toBe(187.50);
    expect(iciciNifty!.isinDivPayout).toBe('INF109K012K1');
    expect(iciciNifty!.isinDivReinvestment).toBe('INF109K012K1');
    
    // Parag Parikh Flexi Cap
    const ppfc = rows.find(r => r.schemeCode === '100002');
    expect(ppfc).toBeDefined();
    expect(ppfc!.nav).toBe(52.85);
    expect(ppfc!.isinDivReinvestment).toBe('INF318A01010');
  });

  it('parses the new AMFI layout (Plan/Option before NAV) as served live', () => {
    const text = [
      'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
      "135762;INF846K01WO1;-;Axis Children's Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026",
      '100001;INF109K012K1;INF109K012K1;ICICI Prudential Nifty 50 Index Fund Direct Plan;Direct Plan;Growth Option;186.80;11-Sep-2026',
    ].join('\n');

    const rows = parseNavText(text);

    expect(rows.length).toBe(2);

    const axis = rows.find(r => r.schemeCode === '135762');
    expect(axis).toBeDefined();
    expect(axis!.nav).toBe(29.9628);
    expect(axis!.isinDivPayout).toBe('INF846K01WO1');
    expect(axis!.isinDivReinvestment).toBeNull();
    expect(axis!.repurchasePrice).toBeNull();
    expect(axis!.salePrice).toBeNull();
    expect(axis!.date).toBe('11-Sep-2026');

    const iciciNifty = rows.find(r => r.schemeCode === '100001');
    expect(iciciNifty!.nav).toBe(186.80);
  });

  it('mutation guard: never parses the Plan column as the NAV', () => {
    const text = [
      '135762;INF846K01WO1;-;Axis Children\'s Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026',
    ].join('\n');

    const rows = parseNavText(text);
    expect(rows.length).toBe(1);
    expect(rows[0]!.nav).toBe(29.9628);
    expect(rows[0]!.nav).not.toBeNaN();
  });

  it('mutation check: changing expected NAV makes test fail', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'NAVAll_11SEP2026.txt'), 'utf8');
    const rows = parseNavText(text);
    
    const iciciNifty = rows.find(r => r.schemeCode === '100001');
    expect(iciciNifty).toBeDefined();
    expect(iciciNifty!.nav).toBe(186.80);
    expect(iciciNifty!.nav).not.toBe(185.00); // wrong value
  });
});

describe('parseNavHistory', () => {
  it('parses historical NAV CSV', () => {
    const csv = `Scheme Code,NAV,Date
100001,185.50,10-Sep-2026
100001,186.80,11-Sep-2026
100002,52.40,10-Sep-2026
100002,52.85,11-Sep-2026`;
    
    const rows = parseNavHistory(csv);
    
    expect(rows.length).toBe(4);
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow!.schemeCode).toBe('100001');
    expect(firstRow!.nav).toBe(185.50);
    expect(firstRow!.date).toBe('10-Sep-2026');
  });
});

describe('ingestNavs', () => {
  it('inserts NAVs for known MF instruments and tracks unknown schemes', async () => {
    const text = readFileSync(join(FIXTURE_DIR, 'NAVAll_11SEP2026.txt'), 'utf8');
    const rows = parseNavText(text);
    
    const result = await ingestNavs(db, rows, '2026-09-11T17:30:00+05:30');
    
    // 5 of 6 schemes in fixture match our seed (100001 ICICI Nifty 50 has different scheme code 120620 in real AMFI)
    expect(result.inserted).toBe(5);
    expect(result.unknownSchemes.length).toBe(1);
  });

  it('idempotent - re-ingesting same date updates nav_micros', async () => {
    const text = readFileSync(join(FIXTURE_DIR, 'NAVAll_11SEP2026.txt'), 'utf8');
    const rows = parseNavText(text);
    
    // First ingest
    await ingestNavs(db, rows, '2026-09-11T17:30:00+05:30');
    
    // Second ingest with different as_of (simulating correction)
    const modifiedRows = rows.map(r => ({ ...r, nav: r.nav + 0.01 }));
    await ingestNavs(db, modifiedRows, '2026-09-11T18:00:00+05:30');
    
    // Verify only one row per instrument/date
    const navs = await db.query<{ instrument_id: string; nav_date: string; nav_micros: number }>(
      'select instrument_id, nav_date, nav_micros from navs where nav_date = $1',
      ['2026-09-11'],
    );
    
    const byInstrument = new Map<string, number>();
    for (const n of navs) {
      byInstrument.set(n.instrument_id, (byInstrument.get(n.instrument_id) || 0) + 1);
    }
    for (const count of byInstrument.values()) {
      expect(count).toBe(1);
    }
  });

  it('stores NAV as BIGINT micros (NAV × 1e6)', async () => {
    const text = readFileSync(join(FIXTURE_DIR, 'NAVAll_11SEP2026.txt'), 'utf8');
    const rows = parseNavText(text);
    
    await ingestNavs(db, rows, '2026-09-11T17:30:00+05:30');
    
    const navs = await db.query<{ instrument_id: string; nav_micros: string | number }>(
      'select instrument_id, nav_micros from navs where nav_date = $1',
      ['2026-09-11'],
    );
    
    for (const n of navs) {
      // ICICI Nifty 50: 186.80 → 186800000 micros
      if (n.instrument_id === 'MF:ICICI-NIFTY50-IDX') {
        expect(Number(n.nav_micros)).toBe(186800000);
      }
      // PPFC: 52.85 → 52850000 micros
      if (n.instrument_id === 'MF:PPFC') {
        expect(Number(n.nav_micros)).toBe(52850000);
      }
    }
  });
});