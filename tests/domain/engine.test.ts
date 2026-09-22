import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  BANDS,
  MF_WEIGHTS,
  SATELLITE_WEIGHTS,
  loadEngineInputs,
  persistSignalScores,
  rankMfs,
  scoreSatellite,
  sectorMedianPe,
  type EngineContext,
  type MfCandidate,
  type SatelliteCandidate,
} from '../../src/domain/engine.js';
import { assessStaleness, blockedInstruments } from '../../src/sources/staleness.js';
import { loadPositions } from '../../src/domain/networth.js';

/** Rising series: +1% per step from ₹1,000. Returned oldest → newest, in paise. */
function series(startPaise: bigint, stepBps: number, n: number): bigint[] {
  const out: bigint[] = [startPaise];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1]!;
    out.push(prev + (prev * BigInt(stepBps)) / 10_000n);
  }
  return out;
}

const TRADING_DAYS = 260;

function candidate(over: Partial<SatelliteCandidate> = {}): SatelliteCandidate {
  return {
    instrumentId: 'NSE:TESTCO',
    sector: 'IT',
    fundamentals: {
      rocePct: 24,
      deRatio: 0.2,
      fcfPos5y: true,
      redFlags: 0,
      peRatio: 20,
      profit5yCagrPct: 18,
      sales5yCagrPct: 14,
    },
    closes: series(100_000n, 20, TRADING_DAYS),
    ...over,
  };
}

function context(over: Partial<EngineContext> = {}): EngineContext {
  return {
    scoreDate: '2026-09-12',
    blockedIds: [],
    gsecYieldPct: 6.9,
    benchmarkCloses: series(2_000_000n, 10, TRADING_DAYS),
    sectorMedianPe: { IT: 28 },
    fit: { headroomPaise: 500_000_00n, sectorWeightPct: { IT: 6 }, sectorCapPct: 20 },
    ...over,
  };
}

describe('scoreSatellite — quality gate (§6, binary)', () => {
  it('blocks on a red flag, and the same row scores once the flag clears', () => {
    const flagged = candidate({ fundamentals: { ...candidate().fundamentals, redFlags: 1 } });
    const failed = scoreSatellite(flagged, context())!;

    expect(failed.qualityPassed).toBe(false);
    // The composite is not merely low — it is not computed at all.
    expect(failed.composite).toBeNull();
    expect(failed.components).toBeNull();
    expect(failed.band).toBe('NONE');
    expect(failed.qualityFailures.join(' ')).toContain(String(flagged.fundamentals.redFlags));

    // Mutation check: the ONLY difference is the flag count, derived from the row above.
    const cleared = scoreSatellite(
      candidate({ fundamentals: { ...flagged.fundamentals, redFlags: 0 } }),
      context(),
    )!;
    expect(cleared.qualityPassed).toBe(true);
    expect(cleared.composite).not.toBeNull();
  });

  it('requires ROCE above the §6 threshold', () => {
    const weak = candidate({ fundamentals: { ...candidate().fundamentals, rocePct: 12 } });
    const r = scoreSatellite(weak, context())!;
    expect(r.qualityPassed).toBe(false);
    expect(r.qualityFailures.some((f) => f.toLowerCase().includes('roce'))).toBe(true);
  });

  it('exempts finance sectors from the D/E gate but not other sectors', () => {
    const leveredFunds = candidate({
      sector: 'Banking',
      fundamentals: { ...candidate().fundamentals, deRatio: 6 },
    });
    const bank = scoreSatellite(leveredFunds, context({ sectorMedianPe: { Banking: 18 } }))!;
    expect(bank.qualityPassed).toBe(true);

    const manufacturer = scoreSatellite({ ...leveredFunds, sector: 'Auto' }, context())!;
    expect(manufacturer.qualityPassed).toBe(false);
    expect(manufacturer.qualityFailures.some((f) => f.includes('D/E'))).toBe(true);
  });

  it('fails closed on unknown fundamentals rather than assuming them good', () => {
    const unknown = candidate({
      fundamentals: {
        rocePct: null,
        deRatio: null,
        fcfPos5y: null,
        redFlags: null,
        peRatio: null,
        profit5yCagrPct: null,
        sales5yCagrPct: null,
      },
    });
    const r = scoreSatellite(unknown, context())!;
    expect(r.qualityPassed).toBe(false);
    expect(r.qualityFailures.length).toBeGreaterThan(1);
  });
});

describe('scoreSatellite — FR-31: a stale input means no score at all', () => {
  it('returns null for a blocked instrument, before any gate runs', () => {
    const c = candidate();
    expect(scoreSatellite(c, context({ blockedIds: [c.instrumentId] }))).toBeNull();
  });

  it('composes with the real staleness engine: stale fundamentals block a watchlist name', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });

    // No screener upload has ever landed, so `screener` is stale by the Task 5 rules.
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    expect(rows.find((r) => r.source === 'screener')!.stale).toBe(true);

    const positions = await loadPositions(db);
    const equity = positions.find((p) => p.kind === 'EQUITY')!;
    const blockedIds = blockedInstruments(rows, positions);
    expect(blockedIds).toContain(equity.instrumentId);

    const scored = scoreSatellite(
      candidate({ instrumentId: equity.instrumentId }),
      context({ blockedIds }),
    );
    expect(scored, 'a name blocked by stale fundamentals may not be scored').toBeNull();
    await db.close();
  });
});

describe('scoreSatellite — composite', () => {
  it('sums its four components and stays inside [0, 100]', () => {
    const r = scoreSatellite(candidate(), context())!;
    const c = r.components!;
    const sum = c.valuation + c.trend + c.earnings + c.fit;
    expect(r.composite).toBeCloseTo(sum, 2);
    expect(r.composite!).toBeGreaterThanOrEqual(0);
    expect(r.composite!).toBeLessThanOrEqual(100);
    expect(c.valuation).toBeLessThanOrEqual(SATELLITE_WEIGHTS.valuation);
    expect(c.trend).toBeLessThanOrEqual(SATELLITE_WEIGHTS.trend);
    expect(c.earnings).toBeLessThanOrEqual(SATELLITE_WEIGHTS.earnings);
    expect(c.fit).toBeLessThanOrEqual(SATELLITE_WEIGHTS.fit);
  });

  it('bands the composite at the §6 thresholds, derived from the constant', () => {
    const strong = scoreSatellite(candidate(), context())!;
    const band = (n: number) =>
      n >= BANDS.high ? 'HIGH' : n >= BANDS.medium ? 'MEDIUM' : n >= BANDS.watch ? 'WATCH' : 'NONE';
    expect(strong.band).toBe(band(strong.composite!));

    // A cheap-but-sinking name must band lower than a cheap-and-rising one.
    const sinking = scoreSatellite(
      candidate({ closes: series(100_000n, -20, TRADING_DAYS) }),
      context(),
    )!;
    expect(sinking.composite!).toBeLessThan(strong.composite!);
    expect(sinking.band).toBe(band(sinking.composite!));
  });

  it('scores relative strength monotonically against the benchmark', () => {
    const ctx = context();
    // Derive the expected 6-month relative strength from the actual closes, not a literal.
    const sixMonths = Math.floor(TRADING_DAYS / 2);
    const ret = (s: bigint[], n: number) => {
      const from = s[s.length - 1 - n]!;
      return Number(((s[s.length - 1]! - from) * 10_000n) / from) / 100;
    };
    const benchRet = ret(ctx.benchmarkCloses, sixMonths);

    const outperformer = candidate({ closes: series(100_000n, 30, TRADING_DAYS) });
    const laggard = candidate({ closes: series(100_000n, 3, TRADING_DAYS) });
    expect(ret(outperformer.closes, sixMonths)).toBeGreaterThan(benchRet);
    expect(ret(laggard.closes, sixMonths)).toBeLessThan(benchRet);

    const hi = scoreSatellite(outperformer, ctx)!;
    const lo = scoreSatellite(laggard, ctx)!;
    expect(hi.components!.trend).toBeGreaterThan(lo.components!.trend);
  });

  it('rewards a name cheap against its sector median, penalises an expensive one', () => {
    const ctx = context({ sectorMedianPe: { IT: 30 } });
    const cheap = scoreSatellite(candidate({ fundamentals: { ...candidate().fundamentals, peRatio: 15 } }), ctx)!;
    const dear = scoreSatellite(candidate({ fundamentals: { ...candidate().fundamentals, peRatio: 60 } }), ctx)!;
    expect(cheap.components!.valuation).toBeGreaterThan(dear.components!.valuation);
  });

  it('cuts the fit component when the satellite bucket has no headroom', () => {
    const withRoom = scoreSatellite(candidate(), context())!;
    const noRoom = scoreSatellite(
      candidate(),
      context({ fit: { headroomPaise: 0n, sectorWeightPct: { IT: 6 }, sectorCapPct: 20 } }),
    )!;
    expect(noRoom.components!.fit).toBeLessThan(withRoom.components!.fit);
  });
});

describe('sectorMedianPe', () => {
  it('takes the median of the cohort, not the mean', () => {
    const cohort = [
      candidate({ instrumentId: 'A', fundamentals: { ...candidate().fundamentals, peRatio: 10 } }),
      candidate({ instrumentId: 'B', fundamentals: { ...candidate().fundamentals, peRatio: 20 } }),
      candidate({ instrumentId: 'C', fundamentals: { ...candidate().fundamentals, peRatio: 120 } }),
    ];
    expect(sectorMedianPe(cohort)).toEqual({ IT: 20 });
  });
});

describe('rankMfs (§6 MF scoring)', () => {
  const navs = (startMicros: bigint, stepBps: number, n: number): bigint[] => {
    const out = [startMicros];
    for (let i = 1; i < n; i++) out.push(out[i - 1]! + (out[i - 1]! * BigInt(stepBps)) / 10_000n);
    return out;
  };

  const mf = (over: Partial<MfCandidate> = {}): MfCandidate => ({
    instrumentId: 'MF:GOOD',
    navMicros: navs(100_000_000n, 100, 36),
    expenseRatioBps: 50,
    tenureMonths: 96,
    aumPaise: 500_00_00_000_00n,
    styleDriftPct: 2,
    ...over,
  });

  it('ranks a consistent compounder above a sliding fund', () => {
    const ranked = rankMfs(
      [mf(), mf({ instrumentId: 'MF:BAD', navMicros: navs(100_000_000n, -100, 36) })],
      { scoreDate: '2026-09-12', blockedIds: [] },
    );
    expect(ranked.map((r) => r.instrumentId)).toEqual(['MF:GOOD', 'MF:BAD']);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.components.consistency).toBeGreaterThan(ranked[1]!.components.consistency);
  });

  it('prefers the cheaper of two otherwise identical funds', () => {
    const ranked = rankMfs(
      [mf({ instrumentId: 'MF:DEAR', expenseRatioBps: 190 }), mf({ instrumentId: 'MF:CHEAP', expenseRatioBps: 25 })],
      { scoreDate: '2026-09-12', blockedIds: [] },
    );
    expect(ranked[0]!.instrumentId).toBe('MF:CHEAP');
  });

  it('drops a blocked fund entirely and keeps every component inside its weight', () => {
    const ranked = rankMfs([mf(), mf({ instrumentId: 'MF:STALE' })], {
      scoreDate: '2026-09-12',
      blockedIds: ['MF:STALE'],
    });
    expect(ranked.map((r) => r.instrumentId)).toEqual(['MF:GOOD']);
    const c = ranked[0]!.components;
    expect(c.consistency).toBeLessThanOrEqual(MF_WEIGHTS.consistency);
    expect(c.returns).toBeLessThanOrEqual(MF_WEIGHTS.returns);
    expect(c.expense).toBeLessThanOrEqual(MF_WEIGHTS.expense);
    expect(c.tenure).toBeLessThanOrEqual(MF_WEIGHTS.tenure);
    expect(c.aum).toBeLessThanOrEqual(MF_WEIGHTS.aum);
    expect(c.style).toBeLessThanOrEqual(MF_WEIGHTS.style);
    // Every component, or a new one can be added and silently left out of the total —
    // which is exactly what this caught when `returns` arrived.
    expect(ranked[0]!.composite).toBeCloseTo(
      c.consistency + c.returns + c.expense + c.tenure + c.aum + c.style, 2);
  });

  it('weights still sum to 100', () => {
    // `returns` took its 25 points from `tenure` and `style`, which have no source and
    // scored 0 for every fund. Taking them from `consistency` would have diluted the
    // one component that works.
    const total = (Object.values(MF_WEIGHTS) as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('computes returns from nav micros without leaving integer arithmetic', () => {
    // 2^53 micros is ~₹9,007 crore of NAV — a float would round this series flat.
    const huge = [9_007_199_254_740_993n, 9_907_919_180_215_092n];
    const ranked = rankMfs([mf({ navMicros: huge })], {
      scoreDate: '2026-09-12',
      blockedIds: [],
      rollingWindow: 1,
    });
    expect(ranked[0]!.components.consistency).toBe(MF_WEIGHTS.consistency);
  });
});

describe('persistSignalScores + loadEngineInputs', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('writes the day’s scores and is safe to re-run (append-only table)', async () => {
    const scores = [scoreSatellite(candidate({ instrumentId: 'NSE:RPOWER' }), context())!];
    expect(await persistSignalScores(db, scores)).toBe(1);
    expect(await persistSignalScores(db, scores)).toBe(0);

    const [row] = await db.query<{
      composite: string | number;
      quality_passed: boolean;
      reg_trend: string | number | null;
    }>(`select composite, quality_passed, reg_trend from signal_scores where instrument_id = 'NSE:RPOWER'`);
    expect(Number(row!.composite)).toBeCloseTo(scores[0]!.composite!, 2);
    expect(row!.quality_passed).toBe(true);
    expect(Number(row!.reg_trend)).toBeCloseTo(scores[0]!.components!.trend, 2);
  });

  it('records a quality failure with a null composite as quality_passed = false', async () => {
    const failed = scoreSatellite(
      candidate({ instrumentId: 'NSE:RPOWER', fundamentals: { ...candidate().fundamentals, redFlags: 3 } }),
      context(),
    )!;
    await persistSignalScores(db, [failed]);
    const [row] = await db.query<{ quality_passed: boolean; reg_trend: number | null }>(
      `select quality_passed, reg_trend from signal_scores where instrument_id = 'NSE:RPOWER'`,
    );
    expect(row!.quality_passed).toBe(false);
    expect(row!.reg_trend).toBeNull();
  });

  it('loads watchlist candidates with their fundamentals and price history', async () => {
    const asOf = '2026-08-12';
    await db.query(
      `insert into watchlist (instrument_id, added_on, source, reason)
       values ('NSE:RPOWER', $1, 'advisor', 'test')`,
      [asOf],
    );
    const [upload] = await db.query<{ id: number }>(
      `insert into screener_uploads (as_of, filename, source) values ($1, 'test.csv', 'screener-in') returning id`,
      [asOf],
    );
    await db.query(
      `insert into fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, fcf_pos_5y, red_flags)
       values ($1, 'NSE:RPOWER', $2, 21, 0.4, true, 0)`,
      [upload!.id, JSON.stringify({ 'P/E': '18', 'Profit 5Y CAGR %': '11', 'Sales 5Y CAGR %': '9' })],
    );
    for (const [i, close] of series(100_000n, 20, 5).entries()) {
      await db.query(
        `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
         values ('NSE:RPOWER', $1, $2, 'nse-bhavcopy', now())`,
        [`2026-08-0${i + 3}`, close.toString()],
      );
    }

    const inputs = await loadEngineInputs(db, asOf, { gsecYieldPct: 6.9 });
    const c = inputs.candidates.find((x) => x.instrumentId === 'NSE:RPOWER')!;
    expect(c).toBeDefined();
    expect(c.fundamentals.rocePct).toBe(21);
    expect(c.fundamentals.peRatio).toBe(18);
    expect(c.closes.length).toBe(5);
    // Oldest → newest, and still bigint paise.
    expect(c.closes[0]!).toBeLessThan(c.closes[4]!);
    expect(typeof c.closes[0]).toBe('bigint');
  });
});
