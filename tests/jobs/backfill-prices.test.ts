import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { backfillPrices, tradingDaysBack } from '../../src/jobs/backfill-prices.js';
import type { BhavcopyRow, IndexBhavcopyRow } from '../../src/sources/bhavcopy.js';

/**
 * The satellite composite scores trend against a 200-day moving average. `prices_eod`
 * held four trading days and `index_prices_eod` was empty, so trend scored 0 for every
 * name and no candidate could clear the MEDIUM threshold. This job is the only thing
 * that puts history on the table.
 *
 * Dates are real: 2026-09-18 is a Friday, 19/20 the weekend, 2026-09-21 a Monday.
 */
describe('price backfill', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency, isin)
       values ('NSE:T', 'EQUITY', 'T', 'INR', 'INE000T01019') on conflict (id) do nothing`,
    );
  });

  const equity = (d: string): BhavcopyRow[] =>
    [{ symbol: 'T', isin: 'INE000T01019', tradeDate: d, close: 100, series: 'EQ' } as BhavcopyRow];
  const index = (d: string): IndexBhavcopyRow[] =>
    [{ seriesCode: 'NIFTY 50', tradeDate: d, close: 25000 } as IndexBhavcopyRow];

  const run = (opts: Parameters<typeof backfillPrices>[1]) => backfillPrices(db, opts);

  it('skips weekends when walking back', async () => {
    // Monday back five sessions must reach the previous Monday, not the previous Thursday.
    expect(await tradingDaysBack(db, '2026-09-21', 5))
      .toEqual(['2026-09-21', '2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15']);
  });

  it('honours a seeded market holiday', async () => {
    await db.query(
      `insert into holidays (holiday_date, note) values (date '2026-09-18', 'test')
       on conflict do nothing`,
    );
    expect(await tradingDaysBack(db, '2026-09-21', 3))
      .toEqual(['2026-09-21', '2026-09-17', '2026-09-16']);
  });

  it('fills both tables oldest-first', async () => {
    const report = await run({
      endIso: '2026-09-21', days: 3, pauseMs: 0,
      fetchDay: async (d) => ({ equity: equity(d), index: index(d) }),
    });
    expect(report.fetched).toEqual(['2026-09-17', '2026-09-18', '2026-09-21']);

    const [eq] = await db.query<{ n: string }>(`select count(*) as n from prices_eod`);
    const [ix] = await db.query<{ n: string }>(`select count(*) as n from index_prices_eod`);
    expect(Number(eq!.n)).toBe(3);
    // The index table being empty is the reported symptom; a backfill that left it that
    // way would have fixed nothing.
    expect(Number(ix!.n)).toBe(3);
  });

  it('re-fetches a day that has equity rows but no index rows', async () => {
    await run({
      endIso: '2026-09-21', days: 1, pauseMs: 0,
      fetchDay: async (d) => ({ equity: equity(d), index: [] }),
    });
    const second = await run({
      endIso: '2026-09-21', days: 1, pauseMs: 0,
      fetchDay: async (d) => ({ equity: equity(d), index: index(d) }),
    });
    // Skipping on equity alone would preserve the exact state the tables were found in.
    expect(second.fetched).toEqual(['2026-09-21']);
    expect(second.skipped).toEqual([]);
  });

  it('skips a day already complete on both tables', async () => {
    const fetchDay = async (d: string) => ({ equity: equity(d), index: index(d) });
    await run({ endIso: '2026-09-21', days: 2, pauseMs: 0, fetchDay });
    const second = await run({ endIso: '2026-09-21', days: 2, pauseMs: 0, fetchDay });
    expect(second.fetched).toEqual([]);
    expect(second.skipped).toEqual(['2026-09-18', '2026-09-21']);
  });

  it('records a day NSE served nothing without aborting the run', async () => {
    const report = await run({
      endIso: '2026-09-21', days: 3, pauseMs: 0,
      fetchDay: async (d) => (d === '2026-09-18'
        ? { equity: [], index: [] }
        : { equity: equity(d), index: index(d) }),
    });
    expect(report.empty).toEqual(['2026-09-18']);
    expect(report.fetched).toEqual(['2026-09-17', '2026-09-21']);
  });

  it('stamps as_of with the session, not the moment of the backfill', async () => {
    await run({
      endIso: '2026-09-21', days: 1, pauseMs: 0,
      fetchDay: async (d) => ({ equity: equity(d), index: index(d) }),
    });
    const [row] = await db.query<{ as_of: string | Date }>(
      `select as_of from prices_eod where trade_date = date '2026-09-21'`,
    );
    const asOf = row!.as_of instanceof Date ? row!.as_of.toISOString() : String(row!.as_of);
    // Stamping `now` would let a backfill alone make FR-31 read the feed as fresh,
    // hiding a daily sync that has stopped running.
    expect(asOf.slice(0, 10)).toBe('2026-09-21');
  });
});
