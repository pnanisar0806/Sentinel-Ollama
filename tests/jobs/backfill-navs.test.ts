import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  amfiDate, backfillNavs, monthBounds, monthsBack,
} from '../../src/jobs/backfill-navs.js';
import type { NavRow } from '../../src/sources/amfi.js';

/**
 * `rankMfs` scores consistency over rolling 12-month NAV windows — 40 of its 100
 * points, its largest single weight — and `consistencyRatio` returns 0 outright when
 * there are fewer points than the window. `navs` held four days, so every fund scored
 * 0 and MF ranking could not tell any two funds apart.
 */
describe('NAV backfill', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency, isin)
       values ('MF:A', 'MF', 'Fund A', 'INR', 'INF000A01019')
       on conflict (id) do nothing`,
    );
  });

  const nav = (date: string, value: number): NavRow => ({
    schemeCode: '100001',
    isinDivPayout: 'INF000A01019',
    isinDivReinvestment: null,
    schemeName: 'Fund A',
    nav: value,
    repurchasePrice: null,
    salePrice: null,
    date,
  });

  it('walks months oldest first', () => {
    expect(monthsBack('2026-03', 4)).toEqual(['2025-12', '2026-01', '2026-02', '2026-03']);
  });

  it('bounds a month on its real last day', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthBounds('2024-02').to).toBe('2024-02-29'); // leap year
    expect(monthBounds('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('formats dates the way AMFI takes them, never ISO', () => {
    expect(amfiDate('2026-09-18')).toBe('18-Sep-2026');
    expect(amfiDate('2026-01-01')).toBe('01-Jan-2026');
  });

  it('ingests a month of NAVs', async () => {
    const report = await backfillNavs(db, {
      endMonth: '2026-09', months: 2, pauseMs: 0,
      fetchMonth: async (from) => [nav(from, 100), nav(from.replace(/^01/, '02'), 101)],
    });
    expect(report.fetched).toEqual(['2026-08', '2026-09']);
    const [row] = await db.query<{ n: string }>(`select count(*) as n from navs`);
    expect(Number(row!.n)).toBe(4);
    await db.close();
  });

  it('skips a month already covered for every tracked fund', async () => {
    const fetchMonth = async (from: string) => [nav(from, 100)];
    await backfillNavs(db, { endMonth: '2026-09', months: 1, pauseMs: 0, fetchMonth });
    const second = await backfillNavs(db, { endMonth: '2026-09', months: 1, pauseMs: 0, fetchMonth });
    expect(second.fetched).toEqual([]);
    expect(second.skipped).toEqual(['2026-09']);
    await db.close();
  });

  it('records a month AMFI served nothing for, without aborting', async () => {
    const report = await backfillNavs(db, {
      endMonth: '2026-09', months: 3, pauseMs: 0,
      fetchMonth: async (from) => (from.includes('Aug') ? [] : [nav(from, 100)]),
    });
    expect(report.empty).toEqual(['2026-08']);
    expect(report.fetched).toEqual(['2026-07', '2026-09']);
    await db.close();
  });

  it('stamps as_of with the month covered, not the moment of the backfill', async () => {
    await backfillNavs(db, {
      endMonth: '2026-09', months: 1, pauseMs: 0,
      fetchMonth: async (from) => [nav(from, 100)],
    });
    const [row] = await db.query<{ as_of: string | Date }>(`select as_of from navs limit 1`);
    const asOf = row!.as_of instanceof Date ? row!.as_of.toISOString() : String(row!.as_of);
    // `now` here would let a backfill alone make FR-31 read a dead AMFI feed as fresh.
    expect(asOf.slice(0, 7)).toBe('2026-09');
    await db.close();
  });
});
