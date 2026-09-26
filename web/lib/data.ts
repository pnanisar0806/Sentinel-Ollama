import { addP, type Paise } from '../../src/money/paise.js';
import { openDb, type Db } from '../../src/db/client.js';
import { buildDigestInput, type DigestInput } from '../../src/notify/digest.js';
import { loadPositions, type Position } from '../../src/domain/networth.js';
import {
  assessStaleness,
  blockedInstruments,
  type StalenessRow,
} from '../../src/sources/staleness.js';
import {
  checkPortfolioRails,
  getFreezeState,
  getBreakerState,
} from '../../src/domain/rails.js';
import { bucketStatuses, milestoneStatuses, type BucketStatus, type MilestoneStatus } from '../../src/domain/buckets.js';
import { currentIps } from '../../src/domain/ips.js';
import { projectVests, type VestEvent } from '../../src/domain/rsu.js';
import { fetchLiveRsuInputs } from '../../src/sources/rsu-live.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import { listRedemptionsUntil, type Redemption } from '../../src/domain/redemptions.js';
import { evaluateExits, type ExitCandidate, type ExitState } from '../../src/domain/sell-triggers.js';
import { loadReportRuns, type ReportRunRecord } from '../../src/domain/report-runs.js';
import { pendingRailChanges, type PendingRailChange } from '../../src/domain/controls.js';
import { loadRatingFilings, watchedIssuers, type StoredFiling } from '../../src/sources/credit-ratings.js';
import { rankHeldFunds, type MfRankingResult } from '../../src/domain/mf-ranking.js';
import { evaluateSwitches, SWITCH_MARGIN, type SwitchCandidate } from '../../src/domain/mf-switch.js';
import { concentration } from '../../src/domain/allocation.js';
import { calibration, type Calibration } from '../../src/domain/scoring.js';
import type { RecLeg } from '../../src/domain/recommendations.js';
import { loadOwnerTimeline, type TimelineEntry } from '../../src/domain/owner-log.js';

let dbPromise: Promise<Db> | null = null;
export function db(): Promise<Db> {
  dbPromise ??= openDb(process.env.DATABASE_URL);
  return dbPromise;
}

// buildDigestInput fetches live RSU price/FX on every call and re-derives the whole
// model. A 60s memo keeps page-to-page navigation in the app fast without the memo
// ever going stale enough to matter in a preview.
let digestMemo: { at: number; value: DigestInput } | null = null;
export async function getDigest(): Promise<DigestInput> {
  if (digestMemo && Date.now() - digestMemo.at < 60_000) return digestMemo.value;
  await db();
  const value = await buildDigestInput(await db(), new Date().toISOString());
  digestMemo = { at: Date.now(), value };
  return value;
}

export async function getOverview() {
  const input = await getDigest();
  const positions = await loadPositions(await db(), input.businessDate);
  const blocked = blockedInstruments(input.staleness, positions);
  return { input, positions, blocked };
}

export async function getHoldings() {
  const input = await getDigest();
  const positions = await loadPositions(await db(), input.businessDate);
  const blocked = new Set(blockedInstruments(input.staleness, positions));
  return { positions, blocked, businessDate: input.businessDate };
}

export async function getAllocation() {
  const input = await getDigest();
  const positions = await loadPositions(await db(), input.businessDate);
  return { input, positions };
}

export async function getRails() {
  const input = await getDigest();
  const d = await db();
  const positions = await loadPositions(d, input.businessDate);
  const total = addP(...positions.map((p) => p.valuePaise));
  // settings_rails mixes scalar owner rails with state blobs (freeze_state,
  // breaker_state, paper_mode). Only the scalars are rails.
  const settings = await d.query<{ key: string; value: unknown }>(
    'select key, value from settings_rails order by key',
  );
  const rails = settings
    .filter((r) => typeof r.value !== 'object' || r.value === null)
    .map((r) => ({ key: r.key, value: Number(r.value) }));
  return { rails, breaches: await checkPortfolioRails(d, positions, total) };
}

export interface BucketsData {
  input: DigestInput;
  buckets: BucketStatus[];
  milestones: MilestoneStatus[];
}
export async function getBuckets(): Promise<BucketsData> {
  const input = await getDigest();
  const d = await db();
  return { input, buckets: await bucketStatuses(d), milestones: await milestoneStatuses(d, input.businessDate) };
}

export interface RsuData {
  businessDate: string;
  priceUsd: number;
  usdInr: number;
  nextVest: VestEvent | null;
  nextVestDate: string | null;
  nextVestTotalNetPaise: Paise | null;
  nextVestCount: number;
  grants: { id: string; grantedOn: string; units: number; note: string | null }[];
  upcoming: VestEvent[];
  confirmed: { vestOn: string; units: number; netPaise: Paise }[];
  projectedRemainingPaise: Paise;
}
export async function getRsu(): Promise<RsuData> {
  const input = await getDigest();
  const d = await db();
  let priceUsd: number = ASSUMPTIONS.seedNowPriceUsd;
  let usdInr: number = ASSUMPTIONS.seedUsdInr;
  try {
    const live = await fetchLiveRsuInputs();
    if (live) {
      priceUsd = Number(live.nowPriceCents) / 100;
      usdInr = live.usdInr;
    }
  } catch {
    // live fetch failed — fall back to seeds, matching digest behaviour
  }
  const grantRows = await d.query<{ id: string; granted_on: string | Date; units: string; note: string | null }>(
    'select id, granted_on, units, note from rsu_grants',
  );
  const grants = grantRows.map((g) => ({
    id: g.id,
    grantedOn: g.granted_on instanceof Date ? g.granted_on.toISOString().slice(0, 10) : String(g.granted_on).slice(0, 10),
    units: Number(g.units),
    note: g.note ?? '',
  }));
  const from = input.businessDate;
  const to = `${Number(from.slice(0, 4)) + 6}-12-31`;
  const pipeline = projectVests(grants, { priceUsd, usdInr, from, to });
  const upcoming = pipeline.filter((v) => v.vestOn >= from && v.status === 'PROJECTED').slice(0, 12);
  const confirmedRows = await d.query<{ vest_on: string | Date; units: string; net_paise: string | null }>(
    "select vest_on, units, net_paise from rsu_vests where status = 'ACTUAL' order by vest_on",
  );
  const confirmed = confirmedRows.map((c) => ({
    vestOn: c.vest_on instanceof Date ? c.vest_on.toISOString().slice(0, 10) : String(c.vest_on).slice(0, 10),
    units: Number(c.units),
    netPaise: (BigInt(c.net_paise ?? '0') as Paise),
  }));
  return {
    businessDate: input.businessDate,
    priceUsd,
    usdInr,
    nextVest: input.nextVest,
    nextVestDate: input.nextVestDate,
    nextVestTotalNetPaise: input.nextVestTotalNetPaise,
    nextVestCount: input.nextVestCount,
    grants,
    upcoming,
    confirmed,
    projectedRemainingPaise: upcoming.reduce((s, v) => addP(s, v.netPaise), 0n as Paise),
  };
}

export async function getIps() {
  return currentIps(await db());
}

export interface FreshnessData {
  rows: StalenessRow[];
  blocked: string[];
  positions: Position[];
  businessDate: string;
}
export async function getFreshness(): Promise<FreshnessData> {
  const input = await getDigest();
  const d = await db();
  const rows = await assessStaleness(d, new Date().toISOString());
  const positions = await loadPositions(d, input.businessDate);
  return { rows, blocked: blockedInstruments(rows, positions), positions, businessDate: input.businessDate };
}

export interface AuditRow {
  id: string;
  at: string;
  entity: string;
  entityId: string;
  action: string;
  actor: string;
  payloadText: string;
}
export async function getAudit(limit = 80): Promise<AuditRow[]> {
  const d = await db();
  const rows = await d.query<{
    id: string; at: string | Date; entity: string; entity_id: string; action: string; actor: string; payload: unknown;
  }>(
    'select id, at, entity, entity_id, action, actor, payload from audit_log order by at desc limit $1',
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    entity: r.entity,
    entityId: r.entity_id,
    action: r.action,
    actor: r.actor,
    payloadText: typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload ?? {}),
  }));
}

export interface OrderIntentRow {
  id: string;
  stableTag: string;
  createdAt: string;
  createdBy: 'advisor' | 'owner';
  recommendationId: number;
  intent: 'BUY' | 'SELL' | 'SWITCH' | 'HOLD';
  instrumentId: string;
  quantity: string;
  limitPricePaise: string | null;
  orderType: 'MARKET' | 'LIMIT';
  deferUntil: string | null;
  alternateInstrumentId: string | null;
  payloadSnapshot: Record<string, unknown>;
  currentRevision: number;
  expiresAt: string | null;
  advisoryPath: boolean;
  asOf: string;
  source: string;
  status: string;
}

export interface OrderTransitionRow {
  id: string;
  orderIntentId: string;
  revisionNumber: number;
  fromStatus: string;
  toStatus: string;
  actor: 'owner' | 'agent' | 'broker' | 'system';
  at: string;
  payloadSnapshot: Record<string, unknown>;
  expectedRevision: number;
  idempotencyKey: string | null;
}

export interface OrderSimulationRow {
  id: string;
  orderIntentId: string;
  revisionNumber: number;
  simType: string;
  simulatedAt: string;
  inputState: Record<string, unknown>;
  outcomeState: Record<string, unknown>;
  note: string;
}

function isDate(v: string | Date | null | undefined): v is Date {
  return v instanceof Date;
}

export async function getOrderIntents(): Promise<OrderIntentRow[]> {
  const d = await db();
  const rows = await d.query<OrderIntentRow>(
    'select * from order_intents order by created_at desc',
  );
  return rows.map((r) => {
    const createdAt = isDate(r.createdAt) ? r.createdAt.toISOString() : String(r.createdAt);
    const expiresAt = r.expiresAt ? (isDate(r.expiresAt) ? r.expiresAt.toISOString() : String(r.expiresAt)) : null;
    const asOf = isDate(r.asOf) ? r.asOf.toISOString() : String(r.asOf);
    return { ...r, createdAt, expiresAt, asOf };
  });
}

export async function getOrderIntent(id: string): Promise<OrderIntentRow | null> {
  const d = await db();
  const [row] = await d.query<OrderIntentRow>(
    'select * from order_intents where id = $1',
    [id],
  );
  if (!row) return null;
  const createdAt = isDate(row.createdAt) ? row.createdAt.toISOString() : String(row.createdAt);
  const expiresAt = row.expiresAt ? (isDate(row.expiresAt) ? row.expiresAt.toISOString() : String(row.expiresAt)) : null;
  const asOf = isDate(row.asOf) ? row.asOf.toISOString() : String(row.asOf);
  return { ...row, createdAt, expiresAt, asOf };
}

export async function getOrderTransitions(orderIntentId: string): Promise<OrderTransitionRow[]> {
  const d = await db();
  const rows = await d.query<OrderTransitionRow>(
    'select * from order_transitions where order_intent_id = $1 order by at desc',
    [orderIntentId],
  );
  return rows.map((r) => {
    const at = isDate(r.at) ? r.at.toISOString() : String(r.at);
    return { ...r, at };
  });
}

export async function getOrderSimulations(orderIntentId: string): Promise<OrderSimulationRow[]> {
  const d = await db();
  const rows = await d.query<OrderSimulationRow>(
    'select * from order_simulations where order_intent_id = $1 order by simulated_at desc',
    [orderIntentId],
  );
  return rows.map((r) => {
    const simulatedAt = isDate(r.simulatedAt) ? r.simulatedAt.toISOString() : String(r.simulatedAt);
    return { ...r, simulatedAt };
  });
}

export async function getApprovalData() {
  const d = await db();
  const intents = await getOrderIntents();
  const pending = intents.filter((i) => ['PENDING_APPROVAL', 'ACKNOWLEDGED', 'AWAITING_MANUAL_EXECUTION', 'DEFERRED'].includes(i.status));
  const history = intents.filter((i) => !['PENDING_APPROVAL', 'ACKNOWLEDGED', 'AWAITING_MANUAL_EXECUTION', 'DEFERRED'].includes(i.status));
  return { pending, history, all: intents };
}

export interface CleanupCalendarData {
  redemptions: Redemption[];
  freezeState: { active: boolean; frozenAt: string | null; reason: string | null };
  breakerState: { active: boolean; consecutiveFalsifications: number; lastFalsificationAt: string | null; demotedAt: string | null; postMortemNote: string | null };
  railChanges: PendingRailChange[];
  /** `firstSeen` is the earliest month `exit_candidates` recorded it; NULL before the
   *  weekly job has written one. */
  exitCandidates: (ExitCandidate & { firstSeen: string | null })[];
  drawdownPct: number | null;
}

/** IPS §3.8: rating filings on the issuers of held bonds, last twelve months. */
export async function getRatingFilings(): Promise<{
  filings: StoredFiling[]; unwatched: string[];
}> {
  const d = await db();
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  return { filings: await loadRatingFilings(d, since), unwatched: (await watchedIssuers(d)).unwatched };
}

export async function getCleanupCalendar(): Promise<CleanupCalendarData> {
  const d = await db();
  const now = new Date().toISOString().slice(0, 10);
  
  // Get redemptions within 60 days
  const redemptions = await listRedemptionsUntil(d, 60, new Date(now));
  
  // Get freeze and breaker state
  const freezeState = await getFreezeState(d);
  const breakerState = await getBreakerState(d);
  
  // FR-34: rail edits waiting out their 48 hours. `last_rail_change` was never written,
  // so this card always read "no cooling" whatever the owner had asked for.
  const railChanges = await pendingRailChanges(d);

  // Get drawdown
  const [drawdown] = await d.query<{ current_pct: number }>(
    `select current_pct from portfolio_drawdown where as_of = (select max(as_of) from portfolio_drawdown)`
  );
  
  // Get exit candidates (sell triggers)
  const input = await buildDigestInput(d, new Date().toISOString());
  const positions = await loadPositions(d, input.businessDate);
  const blocked = blockedInstruments(input.staleness, positions);
  const exitState: ExitState = {
    positions,
    blockedIds: blocked,
    alternatives: [], // Better alternatives would need composite scores
  };
  const exitCandidates = await evaluateExits(d, exitState, now.slice(0, 7));

  // When each was FIRST recorded. The live evaluation only knows about this month, so
  // without this a breach standing since August reads as new every single week — which
  // is precisely what the digest used to do before `exit_candidates` existed.
  const history = await d.query<{ instrument_id: string; trigger_code: string; first_seen: string }>(
    `select instrument_id, trigger_code, min(month) as first_seen
       from exit_candidates group by 1, 2`,
  );
  const firstSeen = new Map(history.map((h) => [`${h.instrument_id}|${h.trigger_code}`, h.first_seen]));
  
  return {
    redemptions,
    freezeState,
    breakerState,
    railChanges,
    exitCandidates: exitCandidates.map((c) => ({
      ...c,
      firstSeen: firstSeen.get(`${c.instrumentId}|${c.trigger}`) ?? null,
    })),
    // numeric arrives as a string from postgres
    drawdownPct: drawdown ? Number(drawdown.current_pct) : null,
  };
}
// ── Phase 1 surfaces ────────────────────────────────────────────────────────
// postgres-js hands back a Date for date/timestamptz columns where PGlite hands back
// a string. Everything below renders dates as ISO strings, so normalise once here
// rather than repeating the check per field — the same driver divergence that the
// IPS shim had been hiding before `currentIps` started normalising `effective_at`.
function isoDate(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

/** `text` columns holding JSON. A malformed row must not take the page down, so the
 *  raw string is surfaced instead of thrown — an unreadable value is still evidence. */
function parseJsonColumn<T>(raw: string | null, fallback: T): T | string {
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw;
  }
}

export interface WatchlistRow {
  key: string;
  instrumentId: string;
  name: string;
  addedOn: string;
  removedOn: string | null;
  source: string;
  reason: string;
}

export async function getWatchlist(): Promise<{ active: WatchlistRow[]; removed: WatchlistRow[] }> {
  const rows = await (await db()).query<{
    instrument_id: string; name: string | null; added_on: unknown;
    removed_on: unknown; source: string; reason: string;
  }>(
    `select w.instrument_id, i.name, w.added_on, w.removed_on, w.source, w.reason
       from watchlist w left join instruments i on i.id = w.instrument_id
      order by w.added_on desc, w.instrument_id`,
  );
  const mapped: WatchlistRow[] = rows.map((r) => ({
    key: `${r.instrument_id}:${isoDate(r.added_on)}`,
    instrumentId: r.instrument_id,
    name: r.name ?? r.instrument_id,
    addedOn: isoDate(r.added_on),
    removedOn: r.removed_on === null ? null : isoDate(r.removed_on),
    source: r.source,
    reason: r.reason,
  }));
  return {
    active: mapped.filter((r) => r.removedOn === null),
    removed: mapped.filter((r) => r.removedOn !== null),
  };
}

export interface SignalRow {
  key: string;
  instrumentId: string;
  name: string;
  composite: number;
  qualityPassed: boolean;
  valuation: number | null;
  trend: number | null;
  earnings: number | null;
  fit: number | null;
  rank: number | null;
  rocePct: number | null;
  deRatio: number | null;
  fcfPositive5y: boolean | null;
  redFlags: number | null;
}

/** The most recent scoring run only. Older runs are history, not the current view. */
export async function getSignals(): Promise<{ scoreDate: string | null; rows: SignalRow[] }> {
  const d = await db();
  const [latest] = await d.query<{ score_date: unknown }>(
    'select max(score_date) as score_date from signal_scores',
  );
  if (!latest?.score_date) return { scoreDate: null, rows: [] };
  const scoreDate = isoDate(latest.score_date);

  const rows = await d.query<{
    instrument_id: string; name: string | null; composite: string; quality_passed: boolean;
    reg_valuation: string | null; reg_trend: string | null; reg_earnings: string | null;
    reg_fit: string | null; rank: number | null; roce_pct: string | null;
    de_ratio: string | null; fcf_pos_5y: boolean | null; red_flags: number | null;
  }>(
    `select s.instrument_id, i.name, s.composite, s.quality_passed,
            s.reg_valuation, s.reg_trend, s.reg_earnings, s.reg_fit, s.rank,
            f.roce_pct, f.de_ratio, f.fcf_pos_5y, f.red_flags
       from signal_scores s
       left join instruments i on i.id = s.instrument_id
       left join lateral (
         select roce_pct, de_ratio, fcf_pos_5y, red_flags
           from fundamentals ff
          where ff.instrument_id = s.instrument_id
          order by ff.upload_id desc limit 1
       ) f on true
      where s.score_date = $1
      order by s.rank nulls last, s.composite desc`,
    [scoreDate],
  );
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    scoreDate,
    rows: rows.map((r) => ({
      key: r.instrument_id,
      instrumentId: r.instrument_id,
      name: r.name ?? r.instrument_id,
      composite: Number(r.composite),
      qualityPassed: r.quality_passed,
      valuation: num(r.reg_valuation),
      trend: num(r.reg_trend),
      earnings: num(r.reg_earnings),
      fit: num(r.reg_fit),
      rank: r.rank,
      rocePct: num(r.roce_pct),
      deRatio: num(r.de_ratio),
      fcfPositive5y: r.fcf_pos_5y,
      redFlags: r.red_flags,
    })),
  };
}

export interface RecommendationRow {
  key: string;
  id: string;
  createdOn: string;
  kind: string;
  intent: string;
  /** `primary_rec` and `alternates` hold `JSON.stringify(RecLeg)` / `RecLeg[]`, NOT display
   *  strings — rendering them directly is React error #31. A row whose JSON is unreadable
   *  arrives as the raw string instead, and the page shows it as unparseable. */
  primary: RecLeg | string;
  alternates: RecLeg[] | string;
  ipsClauses: string[] | string;
  evidence: unknown;
  source: string;
  suppressed: boolean;
  suppressedReason: string | null;
}

export async function getRecommendations(limit = 50): Promise<RecommendationRow[]> {
  const rows = await (await db()).query<{
    id: string; created_on: unknown; kind: string; intent: string; primary_rec: string;
    alternates: string; ips_clause_refs: string; engine_evidence: string; source: string;
    suppressed: boolean; suppressed_reason: string | null;
  }>(
    `select id, created_on, kind, intent, primary_rec, alternates, ips_clause_refs,
            engine_evidence, source, suppressed, suppressed_reason
       from recommendations order by created_on desc, id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    key: String(r.id),
    id: String(r.id),
    createdOn: isoDate(r.created_on),
    kind: r.kind,
    intent: r.intent,
    // Fallback is the raw column: an unparseable leg is surfaced as its own text rather
    // than as an empty object the page would render as a blank recommendation.
    primary: parseJsonColumn<RecLeg | string>(r.primary_rec, r.primary_rec),
    alternates: parseJsonColumn<RecLeg[]>(r.alternates, []),
    ipsClauses: parseJsonColumn<string[]>(r.ips_clause_refs, []),
    evidence: parseJsonColumn<unknown>(r.engine_evidence, null),
    source: r.source,
    suppressed: r.suppressed,
    suppressedReason: r.suppressed_reason,
  }));
}

export interface MaturityInstrument {
  key: string;
  instrumentId: string;
  name: string;
  maturityDate: string;
  facePaise: Paise | null;
  couponRateBps: number | null;
}

export async function getMaturity(horizonDays = 365) {
  const d = await db();
  const redemptions = await listRedemptionsUntil(d, horizonDays);
  const rows = await d.query<{
    id: string; name: string | null; maturity_date: unknown;
    face_value_paise: string | null; coupon_rate_bps: number | null;
  }>(
    `select id, name, maturity_date, face_value_paise, coupon_rate_bps
       from instruments where maturity_date is not null order by maturity_date`,
  );
  const dated: MaturityInstrument[] = rows.map((r) => ({
    key: r.id,
    instrumentId: r.id,
    name: r.name ?? r.id,
    maturityDate: isoDate(r.maturity_date),
    // Unknown face value stays null — never rendered as zero.
    facePaise: r.face_value_paise === null ? null : (BigInt(r.face_value_paise) as Paise),
    couponRateBps: r.coupon_rate_bps,
  }));
  return { redemptions, dated, horizonDays };
}

export interface ScoredRec {
  key: string;
  id: string;
  createdOn: string;
  kind: string;
  intent: string;
  benchmarkAsOf: string;
  eval3m: unknown;
  eval6m: unknown;
  eval12m: unknown;
}

export async function getScoring(): Promise<{ calibration: Calibration; evaluated: ScoredRec[] }> {
  const d = await db();
  const cal = await calibration(d);
  const rows = await d.query<{
    id: string; created_on: unknown; kind: string; intent: string;
    benchmark_as_of: unknown; eval_3m_jsonb: string | null;
    eval_6m_jsonb: string | null; eval_12m_jsonb: string | null;
  }>(
    `select r.id, r.created_on, r.kind, r.intent, b.benchmark_as_of,
            b.eval_3m_jsonb, b.eval_6m_jsonb, b.eval_12m_jsonb
       from benchmarks b join recommendations r on r.id = b.recommendation_id
      order by b.benchmark_as_of desc, r.id desc limit 50`,
  );
  return {
    calibration: cal,
    evaluated: rows.map((r) => ({
      key: String(r.id),
      id: String(r.id),
      createdOn: isoDate(r.created_on),
      kind: r.kind,
      intent: r.intent,
      benchmarkAsOf: isoDate(r.benchmark_as_of),
      eval3m: parseJsonColumn<unknown>(r.eval_3m_jsonb, null),
      eval6m: parseJsonColumn<unknown>(r.eval_6m_jsonb, null),
      eval12m: parseJsonColumn<unknown>(r.eval_12m_jsonb, null),
    })),
  };
}

/**
 * Delivered weekly reports, newest first.
 *
 * `loadReportRuns` reads `audit_log`, where the run record already lived; the narrative
 * and its bullets are now stored in that same row. Runs delivered before 2026-09-21
 * carry no narrative, and the page says so rather than showing an empty panel.
 */
export async function getWeeklyReports(limit = 12): Promise<ReportRunRecord[]> {
  return loadReportRuns(await db(), limit);
}

/**
 * The mutual-fund ranking.
 *
 * `rankMfs` had no production caller at all, so ~₹12L of MF produced no engine output.
 * This is the ranking, not a switch recommendation: a switch needs somewhere to switch
 * TO, and the only funds in the system are the six held.
 */
export async function getMfRanking(): Promise<MfRankingResult> {
  return rankHeldFunds(await db(), new Date().toISOString().slice(0, 10));
}

/**
 * Each held fund against its whole AMFI category.
 *
 * "No switch" is the expected answer and a first-class one: IPS §3.7's twelve-month
 * hold is a floor, and a switch has to be worth realising tax for.
 */
export async function getMfSwitches(): Promise<{
  switches: SwitchCandidate[]; margin: number;
}> {
  return {
    switches: await evaluateSwitches(await db(), new Date().toISOString().slice(0, 10)),
    margin: SWITCH_MARGIN,
  };
}

export interface LogData {
  timeline: TimelineEntry[];
  buckets: { id: string; name: string }[];
  openMilestones: { id: string; name: string }[];
  bonds: { id: string; name: string }[];
}

/** What /log needs: the owner's own timeline and the choices each form offers. */
export async function getLog(): Promise<LogData> {
  const d = await db();
  const input = await getDigest();
  const positions = await loadPositions(d, input.businessDate);
  const bonds = new Map<string, string>();
  // loadPositions already drops a redeemed bond, so what is left is still outstanding.
  for (const p of positions) if (p.kind === 'BOND') bonds.set(p.instrumentId, p.name);
  return {
    timeline: await loadOwnerTimeline(d),
    buckets: input.buckets.map((b) => ({ id: b.id, name: b.name })),
    openMilestones: input.milestones.filter((m) => m.completedOn === null).map((m) => ({ id: m.id, name: m.name })),
    bonds: [...bonds].map(([id, name]) => ({ id, name })),
  };
}
