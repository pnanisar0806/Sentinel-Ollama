import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { SEED_HOLDINGS } from '../../src/seed/seed-data.js';
import { persistMfMetadata } from '../../src/domain/mf-metadata.js';
import {
  CORE_TYPES, RANGE_TABLE, bandFor, horizonYears, loadActualMix, loadFindings, midBps,
  normalisedMidpointsBps, proposeMix, typeOf, type FundType,
} from '../../src/domain/fund-mix.js';

/**
 * Spec §7: the fund mix review. The range table is the owner-approved one, copied
 * verbatim; the actual mix counts each fund once however many sources report it.
 */

const pct = (min: number, max: number) => ({ minBps: min * 100, maxBps: max * 100 });

describe('the §7 range table', () => {
  it('copies the ≥15-year column exactly', () => {
    const got = Object.fromEntries(RANGE_TABLE['15+'].map((r) => [r.type, { minBps: r.minBps, maxBps: r.maxBps, newMoney: r.newMoney }]));
    expect(got).toEqual({
      NIFTY50: { ...pct(35, 50), newMoney: true },
      NEXT50: { ...pct(0, 10), newMoney: true },
      FLEXI: { ...pct(15, 25), newMoney: true },
      LARGE_ACTIVE: { ...pct(0, 0), newMoney: false },
      MID: { ...pct(10, 20), newMoney: true },
      SMALL: { ...pct(5, 10), newMoney: true },
      US: { ...pct(5, 10), newMoney: true },
    });
  });

  it('copies the 7–15-year column exactly', () => {
    const got = Object.fromEntries(RANGE_TABLE['7-15'].map((r) => [r.type, [r.minBps, r.maxBps, r.newMoney]]));
    expect(got).toEqual({
      NIFTY50: [5000, 6500, true], NEXT50: [0, 500, true], FLEXI: [1000, 2000, true],
      LARGE_ACTIVE: [0, 0, false], MID: [500, 1000, true], SMALL: [0, 500, true], US: [500, 1000, true],
    });
  });

  it('every band can reach 100%: sum of minimums ≤ 10 000 ≤ sum of maximums', () => {
    for (const rows of Object.values(RANGE_TABLE)) {
      expect(rows.reduce((s, r) => s + r.minBps, 0)).toBeLessThanOrEqual(10_000);
      expect(rows.reduce((s, r) => s + r.maxBps, 0)).toBeGreaterThanOrEqual(10_000);
    }
  });
});

describe('horizon', () => {
  it('is FI year (1995 + 55) minus the IST year', () => {
    expect(horizonYears('2026-10-23T10:00:00+05:30')).toBe(24);
    // 31 Dec 20:00 UTC is already 1 Jan in Kolkata.
    expect(horizonYears('2026-12-31T20:00:00Z')).toBe(23);
  });

  it('maps years to a band, and has no band under 7', () => {
    expect(bandFor(15)).toBe('15+');
    expect(bandFor(14)).toBe('7-15');
    expect(bandFor(7)).toBe('7-15');
    expect(bandFor(6)).toBeNull();
  });

  it('proposes the 15+ ranges today and nothing under 7 years', () => {
    const p = proposeMix('2026-10-23T10:00:00+05:30');
    expect(p.band).toBe('15+');
    expect(p.horizonYears).toBe(24);
    const late = proposeMix('2045-01-01T00:00:00+05:30');
    expect(late.band).toBeNull();
    expect('reason' in late && late.reason).toMatch(/owner decision needed/);
  });
});

describe('normalised midpoints (15+)', () => {
  const ranges = RANGE_TABLE['15+'];
  const mids = normalisedMidpointsBps(ranges);
  const isCore = (t: FundType) => (CORE_TYPES as readonly FundType[]).includes(t);

  it('sum to exactly 10 000', () => {
    expect(Object.values(mids).reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('put core within 1 bp of the spec\'s "77%", derived from the table', () => {
    const coreMid = ranges.filter((r) => isCore(r.type)).reduce((s, r) => s + midBps(r), 0);
    const allMid = ranges.reduce((s, r) => s + midBps(r), 0);
    const expected = (10_000 * coreMid) / allMid; // 10000 × 75 / 97.5
    const core = (Object.keys(mids) as FundType[]).filter(isCore).reduce((s, t) => s + mids[t], 0);
    expect(Math.abs(core - expected)).toBeLessThanOrEqual(1);
    expect(core).toBeGreaterThanOrEqual(7000);
  });
});

describe('actual fund mix', () => {
  let db: Db;
  let day = 0;

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db);
    day = 0;
  });

  /** A live INDmoney snapshot. One snapshot per call: loadPositions keeps the latest per source. */
  async function live(rows: { id: string; name: string; kind: 'MF' | 'ETF'; canonical: string | null; isin?: string; account: string; rupees: number }[]) {
    day += 1;
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values (date '2026-10-01' + $1::int, 'indmoney') returning id`, [day],
    );
    for (const r of rows) {
      await db.query(
        `insert into instruments (id, kind, name, currency, isin, canonical_id)
         values ($1, $2, $3, 'INR', $4, $5) on conflict (id) do nothing`,
        [r.id, r.kind, r.name, r.isin ?? null, r.canonical],
      );
      await db.query(
        `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
         values ($1, $2, $3, 1, $4, 'indmoney', timestamptz '2026-10-20T12:00:00Z')`,
        [snap!.id, r.id, r.account, BigInt(r.rupees) * 100n],
      );
    }
  }

  const seedPaise = (id: string) => SEED_HOLDINGS.filter((h) => h.instrumentId === id)
    .reduce((s, h) => s + BigInt(h.valuePaise), 0n);

  it('types a live IND:* row through its seed sibling\'s ISIN', async () => {
    await live([{ id: 'IND:5536', name: 'ICICI Prudential Nifty 50 Index Plan Direct Growth', kind: 'MF', canonical: 'MF:5536', account: 'indmoney', rupees: 700_000 }]);
    expect(await typeOf(db, 'IND:5536')).toEqual({ type: 'NIFTY50', topUp: true });
    expect(await typeOf(db, 'MF:ICICI-LARGECAP')).toEqual({ type: 'LARGE_ACTIVE', topUp: true });
  });

  it('types the no-ISIN held ETFs by id, kept but not topped up', async () => {
    await live([
      { id: 'IND:INDS20619', name: 'Nippon India ETF Nifty Next 50 Junior BeES', kind: 'ETF', canonical: null, account: 'zerodha', rupees: 10_000 },
      { id: 'IND:VOO', name: 'Vanguard S&P 500 ETF', kind: 'ETF', canonical: null, account: 'indmoney', rupees: 20_000 },
    ]);
    expect(await typeOf(db, 'IND:INDS20619')).toEqual({ type: 'NEXT50', topUp: false });
    expect(await typeOf(db, 'IND:VOO')).toEqual({ type: 'US', topUp: false });
  });

  it('counts a fund held as seed MF:* and live IND:* once (Review Focus 2)', async () => {
    await live([{ id: 'IND:5536', name: 'ICICI Prudential Nifty 50 Index Plan Direct Growth', kind: 'MF', canonical: 'MF:5536', account: 'indmoney', rupees: 700_000 }]);
    const mix = await loadActualMix(db);
    const nifty = mix.byType.NIFTY50;
    // The seed's ICICI rows (zerodha + indmoney) share canonical MF:5536 with the live
    // row and are superseded; Nifty BeES on zerodha is untouched seed.
    expect(nifty.holdings.map((h) => h.instrumentId).sort()).toEqual(['IND:5536', 'NSE:NIFTYBEES']);
    expect(nifty.valuePaise).toBe(700_000n * 100n + seedPaise('NSE:NIFTYBEES'));
  });

  it('keeps an untyped equity fund visible and in the denominator', async () => {
    await live([
      { id: 'IND:5536', name: 'ICICI Prudential Nifty 50 Index Plan Direct Growth', kind: 'MF', canonical: 'MF:5536', account: 'indmoney', rupees: 700_000 },
      { id: 'IND:99999', name: 'Some Thematic Fund Direct Growth', kind: 'MF', canonical: null, isin: 'INF000Z99999', account: 'indmoney', rupees: 50_000 },
      { id: 'IND:INDS28892', name: 'Zerodha Nifty 1D Rate Liquid ETF', kind: 'ETF', canonical: 'NSE:INDS28892', account: 'zerodha', rupees: 30_000 },
    ]);
    const mix = await loadActualMix(db);
    expect(mix.untyped).toEqual([{ instrumentId: 'IND:99999', name: 'Some Thematic Fund Direct Growth', valuePaise: 50_000n * 100n }]);
    const typed = Object.values(mix.byType).reduce((s, t) => s + t.valuePaise, 0n);
    expect(mix.totalPaise).toBe(typed + 50_000n * 100n);
    // The liquid ETF is debt, not an equity fund.
    expect(JSON.stringify(mix, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/INDS28892|LIQUIDBEES/);
    const shares = Object.values(mix.byType).map((t) => t.shareBps);
    expect(mix.byType.NIFTY50.shareBps).toBe(Number((mix.byType.NIFTY50.valuePaise * 10_000n) / mix.totalPaise));
    expect(shares.every((s) => Number.isInteger(s))).toBe(true);
  });

  it('reports overlap when active large cap and the Nifty 50 index are both held', async () => {
    // The plain seed holds both.
    const findings = await loadFindings(db);
    const overlap = findings.filter((f) => f.kind === 'overlap');
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.instrumentId).toBe('MF:ICICI-LARGECAP');
  });

  it('compares cost only against at least 5 AMFI-category peers', async () => {
    const CAT = 'Equity Scheme - Flexi Cap Fund';
    await db.query(`update instruments set metadata = $1::jsonb where id = 'MF:PPFC'`, [JSON.stringify({ amfiCategory: CAT })]);
    await persistMfMetadata(db, [{ instrumentId: 'MF:PPFC', asOf: '2026-10-01', expenseRatioBps: 69, aumPaise: null, category: 'flexi cap', benchmarkName: null }]);
    const peer = async (code: string, bps: number) => {
      await db.query(
        `insert into instruments (id, kind, name, currency, isin, scheme_code, metadata)
         values ($1, 'MF', $1, 'INR', $2, $3, $4::jsonb)`,
        [`MFU:${code}`, `INF${code}01019`, code, JSON.stringify({ universe: true, category: CAT })],
      );
      await persistMfMetadata(db, [{ instrumentId: `MFU:${code}`, asOf: '2026-10-01', expenseRatioBps: bps, aumPaise: null, category: CAT, benchmarkName: null }]);
    };
    for (const [c, b] of [['101', 50], ['102', 55], ['103', 60], ['104', 65]] as const) await peer(c, b);
    let cost = (await loadFindings(db)).filter((f) => f.kind === 'cost' && f.instrumentId === 'MF:PPFC');
    expect(cost.map((f) => f.text)).toEqual(['cost not compared: 4 peers']);

    await peer('105', 70); // median of 50,55,60,65,70 is 60; PPFC's 69 is above it
    cost = (await loadFindings(db)).filter((f) => f.kind === 'cost' && f.instrumentId === 'MF:PPFC');
    expect(cost).toHaveLength(1);
    expect(cost[0]!.text).toMatch(/0\.69%.*0\.60%/);
  });

  it('flags a single fund above the 35% scheme cap of the whole portfolio', async () => {
    expect((await loadFindings(db)).filter((f) => f.kind === 'scheme_cap')).toEqual([]);
    await live([{ id: 'IND:5536', name: 'ICICI Prudential Nifty 50 Index Plan Direct Growth', kind: 'MF', canonical: 'MF:5536', account: 'indmoney', rupees: 50_000_000 }]);
    const cap = (await loadFindings(db)).filter((f) => f.kind === 'scheme_cap');
    expect(cap.map((f) => f.instrumentId)).toEqual(['IND:5536']);
  });
});
