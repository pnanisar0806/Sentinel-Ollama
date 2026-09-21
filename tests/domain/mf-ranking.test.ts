import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  MAX_ACHIEVABLE_COMPOSITE, MONTHS_PER_WINDOW, monthEndNavs, rankHeldFunds, unevenHistory,
  type RankedFund,
} from '../../src/domain/mf-ranking.js';
import { persistMfMetadata, CRORE_PAISE } from '../../src/domain/mf-metadata.js';

/**
 * `rankMfs` had zero production callers, so ~₹12L of MF — the second largest asset
 * class after EPF — produced no engine output at all.
 */
describe('month-end downsampling', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency) values ('MF:A', 'MF', 'A', 'INR')
       on conflict (id) do nothing`,
    );
  });

  const nav = async (date: string, micros: number) => db.query(
    `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
     values ('MF:A', $1::date, $2, 'amfi', $1::timestamptz)`, [date, micros],
  );

  it('keeps the last NAV of each month, oldest first', async () => {
    await nav('2026-01-05', 100_000_000);
    await nav('2026-01-30', 110_000_000); // month end
    await nav('2026-02-27', 120_000_000);
    // Feeding ~600 DAILY points to a window of 12 would measure twelve-DAY momentum
    // and report it as twelve-month consistency.
    expect(await monthEndNavs(db, ['MF:A'])).toEqual(
      new Map([['MF:A', [110_000_000n, 120_000_000n]]]),
    );
    await db.close();
  });

  it('returns nothing for a fund with no NAVs, rather than throwing', async () => {
    expect(await monthEndNavs(db, ['MF:A'])).toEqual(new Map());
    expect(await monthEndNavs(db, [])).toEqual(new Map());
    await db.close();
  });
});

describe('uneven history is called out, not ranked over', () => {
  const fund = (name: string, months: number): RankedFund => ({
    instrumentId: `MF:${name}`, scoreDate: '2026-09-21', composite: 40, rank: 1,
    components: { consistency: 0, expense: 20, tenure: 0, aum: 15, style: 0 },
    windowsEvaluated: 0, name, valuePaise: 0n, category: 'flexi cap',
    monthsOfHistory: months, withheld: [],
  });

  it('flags a fund that scored 0 on consistency purely for want of history', () => {
    // This is the exact shape a wrong ISIN produced: PPFC had 12 month-ends against the
    // others' 31, so it ranked last on a data gap rather than on merit.
    const caveats = unevenHistory([fund('Deep', 31), fund('Shallow', MONTHS_PER_WINDOW)]);
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('Shallow');
    expect(caveats[0]).toContain('not a like-');
  });

  it('says nothing when every fund is measured the same way', () => {
    expect(unevenHistory([fund('A', 31), fund('B', 31)])).toEqual([]);
    // All short is still like-for-like: nobody gets an unearned advantage.
    expect(unevenHistory([fund('A', 3), fund('B', 4)])).toEqual([]);
  });
});

describe('ranking held funds end to end', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    for (const [seedId, liveId, canon, name] of [
      ['MF:CHEAP', 'IND:1', 'MF:C', 'Cheap Index Fund'],
      ['MF:DEAR', 'IND:2', 'MF:D', 'Expensive Active Fund'],
    ]) {
      await db.query(
        `insert into instruments (id, kind, name, currency, canonical_id)
         values ($1::text, 'MF', $3::text, 'INR', $2::text),
                ($4::text, 'MF', $3::text, 'INR', $2::text)
         on conflict (id) do nothing`,
        [seedId, canon, name, liveId],
      );
    }
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values (date '2026-09-21', 'indmoney') returning id`,
    );
    for (const id of ['IND:1', 'IND:2']) {
      await db.query(
        `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
         values ($1, $2, 'indmoney', 1, 10000000, 'indmoney', timestamptz '2026-09-21T12:00:00Z')`,
        [snap!.id, id],
      );
    }
    // Same NAV path for both, so only the expense ratio can separate them.
    for (const navId of ['MF:CHEAP', 'MF:DEAR']) {
      for (let m = 1; m <= 24; m++) {
        const d = new Date(Date.UTC(2024, m, 0));
        await db.query(
          `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
           values ($1, $2::date, $3, 'amfi', $2::timestamptz)`,
          [navId, d.toISOString().slice(0, 10), 100_000_000 + m * 1_000_000],
        );
      }
    }
    await persistMfMetadata(db, [
      { instrumentId: 'MF:CHEAP', asOf: '2026-09-21', expenseRatioBps: 25,
        aumPaise: 20_000n * CRORE_PAISE, category: 'index funds', benchmarkName: null },
      { instrumentId: 'MF:DEAR', asOf: '2026-09-21', expenseRatioBps: 180,
        aumPaise: 20_000n * CRORE_PAISE, category: 'flexi cap', benchmarkName: null },
    ]);
  });

  it('finds the NAV series through canonical_id, not the position id', async () => {
    // Positions are on IND:*; AMFI files NAVs under the ISIN-bearing MF:* row, which
    // supersession has retired from `positions`. Only canonical_id joins the two.
    const { ranked } = await rankHeldFunds(db, '2026-09-21');
    expect(ranked).toHaveLength(2);
    for (const r of ranked) expect(r.monthsOfHistory).toBeGreaterThan(MONTHS_PER_WINDOW);
    await db.close();
  });

  it('ranks the cheaper fund above the dearer one, all else equal', async () => {
    const { ranked } = await rankHeldFunds(db, '2026-09-21');
    expect(ranked[0]!.instrumentId).toBe('IND:1');
    expect(ranked[0]!.rank).toBe(1);
    // Expense is the only separator: AUM tops out at 2,000 crore and both hold 20,000.
    expect(ranked[0]!.components!.expense).toBeGreaterThan(ranked[1]!.components!.expense);
    expect(ranked[0]!.components!.aum).toBe(ranked[1]!.components!.aum);
    await db.close();
  });

  it('never claims points it has no source for', async () => {
    const { ranked } = await rankHeldFunds(db, '2026-09-21');
    for (const r of ranked) {
      expect(r.components!.tenure).toBe(0);
      expect(r.components!.style).toBe(0);
      expect(r.withheld).toContain('fund tenure');
      expect(r.withheld).toContain('style drift');
      // 25 of the 100 points are unreachable, so a 75 is full marks.
      expect(r.composite).toBeLessThanOrEqual(MAX_ACHIEVABLE_COMPOSITE);
    }
    await db.close();
  });

  it('is empty rather than wrong when nothing is held', async () => {
    await db.query(`delete from holdings`);
    expect(await rankHeldFunds(db, '2026-09-21')).toEqual({ ranked: [], caveats: [] });
    await db.close();
  });
});
