import type { Db } from '../db/client.js';
import type { Recommendation, RecLeg } from './recommendations.js';
import { formatInr } from '../money/paise.js';
import { assessStaleness, blockedInstruments, type StalenessRow } from '../sources/staleness.js';
import { loadPositions, type Position } from '../domain/networth.js';
import { checkFreeze, checkRails, getBreakerState } from './rails.js';
import { validateRecommendation } from './recommendations.js';
import { isTradingDay } from '../seed/seed-holidays.js';

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'MODIFIED'
  | 'DEFERRED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'AWAITING_SESSION'
  | 'EXECUTING'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'BROKER_REJECTED'
  | 'CANCELLED'
  | 'VERIFIED'
  | 'ACKNOWLEDGED'
  | 'AWAITING_MANUAL_EXECUTION'
  | 'ABANDONED';

export type OrderIntent = {
  id: string;
  stableTag: string;
  createdAt: Date;
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
  expiresAt: Date | null;
  advisoryPath: boolean;
  asOf: Date;
  source: string;
  status: OrderStatus;
};

export type OrderRevision = {
  id: string;
  orderIntentId: string;
  revisionNumber: number;
  modifiedAt: Date;
  modifiedBy: 'owner' | 'advisor';
  prevRevision: number;
  quantity: string;
  limitPricePaise: string | null;
  orderType: 'MARKET' | 'LIMIT';
  deferUntil: string | null;
  alternateInstrumentId: string | null;
  payloadSnapshot: Record<string, unknown>;
  railsValidated: boolean;
  validationDetail: Record<string, unknown>;
};

export type OrderTransition = {
  id: string;
  orderIntentId: string;
  revisionNumber: number;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  actor: 'owner' | 'agent' | 'broker' | 'system';
  at: Date;
  payloadSnapshot: Record<string, unknown>;
  expectedRevision: number;
  idempotencyKey: string | null;
};

export type OrderSimulation = {
  id: string;
  orderIntentId: string;
  revisionNumber: number;
  simType: 'SESSION_MISSING' | 'PARTIAL_FILL' | 'BROKER_REJECT' | 'MARKET_CLOSURE' | 'ADVISORY_ACK' | 'ADVISORY_VERIFY' | 'T2_REMINDER' | 'T7_REMINDER';
  simulatedAt: Date;
  inputState: Record<string, unknown>;
  outcomeState: Record<string, unknown>;
  note: string;
};

export type CreateOrderInput = {
  recommendationId: number;
  recommendation: Recommendation;
  createdBy: 'advisor' | 'owner';
  advisoryPath?: boolean;
};

export type ApproveInput = {
  idempotencyKey: string;
  actor: 'owner';
};

export type ModifyInput = {
  idempotencyKey: string;
  actor: 'owner';
  quantity?: string;
  limitPricePaise?: string | null;
  orderType?: 'MARKET' | 'LIMIT';
  deferUntil?: string | null;
  alternateInstrumentId?: string | null;
};

export type DeferInput = {
  idempotencyKey: string;
  actor: 'owner';
  deferUntil: string;
};

export type RejectInput = {
  idempotencyKey: string;
  actor: 'owner';
  reason: string;
};

export type ExpireInput = {
  actor: 'system';
  reason: string;
};

function toOrderIntent(row: Record<string, unknown>, currentStatus: OrderStatus): OrderIntent {
  const qty = row.quantity;
  const normalizedQty = qty === null || qty === undefined ? '0' : (typeof qty === 'string' ? parseFloat(qty).toString() : String(qty));
  return {
    id: row.id as string,
    stableTag: row.stable_tag as string,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    createdBy: row.created_by as 'advisor' | 'owner',
    recommendationId: row.recommendation_id as number,
    intent: row.intent as 'BUY' | 'SELL' | 'SWITCH' | 'HOLD',
    instrumentId: row.instrument_id as string,
    quantity: normalizedQty,
    limitPricePaise: row.limit_price_paise as string | null,
    orderType: row.order_type as 'MARKET' | 'LIMIT',
    deferUntil: row.defer_until as string | null,
    alternateInstrumentId: row.alternate_instrument_id as string | null,
    payloadSnapshot: row.payload_snapshot as Record<string, unknown>,
    status: currentStatus,
    currentRevision: row.current_revision as number,
    expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at as string)) : null,
    advisoryPath: row.advisory_path as boolean,
    asOf: row.as_of instanceof Date ? row.as_of : new Date(row.as_of as string),
    source: row.source as string,
  };
}

function toOrderRevision(row: Record<string, unknown>): OrderRevision {
  return {
    id: row.id as string,
    orderIntentId: row.order_intent_id as string,
    revisionNumber: row.revision_number as number,
    modifiedAt: row.modified_at instanceof Date ? row.modified_at : new Date(row.modified_at as string),
    modifiedBy: row.modified_by as 'owner' | 'advisor',
    prevRevision: row.prev_revision as number,
    quantity: row.quantity as string,
    limitPricePaise: row.limit_price_paise as string | null,
    orderType: row.order_type as 'MARKET' | 'LIMIT',
    deferUntil: row.defer_until as string | null,
    alternateInstrumentId: row.alternate_instrument_id as string | null,
    payloadSnapshot: row.payload_snapshot as Record<string, unknown>,
    railsValidated: row.rails_validated as boolean,
    validationDetail: row.validation_detail as Record<string, unknown>,
  };
}

function toOrderTransition(row: Record<string, unknown>): OrderTransition {
  return {
    id: row.id as string,
    orderIntentId: row.order_intent_id as string,
    revisionNumber: row.revision_number as number,
    fromStatus: row.from_status as OrderStatus,
    toStatus: row.to_status as OrderStatus,
    actor: row.actor as 'owner' | 'agent' | 'broker' | 'system',
    at: row.at instanceof Date ? row.at : new Date(row.at as string),
    payloadSnapshot: row.payload_snapshot as Record<string, unknown>,
    expectedRevision: row.expected_revision as number,
    idempotencyKey: row.idempotency_key as string | null,
  };
}

function toOrderSimulation(row: Record<string, unknown>): OrderSimulation {
  return {
    id: row.id as string,
    orderIntentId: row.order_intent_id as string,
    revisionNumber: row.revision_number as number,
    simType: row.sim_type as OrderSimulation['simType'],
    simulatedAt: row.simulated_at instanceof Date ? row.simulated_at : new Date(row.simulated_at as string),
    inputState: row.input_state as Record<string, unknown>,
    outcomeState: row.outcome_state as Record<string, unknown>,
    note: row.note as string,
  };
}

function normalizeQuantity(q: string | number | null | undefined): string {
  if (q === null || q === undefined) return '0';
  const n = typeof q === 'string' ? parseFloat(q) : q;
  return n.toString();
}

/**
 * FR-30/31 validation gate: checks that the instrument is not blocked by stale data
 * and that the recommendation passes validation. Throws if validation fails.
 */
async function validateOrderGate(
  db: Db,
  instrumentId: string,
  recommendation: Recommendation,
  skipStalenessCheck = false,
  forRecommendationId?: number,
): Promise<void> {
  // Skip staleness check if explicitly requested (e.g., for tests)
  if (!skipStalenessCheck) {
    // Load current positions to check staleness blocking
    const positions = await loadPositions(db);
    const stalenessRows = await assessStaleness(db, new Date().toISOString());
    const blocked = blockedInstruments(stalenessRows, positions);
    
    if (blocked.includes(instrumentId)) {
      const staleSources = stalenessRows.filter((r) => r.stale).map((r) => r.source).join(', ');
      throw new Error(`FR-31: ${instrumentId} blocked by stale data (${staleSources})`);
    }
  }

  // Validate recommendation structure and caps (always enforced)
  const errors = validateRecommendation(recommendation);
  if (errors.length > 0) {
    throw new Error(`FR-11/12 validation failed: ${errors.join('; ')}`);
  }

  // FR-32 and FR-33. `/freeze` halts drafting, and the breaker puts the advisor into
  // report-only after three consecutive approved recommendations hit their falsification
  // conditions. Both states were stored, both were rendered on /cleanup, and neither was
  // ever consulted: `checkFreeze` and `getBreakerState` had no caller anywhere. A control
  // that is displayed but not enforced is worse than one that is absent, because it reads
  // as protection.
  //
  // Cancelling already-pending requests on freeze (the rest of FR-32) is a state
  // transition that belongs with the `/freeze` command itself, which is Phase 2 Task 2.
  // This is the half that stops a NEW draft.
  await checkFreeze(db);
  const breaker = await getBreakerState(db);
  if (breaker.active) {
    throw new Error(
      `FR-33: breaker tripped after ${breaker.consecutiveFalsifications} consecutive `
      + `falsifications (demoted ${breaker.demotedAt ?? 'unknown'}) — the advisor is `
      + 'report-only until /reset_breaker is run with a post-mortem note',
    );
  }

  // The owner rails. This function's comment has always claimed to "validate rails", but
  // until now it checked only freshness and FR-11/12 structure: `checkRails` had no
  // caller anywhere in the codebase, so MAX_ORDER_EXCEEDED, TACTICAL_BUDGET_EXCEEDED,
  // FORBIDDEN_UNIVERSE, HOLD_PERIOD, OVERRIDE_INVALID, COOLING_NOT_ELAPSED and the two
  // drawdown rails gated nothing. An order over the owner's per-order ceiling was
  // created without complaint.
  //
  // STALE_DATA is dropped: the block above already raises it, with the offending sources
  // named, and honours `skipStalenessCheck`. Every other violation refuses the order.
  const railViolations = (await checkRails(db, recommendation, { forRecommendationId }))
    .filter((v) => v.code !== 'STALE_DATA');
  if (railViolations.length > 0) {
    throw new Error(
      `Rails refused this order: ${railViolations.map((v) => `${v.code} (${v.detail})`).join('; ')}`,
    );
  }
}

async function getCurrentStatus(db: Db, orderIntentId: string): Promise<OrderStatus> {
  const [row] = await db.query<Record<string, unknown>>(
    `select to_status from order_transitions where order_intent_id = $1 order by at desc limit 1`,
    [orderIntentId],
  );
  if (!row) return 'DRAFT';
  return row.to_status as OrderStatus;
}

async function getOrderWithStatus(db: Db, id: string): Promise<OrderIntent | null> {
  const [row] = await db.query<Record<string, unknown> & { current_revision: number; quantity: string | number | null }>(
    `select * from order_intents where id = $1`,
    [id],
  );
  if (!row) return null;
  const currentStatus = await getCurrentStatus(db, id);
  
  // Get latest revision number and quantity
  const [revRow] = await db.query<{ revision_number: number; quantity: string | number | null }>(
    `select revision_number, quantity from order_revisions where order_intent_id = $1 order by revision_number desc limit 1`,
    [id],
  );
  const currentRevision = revRow ? revRow.revision_number : row.current_revision;
  const currentQuantity = revRow ? normalizeQuantity(revRow.quantity) : normalizeQuantity(row.quantity);
  
  const intent = toOrderIntent({ ...row, current_revision: currentRevision, quantity: currentQuantity }, currentStatus);
  
  // Merge latest transition payload for fields like deferUntil, rejectReason
  const [latestTransition] = await db.query<Record<string, unknown>>(
    `select payload_snapshot from order_transitions where order_intent_id = $1 order by at desc limit 1`,
    [id],
  );
  if (latestTransition) {
    const transitionPayload = latestTransition.payload_snapshot as Record<string, unknown>;
    return { ...intent, payloadSnapshot: { ...intent.payloadSnapshot, ...transitionPayload } };
  }
  return intent;
}

export async function createOrder(db: Db, input: CreateOrderInput): Promise<OrderIntent> {
  const { recommendationId, recommendation, createdBy, advisoryPath = true } = input;
  const primary = recommendation.primary;
  const expiresAt = primary.action === 'BUY' || primary.action === 'TRIM'
    ? await computeMarketExpiry(db, new Date())
    : computeSipMfExpiry();

  // FR-30/31: Validate rails and freshness before creating draft
  if (!primary.instrumentId) throw new Error('Primary instrumentId is required for order creation');
  await validateOrderGate(db, primary.instrumentId, recommendation, process.env.NODE_ENV === 'test', recommendationId);

  const [row] = await db.query<Record<string, unknown> & { id: string }>(
    `insert into order_intents
       (recommendation_id, intent, instrument_id, quantity, limit_price_paise, order_type,
        defer_until, alternate_instrument_id, payload_snapshot, expires_at, advisory_path, as_of, source, created_by, status, current_revision)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), 'advisor', $12, 'DRAFT', 1)
     returning *`,
    [
      recommendationId,
      primary.action,
      primary.instrumentId,
      primary.amountPaise,
      null,
      'MARKET',
      null,
      null,
      JSON.stringify(recommendation),
      expiresAt.toISOString(),
      advisoryPath,
      createdBy,
    ],
  );

  if (!row) throw new Error('Order insert returned no row');

  await db.query(
    `insert into order_transitions
       (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
     values ($1, 1, 'DRAFT', 'PENDING_APPROVAL', $2, $3, 1, $4)`,
    [
      row.id,
      'agent',
      JSON.stringify({ ...row, status: 'PENDING_APPROVAL' }),
      `create:${row.id}`,
    ],
  );

  const order = await getOrderWithStatus(db, row.id);
  if (!order) throw new Error(`Order ${row.id} not found`);
  return order;
}

/** NSE's equity close, 15:30 IST, expressed in UTC. */
const NSE_CLOSE_UTC_HOUR = 10;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * FR-22: a market approval expires at the end of the trading day — the close of the
 * next NSE session that has not yet ended.
 *
 * This was `15:30 UTC`, which is 21:00 IST, five and a half hours after NSE shuts; and it
 * ignored the trading calendar, so an order drafted on a Saturday expired that Saturday
 * night without a session ever opening. Drafting is now automatic (the daily job turns
 * recommendations into approval requests), which made both defects live: a weekend
 * recommendation would have expired before the owner could act on it.
 */
export async function computeMarketExpiry(db: Db, now: Date): Promise<Date> {
  // The IST calendar date: a draft at 23:00 IST on the 5th is on the 5th, not the 6th.
  let day = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  for (let guard = 0; guard < 30; guard++) {
    const close = new Date(`${day}T${String(NSE_CLOSE_UTC_HOUR).padStart(2, '0')}:00:00Z`);
    if (close > now && await isTradingDay(db, day)) return close;
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
  // Thirty consecutive non-sessions means the calendar is wrong, not that NSE is shut.
  throw new Error(`no NSE session found within 30 days of ${now.toISOString()}`);
}

function computeSipMfExpiry(): Date {
  const now = new Date();
  const expiry = new Date(now);
  expiry.setUTCDate(expiry.getUTCDate() + 7);
  return expiry;
}

export async function getOrder(db: Db, id: string): Promise<OrderIntent | null> {
  return getOrderWithStatus(db, id);
}

export async function getOrderByStableTag(db: Db, stableTag: string): Promise<OrderIntent | null> {
  const [row] = await db.query<Record<string, unknown>>(
    `select * from order_intents where stable_tag = $1`,
    [stableTag],
  );
  if (!row) return null;
  const currentStatus = await getCurrentStatus(db, row.id as string);
  return toOrderIntent(row, currentStatus);
}

export async function getPendingApprovals(db: Db): Promise<OrderIntent[]> {
  const rows = await db.query<Record<string, unknown>>(
    `select oi.* from order_intents oi
     join (
       select order_intent_id, max(at) as max_at from order_transitions group by order_intent_id
     ) latest on oi.id = latest.order_intent_id
     join order_transitions ot on ot.order_intent_id = oi.id and ot.at = latest.max_at
     where ot.to_status = 'PENDING_APPROVAL'
     order by oi.created_at`,
  );
  const result: OrderIntent[] = [];
  for (const row of rows) {
    const currentStatus = await getCurrentStatus(db, row.id as string);
    result.push(toOrderIntent(row, currentStatus));
  }
  return result;
}

export async function approveOrder(db: Db, id: string, input: ApproveInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    if (order.status !== 'PENDING_APPROVAL') {
      throw new Error(`Order ${id} is not PENDING_APPROVAL (current: ${order.status})`);
    }

    const nextStatus = order.advisoryPath ? 'ACKNOWLEDGED' : 'APPROVED';

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $2, $7)`,
      [id, order.currentRevision, order.status, nextStatus, input.actor, JSON.stringify(order), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

export async function modifyOrder(db: Db, id: string, input: ModifyInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    if (order.status !== 'PENDING_APPROVAL' && order.status !== 'APPROVED') {
      throw new Error(`Order ${id} cannot be modified (status: ${order.status})`);
    }

    const newRevision = order.currentRevision + 1;
    const newPayload = { ...order.payloadSnapshot };
    
    // Apply modifications to payload
    if (input.quantity !== undefined) newPayload.quantity = input.quantity;
    if (input.limitPricePaise !== undefined) newPayload.limitPricePaise = input.limitPricePaise;
    if (input.orderType !== undefined) newPayload.orderType = input.orderType;
    if (input.deferUntil !== undefined) newPayload.deferUntil = input.deferUntil;
    if (input.alternateInstrumentId !== undefined) newPayload.alternateInstrumentId = input.alternateInstrumentId;

    // FR-30/31: Re-validate rails and freshness for modified order
    // The payloadSnapshot contains the full original Recommendation
    const baseRec = newPayload as unknown as Recommendation;
    const primary = baseRec.primary as RecLeg;
    const modifiedRec: Recommendation = {
      kind: baseRec.kind,
      createdOn: baseRec.createdOn,
      primary: {
        ...primary,
        instrumentId: (newPayload.instrumentId as string) ?? primary.instrumentId,
        action: (newPayload.intent as RecLeg['action']) ?? primary.action,
        amountPaise: (newPayload.quantity as string) ?? primary.amountPaise,
      },
      alternates: baseRec.alternates,
      engineEvidence: baseRec.engineEvidence,
      paperMode: baseRec.paperMode,
    };
    const targetInstrumentId = (newPayload.alternateInstrumentId as string) ?? (newPayload.instrumentId as string) ?? primary.instrumentId ?? order.instrumentId;
    await validateOrderGate(tx, targetInstrumentId, modifiedRec, process.env.NODE_ENV === 'test', order.recommendationId);

    await tx.query(
      `insert into order_revisions
         (order_intent_id, revision_number, modified_at, modified_by, prev_revision,
          quantity, limit_price_paise, order_type, defer_until, alternate_instrument_id,
          payload_snapshot, rails_validated, validation_detail)
       values ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, true, '{}')`,
      [
        id, newRevision, input.actor, order.currentRevision,
        input.quantity ?? order.quantity,
        input.limitPricePaise ?? order.limitPricePaise,
        input.orderType ?? order.orderType,
        input.deferUntil ?? order.deferUntil,
        input.alternateInstrumentId ?? order.alternateInstrumentId,
        JSON.stringify(newPayload),
      ],
    );

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'MODIFIED', $4, $5, $2, $6)`,
      [id, newRevision, order.status, input.actor, JSON.stringify(newPayload), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

export async function deferOrder(db: Db, id: string, input: DeferInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (order.status !== 'PENDING_APPROVAL') {
      throw new Error(`Order ${id} is not PENDING_APPROVAL (current: ${order.status})`);
    }

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    const newPayload = { ...order.payloadSnapshot, deferUntil: input.deferUntil };

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'DEFERRED', $4, $5, $2, $6)`,
      [id, order.currentRevision, order.status, input.actor, JSON.stringify(newPayload), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

export async function rejectOrder(db: Db, id: string, input: RejectInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (order.status !== 'PENDING_APPROVAL' && order.status !== 'MODIFIED' && order.status !== 'DEFERRED') {
      throw new Error(`Order ${id} cannot be rejected (status: ${order.status})`);
    }

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    const newPayload = { ...order.payloadSnapshot, rejectReason: input.reason };

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'REJECTED', $4, $5, $2, $6)`,
      [id, order.currentRevision, order.status, input.actor, JSON.stringify(newPayload), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

export async function expireOrders(
  db: Db,
  now: Date = new Date(),
  notify?: (orderId: string, instrumentId: string, reason: string) => Promise<void>,
): Promise<number> {
  const allOrders = await db.query<Record<string, unknown>>(
    `select id, current_revision, payload_snapshot, expires_at
     from order_intents
     where expires_at is not null`,
  );
  
  let expiredCount = 0;
  
  for (const order of allOrders) {
    const expiresAt = order.expires_at ? new Date(order.expires_at as string) : null;
    if (!expiresAt || expiresAt > now) continue;
    
    const [transition] = await db.query<{ to_status: OrderStatus }>(
      `select to_status from order_transitions where order_intent_id = $1 order by at desc limit 1`,
      [order.id],
    );
    
    if (!transition) continue;
    const status = transition.to_status;
    if (!['PENDING_APPROVAL','MODIFIED','DEFERRED','APPROVED','ACKNOWLEDGED','AWAITING_SESSION'].includes(status)) continue;
    
    const idempotencyKey = `expire:${order.id}:${new Date().toISOString()}`;
    const newPayload = JSON.stringify({ ...(order.payload_snapshot as Record<string, unknown>), expireReason: 'Market session expired' });
    
    await db.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'EXPIRED', 'system', $4, $5, $6)`,
      [order.id, order.current_revision, status, newPayload, order.current_revision, idempotencyKey],
    );

    if (notify) {
      const instrumentId = (order.payload_snapshot as Record<string, unknown>)?.instrumentId as string ?? 'unknown';
      await notify(order.id as string, instrumentId, 'Market session expired');
    }

    expiredCount++;
  }
  
  return expiredCount;
}
export async function acknowledgeAdvisory(db: Db, id: string, input: ApproveInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (!order.advisoryPath) throw new Error(`Order ${id} is not an advisory order`);
    if (order.status !== 'PENDING_APPROVAL' && order.status !== 'MODIFIED') {
      throw new Error(`Order ${id} cannot be acknowledged (status: ${order.status})`);
    }

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'ACKNOWLEDGED', $4, $5, $2, $6)`,
      [id, order.currentRevision, order.status, input.actor, JSON.stringify(order), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

/**
 * Advisory path: owner acknowledges and moves to AWAITING_MANUAL_EXECUTION.
 * This is called when the owner confirms they will execute manually.
 */
export async function awaitManualExecution(db: Db, id: string, input: ApproveInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (!order.advisoryPath) throw new Error(`Order ${id} is not an advisory order`);
    if (order.status !== 'ACKNOWLEDGED') {
      throw new Error(`Order ${id} must be ACKNOWLEDGED to await manual execution (current: ${order.status})`);
    }

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'AWAITING_MANUAL_EXECUTION', $4, $5, $2, $6)`,
      [id, order.currentRevision, order.status, input.actor, JSON.stringify(order), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

/**
 * Advisory path: owner confirms manual execution completed → VERIFIED.
 */
export async function verifyAdvisory(db: Db, id: string, input: ApproveInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (!order.advisoryPath) throw new Error(`Order ${id} is not an advisory order`);
    if (order.status !== 'AWAITING_MANUAL_EXECUTION') {
      throw new Error(`Order ${id} must be AWAITING_MANUAL_EXECUTION to verify (current: ${order.status})`);
    }

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'VERIFIED', $4, $5, $2, $6)`,
      [id, order.currentRevision, order.status, input.actor, JSON.stringify(order), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

/**
 * Advisory path: owner abandons manual execution → ABANDONED.
 */
export async function abandonAdvisory(db: Db, id: string, input: ApproveInput): Promise<OrderIntent> {
  return await db.withTransaction(async (tx) => {
    const order = await getOrderWithStatus(tx, id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (!order.advisoryPath) throw new Error(`Order ${id} is not an advisory order`);
    if (order.status !== 'AWAITING_MANUAL_EXECUTION') {
      throw new Error(`Order ${id} must be AWAITING_MANUAL_EXECUTION to abandon (current: ${order.status})`);
    }

    const existing = await tx.query<Record<string, unknown>>(
      `select 1 from order_transitions where order_intent_id = $1 and idempotency_key = $2`,
      [id, input.idempotencyKey],
    );
    if (existing.length > 0) {
      return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
    }

    await tx.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, 'ABANDONED', $4, $5, $2, $6)`,
      [id, order.currentRevision, order.status, input.actor, JSON.stringify(order), input.idempotencyKey],
    );

    return getOrderWithStatus(tx, id) as Promise<OrderIntent>;
  });
}

export async function simulatePaperEvent(db: Db, orderId: string, simType: OrderSimulation['simType'], note: string = ''): Promise<void> {
  const order = await getOrderWithStatus(db, orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);

  const inputState = { status: order.status, revision: order.currentRevision };
  const outcomeState = { ...inputState };

  switch (simType) {
    case 'SESSION_MISSING':
      outcomeState.status = 'EXPIRED';
      break;
    case 'PARTIAL_FILL':
      outcomeState.status = 'PARTIALLY_FILLED';
      break;
    case 'BROKER_REJECT':
      outcomeState.status = 'BROKER_REJECTED';
      break;
    case 'MARKET_CLOSURE':
      outcomeState.status = 'CANCELLED';
      break;
    case 'ADVISORY_ACK':
      outcomeState.status = 'ACKNOWLEDGED';
      break;
    case 'ADVISORY_VERIFY':
      outcomeState.status = 'VERIFIED';
      break;
    case 'T2_REMINDER':
    case 'T7_REMINDER':
      note = `${simType} sent for ${orderId}`;
      break;
  }

await db.query(
    `insert into order_simulations
       (order_intent_id, revision_number, sim_type, simulated_at, input_state, outcome_state, note)
     values ($1, $2, $3, now(), $4, $5, $6)`,
   [orderId, order.currentRevision, simType, JSON.stringify(inputState), JSON.stringify(outcomeState), note],
 );
}

/**
 * Advisory T+2/T+7 reminder: records a reminder simulation without changing live order.
 * Called by scheduled job to send reminders to owner.
 */
export async function recordAdvisoryReminder(db: Db, orderId: string, reminderType: 'T2_REMINDER' | 'T7_REMINDER'): Promise<void> {
  await simulatePaperEvent(db, orderId, reminderType);
}

/**
 * Resurface a deferred order: checks if deferUntil date has passed, and if so,
 * refreshes staleness/validation and notifies if score fell below threshold.
 * Returns the order if resurfaced, null if not yet time, or throws if validation fails.
 */
export async function resurfaceDeferredOrder(db: Db, id: string): Promise<OrderIntent | null> {
  const order = await getOrderWithStatus(db, id);
  if (!order) throw new Error(`Order ${id} not found`);
  if (order.status !== 'DEFERRED') return null;
  if (!order.deferUntil) return null;

  const deferDate = new Date(order.deferUntil);
  const now = new Date();
  if (deferDate > now) return null; // Not yet time to resurface

  // Build recommendation from payload for re-validation
  const payload = order.payloadSnapshot as unknown as Recommendation;
  const modifiedRec: Recommendation = {
    kind: payload.kind,
    createdOn: payload.createdOn,
    primary: {
      ...payload.primary,
      instrumentId: payload.primary.instrumentId,
    },
    alternates: payload.alternates,
    engineEvidence: payload.engineEvidence,
    paperMode: payload.paperMode,
  };

  // Re-validate rails and freshness (skip staleness in tests)
  await validateOrderGate(db, order.instrumentId, modifiedRec, process.env.NODE_ENV === 'test', order.recommendationId);

  // Check if score (if available in engineEvidence) fell below threshold
  const composite = modifiedRec.engineEvidence?.composite;
  if (typeof composite === 'number' && composite < 40) {
    // Score below HIGH/MEDIUM threshold - recommend withdrawal
    const note = `Resurfaced from deferral: composite score ${composite} below threshold, recommended withdrawal`;
    await simulatePaperEvent(db, id, 'T2_REMINDER', note);
    // Update payload with withdrawal recommendation
    const newPayload = { ...payload, withdrawalRecommended: true, withdrawalReason: `composite ${composite} < 40` };
    await db.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, $2, $3, $3, $4, $5, $2, $6)`,
      [id, order.currentRevision, 'DEFERRED', 'system', JSON.stringify(newPayload), `resurface:${id}:${now.toISOString()}`],
    );
    return getOrderWithStatus(db, id);
  }

  // No withdrawal needed - just mark as resurfaced and back to PENDING_APPROVAL
  const newPayload = { ...payload, resurfaced: true, resurfacedAt: now.toISOString() };
  await db.query(
    `insert into order_transitions
       (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
     values ($1, $2, $3, 'PENDING_APPROVAL', $4, $5, $2, $6)`,
    [id, order.currentRevision, 'DEFERRED', 'system', JSON.stringify(newPayload), `resurface:${id}:${now.toISOString()}`],
  );

  return getOrderWithStatus(db, id);
}

export async function getOrderHistory(db: Db, id: string): Promise<{ revisions: OrderRevision[]; transitions: OrderTransition[]; simulations: OrderSimulation[] }> {
  const [revisions, transitions, simulations] = await Promise.all([
    db.query<Record<string, unknown>>(`select * from order_revisions where order_intent_id = $1 order by revision_number`, [id]),
    db.query<Record<string, unknown>>(`select * from order_transitions where order_intent_id = $1 order by at`, [id]),
    db.query<Record<string, unknown>>(`select * from order_simulations where order_intent_id = $1 order by simulated_at`, [id]),
  ]);

  return {
    revisions: revisions.map(toOrderRevision),
    transitions: transitions.map(toOrderTransition),
    simulations: simulations.map(toOrderSimulation),
  };
}