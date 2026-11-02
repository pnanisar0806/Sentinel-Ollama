import type { Db } from '../db/client.js';
import { fundAliases, sameFund } from './fund-mix.js';
import { istDate, istMonth } from './sips.js';
import { loadLumpSum } from './lump-sums.js';

/**
 * Owner holding rules (batch C spec): a standing instruction on one fund — no new money, hold
 * until a date, never buy again, or cap its weight. A rule binds the fund through its aliases
 * (MF:* and IND:* rows of one scheme). An exception allows the rule to be broken once, for one
 * IST month or for one lump sum. Ending either early is a `log_reversals` row, never an edit.
 * No rule changes a rail or pauses a SIP by itself; callers only refuse or record a waiver.
 */

export type RuleKind = 'NO_ADD' | 'HOLD_UNTIL' | 'NO_REBUY' | 'CAP_PCT';
const KINDS: readonly RuleKind[] = ['NO_ADD', 'HOLD_UNTIL', 'NO_REBUY', 'CAP_PCT'];

export interface HoldingRule {
  id: string; instrumentId: string; name: string; kind: RuleKind; untilOn: string | null; capBps: number | null;
  note: string; on: string; aliases: string[];
  exceptions: { id: string; month: string | null; lumpSumId: string | null }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM` (or a date) → "Nov 2026". */
export const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export function ruleLabel(r: Pick<HoldingRule, 'kind' | 'untilOn' | 'capBps'>): string {
  switch (r.kind) {
    case 'NO_ADD': return 'no new money';
    case 'NO_REBUY': return 'never buy again';
    case 'HOLD_UNTIL': return `hold until ${monthLabel(r.untilOn!)}`;
    // Display only: an integer bps over 100 prints exactly (1250 → 12.5).
    case 'CAP_PCT': return `cap at ${r.capBps! / 100}%`;
  }
}

/** YYYY-MM-DD and a real calendar day (as owner-log.ts). */
function assertRealDate(on: string): void {
  const d = new Date(`${on}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== on) throw new Error(`not a date: ${on}`);
}

async function audit(db: Db, entity: string, entityId: string, action: string, payload: object): Promise<void> {
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload) values ($1, $2, $3, 'owner', $4::jsonb)`,
    [entity, entityId, action, payload],
  );
}

export async function logHoldingRule(
  db: Db,
  r: { on: string; instrumentId: string; kind: RuleKind; untilOn?: string; capBps?: number; note: string },
  now = new Date().toISOString(),
): Promise<{ id: string }> {
  assertRealDate(r.on);
  if (r.on > istDate(now)) throw new Error(`${r.on} is in the future`);
  if (!KINDS.includes(r.kind)) throw new Error(`not a rule kind: ${r.kind}`);
  if (r.kind === 'HOLD_UNTIL') {
    if (r.untilOn === undefined) throw new Error('a hold-until rule needs its date');
    assertRealDate(r.untilOn);
    if (r.untilOn <= istDate(now)) throw new Error(`a hold-until date must be in the future, not ${r.untilOn}`);
  } else if (r.untilOn !== undefined) throw new Error('only a hold-until rule carries a date');
  if (r.kind === 'CAP_PCT') {
    if (r.capBps === undefined || !Number.isInteger(r.capBps) || r.capBps < 1 || r.capBps > 10000) {
      throw new Error('a cap must be a whole number of basis points from 1 to 10000');
    }
  } else if (r.capBps !== undefined) throw new Error('only a cap rule carries a cap');
  const note = r.note.trim();
  if (note.length > 500) throw new Error('a note is limited to 500 characters');

  return db.withTransaction(async (tx) => {
    // Locking the instrument serialises two rules on it, so the duplicate check below holds.
    const [inst] = await tx.query<{ name: string }>(`select name from instruments where id = $1 for update`, [r.instrumentId]);
    if (!inst) throw new Error(`no instrument ${r.instrumentId}`);
    const aliases = await fundAliases(tx, r.instrumentId);
    const label = ruleLabel({ kind: r.kind, untilOn: r.untilOn ?? null, capBps: r.capBps ?? null });
    const dup = (await loadActiveHoldingRules(tx, now)).find((x) => x.kind === r.kind && sameFund(x.aliases, aliases));
    if (dup) throw new Error(`a ${ruleLabel(dup)} rule on ${dup.name} is already active; end it first`);
    const [row] = await tx.query<{ id: string }>(
      `insert into holding_rules (instrument_id, kind, until_on, cap_bps, note, occurred_on, as_of, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'owner-web') returning id::text`,
      [r.instrumentId, r.kind, r.untilOn ?? null, r.capBps ?? null, note || null, r.on, now],
    );
    await audit(tx, 'holding_rule', r.instrumentId, 'LOGGED', {
      on: r.on, kind: r.kind, label, untilOn: r.untilOn ?? null, capBps: r.capBps ?? null, note, fund: inst.name,
      rowId: row!.id, source: 'owner-web',
    });
    return { id: row!.id };
  });
}

export async function logRuleException(
  db: Db,
  e: { ruleId: string; month?: string; lumpSumId?: string; note: string },
  now = new Date().toISOString(),
): Promise<{ id: string }> {
  const note = e.note.trim();
  if (note === '') throw new Error('an exception needs a note');
  if (note.length > 500) throw new Error('a note is limited to 500 characters');
  if ((e.month === undefined) === (e.lumpSumId === undefined)) throw new Error('an exception covers one month or one lump sum, not both or neither');
  if (e.month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.month)) throw new Error(`not a month: ${e.month}`);
    if (e.month < istMonth(now)) throw new Error(`${e.month} has already passed`);
  }

  return db.withTransaction(async (tx) => {
    await tx.query(`select id from holding_rules where id::text = $1 for update`, [e.ruleId]);
    const rule = (await loadActiveHoldingRules(tx, now)).find((r) => r.id === e.ruleId);
    if (!rule) throw new Error('that rule is not active');
    if (e.lumpSumId !== undefined && !(await loadLumpSum(tx, e.lumpSumId))) throw new Error('no such lump sum (unknown or reversed)');
    const [row] = await tx.query<{ id: string }>(
      `insert into holding_rule_exceptions (rule_id, month, lump_sum_id, note, as_of, source)
       values ($1, $2, $3, $4, $5, 'owner-web') returning id::text`,
      [e.ruleId, e.month ?? null, e.lumpSumId ?? null, note, now],
    );
    await audit(tx, 'holding_rule_exception', e.ruleId, 'LOGGED', {
      ruleId: e.ruleId, rule: `${ruleLabel(rule)} on ${rule.name}`, month: e.month ?? null, lumpSumId: e.lumpSumId ?? null, note,
      rowId: row!.id, source: 'owner-web',
    });
    return { id: row!.id };
  });
}

/** Rules not reversed and not past their IST until-date, oldest first, with their live exceptions. */
export async function loadActiveHoldingRules(db: Db, now: string): Promise<HoldingRule[]> {
  const rows = await db.query<{
    id: string; instrument_id: string; name: string; kind: RuleKind; until_on: string | null; cap_bps: number | null;
    note: string | null; on: string;
  }>(
    `select r.id::text, r.instrument_id, i.name, r.kind, r.until_on::text, r.cap_bps, r.note, r.occurred_on::text "on"
       from holding_rules r join instruments i on i.id = r.instrument_id
      where not exists (select 1 from log_reversals x where x.entity = 'holding_rule' and x.entity_id = r.id::text)
        and (r.until_on is null or r.until_on >= $1::date)
      order by r.occurred_on, r.as_of`,
    [istDate(now)]);
  const exceptions = await db.query<{ id: string; rule_id: string; month: string | null; lump_sum_id: string | null }>(
    `select e.id::text, e.rule_id::text, e.month, e.lump_sum_id::text from holding_rule_exceptions e
      where e.rule_id::text = any($1::text[])
        and not exists (select 1 from log_reversals x where x.entity = 'holding_rule_exception' and x.entity_id = e.id::text)
      order by e.as_of`,
    [rows.map((r) => r.id)]);
  const out: HoldingRule[] = [];
  for (const r of rows) {
    out.push({
      id: r.id, instrumentId: r.instrument_id, name: r.name, kind: r.kind, untilOn: r.until_on, capBps: r.cap_bps,
      note: r.note ?? '', on: r.on, aliases: await fundAliases(db, r.instrument_id),
      exceptions: exceptions.filter((e) => e.rule_id === r.id).map((e) => ({ id: e.id, month: e.month, lumpSumId: e.lump_sum_id })),
    });
  }
  return out;
}

/**
 * Does any rule refuse this action? Pure. Returns the first breaking rule no exception covers;
 * failing that, the first covered one with `waivedBy` set (callers allow it and record the
 * waiver); null when nothing breaks. A month exception covers only month money (`lumpSumId`
 * null); a lump-sum exception covers only that lump sum.
 */
export function ruleBlock(
  rules: HoldingRule[],
  q: { aliases: string[]; action: 'BUY' | 'SELL'; amountPaise: bigint | null; heldPaise: bigint; portfolioPaise: bigint | null; month: string; lumpSumId: string | null },
): { rule: HoldingRule; reason: string; waivedBy: string | null } | null {
  let waived: { rule: HoldingRule; reason: string; waivedBy: string | null } | null = null;
  for (const rule of rules) {
    if (!sameFund(rule.aliases, q.aliases)) continue;
    const reason = breaks(rule, q);
    if (reason === null) continue;
    const ex = rule.exceptions.find((e) => (q.lumpSumId === null ? e.month === q.month : e.lumpSumId === q.lumpSumId));
    if (!ex) return { rule, reason, waivedBy: null };
    waived ??= { rule, reason, waivedBy: ex.id };
  }
  return waived;
}

function breaks(rule: HoldingRule, q: Parameters<typeof ruleBlock>[1]): string | null {
  const reason = `your ${ruleLabel(rule)} rule on ${rule.name}`;
  if (q.action === 'SELL') return rule.kind === 'HOLD_UNTIL' ? reason : null;
  switch (rule.kind) {
    case 'NO_ADD': return reason;
    case 'NO_REBUY': return q.heldPaise === 0n ? reason : null;
    case 'CAP_PCT':
      if (q.portfolioPaise === null) return `${reason}: cap unknown — portfolio total unknown`;
      return (q.heldPaise + (q.amountPaise ?? 0n)) * 10000n > BigInt(rule.capBps!) * q.portfolioPaise ? reason : null;
    case 'HOLD_UNTIL': return null;
  }
}
