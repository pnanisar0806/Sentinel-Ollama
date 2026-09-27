import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { classifyBseEvent, newsCoverage, recordNews } from '../../src/sources/news.js';

/**
 * Phase 2.5 Task 2. Owner policy (2026-09-27): a long-term investor acts only on MATERIAL
 * corporate events; headlines are noise. The source is BSE's Reg 30 filings, fetched per
 * held/watched company. The fixture is a verbatim capture of CRISIL's July–August 2026 filings.
 */
const fixture = JSON.parse(readFileSync('tests/fixtures/bse/crisil-2026-07-08.json', 'utf8')) as { Table: Record<string, unknown>[] };
const bse = (rows: Record<string, unknown>[]) =>
  (async () => ({ ok: true, json: async () => ({ Table: rows }) })) as unknown as typeof fetch;
const scrips = [{ scrip: '500092', isin: 'INE007A01025', symbol: 'CRISIL', names: ['CRISIL Ltd'] }];
const NOW = new Date('2026-09-27T10:00:00Z');

describe('what counts as material', () => {
  it('keeps results, dividends, restructuring and management changes; drops notices', () => {
    const kinds = fixture.Table.map((r) => classifyBseEvent(r));
    const byCategory = (sub: string) => kinds[fixture.Table.findIndex((r) => r['SUBCATNAME'] === sub)];
    expect(byCategory('Financial Results')).toBe('results');
    expect(byCategory('Dividend')).toBe('corporate_action');
    expect(byCategory('Restructuring')).toBe('mna');
    expect(byCategory('Change in Directorate')).toBe('management');
    expect(byCategory('Newspaper Publication')).toBeNull();
    expect(byCategory('Closure of Trading Window')).toBeNull();
    expect(byCategory('Analyst / Investor Meet')).toBeNull();
  });

  it('keeps a category it has never seen as "unknown" rather than dropping it', () => {
    expect(classifyBseEvent({ CATEGORYNAME: 'Company Update', SUBCATNAME: 'Something New', CRITICALNEWS: 0 })).toBe('unknown');
  });
});

describe('fetching and coverage', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency, isin) values
      ('NSE:CRISIL', 'EQUITY', 'CRISIL Ltd', 'INR', 'INE007A01025'),
      ('NSE:NOWHERE', 'EQUITY', 'Unlisted On BSE', 'INR', 'INE999X01011')`);
    await db.query(`insert into watchlist (instrument_id, added_on, source, reason) values
      ('NSE:CRISIL', '2026-01-01', 'owner', 't'), ('NSE:NOWHERE', '2026-01-01', 'owner', 't')`);
  });

  it('stores material events once however often it runs', async () => {
    const first = await recordNews(db, { now: NOW, days: 90, fetchImpl: bse(fixture.Table), scrips });
    const again = await recordNews(db, { now: NOW, days: 90, fetchImpl: bse(fixture.Table), scrips });
    expect(first.stored).toBeGreaterThan(0);
    expect(again.stored).toBe(0);
    const [row] = await db.query<{ n: string }>(`select count(*) n from news_events where instrument_id = 'NSE:CRISIL'`);
    expect(Number(row!.n)).toBe(first.stored);
    await db.close();
  });

  it('an empty successful fetch is fresh coverage, not a failure', async () => {
    await recordNews(db, { now: NOW, days: 90, fetchImpl: bse([]), scrips });
    expect(await newsCoverage(db, 'NSE:CRISIL', NOW)).toMatchObject({ state: 'fresh' });
    await db.close();
  });

  it('finds a company by symbol or unique name when the ISIN is missing or stale', async () => {
    const { bseResolver } = await import('../../src/sources/bse.js');
    const r = bseResolver([
      { scrip: '1', isin: 'INE111A01011', symbol: 'KOTAKBANK', names: ['Kotak Mahindra Bank Ltd'] },
      { scrip: '2', isin: 'INE222A01011', symbol: 'TATA1', names: ['Tata Twin Ltd'] },
      { scrip: '3', isin: 'INE333A01011', symbol: 'TATA2', names: ['Tata Twin Limited'] },
    ]);
    expect(r({ isin: 'INE237A01028', symbol: 'KOTAKBANK', name: 'x' })).toBe('1');
    expect(r({ isin: null, symbol: null, name: 'Kotak Mahindra Bank Limited' })).toBe('1');
    // Two companies normalise to the same name: that is a guess, so no match.
    expect(r({ isin: null, symbol: null, name: 'Tata Twin Ltd' })).toBeNull();
  });

  it('a company it cannot find on BSE is unresolved, never assumed quiet', async () => {
    await recordNews(db, { now: NOW, days: 90, fetchImpl: bse([]), scrips });
    expect(await newsCoverage(db, 'NSE:NOWHERE', NOW)).toMatchObject({ state: 'unresolved' });
    await db.close();
  });

  it('a failure after a success keeps the old success and its age; past 7 days it is stale', async () => {
    await recordNews(db, { now: NOW, days: 90, fetchImpl: bse([]), scrips });
    const down = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    await recordNews(db, { now: later, days: 90, fetchImpl: down, scrips });
    expect(await newsCoverage(db, 'NSE:CRISIL', later)).toMatchObject({ state: 'fresh', lastFailure: true });
    const muchLater = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(await newsCoverage(db, 'NSE:CRISIL', muchLater)).toMatchObject({ state: 'stale' });
    await db.close();
  });

  it('never fetched is missing coverage', async () => {
    expect(await newsCoverage(db, 'NSE:CRISIL', NOW)).toMatchObject({ state: 'missing' });
    await db.close();
  });
});
