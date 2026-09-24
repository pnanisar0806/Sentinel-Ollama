import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { currentDrawdown, dayReturn, drawdownSeries, recordDrawdown } from '../../src/domain/drawdown.js';

/**
 * `portfolio_drawdown` was read by the rails and written by nothing, so the 15%
 * no-loosening rule and the 20% §3.10 protocol could never fire. The series must be
 * FLOW-NEUTRAL: a salary SIP or a redemption landing in the bank is not a gain, and a
 * portfolio falling 20% while ₹50k a month flows in must not read as flat.
 */
type H = { instrumentId: string; kind: string; quantity: number; valuePaise: number };
const book = (...hs: H[]) => new Map(hs.map((h) => [h.instrumentId, h]));
const eq = (id: string, quantity: number, valuePaise: number): H => ({ instrumentId: id, kind: 'EQUITY', quantity, valuePaise });
const cash = (valuePaise: number): H => ({ instrumentId: 'CASH', kind: 'CASH', quantity: 0, valuePaise });

describe('a day\'s return is price only', () => {
  it('measures a price move', () => {
    // 10 units at 100 -> 10 units at 90.
    expect(dayReturn(book(eq('A', 10, 1000)), book(eq('A', 10, 900)))).toBeCloseTo(-0.1, 10);
  });

  it('ignores a purchase — buying more units is a flow, not a gain', () => {
    // 10 -> 20 units at an unchanged price of 100.
    expect(dayReturn(book(eq('A', 10, 1000)), book(eq('A', 20, 2000)))).toBeCloseTo(0, 10);
  });

  it('holds a deposit into cash flat', () => {
    // The bank balance jumps by a redemption; nothing was earned.
    expect(dayReturn(book(eq('A', 10, 1000), cash(5000)), book(eq('A', 10, 1000), cash(300000))))
      .toBeCloseTo(0, 10);
  });

  it('still sees the fall when money is flowing in at the same time', () => {
    // Equity down 20% on unchanged units while cash triples: a raw rupee sum would read
    // this as a GAIN. Price-only, it is a fall of 20% on the equity share.
    const r = dayReturn(
      book(eq('A', 10, 1000), cash(1000)),
      book(eq('A', 10, 800), cash(3000)),
    )!;
    expect(r).toBeCloseTo(-0.1, 10); // -200 on a 2000 book
  });

  it('drops a holding sold today out of both sides', () => {
    expect(dayReturn(book(eq('A', 10, 1000), eq('B', 5, 500)), book(eq('A', 10, 1000)))).toBeCloseTo(0, 10);
  });

  it('is null when the days share nothing, rather than a calm 0%', () => {
    expect(dayReturn(book(eq('A', 1, 100)), book(eq('B', 1, 100)))).toBeNull();
  });
});

describe('the recorded series', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency) values
      ('NSE:A', 'EQUITY', 'A', 'INR'), ('CASH:BANK', 'CASH', 'Bank', 'INR')`);
  });

  const day = async (d: string, units: number, pricePaise: number, cashPaise: number) => {
    const [s] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1, 'indmoney') returning id`, [d]);
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
       values ($1, 'NSE:A', 'zerodha', $2, $3, 'indmoney', $4::timestamptz),
              ($1, 'CASH:BANK', 'bank', 0, $5, 'indmoney', $4::timestamptz)`,
      [s!.id, units, units * pricePaise, `${d}T12:00:00Z`, cashPaise]);
  };

  it('tracks peak and drawdown through a fall and a partial recovery', async () => {
    await day('2026-09-01', 10, 100, 0);
    await day('2026-09-02', 10, 110, 0); // new peak
    await day('2026-09-03', 10, 88, 0);  // 20% below it
    await day('2026-09-04', 10, 99, 0);
    const s = await drawdownSeries(db);
    expect(s.map((p) => p.drawdownPct)).toEqual([0, 0, 20, 10]);
    expect(s[3]!.peakDate).toBe('2026-09-02');
    await db.close();
  });

  it('reports the fall even while a large deposit lands', async () => {
    await day('2026-09-01', 10, 100, 1000);
    await day('2026-09-02', 10, 70, 500000); // equity -30%, cash up 500x
    const s = await drawdownSeries(db);
    // Book was 2000 (1000 equity + 1000 cash); equity lost 300 -> 15%.
    expect(s[1]!.drawdownPct).toBe(15);
    await db.close();
  });

  it('writes each day once however often sync runs', async () => {
    await day('2026-09-01', 10, 100, 0);
    await day('2026-09-02', 10, 90, 0);
    expect((await recordDrawdown(db)).written).toBe(2);
    expect((await recordDrawdown(db)).written).toBe(0);
    await db.close();
  });

  it('has no evidence when the last record is stale', async () => {
    await day('2026-09-01', 10, 100, 0);
    await recordDrawdown(db);
    expect(await currentDrawdown(db, new Date('2026-09-03T00:00:00Z'))).toBe(0);
    // A week and more with no record is not evidence of a calm market.
    expect(await currentDrawdown(db, new Date('2026-09-20T00:00:00Z'))).toBeNull();
    await db.close();
  });
});

/**
 * The RSU is ~23% of the book and has no daily snapshot history, so until 2026-09-24 the
 * drawdown left it out and under-reported any fall in NOW. It is now priced from its own
 * daily close.
 */
describe('the ServiceNow RSU is in the drawdown', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency) values
      ('NSE:A', 'EQUITY', 'A', 'INR'), ('US:NOW', 'RSU', 'ServiceNow', 'USD')`);
    // An equity book that never moves, and an RSU worth the same.
    for (const d of ['2026-09-01', '2026-09-02']) {
      const [s] = await db.query<{ id: string }>(
        `insert into snapshots (business_date, source) values ($1, 'indmoney') returning id`, [d]);
      await db.query(
        `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
         values ($1, 'NSE:A', 'zerodha', 10, 100000, 'indmoney', $2::timestamptz)`, [s!.id, `${d}T12:00:00Z`]);
    }
    const [seedSnap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ('2026-09-02', 'manual-seed') returning id`);
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
       values ($1, 'US:NOW', 'fidelity', 1, 100000, 'manual-seed', timestamptz '2026-09-02T12:00:00Z')`,
      [seedSnap!.id]);
  });

  const now = (d: string, paise: number) => db.query(
    `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
     values ('US:NOW', $1, $2, 'yahoo', $3::timestamptz)`, [d, paise, `${d}T21:00:00Z`]);

  it('sees a fall in NOW that the INDmoney book alone would miss', async () => {
    await now('2026-09-01', 10000);
    await now('2026-09-02', 5000); // NOW halves
    const s = await drawdownSeries(db);
    // The RSU's units are anchored on its value TODAY (Rs 1,000 at the halved price), so
    // it held 20 units and was worth Rs 2,000 yesterday — two-thirds of a Rs 3,000 book.
    // Halving it is a 33.33% drawdown. Without the RSU leg this read 0%.
    expect(s[1]!.drawdownPct).toBe(33.33);
    await db.close();
  });

  it('carries the last US close across a date with no US session', async () => {
    await now('2026-08-31', 10000); // no close on 09-01 or 09-02
    const s = await drawdownSeries(db);
    expect(s.map((p) => p.drawdownPct)).toEqual([0, 0]);
    await db.close();
  });

  it('leaves the series as it was when there is no NOW history yet', async () => {
    const s = await drawdownSeries(db);
    expect(s.map((p) => p.drawdownPct)).toEqual([0, 0]);
    await db.close();
  });
});
