import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  candidatesIn, categoriesHeld, loadUniverse, persistUniverse, universeInstrumentId,
} from '../../src/domain/mf-universe.js';
import { canonicalCategory, isDirectGrowth, parseNavUniverse } from '../../src/sources/amfi.js';
import { monthEndRows } from '../../src/jobs/build-mf-universe.js';
import type { NavRow, UniverseRow } from '../../src/sources/amfi.js';

/**
 * The advisor does not browse. It does not need to: AMFI publishes all 14,138 schemes
 * daily with the SEBI category as a heading, which is the whole Indian market —
 * verifiable and reproducible where a model's recollection is neither.
 */
describe('parsing the AMFI universe', () => {
  const file = [
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
    '',
    'Open Ended Schemes(Equity Scheme - Mid Cap Fund)',
    'HDFC Mutual Fund',
    '118989;INF179K01XQ0;-;HDFC Mid Cap Fund;Direct Plan;Growth Option;231.413;18-Sep-2026',
    '118988;INF179K01XO5;INF179K01XP2;HDFC Mid Cap Fund;Direct Plan;IDCW Option;81.906;18-Sep-2026',
    '105758;INF179K01CR2;-;HDFC Mid Cap Fund;Regular Plan;Growth;207.974;18-Sep-2026',
    'Open Ended Schemes(Equity Schemes - Mid Cap Fund)',
    'Motilal Oswal Mutual Fund',
    '127042;INF247L01445;-;Motilal Oswal Midcap Fund;;;119.7221;18-Sep-2026',
  ].join('\n');

  it('files each scheme under the heading above it', () => {
    const rows = parseNavUniverse(file);
    expect(rows).toHaveLength(4);
    // Both spellings collapse: AMFI writes 'Equity Scheme -' and 'Equity Schemes -' in
    // one file, which would otherwise split Mid Cap into two smaller cohorts.
    expect(new Set(rows.map((r) => r.category))).toEqual(
      new Set(['Equity Scheme - Mid Cap Fund']),
    );
  });

  it('ignores the AMC name lines between the headings', () => {
    // 'HDFC Mutual Fund' is a heading too, but not a category.
    expect(parseNavUniverse(file).every((r) => r.category.includes('Mid Cap'))).toBe(true);
  });

  it('normalises the two spellings of a category', () => {
    expect(canonicalCategory('Open Ended Schemes(Equity Schemes - Mid Cap Fund)'))
      .toBe(canonicalCategory('Open Ended Schemes(Equity Scheme - Mid Cap Fund)'));
  });

  it('keeps only the Direct growth plan as a candidate', () => {
    const rows = parseNavUniverse(file).filter(isDirectGrowth);
    // The IDCW option is a different security with a different NAV series, and a
    // Regular plan carries a trail the owner does not pay.
    expect(rows.map((r) => r.schemeCode)).toEqual(['118989']);
  });

  it('counts Cumulative as growth, because ICICI calls it that', () => {
    const icici = parseNavUniverse([
      'Scheme Code;A;B;Scheme Name;Plan;Option;Net Asset Value;Date',
      'Open Ended Schemes(Other Scheme - Index Funds)',
      '120620;INF109K012M7;-;ICICI Prudential Nifty 50 Index Fund;Direct Plan;Cumulative;247.86;18-Sep-2026',
    ].join('\n'));
    // Excluding it would drop the owner's own index fund from its cohort.
    expect(icici.filter(isDirectGrowth)).toHaveLength(1);
  });
});

const row = (schemeCode: string, isin: string, category: string, plan = 'Direct Plan'): UniverseRow => ({
  schemeCode, isin, schemeName: `Fund ${schemeCode}`, plan, option: 'Growth',
  nav: 100, category,
});

describe('choosing candidates', () => {
  let db: Db;
  const MID = 'Equity Scheme - Mid Cap Fund';

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency, isin, scheme_code, canonical_id) values
         ('MF:HELD', 'MF', 'Held Fund', 'INR', 'INF000H01019', '118989', 'MF:H'),
         ('IND:1',   'MF', 'Held Fund', 'INR', null, null, 'MF:H')`,
    );
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values (date '2026-09-21','indmoney') returning id`,
    );
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
       values ($1, 'IND:1', 'indmoney', 1, 10000000, 'indmoney', timestamptz '2026-09-21T12:00:00Z')`,
      [snap!.id],
    );
  });

  it('builds a cohort only for a category the owner actually holds', async () => {
    const rows = [row('118989', 'INF000H01019', MID), row('999', 'INF999A01019', 'Equity Scheme - Small Cap Fund')];
    expect(await categoriesHeld(db, rows)).toEqual([MID]);
    await db.close();
  });

  it('drops a fund that cannot be proven Direct growth', () => {
    const rows = [row('1', 'INF001A01019', MID), row('2', 'INF002A01019', MID, 'Regular Plan')];
    expect(candidatesIn(rows, [MID]).map((c) => c.schemeCode)).toEqual(['1']);
  });

  it('never creates a second instrument for a fund already held', async () => {
    const report = await persistUniverse(db, candidatesIn(
      [row('118989', 'INF000H01019', MID), row('2', 'INF002A01019', MID)], [MID],
    ));
    // Two rows for one ISIN would give the fund two NAV series and let it appear twice
    // in its own cohort.
    expect(report).toEqual({ created: 1, skippedHeld: 1 });
    expect((await loadUniverse(db)).map((c) => c.instrumentId))
      .toEqual([universeInstrumentId('2')]);
    await db.close();
  });

  it('round-trips the category through instrument metadata', async () => {
    await persistUniverse(db, candidatesIn([row('7', 'INF007A01019', MID)], [MID]));
    expect((await loadUniverse(db))[0]!.category).toBe(MID);
    await db.close();
  });
});

describe('month-end selection', () => {
  const nav = (isin: string, date: string, v: number): NavRow => ({
    schemeCode: 'X', isinDivPayout: isin, isinDivReinvestment: null,
    schemeName: 'X', nav: v, repurchasePrice: null, salePrice: null, date,
  });

  it('keeps the last trading day of the month per fund', () => {
    const rows = [
      nav('INF001A01019', '01-Sep-2026', 10),
      nav('INF001A01019', '30-Sep-2026', 12),
      nav('INF001A01019', '15-Sep-2026', 11),
    ];
    const out = monthEndRows(rows, new Set(['INF001A01019']));
    // AMFI's `dd-MMM-yyyy` does not sort as a string, so the day is parsed.
    expect(out).toHaveLength(1);
    expect(out[0]!.nav).toBe(12);
  });

  it('ignores a fund that is not in the universe', () => {
    expect(monthEndRows([nav('INF999Z01011', '30-Sep-2026', 5)], new Set(['INF001A01019'])))
      .toEqual([]);
  });
});
