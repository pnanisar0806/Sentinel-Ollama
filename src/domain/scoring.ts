import type { Db } from '../db/client.js';

/**
 * PRD §13 scoring harness. A recommendation is scored against the world it was made in:
 * the instrument's close and the benchmark index close on the day it was created, captured
 * once and never rewritten (migration 0012 enforces that). Everything after is a post-hoc
 * evaluation at 3, 6 and 12 months.
 *
 * The harness ACCRUES. On a fresh install it has nothing to say, and saying so is the
 * point — a hit-rate computed from two recommendations is worse than no hit-rate, because
 * it invites the owner to trust a number that cannot mean anything yet.
 */

/** §13 evaluation horizons, in months. */
export const EVAL_HORIZONS = [3, 6, 12] as const;
export type EvalHorizon = (typeof EVAL_HORIZONS)[number];

/**
 * Below this many completed evaluations in a conviction bucket, the calibration table
 * says "insufficient data" instead of a percentage.
 *
 * 20 is a stake in the ground, not a derived figure: at a cap of four recommendations a
 * month it is roughly half a year of output per bucket, and below it a single outcome
 * moves the hit-rate by more than five points. It is an OWNER TRUE-UP ITEM — the right
 * number is a judgement about how much evidence he wants before he trusts the table.
 */
export const MIN_EVALS_FOR_CALIBRATION = 20;

export interface BenchmarkSnapshot {
  instrumentId: string | null;
  closePaise: string | null;
  indexSeries: string;
  indexClosePaise: string | null;
  /** The conviction the engine had at creation — the axis the calibration table splits on. */
  conviction: string;
  /** Set when the instrument or the index had no close on the day. */
  note?: string;
}

export interface DueEval {
  benchmarkId: number;
  recommendationId: number;
  horizon: EvalHorizon;
  createdOn: string;
  snapshot: BenchmarkSnapshot;
}

export interface EvalResult {
  benchmarkId: number;
  horizon: EvalHorizon;
  asOf: string;
  instrumentReturnBps: number | null;
  benchmarkReturnBps: number | null;
  /** Instrument minus benchmark. The only number that says whether the call was right. */
  excessBps: number | null;
  /** §13: the call is healthy when it beat the benchmark it was measured against. */
  convictionHealthy: boolean | null;
  note: string | null;
}

const DEFAULT_INDEX = 'NIFTY 500';

const isoDate = (v: string | Date): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export function addMonths(dateIso: string, months: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return d.toISOString().slice(0, 10);
}

async function closeOn(db: Db, instrumentId: string, onOrBefore: string): Promise<bigint | null> {
  const [row] = await db.query<{ close_paise: string | number | bigint }>(
    `select close_paise from prices_eod where instrument_id = $1 and trade_date <= $2
      order by trade_date desc limit 1`,
    [instrumentId, onOrBefore],
  );
  return row === undefined ? null : BigInt(row.close_paise);
}

async function indexCloseOn(db: Db, series: string, onOrBefore: string): Promise<bigint | null> {
  const [row] = await db.query<{ close_paise: string | number | bigint }>(
    `select close_paise from index_prices_eod where series_code = $1 and trade_date <= $2
      order by trade_date desc limit 1`,
    [series, onOrBefore],
  );
  return row === undefined ? null : BigInt(row.close_paise);
}

/** Integer basis points. Money never divides through a float. */
function returnBps(from: bigint | null, to: bigint | null): number | null {
  if (from === null || to === null || from <= 0n) return null;
  return Number(((to - from) * 10_000n) / from);
}

/**
 * §13.2: captures the point of comparison at creation. Idempotent per
 * `(recommendation_id, benchmark_as_of)`, so a re-run of the week's report cannot move a
 * snapshot that already exists.
 */
export async function snapshotBenchmark(
  db: Db,
  opts: {
    recommendationId: number;
    instrumentId: string | null;
    asOf: string;
    conviction: string;
    indexSeries?: string;
  },
): Promise<BenchmarkSnapshot> {
  const indexSeries = opts.indexSeries ?? DEFAULT_INDEX;
  const close = opts.instrumentId === null ? null : await closeOn(db, opts.instrumentId, opts.asOf);
  const indexClose = await indexCloseOn(db, indexSeries, opts.asOf);

  const missing: string[] = [];
  if (opts.instrumentId !== null && close === null) missing.push('no instrument close');
  if (indexClose === null) missing.push(`no ${indexSeries} close`);

  const snapshot: BenchmarkSnapshot = {
    instrumentId: opts.instrumentId,
    closePaise: close === null ? null : close.toString(),
    indexSeries,
    indexClosePaise: indexClose === null ? null : indexClose.toString(),
    conviction: opts.conviction,
    ...(missing.length > 0
      ? { note: `${missing.join(', ')} on ${opts.asOf} — this recommendation cannot be scored` }
      : {}),
  };

  await db.query(
    `insert into benchmarks (recommendation_id, benchmark_as_of, benchmark_jsonb)
     values ($1, $2, $3)
     on conflict (recommendation_id, benchmark_as_of) do nothing`,
    [opts.recommendationId, opts.asOf, JSON.stringify(snapshot)],
  );
  return snapshot;
}

/**
 * Recommendations whose 3/6/12-month mark has passed with no evaluation written yet.
 * Nothing is ever scored early: a horizon that has not elapsed by `asOf` is not returned.
 */
export async function dueEvals(db: Db, asOf: string): Promise<DueEval[]> {
  const rows = await db.query<{
    id: number;
    recommendation_id: number;
    benchmark_as_of: string | Date;
    benchmark_jsonb: string;
    eval_3m_as_of: string | Date | null;
    eval_6m_as_of: string | Date | null;
    eval_12m_as_of: string | Date | null;
  }>(
    `select id, recommendation_id, benchmark_as_of, benchmark_jsonb,
            eval_3m_as_of, eval_6m_as_of, eval_12m_as_of
       from benchmarks order by id`,
  );

  const due: DueEval[] = [];
  for (const r of rows) {
    const createdOn = isoDate(r.benchmark_as_of);
    const done: Record<EvalHorizon, unknown> = {
      3: r.eval_3m_as_of,
      6: r.eval_6m_as_of,
      12: r.eval_12m_as_of,
    };
    for (const horizon of EVAL_HORIZONS) {
      if (done[horizon] !== null) continue;
      if (addMonths(createdOn, horizon) > asOf) continue;
      due.push({
        benchmarkId: Number(r.id),
        recommendationId: Number(r.recommendation_id),
        horizon,
        createdOn,
        snapshot: JSON.parse(r.benchmark_jsonb) as BenchmarkSnapshot,
      });
    }
  }
  return due;
}

/** Computes one §13 evaluation and writes it. The creation snapshot is not touched. */
export async function evaluateRec(db: Db, due: DueEval, asOf: string): Promise<EvalResult> {
  const s = due.snapshot;
  const evalDate = addMonths(due.createdOn, due.horizon);
  const now =
    s.instrumentId === null ? null : await closeOn(db, s.instrumentId, evalDate);
  const indexNow = await indexCloseOn(db, s.indexSeries, evalDate);

  const instrumentReturnBps = returnBps(
    s.closePaise === null ? null : BigInt(s.closePaise),
    now,
  );
  const benchmarkReturnBps = returnBps(
    s.indexClosePaise === null ? null : BigInt(s.indexClosePaise),
    indexNow,
  );
  const excessBps =
    instrumentReturnBps === null || benchmarkReturnBps === null
      ? null
      : instrumentReturnBps - benchmarkReturnBps;

  const result: EvalResult = {
    benchmarkId: due.benchmarkId,
    horizon: due.horizon,
    asOf: evalDate,
    instrumentReturnBps,
    benchmarkReturnBps,
    excessBps,
    convictionHealthy: excessBps === null ? null : excessBps > 0,
    note:
      excessBps === null
        ? `not scoreable: ${s.note ?? 'a close was missing at creation or at the evaluation date'}`
        : null,
  };

  const col = `eval_${due.horizon}m`;
  await db.query(
    `update benchmarks set ${col}_as_of = $1, ${col}_jsonb = $2 where id = $3`,
    [evalDate, JSON.stringify(result), due.benchmarkId],
  );
  return result;
}

export async function runDueEvals(db: Db, asOf: string): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const due of await dueEvals(db, asOf)) out.push(await evaluateRec(db, due, asOf));
  return out;
}

export interface CalibrationRow {
  conviction: string;
  horizon: EvalHorizon;
  evaluated: number;
  /** null until the bucket has `MIN_EVALS_FOR_CALIBRATION` completed evaluations. */
  hitRate: number | null;
  medianExcessBps: number | null;
}

export interface Calibration {
  rows: CalibrationRow[];
  totalEvaluated: number;
  /** True while no bucket has enough evidence to state a hit-rate. */
  insufficient: boolean;
  minimum: number;
}

/**
 * §13 calibration: conviction bucket against hit-rate. Reports "insufficient data" rather
 * than a percentage derived from a handful of outcomes.
 */
export async function calibration(db: Db): Promise<Calibration> {
  const rows = await db.query<{
    benchmark_jsonb: string;
    eval_3m_jsonb: string | null;
    eval_6m_jsonb: string | null;
    eval_12m_jsonb: string | null;
  }>(
    `select benchmark_jsonb, eval_3m_jsonb, eval_6m_jsonb, eval_12m_jsonb from benchmarks`,
  );

  const buckets = new Map<string, { hits: number; excess: number[] }>();
  let totalEvaluated = 0;

  for (const r of rows) {
    const conviction = (JSON.parse(r.benchmark_jsonb) as BenchmarkSnapshot).conviction;
    const byHorizon: [EvalHorizon, string | null][] = [
      [3, r.eval_3m_jsonb],
      [6, r.eval_6m_jsonb],
      [12, r.eval_12m_jsonb],
    ];
    for (const [horizon, raw] of byHorizon) {
      if (raw === null) continue;
      const evaluation = JSON.parse(raw) as EvalResult;
      if (evaluation.excessBps === null) continue; // unscoreable is not a miss
      const key = `${conviction}|${horizon}`;
      const bucket = buckets.get(key) ?? { hits: 0, excess: [] };
      if (evaluation.convictionHealthy === true) bucket.hits++;
      bucket.excess.push(evaluation.excessBps);
      buckets.set(key, bucket);
      totalEvaluated++;
    }
  }

  const out: CalibrationRow[] = [...buckets].map(([key, bucket]) => {
    const [conviction, horizon] = key.split('|');
    const n = bucket.excess.length;
    const sorted = [...bucket.excess].sort((a, b) => a - b);
    const median =
      n === 0 ? null : n % 2 === 1 ? sorted[(n - 1) / 2]! : Math.round((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
    const enough = n >= MIN_EVALS_FOR_CALIBRATION;
    return {
      conviction: conviction!,
      horizon: Number(horizon) as EvalHorizon,
      evaluated: n,
      hitRate: enough ? bucket.hits / n : null,
      medianExcessBps: enough ? median : null,
    };
  });
  out.sort((a, b) => a.conviction.localeCompare(b.conviction) || a.horizon - b.horizon);

  return {
    rows: out,
    totalEvaluated,
    insufficient: out.every((r) => r.hitRate === null),
    minimum: MIN_EVALS_FOR_CALIBRATION,
  };
}
