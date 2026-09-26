import type { Db } from '../db/client.js';
import { formatInr, type Paise } from '../money/paise.js';

/**
 * What the owner did outside Sentinel, told to it from the web app (/log).
 *
 * Each entry is a fact the rest of the system reads — a goal deposit is what the cash
 * ceiling excuses and what the buckets report counts — and each lands in `audit_log`
 * with `actor = 'owner'`, which is where the timeline reads it back from.
 */

export type GoalMoveKind = 'sip' | 'maturity' | 'vest' | 'withdrawal';

const today = (now: string): string => now.slice(0, 10);

function assertDate(on: string, now: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new Error(`not a date: ${on}`);
  if (on > today(now)) throw new Error(`${on} is in the future`);
}

async function audit(db: Db, entity: string, entityId: string, action: string, payload: object): Promise<void> {
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload) values ($1, $2, $3, 'owner', $4::jsonb)`,
    [entity, entityId, action, JSON.stringify(payload)],
  );
}

/** Money into (or out of) a goal bucket. The amount is entered positive; a withdrawal is stored negative. */
export async function logGoalMove(
  db: Db,
  m: { bucketId: string; occurredOn: string; amountPaise: bigint; kind: GoalMoveKind; note: string },
  now = new Date().toISOString(),
): Promise<void> {
  if (m.amountPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(m.occurredOn, now);
  const [bucket] = await db.query<{ name: string }>(`select name from buckets where id = $1`, [m.bucketId]);
  if (!bucket) throw new Error(`no goal ${m.bucketId}`);
  const signed = m.kind === 'withdrawal' ? -m.amountPaise : m.amountPaise;
  await db.withTransaction(async (tx) => {
    await tx.query(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, note, as_of, source)
       values ($1, $2, $3, $4, $5, $6, 'owner-web')`,
      [m.bucketId, m.occurredOn, signed.toString(), m.kind, m.note.trim(), now],
    );
    await audit(tx, 'bucket_flow', m.bucketId, 'LOGGED', {
      on: m.occurredOn, amountPaise: signed.toString(), kind: m.kind, note: m.note.trim(), bucket: bucket.name,
    });
  });
}

export async function completeMilestone(db: Db, id: string, on: string, now = new Date().toISOString()): Promise<void> {
  assertDate(on, now);
  const [m] = await db.query<{ completed_on: string | null; name: string }>(
    `select completed_on::text, name from milestones where id = $1`, [id]);
  if (!m) throw new Error(`no milestone ${id}`);
  if (m.completed_on !== null) throw new Error(`${m.name} is already marked complete on ${m.completed_on}`);
  await db.withTransaction(async (tx) => {
    await tx.query(`update milestones set completed_on = $2 where id = $1`, [id, on]);
    await audit(tx, 'milestone', id, 'COMPLETED', { on, name: m.name });
  });
}

export async function logNote(db: Db, n: { on: string; text: string }, now = new Date().toISOString()): Promise<void> {
  assertDate(n.on, now);
  const text = n.text.trim();
  if (text === '') throw new Error('a note cannot be empty');
  if (text.length > 1000) throw new Error('a note is limited to 1,000 characters');
  await audit(db, 'owner_note', n.on, 'NOTE', { on: n.on, text });
}

export interface TimelineEntry { key: string; on: string; at: string; kind: string; summary: string }

type Payload = Record<string, unknown>;

function describe(entity: string, entityId: string, action: string, p: Payload): { kind: string; summary: string } {
  const money = (v: unknown) => (typeof v === 'string' ? formatInr(BigInt(v) as Paise) : 'unknown amount');
  switch (`${entity}/${action}`) {
    case 'bucket_flow/LOGGED': {
      const amount = BigInt(String(p['amountPaise'] ?? '0'));
      const verb = amount < 0n ? 'Withdrew' : 'Deposited';
      const abs = (amount < 0n ? -amount : amount).toString();
      return { kind: 'Goal', summary: `${verb} ${money(abs)} ${amount < 0n ? 'from' : 'into'} ${entityId}${p['note'] ? ` — ${String(p['note'])}` : ''}` };
    }
    case 'milestone/COMPLETED': return { kind: 'Milestone', summary: `Completed ${String(p['name'] ?? entityId)}` };
    case 'owner_note/NOTE': return { kind: 'Note', summary: String(p['text'] ?? '') };
    case 'bond_redemption/REDEEMED': return { kind: 'Bond', summary: `Bond redeemed: ${entityId}` };
    case 'bond_redemption/AMOUNT_STATED': return { kind: 'Bond', summary: `Redemption amount stated: ${money(p['amountPaise'])}` };
    case 'rsu_vest/CONFIRMED': return { kind: 'RSU', summary: 'Vest confirmed' };
    default: return { kind: entity, summary: `${entity} ${action}` };
  }
}

/** What the owner did, newest first: their own audit rows, never the system's. */
export async function loadOwnerTimeline(db: Db, limit = 100): Promise<TimelineEntry[]> {
  const rows = await db.query<{ id: string; at: string | Date; entity: string; entity_id: string; action: string; payload: unknown }>(
    `select id::text, at, entity, entity_id, action, payload from audit_log
      where actor = 'owner' and entity in ('bucket_flow', 'milestone', 'owner_note', 'bond_redemption', 'rsu_vest')
      order by at desc, id desc limit $1`,
    [limit],
  );
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload ?? {}) as Payload;
    const at = new Date(r.at).toISOString();
    const on = typeof p['on'] === 'string' ? p['on'] : typeof p['receivedOn'] === 'string' ? p['receivedOn'] : at.slice(0, 10);
    return { key: r.id, on, at, ...describe(r.entity, r.entity_id, r.action, p) };
  }).sort((a, b) => (a.on === b.on ? b.at.localeCompare(a.at) : b.on.localeCompare(a.on)));
}
