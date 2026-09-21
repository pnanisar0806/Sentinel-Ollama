import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { ingestNavs, type NavRow } from '../../src/sources/amfi.js';

/**
 * Four of the six seeded funds carried the wrong AMFI identifiers, so every NAV stored
 * against them was a different plan's price series. The scheme codes were sequential
 * placeholders (100002-100006) matching no AMFI scheme, and the ISINs named the IDCW
 * variant, or in one case a different fund on the Regular plan.
 *
 * Each expected value below was resolved against AMFI's NAVAll.txt on 2026-09-21 and
 * cross-checked against the NAV INDmoney reports for the holding — the two agreed to
 * the paisa for PPFC (89.8569), HDFC Mid Cap (231.413) and Motilal Midcap (120.0335).
 */
const EXPECTED: Record<string, { isin: string; scheme: string }> = {
  'MF:PPFC': { isin: 'INF879O01027', scheme: '122639' },
  'MF:HDFC-MIDCAP': { isin: 'INF179K01XQ0', scheme: '118989' },
  'MF:ICICI-LARGECAP': { isin: 'INF109K016L0', scheme: '120586' },
  'MF:MOTILAL-MIDCAP': { isin: 'INF247L01445', scheme: '127042' },
  'MF:ICICI-NIFTY50-IDX': { isin: 'INF109K012M7', scheme: '120620' },
  'MF:BANDHAN-SMALLCAP': { isin: 'INF194KB1AL4', scheme: '147946' },
};

/** The wrong values, so a regression is caught by identity and not only by absence. */
const RETIRED_ISINS = ['INF879O01308', 'INF179K01XP2', 'INF109K01449', 'INF247L01452'];

describe('seeded mutual funds name the plan the owner actually holds', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('carries the AMFI ISIN and scheme code for every fund', async () => {
    const rows = await db.query<{ id: string; isin: string | null; scheme_code: string | null }>(
      `select id, isin, scheme_code from instruments where kind = 'MF' and id like 'MF:%'`,
    );
    expect(rows.length).toBe(Object.keys(EXPECTED).length);
    for (const r of rows) {
      const want = EXPECTED[r.id];
      expect(want, `unexpected seeded fund ${r.id}`).toBeDefined();
      expect(r.isin, r.id).toBe(want!.isin);
      expect(r.scheme_code, r.id).toBe(want!.scheme);
    }
    await db.close();
  });

  it('carries none of the wrong-plan ISINs it used to', async () => {
    const rows = await db.query<{ id: string }>(
      `select id from instruments where isin = any($1::text[])`, [RETIRED_ISINS],
    );
    expect(rows.map((r) => r.id)).toEqual([]);
    await db.close();
  });

  it('uses no placeholder scheme code', async () => {
    // 100002-100006 were invented as a sequence and match no AMFI scheme.
    const rows = await db.query<{ id: string; scheme_code: string }>(
      `select id, scheme_code from instruments
        where kind = 'MF' and scheme_code between '100000' and '100010'`,
    );
    expect(rows).toEqual([]);
    await db.close();
  });

  it('attaches an AMFI NAV row to the fund it belongs to', async () => {
    // The real ISIN for PPFC Direct Growth, as AMFI publishes it.
    const navRow: NavRow = {
      schemeCode: '122639',
      isinDivPayout: 'INF879O01027',
      isinDivReinvestment: null,
      schemeName: 'Parag Parikh Flexi Cap Fund',
      nav: 89.8569,
      repurchasePrice: null,
      salePrice: null,
      date: '2026-09-18',
    };
    await ingestNavs(db, [navRow], '2026-09-18T12:00:00Z');

    const [row] = await db.query<{ instrument_id: string; nav_micros: string }>(
      `select instrument_id, nav_micros from navs where nav_date = date '2026-09-18'`,
    );
    expect(row?.instrument_id).toBe('MF:PPFC');
    expect(Number(row!.nav_micros)).toBe(Math.round(89.8569 * 1_000_000));
    await db.close();
  });

  it('does NOT attach the IDCW plan it used to match', async () => {
    const idcw: NavRow = {
      schemeCode: '153964',
      isinDivPayout: null,
      isinDivReinvestment: 'INF879O01308',
      schemeName: 'Parag Parikh Flexi Cap Fund',
      nav: 20.1234,
      repurchasePrice: null,
      salePrice: null,
      date: '2026-09-18',
    };
    const report = await ingestNavs(db, [idcw], '2026-09-18T12:00:00Z');
    // A different plan's NAV must land nowhere, not on the holding.
    expect(report.inserted).toBe(0);
    expect(report.unknownSchemes.length).toBe(1);
    await db.close();
  });
});
