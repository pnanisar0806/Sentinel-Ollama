import { addP, type Paise } from '../../src/money/paise.js';
import { openDb, type Db } from '../../src/db/client.js';
import { buildDigestInput, type DigestInput } from '../../src/notify/digest.js';
import { loadPositions, type Position, type AssetClass } from '../../src/domain/networth.js';
import {
  assessStaleness,
  blockedInstruments,
  type StalenessRow,
} from '../../src/sources/staleness.js';
import { evaluateRails, loadOwnerRails, type RailBreach, type OwnerRail } from '../../src/domain/rails.js';
import { bucketStatuses, milestoneStatuses, type BucketStatus, type MilestoneStatus } from '../../src/domain/buckets.js';
import { currentIps } from '../../src/domain/ips.js';
import { projectVests, type VestEvent } from '../../src/domain/rsu.js';
import { fetchLiveRsuInputs } from '../../src/sources/rsu-live.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import { listRedemptionsUntil, type Redemption } from '../../src/domain/redemptions.js';
import { getFreezeState, getBreakerState } from '../../src/domain/rails.js';
import { evaluateExits, type ExitCandidate, type ExitState } from '../../src/domain/sell-triggers.js';
import { concentration } from '../../src/domain/allocation.js';

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
  const positions = await loadPositions(await db(), input.businessDate);
  const byClass = new Map<AssetClass, Paise>();
  for (const p of positions) {
    byClass.set(p.assetClass, addP(byClass.get(p.assetClass) ?? (0n as Paise), p.valuePaise));
  }
  const total = addP(...byClass.values());
  return { rails: await loadOwnerRails(await db()), breaches: evaluateRails(await loadOwnerRails(await db()), byClass, total) };
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

export async function getOrderIntents(): Promise<OrderIntentRow[]> {
  const d = await db();
  const rows = await d.query<OrderIntentRow>(
    'select * from order_intents order by created_at desc',
  );
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    expiresAt: r.expiresAt ? (r.expiresAt instanceof Date ? r.expiresAt.toISOString() : String(r.expiresAt)) : null,
    asOf: r.asOf instanceof Date ? r.asOf.toISOString() : String(r.asOf),
  }));
}

export async function getOrderIntent(id: string): Promise<OrderIntentRow | null> {
  const d = await db();
  const [row] = await d.query<OrderIntentRow>(
    'select * from order_intents where id = $1',
    [id],
  );
  if (!row) return null;
  return {
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    expiresAt: row.expiresAt ? (row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt)) : null,
    asOf: row.asOf instanceof Date ? row.asOf.toISOString() : String(row.asOf),
  };
}

export async function getOrderTransitions(orderIntentId: string): Promise<OrderTransitionRow[]> {
  const d = await db();
  const rows = await d.query<OrderTransitionRow>(
    'select * from order_transitions where order_intent_id = $1 order by at desc',
    [orderIntentId],
  );
  return rows.map((r) => ({
    ...r,
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
  }));
}

export async function getOrderSimulations(orderIntentId: string): Promise<OrderSimulationRow[]> {
  const d = await db();
  const rows = await d.query<OrderSimulationRow>(
    'select * from order_simulations where order_intent_id = $1 order by simulated_at desc',
    [orderIntentId],
  );
  return rows.map((r) => ({
    ...r,
    simulatedAt: r.simulatedAt instanceof Date ? r.simulatedAt.toISOString() : String(r.simulatedAt),
  }));
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
  railCoolingUntil: string | null;
  exitCandidates: ExitCandidate[];
  drawdownPct: number | null;
}

export async function getCleanupCalendar(): Promise<CleanupCalendarData> {
  const d = await db();
  const now = new Date().toISOString().slice(0, 10);
  
  // Get redemptions within 60 days
  const redemptions = await listRedemptionsUntil(d, 60, new Date(now));
  
  // Get freeze and breaker state
  const freezeState = await getFreezeState(d);
  const breakerState = await getBreakerState(d);
  
  // Get rail cooling
  const [coolingRow] = await d.query<{ value: { cooling_until: string } | string }>(
    `select value from settings_rails where key = 'last_rail_change'`
  );
  let railCoolingUntil: string | null = null;
  if (coolingRow) {
    const val = typeof coolingRow.value === 'string' ? JSON.parse(coolingRow.value) : coolingRow.value;
    if (val.cooling_until && new Date(val.cooling_until) > new Date()) {
      railCoolingUntil = val.cooling_until;
    }
  }
  
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
  
  return {
    redemptions,
    freezeState,
    breakerState,
    railCoolingUntil,
    exitCandidates,
    drawdownPct: drawdown?.current_pct ?? null,
  };
}