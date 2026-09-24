import type { Db } from '../db/client.js';
import { DEFAULT_OWNER_RAILS, getBreakerState, getFreezeState, resetBreaker, setFreeze } from './rails.js';
import { testCondition, type FalsificationCondition } from './sell-triggers.js';
import { currentDrawdown } from './drawdown.js';

/**
 * The owner's safety controls: freeze (FR-32), the falsification breaker (FR-33) and
 * rail changes with cooling (FR-34).
 *
 * Each existed as stored state that `/cleanup` rendered and `checkRails` read, and
 * nothing ever SET: `setFreeze`, `recordFalsification` and `last_rail_change` had no
 * production writer. A control that is displayed but never engaged is worse than an
 * absent one, because it reads as protection.
 *
 * Kept free of any transport, so the web app and the Telegram bot call the same
 * functions — the bot only runs while the owner has it open locally, so the web is the
 * surface that is always there.
 */

// ── FR-32: freeze ────────────────────────────────────────────────────────────────────

/** Everything that is still waiting on someone. A freeze stops all of it. */
const OPEN_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'MODIFIED', 'DEFERRED', 'APPROVED',
  'ACKNOWLEDGED', 'AWAITING_SESSION', 'AWAITING_MANUAL_EXECUTION',
];

/** Typed to leave a freeze. A tap is not a decision; a word is. */
export const UNFREEZE_PHRASE = 'UNFREEZE';

/**
 * Halts drafting and cancels every open request, in one transaction with its audit.
 *
 * Cancelling is not optional: a freeze that left approvals pending would let the owner
 * — or a replayed callback — approve through it. Notifications keep flowing.
 */
export async function freeze(db: Db, reason: string, at: Date = new Date()): Promise<{ cancelled: string[] }> {
  if (reason.trim() === '') throw new Error('a freeze needs a reason');
  return db.withTransaction(async (tx) => {
    await setFreeze(tx, true, reason);
    const open = await tx.query<{ id: string; current_revision: number; status: string }>(
      `select o.id, o.current_revision,
              coalesce((select t.to_status from order_transitions t
                         where t.order_intent_id = o.id order by t.at desc limit 1), 'DRAFT') as status
         from order_intents o`,
    );
    const cancelled: string[] = [];
    for (const o of open.filter((x) => OPEN_STATUSES.includes(x.status))) {
      await tx.query(
        `insert into order_transitions
           (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot,
            expected_revision, idempotency_key)
         values ($1, $2, $3, 'CANCELLED', 'owner', $4::jsonb, $2, $5)`,
        [o.id, o.current_revision, o.status,
         JSON.stringify({ cancelReason: `FREEZE: ${reason}` }), `freeze:${at.toISOString()}:${o.id}`],
      );
      cancelled.push(o.id);
    }
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('freeze', 'owner', 'FROZEN', 'owner', $1::jsonb)`,
      [JSON.stringify({ reason, cancelled, at: at.toISOString() })],
    );
    return { cancelled };
  });
}

/**
 * Lifts a freeze, only on the typed phrase. It does NOT revive what the freeze
 * cancelled: those were decisions made under different facts.
 */
export async function unfreeze(db: Db, typed: string): Promise<void> {
  if (typed.trim() !== UNFREEZE_PHRASE) {
    throw new Error(`to lift the freeze, type ${UNFREEZE_PHRASE} exactly`);
  }
  if (!(await getFreezeState(db)).active) throw new Error('not frozen');
  await db.withTransaction(async (tx) => {
    await setFreeze(tx, false, '');
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('freeze', 'owner', 'UNFROZEN', 'owner', '{}'::jsonb)`,
    );
  });
}

// ── FR-33: the falsification breaker ─────────────────────────────────────────────────

/** Three consecutive falsified approvals demote the advisor to report-only. */
export const BREAKER_STREAK = 3;
/** An approval that survives this long without its condition firing did not fail. */
export const FALSIFICATION_HORIZON_MONTHS = 12;

export type Outcome = 'HIT' | 'NOT_HIT';

export interface BreakerEvaluation {
  /** Approved recommendations with a falsification condition, oldest approval first. */
  outcomes: { recommendationId: number; approvedAt: string; outcome: Outcome | 'UNKNOWN' }[];
  streak: number;
  tripped: boolean;
}

const addMonths = (iso: string, months: number): string => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
};

/**
 * Derives the breaker from approved recommendations rather than incrementing a counter.
 *
 * `recordFalsification` incremented a number, so any replayed or duplicate observation
 * fabricated a streak, and nothing called it anyway. Here the streak is recomputed from
 * facts every time, which makes it idempotent by construction. The semantics, because
 * the plan requires them written down:
 *
 * - **Counted:** recommendations the OWNER approved (an order reached APPROVED or
 *   ACKNOWLEDGED by actor `owner`) whose primary leg carries a falsification condition.
 *   Exits and cleanup items carry none and are not counted.
 * - **HIT:** the condition fired. Recorded once, the first time it is observed, and never
 *   un-recorded — a price that falls through the level and recovers still falsified the
 *   thesis.
 * - **NOT_HIT:** twelve months passed after approval without the condition firing.
 * - **UNKNOWN:** neither yet, or the data to test it is missing. Unknown is NOT a
 *   success: it neither extends nor breaks a streak.
 * - **Order:** by approval time, fixed at approval, so a later observation cannot
 *   re-order history. The streak is the run of HITs at the END of the resolved list.
 * - **Reset:** only approvals after the last `/reset_breaker` count, or the same three
 *   hits would re-trip the breaker the moment it was reset.
 */
export async function evaluateBreaker(db: Db, now: Date = new Date()): Promise<BreakerEvaluation> {
  const [reset] = await db.query<{ at: string | Date }>(
    `select at from audit_log where entity = 'breaker' and action = 'BREAKER_RESET'
      order by at desc limit 1`,
  );
  const since = reset ? new Date(reset.at).toISOString() : '1970-01-01T00:00:00Z';

  const approved = await db.query<{ recommendation_id: string; approved_at: string | Date; primary_rec: string }>(
    `select o.recommendation_id, min(t.at) as approved_at, r.primary_rec
       from order_intents o
       join order_transitions t on t.order_intent_id = o.id
       join recommendations r on r.id = o.recommendation_id
      where t.to_status in ('APPROVED', 'ACKNOWLEDGED') and t.actor = 'owner'
      group by o.recommendation_id, r.primary_rec
     having min(t.at) > $1::timestamptz
      order by min(t.at)`,
    [since],
  );

  const recorded = new Map((await db.query<{ entity_id: string; action: Outcome }>(
    `select entity_id, action from audit_log where entity = 'falsification'`,
  )).map((r) => [r.entity_id, r.action]));

  const outcomes: BreakerEvaluation['outcomes'] = [];
  for (const a of approved) {
    const primary = JSON.parse(a.primary_rec) as { instrumentId: string | null; falsification: FalsificationCondition | null };
    if (primary.falsification === null || primary.instrumentId === null) continue;
    const recId = String(a.recommendation_id);
    const approvedAt = new Date(a.approved_at).toISOString();

    let outcome: Outcome | 'UNKNOWN' = recorded.get(recId) ?? 'UNKNOWN';
    if (outcome === 'UNKNOWN') {
      const verdict = await testCondition(db, primary.instrumentId, primary.falsification, now.toISOString().slice(0, 10));
      if (verdict?.fired === true) outcome = 'HIT';
      else if (addMonths(approvedAt, FALSIFICATION_HORIZON_MONTHS) <= now.toISOString()) outcome = 'NOT_HIT';
      if (outcome !== 'UNKNOWN') {
        await db.query(
          `insert into audit_log (entity, entity_id, action, actor, payload)
           values ('falsification', $1, $2, 'agent', $3::jsonb)`,
          [recId, outcome, JSON.stringify({ evidence: verdict?.evidence ?? 'horizon passed', at: now.toISOString() })],
        );
      }
    }
    outcomes.push({ recommendationId: Number(recId), approvedAt, outcome });
  }

  let streak = 0;
  for (const o of outcomes.filter((x) => x.outcome !== 'UNKNOWN')) {
    streak = o.outcome === 'HIT' ? streak + 1 : 0;
  }

  const state = await getBreakerState(db);
  const tripped = streak >= BREAKER_STREAK;
  if (tripped && !state.active) {
    await db.query(
      `insert into settings_rails (key, value) values ('breaker_state', $1::jsonb)
       on conflict (key) do update set value = $1::jsonb`,
      [JSON.stringify({
        active: true, consecutiveFalsifications: streak,
        lastFalsificationAt: now.toISOString(), demotedAt: now.toISOString(), postMortemNote: null,
      })],
    );
    await db.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('breaker', 'trip', 'BREAKER_TRIPPED', 'agent', $1::jsonb)`,
      [JSON.stringify({ streak, recommendations: outcomes.slice(-streak).map((o) => o.recommendationId) })],
    );
  }
  return { outcomes, streak, tripped };
}

/** Typed to reset the breaker. */
export const RESET_PHRASE = 'RESET BREAKER';

/**
 * The mandatory post-mortem, written by the agent from the record (PRD §11.5), which
 * the owner then reads and confirms. Deterministic: it states which approvals failed and
 * how, and originates no number of its own.
 */
export async function breakerPostMortem(db: Db): Promise<string> {
  const rows = await db.query<{ entity_id: string; payload: unknown; at: string | Date }>(
    `select entity_id, payload, at from audit_log
      where entity = 'falsification' and action = 'HIT' order by at desc limit $1`,
    [BREAKER_STREAK],
  );
  if (rows.length === 0) return 'No falsified approvals are on record.';
  const lines = rows.reverse().map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { evidence?: string };
    return `- Recommendation #${r.entity_id}: ${p.evidence ?? 'falsified'} (${new Date(r.at).toISOString().slice(0, 10)})`;
  });
  return [
    `${rows.length} consecutive approved recommendations hit their falsification conditions:`,
    ...lines,
    'Each thesis named in advance what would prove it wrong, and each was proved wrong.',
    'Reset only once the pattern is understood; the advisor was report-only until now.',
  ].join('\n');
}

export async function resetBreakerWithPostMortem(db: Db, typed: string): Promise<string> {
  if (typed.trim() !== RESET_PHRASE) throw new Error(`to reset the breaker, type ${RESET_PHRASE} exactly`);
  if (!(await getBreakerState(db)).active) throw new Error('the breaker is not tripped');
  const note = await breakerPostMortem(db);
  await resetBreaker(db, note);
  return note;
}

// ── FR-34: rail changes cool for 48 hours ────────────────────────────────────────────

export const RAIL_COOLING_HOURS = 48;
export const LOOSENING_BLOCK_DRAWDOWN_PCT = 15;

/**
 * Every current rail is a ceiling or a cap, so a HIGHER value is a looser rail. Listed
 * explicitly rather than assumed, so a future rail whose direction is the other way
 * must be added here deliberately — an unknown rail is refused, not guessed at.
 */
const LOOSER_WHEN_HIGHER = new Set(Object.keys(DEFAULT_OWNER_RAILS));

export function isLoosening(key: string, current: number, proposed: number): boolean {
  if (!LOOSER_WHEN_HIGHER.has(key)) throw new Error(`unknown rail ${key}`);
  return proposed > current;
}

async function railValue(db: Db, key: string): Promise<number> {
  const [row] = await db.query<{ value: unknown }>(`select value from settings_rails where key = $1`, [key]);
  return Number(row ? row.value : DEFAULT_OWNER_RAILS[key]);
}

/**
 * Loosening is refused above 15% drawdown — and refused when there is no recent
 * drawdown evidence at all, because missing evidence cannot approve a loosening.
 */
async function looseningAllowed(db: Db, now: Date): Promise<string | null> {
  const dd = await currentDrawdown(db, now);
  if (dd === null) return 'no recent drawdown evidence, so a loosening cannot be approved';
  if (dd > LOOSENING_BLOCK_DRAWDOWN_PCT) {
    return `portfolio drawdown is ${dd}%, above the ${LOOSENING_BLOCK_DRAWDOWN_PCT}% line`;
  }
  return null;
}

/**
 * Proposes a rail change. It takes effect 48 hours later, not now, and a loosening is
 * checked again at that point. Tightening cools too: the PRD says every edit waits.
 *
 * This replaces `COOLING_NOT_ELAPSED` in the order gate, which blocked EVERY order for
 * 48 hours after any rail change. The PRD asks that the edit wait, not the portfolio.
 */
export async function proposeRailChange(
  db: Db, key: string, proposed: number, now: Date = new Date(),
): Promise<{ activatesAt: string; loosening: boolean }> {
  if (!Number.isFinite(proposed) || proposed <= 0) throw new Error('a rail value must be a positive number');
  const current = await railValue(db, key);
  if (proposed === current) throw new Error(`${key} is already ${current}`);
  const loosening = isLoosening(key, current, proposed);
  if (loosening) {
    const refusal = await looseningAllowed(db, now);
    if (refusal !== null) throw new Error(`refused: ${refusal}`);
  }
  await db.query(
    `insert into settings_rails (key, value, pending_value, pending_since)
     values ($1, $2::jsonb, $3::jsonb, $4)
     on conflict (key) do update set pending_value = $3::jsonb, pending_since = $4`,
    [key, JSON.stringify(current), JSON.stringify(proposed), now.toISOString()],
  );
  const activatesAt = new Date(now.getTime() + RAIL_COOLING_HOURS * 3_600_000).toISOString();
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('rail', $1, 'RAIL_CHANGE_PROPOSED', 'owner', $2::jsonb)`,
    [key, JSON.stringify({ key, current, proposed, loosening, activatesAt })],
  );
  return { activatesAt, loosening };
}

export interface PendingRailChange { key: string; current: number; proposed: number; activatesAt: string }

export async function pendingRailChanges(db: Db): Promise<PendingRailChange[]> {
  const rows = await db.query<{ key: string; value: unknown; pending_value: unknown; pending_since: string | Date }>(
    `select key, value, pending_value, pending_since from settings_rails
      where pending_value is not null and pending_since is not null order by key`,
  );
  return rows.map((r) => ({
    key: r.key,
    current: Number(r.value),
    proposed: Number(r.pending_value),
    activatesAt: new Date(new Date(r.pending_since).getTime() + RAIL_COOLING_HOURS * 3_600_000).toISOString(),
  }));
}

/** Activates each change whose 48 hours are up, re-checking a loosening at activation. */
export async function applyDueRailChanges(
  db: Db, now: Date = new Date(),
): Promise<{ activated: string[]; refused: { key: string; reason: string }[] }> {
  const activated: string[] = [];
  const refused: { key: string; reason: string }[] = [];
  for (const c of await pendingRailChanges(db)) {
    if (c.activatesAt > now.toISOString()) continue;
    const refusal = isLoosening(c.key, c.current, c.proposed) ? await looseningAllowed(db, now) : null;
    if (refusal !== null) {
      await db.query(`update settings_rails set pending_value = null, pending_since = null where key = $1`, [c.key]);
      await db.query(
        `insert into audit_log (entity, entity_id, action, actor, payload)
         values ('rail', $1, 'RAIL_CHANGE_REFUSED', 'agent', $2::jsonb)`,
        [c.key, JSON.stringify({ ...c, reason: refusal })],
      );
      refused.push({ key: c.key, reason: refusal });
      continue;
    }
    await db.query(
      `update settings_rails set value = pending_value, pending_value = null, pending_since = null,
              updated_at = now() where key = $1`,
      [c.key],
    );
    await db.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('rail', $1, 'RAIL_CHANGE_ACTIVATED', 'agent', $2::jsonb)`,
      [c.key, JSON.stringify(c)],
    );
    activated.push(c.key);
  }
  return { activated, refused };
}
