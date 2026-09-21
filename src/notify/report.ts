import type { Db } from '../db/client.js';
import { escapeMarkdown } from './telegram.js';
import { formatInr } from '../money/paise.js';
import { loadPositions, netWorth, type Position } from '../domain/networth.js';
import { assessStaleness, blockedInstruments, type StalenessRow } from '../sources/staleness.js';
import {
  loadEngineInputs,
  persistSignalScores,
  scoreSatellite,
  type SatelliteScore,
} from '../domain/engine.js';
import { rebalanceRec, type FundingRoute } from '../domain/alloc-engine.js';
import { evaluateExits, persistExitCandidates, type ExitCandidate } from '../domain/sell-triggers.js';
import { listRedemptionsUntil, type Redemption } from '../domain/redemptions.js';
import {
  buildRecommendation,
  persistRecommendation,
  isPaperMode,
  type RecLeg,
  type Recommendation,
} from '../domain/recommendations.js';
import { narrate, type NarrationDeps } from '../sources/llm-narration.js';
import { calibration, runDueEvals, snapshotBenchmark, type Calibration, type EvalResult } from '../domain/scoring.js';

/**
 * FR-51 weekly deep report (PRD §12.2). Five sections: signal review, watchlist changes,
 * recommendation pipeline, staleness, narrative.
 *
 * `buildReportInput` runs the week's pipeline and persists what it produces; `composeReport`
 * is pure, so the rendering is testable without a database. Same split as `digest.ts`.
 *
 * This module does not reach `buckets.ts`/`maturities.ts`: it drives the sizing engines, and
 * a sizing path must not see `funded-status` (the no-catch-up firewall). The maturity ROUTING
 * recommendation is assembled by `jobs/report.ts` — a reporting surface — and passed in.
 */

/** Long lists collapse past this, with a count, so the report stays a report. */
export const MAX_LIST_ITEMS = 8;

/** How far ahead the pipeline looks for a redemption. */
export const REDEMPTION_HORIZON_DAYS = 45;

const WEEK_DAYS = 7;

export interface SignalReview {
  scored: SatelliteScore[];
  /** Names that reached MEDIUM or better this week and had not before. */
  newlyRecommended: string[];
  /** Names whose composite fell by a band since the comparison date. */
  fallen: { instrumentId: string; from: number; to: number }[];
  /** Names the quality gate rejected this week. */
  qualityDrops: { instrumentId: string; failures: string[] }[];
  comparedWith: string | null;
  /** Why no scoring happened, when it did not. */
  skippedReason: string | null;
}

export interface WatchlistChange {
  instrumentId: string;
  change: 'added' | 'removed';
  on: string;
  source: string;
  reason: string;
}

export interface StoredRecommendation {
  id: number;
  createdOn: string;
  kind: string;
  intent: string;
  primary: RecLeg;
  alternates: RecLeg[];
  ipsClauseRefs: string[];
}

export interface SuppressedAction {
  loggedOn: string;
  action: string;
  reason: string;
  suppressedBy: string;
}

export interface BlockedName {
  instrumentId: string;
  reason: string;
}

export interface ReportInput {
  asOf: string;
  generatedAt: string;
  paperMode: boolean;
  signalReview: SignalReview;
  watchlistChanges: WatchlistChange[];
  pipeline: {
    recommendations: StoredRecommendation[];
    /**
     * Open recommendations whose instrument is blocked TODAY. FR-31 is not only about
     * generating a recommendation: one raised last week on data that has since gone stale
     * is not actionable either, so it leaves the pipeline and appears under staleness.
     */
    withheld: StoredRecommendation[];
    suppressed: SuppressedAction[];
    exits: ExitCandidate[];
    redemptions: Redemption[];
  };
  staleness: {
    rows: StalenessRow[];
    blocked: BlockedName[];
    incidents: { subject: string; detail: string; openedAt: string }[];
  };
  /** §13 scoring: evaluations that came due this run, and the calibration table. */
  scoring: { evaluated: EvalResult[]; calibration: Calibration };
  bullets: string[];
  narrative: string | null;
}

export interface BuildReportOptions {
  now?: string;
  /** 10Y G-sec yield. Absent ⇒ no satellite scoring, stated as a skip reason. */
  gsecYieldPct?: number | undefined;
  /** Load-free routes available to fund an allocation move. */
  routes?: FundingRoute[];
  /** Maturity routing recommendations, assembled by the job layer. */
  maturityRecommendations?: Recommendation[];
  narration?: Omit<NarrationDeps, 'bullets' | 'engineJson'>;
}

const iso = (v: string | Date): string =>
  v instanceof Date ? v.toISOString() : String(v);
const isoDate = (v: string | Date): string => iso(v).slice(0, 10);

function daysBefore(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Why each blocked name is blocked, in the owner's words rather than a source code. */
function blockReasons(rows: StalenessRow[], positions: Position[], blocked: string[]): BlockedName[] {
  const stale = new Set(rows.filter((r) => r.stale).map((r) => r.source));
  const age = new Map(rows.map((r) => [r.source, r]));
  const describe = (source: string): string => {
    const row = age.get(source);
    if (row === undefined) return source;
    const ageText = row.ageHours === Infinity ? 'never delivered' : `${row.ageHours.toFixed(1)}h old`;
    return `${source} ${ageText} against a ${row.limitHours}h limit`;
  };

  return blocked.map((id) => {
    const p = positions.find((x) => x.instrumentId === id);
    const causes: string[] = [];
    if (p !== undefined) {
      if (stale.has(p.source)) causes.push(describe(p.source));
      if (p.currency !== 'INR' && stale.has('frankfurter')) causes.push(describe('frankfurter'));
      if (p.kind === 'MF' && stale.has('amfi')) causes.push(describe('amfi'));
      if (['EQUITY', 'ETF', 'BOND'].includes(p.kind) && stale.has('bhavcopy')) causes.push(describe('bhavcopy'));
      if (p.kind === 'EQUITY' && stale.has('screener')) causes.push(describe('screener'));
    }
    return { instrumentId: id, reason: causes.length > 0 ? causes.join('; ') : 'a valuation input is stale' };
  });
}

async function runSignalReview(
  db: Db,
  asOf: string,
  blocked: readonly string[],
  gsecYieldPct: number | undefined,
): Promise<SignalReview> {
  const empty: SignalReview = {
    scored: [],
    newlyRecommended: [],
    fallen: [],
    qualityDrops: [],
    comparedWith: null,
    skippedReason: null,
  };
  if (gsecYieldPct === undefined) {
    return {
      ...empty,
      skippedReason:
        'no 10Y G-sec yield is configured, and the valuation leg scores earnings yield against it — ' +
        'the engine will not invent the risk-free rate',
    };
  }

  const inputs = await loadEngineInputs(db, asOf, { gsecYieldPct });
  const ctx = {
    ...inputs.context,
    blockedIds: blocked,
    fit: { headroomPaise: 0n as never, sectorWeightPct: {}, sectorCapPct: 25 },
  };
  const scored = inputs.candidates
    .map((c) => scoreSatellite(c, ctx))
    .filter((s): s is SatelliteScore => s !== null);
  await persistSignalScores(db, scored);

  const priorDate = await db.query<{ score_date: string | Date }>(
    `select score_date from signal_scores where score_date < $1 order by score_date desc limit 1`,
    [asOf],
  );
  const comparedWith = priorDate[0] === undefined ? null : isoDate(priorDate[0].score_date);
  const prior = new Map<string, number>();
  if (comparedWith !== null) {
    const rows = await db.query<{ instrument_id: string; composite: string | number; quality_passed: boolean }>(
      `select instrument_id, composite, quality_passed from signal_scores where score_date = $1`,
      [comparedWith],
    );
    for (const r of rows) if (r.quality_passed) prior.set(r.instrument_id, Number(r.composite));
  }

  const newlyRecommended: string[] = [];
  const fallen: SignalReview['fallen'] = [];
  const qualityDrops: SignalReview['qualityDrops'] = [];
  for (const s of scored) {
    if (!s.qualityPassed) {
      qualityDrops.push({ instrumentId: s.instrumentId, failures: s.qualityFailures });
      continue;
    }
    const was = prior.get(s.instrumentId);
    if ((s.band === 'HIGH' || s.band === 'MEDIUM') && (was === undefined || was < 70)) {
      newlyRecommended.push(s.instrumentId);
    }
    if (was !== undefined && s.composite !== null && s.composite < was) {
      fallen.push({ instrumentId: s.instrumentId, from: was, to: s.composite });
    }
  }

  return { scored, newlyRecommended, fallen, qualityDrops, comparedWith, skippedReason: null };
}

function satelliteLeg(s: SatelliteScore, sector: string | null): RecLeg {
  const c = s.components!;
  return {
    intent: 'add satellite equity exposure',
    instrumentId: s.instrumentId,
    action: 'BUY',
    amountPaise: null,
    thesis:
      `Composite ${s.composite} of 100 (${s.band}): valuation ${c.valuation}, trend ${c.trend}, ` +
      `earnings ${c.earnings}, fit ${c.fit}, scored ${s.scoreDate} after passing the quality gate. ` +
      `${sector === null ? 'Sector unknown from our data.' : `Sector ${sector}.`} ` +
      `Sizing and the buy price are the owner's call — this is a paper candidate, not an order.`,
    ipsClauseRefs: ['3.4', '3.6'],
    falsification: { metric: 'roce_pct', op: 'lt', value: 15 },
  };
}

export async function buildReportInput(
  db: Db,
  asOf: string,
  opts: BuildReportOptions = {},
): Promise<ReportInput> {
  const generatedAt = opts.now ?? new Date().toISOString();
  const month = asOf.slice(0, 7);

  const rows = await assessStaleness(db, generatedAt);
  const positions = await loadPositions(db);
  const blocked = blockedInstruments(rows, positions);
  const incidentRows = await db.query<{ subject: string; detail: string; opened_at: string | Date }>(
    `select subject, detail, opened_at from incidents
      where kind = 'STALE_DATA' and resolved_at is null order by subject`,
  );

  const signalReview = await runSignalReview(db, asOf, blocked, opts.gsecYieldPct);

  // Allocation: one recommendation per breach direction, sized off the Phase 0 basis.
  const rebalance = rebalanceRec(
    { netWorth: netWorth(positions, 0n as never), positions, routes: opts.routes ?? [] },
    month,
  );
  const built: Recommendation[] = [...(opts.maturityRecommendations ?? [])];
  for (const action of rebalance.actions) {
    built.push(
      buildRecommendation({
        kind: 'rebalance',
        createdOn: asOf,
        primary: {
          intent: `${action.kind === 'ADD' ? 'restore' : 'reduce'} ${action.assetClass} toward its IPS band`,
          instrumentId: action.instrumentId ?? null,
          action: action.kind === 'TRIM' ? 'TRIM' : action.kind === 'ADD' ? 'BUY' : 'REDIRECT',
          amountPaise: action.amountPaise.toString(),
          thesis: `${action.rationale}. ${action.taxNote}. Route: ${action.route}.`,
          ipsClauseRefs: rebalance.ipsClauseRefs,
          falsification: null,
        },
        engineEvidence: { drift: rebalance.summary, direction: rebalance.direction },
      }),
    );
  }
  for (const s of signalReview.scored) {
    if (s.band !== 'HIGH' && s.band !== 'MEDIUM') continue;
    if (blocked.includes(s.instrumentId)) continue;
    built.push(
      buildRecommendation({
        kind: 'satellite',
        createdOn: asOf,
        primary: satelliteLeg(s, null),
        engineEvidence: { composite: s.composite, band: s.band, evidence: s.evidence },
      }),
    );
  }
  for (const rec of built) {
    const { id } = await persistRecommendation(db, rec);
    // §13.2: capture the point of comparison the moment the call is made. A suppressed
    // recommendation has no id and nothing to score.
    if (id !== null) {
      await snapshotBenchmark(db, {
        recommendationId: id,
        instrumentId: rec.primary.instrumentId,
        asOf,
        conviction: String((rec.engineEvidence as { band?: string }).band ?? rec.kind),
      });
    }
  }

  // Evaluations fall due on their own clock, so the weekly run is where they land.
  const evaluated = await runDueEvals(db, asOf);

  const stored = await db.query<{
    id: number;
    created_on: string | Date;
    kind: string;
    intent: string;
    primary_rec: string;
    alternates: string;
    ips_clause_refs: string;
  }>(
    `select id, created_on, kind, intent, primary_rec, alternates, ips_clause_refs
       from recommendations
      where suppressed = false and created_on <= $1 and created_on >= $2
      order by created_on desc, id desc`,
    [asOf, daysBefore(asOf, 90)],
  );

  const suppressed = await db.query<{
    logged_on: string | Date;
    action: string;
    reason: string;
    suppressed_by: string;
  }>(
    `select logged_on, action, reason, suppressed_by from suppressed_actions
      where logged_on <= $1 and logged_on >= $2 order by logged_on desc`,
    [asOf, daysBefore(asOf, 30)],
  );

  const exits = await evaluateExits(db, { positions, blockedIds: blocked }, month);
  // Record what the triggers found. Idempotent per (month, instrument, trigger), so the
  // four or five weekly runs inside a month write the first one and nothing after it.
  // Without this the digest re-sent the same standing candidates every week with no
  // memory, and nothing could say when a name was first flagged.
  await persistExitCandidates(db, exits, asOf);

  const watchRows = await db.query<{
    instrument_id: string;
    added_on: string | Date;
    removed_on: string | Date | null;
    source: string;
    reason: string;
  }>(
    `select instrument_id, added_on, removed_on, source, reason from watchlist
      where added_on >= $1 or removed_on >= $1`,
    [daysBefore(asOf, WEEK_DAYS)],
  );
  const watchlistChanges: WatchlistChange[] = [];
  for (const w of watchRows) {
    if (isoDate(w.added_on) >= daysBefore(asOf, WEEK_DAYS)) {
      watchlistChanges.push({ instrumentId: w.instrument_id, change: 'added', on: isoDate(w.added_on), source: w.source, reason: w.reason });
    }
    if (w.removed_on !== null && isoDate(w.removed_on) >= daysBefore(asOf, WEEK_DAYS)) {
      watchlistChanges.push({ instrumentId: w.instrument_id, change: 'removed', on: isoDate(w.removed_on), source: w.source, reason: w.reason });
    }
  }

  const openRecs: StoredRecommendation[] = stored.map((r) => ({
    id: Number(r.id),
    createdOn: isoDate(r.created_on),
    kind: r.kind,
    intent: r.intent,
    primary: JSON.parse(r.primary_rec) as RecLeg,
    alternates: JSON.parse(r.alternates) as RecLeg[],
    ipsClauseRefs: JSON.parse(r.ips_clause_refs) as string[],
  }));
  const isBlocked = (r: StoredRecommendation): boolean =>
    r.primary.instrumentId !== null && blocked.includes(r.primary.instrumentId);

  const input: ReportInput = {
    asOf,
    generatedAt,
    paperMode: await isPaperMode(db),
    signalReview,
    watchlistChanges,
    pipeline: {
      recommendations: openRecs.filter((r) => !isBlocked(r)),
      withheld: openRecs.filter(isBlocked),
      suppressed: suppressed.map((s) => ({
        loggedOn: isoDate(s.logged_on),
        action: s.action,
        reason: s.reason,
        suppressedBy: s.suppressed_by,
      })),
      exits,
      redemptions: await listRedemptionsUntil(db, REDEMPTION_HORIZON_DAYS, new Date(`${asOf}T00:00:00Z`)),
    },
    staleness: {
      rows,
      blocked: blockReasons(rows, positions, blocked),
      incidents: incidentRows.map((i) => ({ subject: i.subject, detail: i.detail, openedAt: iso(i.opened_at) })),
    },
    scoring: { evaluated, calibration: await calibration(db) },
    bullets: [],
    narrative: null,
  };

  input.bullets = reportBullets(input);
  input.narrative = await narrate({
    ...opts.narration,
    bullets: input.bullets,
    engineJson: JSON.stringify({
      asOf,
      scored: input.signalReview.scored.map((s) => ({ id: s.instrumentId, composite: s.composite, band: s.band })),
      recommendations: input.pipeline.recommendations.map((r) => ({ kind: r.kind, intent: r.intent })),
      blocked: input.staleness.blocked,
    }),
  });

  return input;
}

/** The deterministic summary. The narrative rewrites exactly this — nothing more. */
export function reportBullets(input: ReportInput): string[] {
  const b: string[] = [];
  b.push(`As of ${input.asOf}; generated ${input.generatedAt}.`);
  b.push(
    input.signalReview.skippedReason !== null
      ? `Signal review skipped: ${input.signalReview.skippedReason}.`
      : `${input.signalReview.scored.length} names scored; ${input.signalReview.newlyRecommended.length} newly at MEDIUM or better; ${input.signalReview.qualityDrops.length} rejected by the quality gate.`,
  );
  b.push(`${input.watchlistChanges.length} watchlist changes in the last ${WEEK_DAYS} days.`);
  b.push(
    `${input.pipeline.recommendations.length} open recommendations, ${input.pipeline.suppressed.length} suppressed by FR-12, ${input.pipeline.exits.length} exit candidates.`,
  );
  b.push(
    `${input.staleness.blocked.length} instruments blocked by stale data; ${input.staleness.incidents.length} open staleness incidents.`,
  );
  b.push(
    input.scoring.calibration.insufficient
      ? `Scoring: ${input.scoring.calibration.totalEvaluated} completed evaluations — not enough to state a hit-rate (needs ${input.scoring.calibration.minimum} per bucket).`
      : `Scoring: ${input.scoring.calibration.totalEvaluated} completed evaluations across ${input.scoring.calibration.rows.length} conviction buckets.`,
  );
  if (input.pipeline.redemptions.length > 0) {
    b.push(
      `${input.pipeline.redemptions.length} redemption(s) inside ${REDEMPTION_HORIZON_DAYS} days: ${input.pipeline.redemptions.map((r) => `${r.symbol} on ${r.maturityDate}`).join(', ')}.`,
    );
  }
  return b;
}

function collapse<T>(items: T[], render: (t: T) => string): string[] {
  const shown = items.slice(0, MAX_LIST_ITEMS).map(render);
  if (items.length > MAX_LIST_ITEMS) shown.push(`…and ${items.length - MAX_LIST_ITEMS} more`);
  return shown;
}

function renderLeg(label: string, leg: RecLeg): string[] {
  return [
    `  ${label}: ${leg.action} ${escapeMarkdown(leg.instrumentId ?? '—')}${leg.amountPaise === null ? '' : ` ${formatInr(BigInt(leg.amountPaise) as never)}`}`,
    `    intent: ${escapeMarkdown(leg.intent)}`,
    `    thesis: ${escapeMarkdown(leg.thesis)}`,
    `    IPS ${leg.ipsClauseRefs.join(', ')}`,
  ];
}

/** Pure rendering. Every section states the timestamp of the data behind it. */
export function composeReport(input: ReportInput): string {
  const out: string[] = [];
  out.push(`🗓 *Weekly Deep Report* — as of ${input.asOf}`);
  out.push(`_generated ${input.generatedAt}${input.paperMode ? ' · PAPER MODE — nothing here executes' : ''}_`);

  out.push('', '*1. Signal review*');
  if (input.signalReview.skippedReason !== null) {
    out.push(`Not run: ${escapeMarkdown(input.signalReview.skippedReason)}.`);
  } else {
    out.push(
      `${input.signalReview.scored.length} names scored` +
        (input.signalReview.comparedWith === null
          ? ' (no earlier scores to compare with)'
          : ` against ${input.signalReview.comparedWith}`),
    );
    if (input.signalReview.newlyRecommended.length > 0) {
      out.push(`New at MEDIUM+: ${collapse(input.signalReview.newlyRecommended, (s) => escapeMarkdown(s)).join(', ')}`);
    }
    out.push(...collapse(input.signalReview.fallen, (f) => `↓ ${escapeMarkdown(f.instrumentId)} ${f.from} → ${f.to}`));
    out.push(...collapse(input.signalReview.qualityDrops, (q) => `✗ ${escapeMarkdown(q.instrumentId)}: ${escapeMarkdown(q.failures.join('; '))}`));
  }

  out.push('', '*2. Watchlist changes*');
  out.push(
    input.watchlistChanges.length === 0
      ? `No changes in the last ${WEEK_DAYS} days.`
      : collapse(
          input.watchlistChanges,
          (w) =>
            `${w.change === 'added' ? '+' : '−'} ${escapeMarkdown(w.instrumentId)} (${w.on}, ${escapeMarkdown(w.source)})` +
            `${w.source === 'advisor' ? ' — advisor proposal, awaiting your sign-off' : ''}: ${escapeMarkdown(w.reason)}`,
        ).join('\n'),
  );

  out.push('', '*3. Recommendation pipeline*');
  if (input.pipeline.recommendations.length === 0) {
    out.push('No open recommendations.');
  }
  for (const r of input.pipeline.recommendations.slice(0, MAX_LIST_ITEMS)) {
    out.push(`#${r.id} ${escapeMarkdown(r.kind)} — created ${r.createdOn}`);
    out.push(...renderLeg('primary', r.primary));
    r.alternates.forEach((a, i) => out.push(...renderLeg(`alternate A${i + 1}`, a)));
  }
  if (input.pipeline.recommendations.length > MAX_LIST_ITEMS) {
    out.push(`…and ${input.pipeline.recommendations.length - MAX_LIST_ITEMS} more`);
  }
  if (input.pipeline.exits.length > 0) {
    out.push('Exit candidates (paper):');
    out.push(
      ...collapse(
        input.pipeline.exits,
        (e) =>
          `  ${e.trigger} · ${escapeMarkdown(e.instrumentId)} · ${e.action} — ${escapeMarkdown(e.evidence)}` +
          `${e.blockedByMinimumHold ? ' [held under the §3.7 minimum]' : ''}`,
      ),
    );
  }
  if (input.pipeline.suppressed.length > 0) {
    out.push('Suppressed by FR-12 (shown, not dropped):');
    out.push(...collapse(input.pipeline.suppressed, (s) => `  ${s.loggedOn} ${escapeMarkdown(s.action)} — ${escapeMarkdown(s.reason)}`));
  }
  if (input.pipeline.redemptions.length > 0) {
    out.push('Upcoming redemptions:');
    out.push(...collapse(input.pipeline.redemptions, (r) => `  ${escapeMarkdown(r.symbol)} matures ${r.maturityDate} (${r.daysUntil}d)`));
  }

  out.push('', '*4. Staleness*');
  out.push(
    ...input.staleness.rows.map(
      (r) =>
        `  ${r.stale ? '🔴' : r.state === 'unimplemented' ? '⚪' : '🟢'} ${escapeMarkdown(r.source)} — ` +
        `${r.ageHours === Infinity ? 'never' : `${r.ageHours.toFixed(1)}h`} / ${r.limitHours}h (as of ${r.asOf})`,
    ),
  );
  if (input.staleness.blocked.length > 0) {
    out.push('Blocked from recommendations (FR-31):');
    out.push(...collapse(input.staleness.blocked, (b) => `  ${escapeMarkdown(b.instrumentId)} — ${escapeMarkdown(b.reason)}`));
  }
  if (input.pipeline.withheld.length > 0) {
    out.push('Open recommendations withheld until their data is fresh again:');
    out.push(
      ...collapse(
        input.pipeline.withheld,
        (r) => `  #${r.id} ${escapeMarkdown(r.kind)} · ${escapeMarkdown(r.primary.instrumentId ?? '—')} — ${escapeMarkdown(r.intent)}`,
      ),
    );
  }
  if (input.staleness.incidents.length > 0) {
    out.push('Open incidents:');
    out.push(...collapse(input.staleness.incidents, (i) => `  ${escapeMarkdown(i.subject)} since ${i.openedAt} — ${escapeMarkdown(i.detail)}`));
  }

  out.push('', '*5. Scoring (§13)*');
  out.push(
    input.scoring.evaluated.length === 0
      ? 'No evaluations came due this week.'
      : `${input.scoring.evaluated.length} evaluation(s) came due:`,
  );
  out.push(
    ...collapse(
      input.scoring.evaluated,
      (e) =>
        `  #${e.benchmarkId} ${e.horizon}m at ${e.asOf}: ` +
        (e.excessBps === null
          ? escapeMarkdown(e.note ?? 'not scoreable')
          : `${(e.excessBps / 100).toFixed(1)}pp vs benchmark ${e.convictionHealthy ? '✅' : '❌'}`),
    ),
  );
  if (input.scoring.calibration.insufficient) {
    out.push(
      `Calibration: insufficient data — ${input.scoring.calibration.totalEvaluated} completed ` +
        `evaluation(s), and a bucket needs ${input.scoring.calibration.minimum} before a hit-rate means anything.`,
    );
  } else {
    out.push(
      ...input.scoring.calibration.rows.map(
        (r) =>
          `  ${escapeMarkdown(r.conviction)} @${r.horizon}m: ` +
          (r.hitRate === null
            ? `${r.evaluated} eval(s) — insufficient data`
            : `${(r.hitRate * 100).toFixed(0)}% hit-rate over ${r.evaluated}, median ${(r.medianExcessBps! / 100).toFixed(1)}pp`),
      ),
    );
  }

  out.push('', '*6. Narrative*');
  out.push(
    input.narrative === null
      ? input.bullets.map((b) => `• ${escapeMarkdown(b)}`).join('\n')
      : escapeMarkdown(input.narrative),
  );

  return out.join('\n');
}
