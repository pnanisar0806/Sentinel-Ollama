import type { Db } from '../db/client.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { formatInr, type Paise } from '../money/paise.js';
import { railPaise } from './rail-values.js';
import { istDate } from './sips.js';
import { assertRealDate } from './owner-log.js';

/**
 * Life events (batch C spec "Life events"): something changed in the owner's life, and the
 * event leaves a review list of what it touches until the owner closes each line. Nothing
 * here changes a rail or an assumption, and nothing pauses a SIP: a stop-event is a flag.
 *
 * Goal lines (emergency target, education goal) are goal status, so they are built only in
 * `web/lib/life-events.ts`; this module never reads a goal (tests/architecture/no-catch-up).
 */

export type LifeEventKind = 'SALARY_CHANGE' | 'JOB_LOSS' | 'NEW_DEPENDENT' | 'WINDFALL' | 'RETIREMENT_AGE' | 'MEDICAL_EXPENSE';
export type ReviewItemKind = 'rail' | 'constant' | 'goal';
export interface ReviewItem { key: string; kind: ReviewItemKind; label: string }

const EMERGENCY: ReviewItem = { key: 'emergency_target', kind: 'goal', label: 'emergency-fund target' };
const BUDGET: ReviewItem = { key: 'monthly_budget_paise', kind: 'rail', label: 'monthly budget' };

export const REVIEW_ITEMS: Record<LifeEventKind, ReviewItem[]> = {
  SALARY_CHANGE: [BUDGET, { key: 'goal_setaside_monthly_paise', kind: 'rail', label: 'goal set-aside' },
    { key: 'salaryStepUp', kind: 'constant', label: 'salary step-up' }, EMERGENCY],
  JOB_LOSS: [EMERGENCY, BUDGET],
  NEW_DEPENDENT: [{ key: 'childArrivalYear', kind: 'constant', label: 'child arrival year' },
    { key: 'childMonthlyDentInr', kind: 'constant', label: 'child monthly cost (₹)' }, EMERGENCY,
    { key: 'education_goal', kind: 'goal', label: 'education goal' }],
  WINDFALL: [],
  RETIREMENT_AGE: [{ key: 'fiTargetAge', kind: 'constant', label: 'FI target age' },
    { key: 'fund_mix_horizon', kind: 'constant', label: 'fund-mix horizon band — re-proposal follows the age' }],
  MEDICAL_EXPENSE: [EMERGENCY],
};

export interface ReviewLine {
  eventId: string; eventKind: LifeEventKind; eventOn: string;
  key: string; kind: ReviewItemKind; label: string;
  /** Null when there is nothing to show (no code value, or a goal that cannot load). */
  current: string | null;
  state: 'OPEN' | 'NEEDS_CHANGE';
  newValueText: string | null;
}

const KINDS = Object.keys(REVIEW_ITEMS) as LifeEventKind[];
/** IPS stop-event: a medical expense above ₹30,00,000. */
const MEDICAL_STOP_PAISE = 300_000_000n;
const NOTE_MAX = 500;

function cleanNote(note: string): string | null {
  const n = note.trim();
  if (n.length > NOTE_MAX) throw new Error(`a note is limited to ${NOTE_MAX} characters`);
  return n === '' ? null : n;
}

function assertPast(on: string, now: string): void {
  assertRealDate(on);
  if (on > istDate(now)) throw new Error(`${on} is in the future`);
}

/** The owner audit row `reverseEntry` keys on (payload `rowId` = the life_events id). */
async function insertEvent(
  tx: Db, e: { kind: string; on: string; amount: bigint | null; detail: object; endsId: string | null; note: string | null }, now: string,
): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into life_events (kind, occurred_on, amount_paise, detail, ends_event_id, note, as_of, source)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, 'owner-web') returning id::text`,
    [e.kind, e.on, e.amount?.toString() ?? null, e.detail, e.endsId, e.note, now]);
  await tx.query(`insert into audit_log (entity, entity_id, action, actor, payload) values ('life_event', $1, $2, 'owner', $3::jsonb)`,
    [e.kind, e.kind === 'ENDED' ? 'ENDED' : 'LOGGED', {
      source: 'owner-web', rowId: row!.id, on: e.on, kind: e.kind, amountPaise: e.amount?.toString() ?? null,
      detail: e.detail, endsEventId: e.endsId, note: e.note,
    }]);
  return row!.id;
}

export async function logLifeEvent(
  db: Db,
  e: { kind: LifeEventKind; on: string; amountPaise?: bigint; detail?: { expectedOn?: string; fiTargetAge?: number; from?: string }; note: string },
  now = new Date().toISOString(),
): Promise<{ id: string }> {
  if (!KINDS.includes(e.kind)) throw new Error(`not a life event: ${e.kind}`);
  // A windfall is money: it is logged as a lump sum (the /log form hands off), never as an event row.
  if (e.kind === 'WINDFALL') throw new Error('log a windfall under Money received');
  if (e.kind === 'NEW_DEPENDENT') assertRealDate(e.on); else assertPast(e.on, now);
  const needsAmount = e.kind === 'SALARY_CHANGE' || e.kind === 'MEDICAL_EXPENSE';
  if (e.amountPaise !== undefined ? e.amountPaise <= 0n : needsAmount) throw new Error('the amount must be positive');
  const d = e.detail ?? {};
  const detail: Record<string, unknown> = {};
  if (e.kind === 'RETIREMENT_AGE') {
    const age = d.fiTargetAge;
    if (typeof age !== 'number' || !Number.isInteger(age) || age < 35 || age > 75) throw new Error('the FI target age must be a whole number within 35–75');
    detail.fiTargetAge = age;
  }
  if (e.kind === 'NEW_DEPENDENT' && !d.expectedOn) throw new Error('a new dependent needs an expected date');
  if (d.expectedOn) { assertRealDate(d.expectedOn); detail.expectedOn = d.expectedOn; }
  const from = d.from?.trim();
  if (from) { if (from.length > 120) throw new Error('"from" is limited to 120 characters'); detail.from = from; }
  const note = cleanNote(e.note);
  const id = await db.withTransaction((tx) =>
    insertEvent(tx, { kind: e.kind, on: e.on, amount: e.amountPaise ?? null, detail, endsId: null, note }, now));
  return { id };
}

/** A job loss ending, or a medical expense settled: a second, dated `ENDED` row. */
export async function endLifeEvent(
  db: Db, e: { eventId: string; on: string; note: string }, now = new Date().toISOString(),
): Promise<{ id: string }> {
  assertPast(e.on, now);
  const note = cleanNote(e.note);
  const id = await db.withTransaction(async (tx) => {
    const [ev] = await tx.query<{ kind: string; on: string }>(
      `select kind, occurred_on::text as "on" from life_events e where id::text = $1 and ${live('e')}`, [e.eventId]);
    if (!ev) throw new Error(`no life event ${e.eventId}`);
    if (ev.kind !== 'JOB_LOSS' && ev.kind !== 'MEDICAL_EXPENSE') throw new Error('only a job loss or a medical expense can be ended');
    if (e.on < ev.on) throw new Error(`it cannot end before it began (${ev.on})`);
    const ended = await tx.query(`select 1 from life_events e where ends_event_id::text = $1 and ${live('e')}`, [e.eventId]);
    if (ended.length) throw new Error('this event is already ended');
    return insertEvent(tx, { kind: 'ENDED', on: e.on, amount: null, detail: {}, endsId: e.eventId, note }, now);
  });
  return { id };
}

/** Not reversed (src/domain/reversals.ts). */
const live = (a: string) => `not exists (select 1 from log_reversals r where r.entity = 'life_event' and r.entity_id = ${a}.id::text)`;

export async function reviewLine(
  db: Db, r: { eventId: string; key: string; outcome: 'STILL_RIGHT' | 'NEEDS_CHANGE'; newValueText?: string }, now = new Date().toISOString(),
): Promise<void> {
  const [ev] = await db.query<{ kind: string }>(`select kind from life_events e where id::text = $1 and ${live('e')}`, [r.eventId]);
  if (!ev) throw new Error(`no life event ${r.eventId}`);
  const items = REVIEW_ITEMS[ev.kind as LifeEventKind] ?? [];
  if (!items.some((i) => i.key === r.key)) throw new Error(`${r.key} is not a review item of a ${ev.kind} event`);
  if (r.outcome !== 'STILL_RIGHT' && r.outcome !== 'NEEDS_CHANGE') throw new Error(`not a review outcome: ${r.outcome}`);
  const text = r.outcome === 'NEEDS_CHANGE' ? r.newValueText?.trim() ?? '' : null;
  if (text === '') throw new Error('"needs changing" needs the new value');
  if (text !== null && text.length > NOTE_MAX) throw new Error(`the new value is limited to ${NOTE_MAX} characters`);
  await db.query(
    `insert into life_event_reviews (event_id, item_key, outcome, new_value_text, as_of, source) values ($1, $2, $3, $4, $5, 'owner-web')`,
    [r.eventId, r.key, r.outcome, text, now]);
}

/**
 * Open lines of the given item kinds, for live events logged by `now`. The latest review
 * row per (event, key) decides — by `as_of`, so two answers to one line need distinct
 * instants. A rail line also closes when a rail change was proposed after the event, by `now`,
 * and not refused since (`applyDueRailChanges` refuses a loosening at activation).
 * Shared with `web/lib/life-events.ts`, which passes the goal kind and its own `current`.
 */
export async function openReviewLines(
  db: Db, now: string, kinds: ReviewItemKind[], current: (item: ReviewItem) => string | null | Promise<string | null>,
): Promise<ReviewLine[]> {
  const events = await db.query<{ id: string; kind: LifeEventKind; on: string; as_of: string | Date }>(
    `select id::text, kind, occurred_on::text as "on", as_of from life_events e
      where kind <> 'ENDED' and as_of <= $1 and ${live('e')} order by occurred_on, as_of`, [now]);
  if (!events.length) return [];
  const reviews = new Map((await db.query<{ event_id: string; item_key: string; outcome: string; new_value_text: string | null }>(
    `select distinct on (event_id, item_key) event_id::text, item_key, outcome, new_value_text from life_event_reviews
      where as_of <= $1 order by event_id, item_key, as_of desc`, [now])).map((r) => [`${r.event_id}|${r.item_key}`, r]));
  const proposed = new Map((await db.query<{ key: string; at: string | Date }>(
    `select p.entity_id as key, max(p.at) as at from audit_log p
      where p.entity = 'rail' and p.action = 'RAIL_CHANGE_PROPOSED' and p.at <= $1
        and not exists (select 1 from audit_log x where x.entity = 'rail' and x.entity_id = p.entity_id
                          and x.action = 'RAIL_CHANGE_REFUSED' and x.at > p.at and x.at <= $1)
      group by p.entity_id`, [now]))
    .map((p) => [p.key, new Date(p.at).getTime()]));
  const lines: ReviewLine[] = [];
  for (const ev of events) {
    for (const item of REVIEW_ITEMS[ev.kind].filter((i) => kinds.includes(i.kind))) {
      if (item.kind === 'rail' && (proposed.get(item.key) ?? -Infinity) > new Date(ev.as_of).getTime()) continue;
      const r = reviews.get(`${ev.id}|${item.key}`);
      if (r && r.outcome !== 'NEEDS_CHANGE') continue;
      lines.push({
        eventId: ev.id, eventKind: ev.kind, eventOn: ev.on, key: item.key, kind: item.kind, label: item.label,
        current: await current(item), state: r ? 'NEEDS_CHANGE' : 'OPEN', newValueText: r?.new_value_text ?? null,
      });
    }
  }
  return lines;
}

/** Rail and constant lines. A rail shows its current value in rupees; a constant its code value. */
export function loadReviewLines(db: Db, now: string): Promise<ReviewLine[]> {
  return openReviewLines(db, now, ['rail', 'constant'], async (item) => {
    if (item.kind === 'rail') return formatInr(await railPaise(db, item.key) as Paise);
    return item.key in ASSUMPTIONS ? String(ASSUMPTIONS[item.key as keyof typeof ASSUMPTIONS]) : null;
  });
}

export async function stopEventsInForce(
  db: Db, now: string,
): Promise<{ eventId: string; kind: 'JOB_LOSS' | 'MEDICAL_EXPENSE'; since: string; text: string }[]> {
  const rows = await db.query<{ id: string; kind: 'JOB_LOSS' | 'MEDICAL_EXPENSE'; on: string; amount_paise: string | null }>(
    `select e.id::text, e.kind, e.occurred_on::text as "on", e.amount_paise::text from life_events e
      where ${live('e')}
        and ((e.kind = 'JOB_LOSS' and e.occurred_on <= ($1::date - interval '3 months')::date)
          or (e.kind = 'MEDICAL_EXPENSE' and e.amount_paise > $2))
        and not exists (select 1 from life_events x where x.ends_event_id = e.id and ${live('x')})
      order by e.occurred_on, e.as_of`, [istDate(now), MEDICAL_STOP_PAISE.toString()]);
  return rows.map((r) => {
    const what = r.kind === 'JOB_LOSS' ? `job loss since ${r.on}` : `medical expense ${formatInr(BigInt(r.amount_paise!) as Paise)}`;
    return {
      eventId: r.id, kind: r.kind, since: r.on,
      text: `IPS stop-event in force (${what}): pausing SIPs is permitted, not advised. Sentinel changes nothing.`,
    };
  });
}
