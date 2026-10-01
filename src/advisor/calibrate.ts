import type { Db } from '../db/client.js';
import { EVAL_HORIZONS, MIN_EVALS_FOR_CALIBRATION, type EvalHorizon } from '../domain/scoring.js';

/**
 * Calibration by origin, conviction and horizon (Phase 2.5 Task 7), read from the stored
 * benchmark evaluations (§13). It extends `scoring.calibration` in three ways:
 *
 * - Origin: a recommendation the owner signed from advice (engine_evidence carries
 *   `advisorProposalId`) is scored apart from one the engine raised directly, so the
 *   model's decisions can be judged on their own.
 * - One recommendation counts ONCE per horizon — its earliest benchmark snapshot — even
 *   if it was benchmarked on more than one day.
 * - Unscoreable outcomes are counted as excluded, never as misses.
 *
 * Each bucket withholds its hit-rate below MIN_EVALS_FOR_CALIBRATION (owner-confirmed 20).
 * N alone does not prove skill; replayed (retrospective) results are never mixed in here.
 */

interface OriginCalibrationRow {
  origin: 'advisor' | 'engine';
  conviction: string;
  horizon: EvalHorizon;
  evaluated: number;
  excluded: number;
  hitRate: number | null;
  medianExcessBps: number | null;
}

const parse = (v: unknown): Record<string, unknown> | null =>
  v === null || v === undefined ? null : (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

export async function calibrateByOrigin(db: Db): Promise<{ rows: OriginCalibrationRow[]; minimum: number }> {
  const rows = await db.query<{ recommendation_id: string; benchmark_jsonb: unknown; eval_3m_jsonb: unknown; eval_6m_jsonb: unknown; eval_12m_jsonb: unknown; engine_evidence: unknown }>(
    `select distinct on (b.recommendation_id) b.recommendation_id, b.benchmark_jsonb,
            b.eval_3m_jsonb, b.eval_6m_jsonb, b.eval_12m_jsonb, r.engine_evidence
       from benchmarks b join recommendations r on r.id = b.recommendation_id
      order by b.recommendation_id, b.benchmark_as_of, b.id`,
  );
  const buckets = new Map<string, { hits: number; excess: number[]; excluded: number }>();
  for (const r of rows) {
    const evidence = parse(r.engine_evidence) ?? {};
    const origin = evidence['advisorProposalId'] !== undefined ? 'advisor' : 'engine';
    const conviction = String(parse(r.benchmark_jsonb)?.['conviction'] ?? 'unknown');
    const evals: Record<EvalHorizon, unknown> = { 3: r.eval_3m_jsonb, 6: r.eval_6m_jsonb, 12: r.eval_12m_jsonb };
    for (const h of EVAL_HORIZONS) {
      const e = parse(evals[h]);
      if (e === null) continue; // not yet due: neither evaluated nor excluded
      const key = `${origin}|${conviction}|${h}`;
      const b = buckets.get(key) ?? { hits: 0, excess: [], excluded: 0 };
      if (e['excessBps'] === null || e['excessBps'] === undefined) b.excluded++;
      else {
        b.excess.push(Number(e['excessBps']));
        if (e['convictionHealthy'] === true) b.hits++;
      }
      buckets.set(key, b);
    }
  }
  const out = [...buckets].map(([key, b]): OriginCalibrationRow => {
    const [origin, conviction, h] = key.split('|');
    const n = b.excess.length;
    const s = [...b.excess].sort((x, y) => x - y);
    const enough = n >= MIN_EVALS_FOR_CALIBRATION;
    return {
      origin: origin as 'advisor' | 'engine', conviction: conviction!, horizon: Number(h) as EvalHorizon,
      evaluated: n, excluded: b.excluded,
      hitRate: enough ? b.hits / n : null,
      medianExcessBps: enough ? (n % 2 ? s[(n - 1) / 2]! : Math.round((s[n / 2 - 1]! + s[n / 2]!) / 2)) : null,
    };
  }).sort((a, b) => a.origin.localeCompare(b.origin) || a.conviction.localeCompare(b.conviction) || a.horizon - b.horizon);
  return { rows: out, minimum: MIN_EVALS_FOR_CALIBRATION };
}
