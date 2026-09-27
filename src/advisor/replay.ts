import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { PROMPT_VERSION } from '../sources/sentiment.js';
import { SIZING_POLICY } from '../domain/sizing.js';

/**
 * Point-in-time replay (Phase 2.5 Task 5, PRD §13).
 *
 * Reconstructs what the advisor could have known at a cutoff from RECORDED evidence only:
 * a row counts if its economic date AND its arrival time are both on or before the cutoff,
 * so a late backfill of old news, or a later reclassification, cannot leak backwards.
 * No model and no network are called; the only write is `replay_runs`.
 *
 * What it is not: re-running today's model on old news would be a retrospective
 * experiment (the model may have seen the outcome in training), not a backtest. Engine
 * scores are replayed as stored artifacts, not recomputed. Inputs with no history —
 * owner rails, the watchlist's past membership before its first row — are named in
 * `coverage.unreconstructable` rather than silently taken from today.
 */

export interface ReplayNews { eventId: number; instrumentId: string | null; eventType: string; headline: string; publishedAt: string; polarity: string | null; materiality: string | null }
export interface ReplayScore { instrumentId: string; scoreDate: string; composite: number }
export interface ReplayPoint { cutoff: string; news: ReplayNews[]; scores: ReplayScore[]; holdingsSnapshot: string | null }

const endOfDay = (d: string): string => `${d}T23:59:59.999+05:30`;

export async function replayAt(db: Db, cutoff: string): Promise<ReplayPoint> {
  const until = endOfDay(cutoff);
  const news = await db.query<{ id: string; instrument_id: string | null; event_type: string; headline: string; published_at: string | Date; polarity: string | null; materiality: string | null }>(
    `select e.id, e.instrument_id, e.event_type, e.headline, e.published_at, s.polarity, s.materiality
       from news_events e
       left join lateral (select polarity, materiality from event_sentiment x
                           where x.event_id = e.id and x.classified_at <= $1
                           order by x.classified_at desc, x.id desc limit 1) s on true
      where e.published_at <= $1 and e.received_at <= $1
      order by e.published_at, e.id`,
    [until],
  );
  const [latest] = await db.query<{ d: string | null }>(`select max(score_date)::text d from signal_scores where score_date <= $1::date`, [cutoff]);
  const scores = latest?.d
    ? await db.query<{ instrument_id: string; score_date: string; composite: string }>(
      `select instrument_id, score_date::text, composite::text from signal_scores where score_date = $1 order by instrument_id`, [latest.d])
    : [];
  const [snap] = await db.query<{ d: string | null }>(
    `select max(business_date)::text d from snapshots where business_date <= $1::date and taken_at <= $2`, [cutoff, until]);
  return {
    cutoff,
    news: news.map((n) => ({
      eventId: Number(n.id), instrumentId: n.instrument_id, eventType: n.event_type, headline: n.headline,
      publishedAt: new Date(n.published_at).toISOString(), polarity: n.polarity, materiality: n.materiality,
    })),
    scores: scores.map((s) => ({ instrumentId: s.instrument_id, scoreDate: s.score_date, composite: Number(s.composite) })),
    holdingsSnapshot: snap?.d ?? null,
  };
}

const monthEnds = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    out.push(end > to ? to : end);
  }
  return out;
};

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);

export interface ReplayRun {
  datasetHash: string; codeHash: string; configHash: string;
  coverage: { points: number; newsSeen: number; scoresSeen: number; unreconstructable: string[] };
  result: ReplayPoint[];
}

/** Month-end replay over a window. Same evidence, same result — whatever day it is run. */
export async function replayWindow(db: Db, opts: { from: string; to: string; now?: Date }): Promise<ReplayRun> {
  const result: ReplayPoint[] = [];
  for (const cutoff of monthEnds(opts.from, opts.to)) result.push(await replayAt(db, cutoff));
  const unreconstructable = [
    'owner rails: settings_rails keeps only current values, so past rails are not known',
    'cash and reservations at the cutoff: not versioned, so sizing is not replayed',
    'engine scores are stored artifacts; their ingestion time is not recorded',
  ];
  if (result.some((p) => p.holdingsSnapshot === null)) unreconstructable.push('holdings: no snapshot on or before some cutoffs');
  const run: ReplayRun = {
    datasetHash: sha(result),
    codeHash: sha([SIZING_POLICY, PROMPT_VERSION, 'replay-v1']),
    configHash: sha({ from: opts.from, to: opts.to, step: 'month-end' }),
    coverage: {
      points: result.length,
      newsSeen: result.reduce((n, p) => n + p.news.length, 0),
      scoresSeen: result.reduce((n, p) => n + p.scores.length, 0),
      unreconstructable,
    },
    result,
  };
  await db.query(
    `insert into replay_runs (dataset_hash, code_hash, config_hash, window_from, window_to, coverage, result, as_of)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [run.datasetHash, run.codeHash, run.configHash, opts.from, opts.to, JSON.stringify(run.coverage), JSON.stringify(run.result),
     (opts.now ?? new Date()).toISOString()],
  );
  return run;
}
