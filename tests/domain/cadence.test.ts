import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { monthlyReviewDone, nextMonthStart, recordMonthlyReview } from '../../src/domain/cadence.js';
import { addTarget, DEFAULT_ADD_INSTRUMENT } from '../../src/domain/alloc-engine.js';
import { buildReportInput } from '../../src/notify/report.js';
import type { Position } from '../../src/domain/networth.js';

/**
 * Owner, 2026-09-24: "the advisor will not tell me every day something to buy or sell
 * right? that will be bad. weekly once is fine but monthly once is better."
 */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

/**
 * Every ATTEMPT to propose, kept or refused. Counting stored recommendations alone would
 * hide a second attempt: FR-12's repeat-BUY hold refuses the same BUY inside twelve
 * months and logs it to suppressed_actions instead of storing it.
 */
const recCount = async (): Promise<number> => {
  const [r] = await db.query<{ n: string }>(
    `select count(*) as n from recommendations where kind in ('rebalance', 'satellite')`);
  const [s] = await db.query<{ n: string }>(
    `select count(*) as n from suppressed_actions where action like 'rebalance:%' or action like 'satellite:%'`);
  return Number(r!.n) + Number(s!.n);
};

describe('buy/sell proposals come once a month', () => {
  it('records the review so the same month is not reviewed twice', async () => {
    expect(await monthlyReviewDone(db, 'recommendations', '2026-09')).toBe(false);
    await recordMonthlyReview(db, 'recommendations', '2026-09');
    expect(await monthlyReviewDone(db, 'recommendations', '2026-09')).toBe(true);
    expect(await monthlyReviewDone(db, 'recommendations', '2026-10')).toBe(false);
    // Cleanup keeps its own clock.
    expect(await monthlyReviewDone(db, 'cleanup', '2026-09')).toBe(false);
    await db.close();
  });

  it('proposes on the first weekly run of a month and nothing on the later ones', async () => {
    await buildReportInput(db, '2026-09-06', { gsecYieldPct: 7 });
    const afterFirst = await recCount();
    expect(afterFirst, 'the seed must produce a proposal, or this proves nothing').toBeGreaterThan(0);
    await buildReportInput(db, '2026-09-13', { gsecYieldPct: 7 });
    await buildReportInput(db, '2026-09-20', { gsecYieldPct: 7 });
    expect(await recCount()).toBe(afterFirst);
    expect(await monthlyReviewDone(db, 'recommendations', '2026-09')).toBe(true);
    await db.close();
  });

  it('reviews again when the next month starts, even if its first Sunday run was dropped', async () => {
    await buildReportInput(db, '2026-09-06', { gsecYieldPct: 7 });
    // No run on 2026-10-04 (GitHub dropped it); the 2026-10-11 run is the review.
    await buildReportInput(db, '2026-10-11', { gsecYieldPct: 7 });
    expect(await monthlyReviewDone(db, 'recommendations', '2026-10')).toBe(true);
    await db.close();
  });

  it('names the next review date', () => {
    expect(nextMonthStart('2026-09')).toBe('2026-10-01');
    expect(nextMonthStart('2026-12')).toBe('2027-01-01');
  });
});

describe('a rebalance top-up names what to buy', () => {
  const pos = (over: Partial<Position>): Position => ({
    instrumentId: 'X', name: 'X', kind: 'ETF', account: 'zerodha', valuePaise: 100n as never,
    avgCostPaise: null, assetClass: 'GOLD', issuer: null, sector: null, currency: 'INR',
    isEmployer: false, asOf: '2026-09-24', source: 'test', ...over,
  } as Position);

  it('adds to the largest existing holding in the class', () => {
    expect(addTarget([
      pos({ instrumentId: 'NSE:GOLDBEES', valuePaise: 300n as never }),
      pos({ instrumentId: 'NSE:OTHERGOLD', valuePaise: 100n as never }),
    ], 'GOLD')).toBe('NSE:GOLDBEES');
  });

  it('sends an equity top-up to the core index, never to a satellite stock', () => {
    // IPS §3.4: a rebalance flow is core. A direct stock needs a thesis from the
    // satellite engine, not a drift calculation.
    expect(addTarget([
      pos({ instrumentId: 'NSE:BIGSTOCK', name: 'Big Stock', kind: 'EQUITY', assetClass: 'EQUITY', valuePaise: 900n as never }),
      pos({ instrumentId: 'MF:ICICI-NIFTY50-IDX', name: 'ICICI Pru Nifty 50 Index', kind: 'MF', assetClass: 'EQUITY', valuePaise: 100n as never }),
    ], 'EQUITY')).toBe('MF:ICICI-NIFTY50-IDX');
  });

  it('never tops up EPF or a bond', () => {
    expect(addTarget([
      pos({ instrumentId: 'EPF:X', kind: 'EPF', assetClass: 'DEBT', valuePaise: 999n as never }),
      pos({ instrumentId: 'BOND:X', kind: 'BOND', assetClass: 'DEBT', valuePaise: 999n as never }),
    ], 'DEBT')).toBe(DEFAULT_ADD_INSTRUMENT.DEBT);
  });

  it('falls back to the plain index ETF when nothing suitable is held', () => {
    expect(addTarget([], 'GOLD')).toBe('NSE:GOLDBEES');
  });
});

describe('a top-up is one month’s tranche', () => {
  it('sizes a gap larger than the rails as a staged monthly amount', async () => {
    await buildReportInput(db, '2026-09-06', { gsecYieldPct: 7 });
    const rows = await db.query<{ primary_rec: string }>(
      `select primary_rec from recommendations where kind = 'rebalance'`);
    const buys = rows.map((r) => JSON.parse(r.primary_rec) as
      { action: string; amountPaise: string; instrumentId: string | null; thesis: string })
      .filter((p) => p.action === 'BUY');
    expect(buys.length, 'the seed must produce a rebalance BUY, or this proves nothing').toBeGreaterThan(0);
    for (const b of buys) {
      // Never above the tactical budget (Rs 50,000), so it can actually be drafted.
      expect(BigInt(b.amountPaise)).toBeLessThanOrEqual(50_00_000n);
      expect(b.instrumentId).not.toBeNull();
      expect(b.thesis).toMatch(/monthly tranche/);
    }
    await db.close();
  });
});
