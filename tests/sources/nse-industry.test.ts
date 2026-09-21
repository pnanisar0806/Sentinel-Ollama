import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { applyIndustries, parseIndustryCsv } from '../../src/sources/nse-industry.js';

/**
 * `instruments.sector` was set for 34 of 73 watchlist names, with one-member values like
 * 'Beauty E-commerce' — so a sector median P/E compared a stock against itself and the
 * valuation relative leg scored 0 almost everywhere. The screener's Industry column
 * needs a paid subscription; NSE publishes the same classification free.
 */
describe('parseIndustryCsv', () => {
  const header = 'Company Name,Industry,Symbol,Series,ISIN Code';

  it('reads NSE’s own row shape', () => {
    const rows = parseIndustryCsv([header,
      '360 ONE WAM Ltd.,Financial Services,360ONE,EQ,INE466L01038'].join('\n'));
    expect(rows).toEqual([
      { symbol: '360ONE', isin: 'INE466L01038', industry: 'Financial Services' },
    ]);
  });

  it('survives a comma inside the company name', () => {
    // Columns are counted from the END for exactly this reason.
    const rows = parseIndustryCsv([header,
      'Some Co., Ltd.,Capital Goods,SOMECO,EQ,INE000A01019'].join('\n'));
    expect(rows[0]).toEqual(
      { symbol: 'SOMECO', isin: 'INE000A01019', industry: 'Capital Goods' },
    );
  });

  it('returns nothing when the header is not the industry list', () => {
    expect(parseIndustryCsv('Symbol,Open,Close\nX,1,2')).toEqual([]);
    expect(parseIndustryCsv('')).toEqual([]);
  });
});

describe('applyIndustries', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency, isin, sector) values
         ('NSE:BYSYMBOL', 'EQUITY', 'By symbol', 'INR', null, null),
         ('NSE:XYZ', 'EQUITY', 'By isin', 'INR', 'INE000A01019', null),
         ('MF:FUND', 'MF', 'A fund', 'INR', null, null),
         ('NSE:KEPT', 'EQUITY', 'Not listed by NSE', 'INR', null, 'Owner Sector')`,
    );
  });

  const row = (symbol: string, isin: string, industry: string) => ({ symbol, isin, industry });

  it('matches on the NSE symbol', async () => {
    await applyIndustries(db, [row('BYSYMBOL', '', 'Capital Goods')]);
    const [r] = await db.query<{ sector: string }>(
      `select sector from instruments where id = 'NSE:BYSYMBOL'`);
    expect(r!.sector).toBe('Capital Goods');
    await db.close();
  });

  it('matches on ISIN when the id does not line up', async () => {
    const report = await applyIndustries(db, [row('SOMETHINGELSE', 'INE000A01019', 'Power')]);
    expect(report.updated).toBe(1);
    const [r] = await db.query<{ sector: string }>(
      `select sector from instruments where id = 'NSE:XYZ'`);
    expect(r!.sector).toBe('Power');
    await db.close();
  });

  it('counts a stock the portfolio does not hold as unmatched, not as an error', async () => {
    const report = await applyIndustries(db, [row('NOTHELD', 'INE999Z01011', 'Chemicals')]);
    expect(report).toEqual({ updated: 0, unmatched: 1 });
    await db.close();
  });

  it('leaves an instrument NSE does not list exactly as it was', async () => {
    await applyIndustries(db, [row('BYSYMBOL', '', 'Capital Goods')]);
    const [kept] = await db.query<{ sector: string }>(
      `select sector from instruments where id = 'NSE:KEPT'`);
    // Overwriting a known sector with NULL because one source is silent loses
    // information; a mutual fund has no equity sector to begin with.
    expect(kept!.sector).toBe('Owner Sector');
    const [fund] = await db.query<{ sector: string | null }>(
      `select sector from instruments where id = 'MF:FUND'`);
    expect(fund!.sector).toBeNull();
    await db.close();
  });

  it('does not match an empty ISIN against an instrument that has none', async () => {
    // `isin = ''` must never collapse onto every NULL-ISIN row.
    const report = await applyIndustries(db, [row('UNKNOWNSYM', '', 'Metals & Mining')]);
    expect(report.updated).toBe(0);
    await db.close();
  });
});
