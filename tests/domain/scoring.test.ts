import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  EVAL_HORIZONS,
  MIN_EVALS_FOR_CALIBRATION,
  addMonths,
  calibration,
  dueEvals,
  evaluateRec,
  runDueEvals,
  snapshotBenchmark,
} from '../../src/domain/scoring.js';

const CREATED = '2026-08-12';
let db: Db;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: CREATED });
});

async function price(instrumentId: string, date: string, closePaise: bigint): Promise<void> {
  await db.query(
    `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
     values ($1, $2, $3, 'nse-bhavcopy', $4)
     on conflict (instrument_id, trade_date) do update set close_paise = excluded.close_paise`,
    [instrumentId, date, closePaise.toString(), `${date}T18:00:00Z`],
  );
}

async function indexPrice(date: string, closePaise: bigint): Promise<void> {
  await db.query(
    `insert into index_prices_eod (series_code, trade_date, close_paise, as_of)
     values ('NIFTY 500', $1, $2, $3)
     on conflict (series_code, trade_date) do update set close_paise = excluded.close_paise`,
    [date, closePaise.toString(), `${date}T18:00:00Z`],
  );
}

async function recommendation(createdOn = CREATED): Promise<number> {
  const [row] = await db.query<{ id: number }>(
    `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence)
     values ($1, 'satellite', 'test', '{}', '[]', '["3.4"]', '{}') returning id`,
    [createdOn],
  );
  return Number(row!.id);
}

describe('addMonths', () => {
  it('lands on the same day of the month, clamping at a short month', () => {
    expect(addMonths('2026-08-12', 3)).toBe('2026-11-12');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2026-08-12', 12)).toBe('2027-08-12');
  });
});

describe('snapshotBenchmark (§13.2)', () => {
  it('captures the exact closes of the creation day', async () => {
    await price('NSE:RPOWER', CREATED, 12_345n);
    await indexPrice(CREATED, 2_000_000n);
    const id = await recommendation();

    const snap = await snapshotBenchmark(db, {
      recommendationId: id,
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });
    expect(snap.closePaise).toBe('12345');
    expect(snap.indexClosePaise).toBe('2000000');
    expect(snap.note).toBeUndefined();
  });

  it('moves with the seeded price — a different close gives a different snapshot', async () => {
    await indexPrice(CREATED, 2_000_000n);
    await price('NSE:RPOWER', CREATED, 12_345n);
    const first = await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });

    await price('NSE:RPOWER', CREATED, 99_999n);
    const second = await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });
    expect(second.closePaise).not.toBe(first.closePaise);
    expect(second.closePaise).toBe('99999');
  });

  it('refuses to rewrite a snapshot once taken, but keeps the row', async () => {
    await price('NSE:RPOWER', CREATED, 12_345n);
    await indexPrice(CREATED, 2_000_000n);
    const id = await recommendation();
    await snapshotBenchmark(db, { recommendationId: id, instrumentId: 'NSE:RPOWER', asOf: CREATED, conviction: 'HIGH' });

    await price('NSE:RPOWER', CREATED, 55_555n);
    await snapshotBenchmark(db, { recommendationId: id, instrumentId: 'NSE:RPOWER', asOf: CREATED, conviction: 'HIGH' });

    const rows = await db.query<{ benchmark_jsonb: string }>(
      `select benchmark_jsonb from benchmarks where recommendation_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.benchmark_jsonb).closePaise).toBe('12345');

    // And the database itself refuses an overwrite (migration 0012).
    await expect(
      db.query(`update benchmarks set benchmark_jsonb = '{}' where recommendation_id = $1`, [id]),
    ).rejects.toThrow(/may not be rewritten/);
  });

  it('records why a recommendation cannot be scored rather than inventing a price', async () => {
    const snap = await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'MEDIUM',
    });
    expect(snap.closePaise).toBeNull();
    expect(snap.note).toMatch(/cannot be scored/);
  });
});

describe('dueEvals', () => {
  it('scores nothing on a fresh seed — no horizon has elapsed', async () => {
    await price('NSE:RPOWER', CREATED, 12_345n);
    await indexPrice(CREATED, 2_000_000n);
    await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });
    expect(await dueEvals(db, CREATED)).toEqual([]);
    // Not even the day before the 3-month mark.
    const dayBefore = addMonths(CREATED, 3);
    expect(await dueEvals(db, new Date(new Date(`${dayBefore}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10))).toEqual([]);
  });

  it('returns each horizon exactly once, as it elapses', async () => {
    await price('NSE:RPOWER', CREATED, 12_345n);
    await indexPrice(CREATED, 2_000_000n);
    await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });

    const at3 = await dueEvals(db, addMonths(CREATED, 3));
    expect(at3.map((d) => d.horizon)).toEqual([3]);

    await runDueEvals(db, addMonths(CREATED, 3));
    expect(await dueEvals(db, addMonths(CREATED, 3))).toEqual([]);

    const at12 = await dueEvals(db, addMonths(CREATED, 12));
    expect(at12.map((d) => d.horizon)).toEqual([6, 12]);
  });
});

describe('evaluateRec', () => {
  it('computes excess return over the benchmark in integer bps', async () => {
    await price('NSE:RPOWER', CREATED, 100_000n);
    await indexPrice(CREATED, 2_000_000n);
    const id = await recommendation();
    await snapshotBenchmark(db, { recommendationId: id, instrumentId: 'NSE:RPOWER', asOf: CREATED, conviction: 'HIGH' });

    const evalDate = addMonths(CREATED, 3);
    await price('NSE:RPOWER', evalDate, 120_000n); // +20%
    await indexPrice(evalDate, 2_100_000n); //  +5%

    const [result] = await runDueEvals(db, evalDate);
    expect(result!.instrumentReturnBps).toBe(2000);
    expect(result!.benchmarkReturnBps).toBe(500);
    expect(result!.excessBps).toBe(1500);
    expect(result!.convictionHealthy).toBe(true);
  });

  it('marks a call that lagged its benchmark as unhealthy', async () => {
    await price('NSE:RPOWER', CREATED, 100_000n);
    await indexPrice(CREATED, 2_000_000n);
    const id = await recommendation();
    await snapshotBenchmark(db, { recommendationId: id, instrumentId: 'NSE:RPOWER', asOf: CREATED, conviction: 'MEDIUM' });

    const evalDate = addMonths(CREATED, 3);
    await price('NSE:RPOWER', evalDate, 101_000n); // +1%
    await indexPrice(evalDate, 2_200_000n); // +10%

    const [result] = await runDueEvals(db, evalDate);
    expect(result!.excessBps).toBeLessThan(0);
    expect(result!.convictionHealthy).toBe(false);
  });

  it('writes the evaluation without disturbing the creation snapshot', async () => {
    await price('NSE:RPOWER', CREATED, 100_000n);
    await indexPrice(CREATED, 2_000_000n);
    const id = await recommendation();
    await snapshotBenchmark(db, { recommendationId: id, instrumentId: 'NSE:RPOWER', asOf: CREATED, conviction: 'HIGH' });
    const evalDate = addMonths(CREATED, 3);
    await price('NSE:RPOWER', evalDate, 120_000n);
    await indexPrice(evalDate, 2_100_000n);
    await runDueEvals(db, evalDate);

    const [row] = await db.query<{ benchmark_jsonb: string; eval_3m_jsonb: string; eval_3m_as_of: string | Date }>(
      `select benchmark_jsonb, eval_3m_jsonb, eval_3m_as_of from benchmarks where recommendation_id = $1`,
      [id],
    );
    expect(JSON.parse(row!.benchmark_jsonb).closePaise).toBe('100000');
    expect(JSON.parse(row!.eval_3m_jsonb).excessBps).toBe(1500);
  });

  it('says a call is unscoreable rather than calling a missing price a loss', async () => {
    const id = await recommendation();
    await snapshotBenchmark(db, { recommendationId: id, instrumentId: 'NSE:RPOWER', asOf: CREATED, conviction: 'HIGH' });
    const [result] = await runDueEvals(db, addMonths(CREATED, 3));
    expect(result!.excessBps).toBeNull();
    expect(result!.convictionHealthy).toBeNull();
    expect(result!.note).toMatch(/not scoreable/);
  });
});

describe('calibration (§13)', () => {
  it('says "insufficient data" instead of a hit-rate built on a handful of outcomes', async () => {
    const empty = await calibration(db);
    expect(empty.totalEvaluated).toBe(0);
    expect(empty.insufficient).toBe(true);
    expect(empty.rows).toEqual([]);
    expect(empty.minimum).toBe(MIN_EVALS_FOR_CALIBRATION);

    await price('NSE:RPOWER', CREATED, 100_000n);
    await indexPrice(CREATED, 2_000_000n);
    const evalDate = addMonths(CREATED, 3);
    await price('NSE:RPOWER', evalDate, 120_000n);
    await indexPrice(evalDate, 2_100_000n);
    await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });
    await runDueEvals(db, evalDate);

    const one = await calibration(db);
    expect(one.totalEvaluated).toBe(1);
    expect(one.rows[0]!.evaluated).toBe(1);
    // One winning call is not a 100% hit-rate.
    expect(one.rows[0]!.hitRate).toBeNull();
    expect(one.insufficient).toBe(true);
  });

  it('states a hit-rate once the bucket clears the minimum', async () => {
    await indexPrice(CREATED, 2_000_000n);
    const evalDate = addMonths(CREATED, 3);
    await indexPrice(evalDate, 2_100_000n);

    for (let i = 0; i < MIN_EVALS_FOR_CALIBRATION; i++) {
      const instrument = `NSE:RPOWER`;
      await price(instrument, CREATED, 100_000n);
      // Three of them lag the index; the rest beat it.
      await price(instrument, evalDate, i < 3 ? 100_500n : 120_000n);
      await snapshotBenchmark(db, {
        recommendationId: await recommendation(),
        instrumentId: instrument,
        asOf: CREATED,
        conviction: 'HIGH',
      });
      await runDueEvals(db, evalDate);
    }

    const c = await calibration(db);
    expect(c.totalEvaluated).toBe(MIN_EVALS_FOR_CALIBRATION);
    const high = c.rows.find((r) => r.conviction === 'HIGH' && r.horizon === 3)!;
    expect(high.hitRate).not.toBeNull();
    // Derived from the run above rather than restated: 3 laggards out of the batch.
    expect(high.hitRate).toBeCloseTo((MIN_EVALS_FOR_CALIBRATION - 3) / MIN_EVALS_FOR_CALIBRATION, 6);
    expect(c.insufficient).toBe(false);
  });

  it('never counts an unscoreable evaluation as a miss', async () => {
    await snapshotBenchmark(db, {
      recommendationId: await recommendation(),
      instrumentId: 'NSE:RPOWER',
      asOf: CREATED,
      conviction: 'HIGH',
    });
    await runDueEvals(db, addMonths(CREATED, 3));
    const c = await calibration(db);
    expect(c.totalEvaluated).toBe(0);
    expect(c.rows).toEqual([]);
  });

  it('exposes all three §13 horizons', () => {
    expect([...EVAL_HORIZONS]).toEqual([3, 6, 12]);
  });
});
