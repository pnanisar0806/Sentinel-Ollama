import type { Db } from '../db/client.js';
import { auditPayload } from './owner-sales.js';
import { formatInr, type Paise } from '../money/paise.js';

/**
 * Correcting a mistaken owner entry (spec §3.4): a `log_reversals` row, never an edit.
 *
 * Keys: a single row (purchase, SIP payment, goal move, SIP move) keys on its table id; a group
 * (earmark, spend, sale) keys on its owner audit row id, whose payload `rowIds` lists the
 * group's flows. A group writes its key plus one `bucket_flow` reversal per flow, so the
 * balance reader sees them. Only entries whose audit payload carries `rowId`/`rowIds` —
 * those written since batch A — can be reversed.
 */
export const REVERSAL_ENTITIES = ['bucket_flow', 'owner_purchase', 'owner_sip_payment', 'owner_sale', 'earmark', 'spend', 'sip_move'] as const;
export type ReversalEntity = typeof REVERSAL_ENTITIES[number];

const TABLES: Partial<Record<ReversalEntity, string>> = {
  bucket_flow: 'bucket_flows', owner_purchase: 'owner_purchases', owner_sip_payment: 'owner_sip_payments', owner_sale: 'owner_sales',
  sip_move: 'sip_moves',
};
export const GROUPS: ReadonlySet<ReversalEntity> = new Set(['earmark', 'spend', 'owner_sale']);

export async function isReversed(db: Db, entity: ReversalEntity, entityId: string): Promise<boolean> {
  return (await db.query(`select 1 from log_reversals where entity = $1 and entity_id = $2`, [entity, entityId])).length > 0;
}

export async function reverseEntry(
  db: Db, r: { entity: ReversalEntity; entityId: string; reason: string }, now: string,
): Promise<void> {
  const { entity, entityId } = r;
  const reason = r.reason.trim();
  if (reason === '') throw new Error('a reversal needs a reason');
  if (reason.length > 500) throw new Error('a reason is limited to 500 characters');
  if (!Number.isFinite(Date.parse(now))) throw new Error('a valid as_of timestamp is required');
  const group = GROUPS.has(entity);

  await db.withTransaction(async (tx) => {
    if (await isReversed(tx, entity, entityId)) throw new Error('this entry is already reversed');
    const [a] = await tx.query<{ payload: unknown }>(
      group
        ? `select payload from audit_log where actor = 'owner' and entity = $1 and id::text = $2 and jsonb_typeof(${auditPayload('audit_log')}->'rowIds') = 'array'`
        : `select payload from audit_log where actor = 'owner' and entity = $1 and ${auditPayload('audit_log')}->>'rowId' = $2`,
      [entity, entityId]);
    if (!a) throw new Error(`not a reversible owner entry: ${entity} ${entityId}`);
    const p = (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload) as { rowId?: unknown; rowIds?: unknown };
    const rowIds = group ? (p.rowIds as unknown[]).map(String) : [];

    // Every row the entry wrote must be the owner's: a sale's own row, then its flows.
    const own: [string, string][] = group ? rowIds.map((id) => ['bucket_flows', id]) : [[TABLES[entity]!, entityId]];
    if (group && p.rowId != null && TABLES[entity]) own.push([TABLES[entity]!, String(p.rowId)]);
    for (const [table, id] of own) {
      const [row] = await tx.query<{ source: string }>(`select source from ${table} where id::text = $1`, [id]);
      if (!row) throw new Error(`no ${table} row ${id}`);
      if (!row.source.startsWith('owner-')) throw new Error(`only owner-entered rows can be reversed; this one is ${row.source}`);
    }

    // No balance may go below zero (spec §7.4): per bucket, and per label on SP (every SP row has one).
    const flowIds = entity === 'bucket_flow' ? [entityId] : rowIds;
    if (flowIds.length) {
      const hits = await tx.query<{ bucket_id: string; label: string | null; delta: string }>(
        `select bucket_id, label, (-sum(amount_paise))::text delta from bucket_flows where id::text = any($1::text[]) group by bucket_id, label`,
        [flowIds]);
      await tx.query(`select id from buckets where id = any($1::text[]) for update`, [hits.map((h) => h.bucket_id)]);
      const live = `from bucket_flows f where f.bucket_id = $1 and ($2::text is null or f.label = $2)
        and not exists (select 1 from log_reversals x where x.entity = 'bucket_flow' and x.entity_id = f.id::text)`;
      for (const h of hits) {
        const delta = BigInt(h.delta);
        if (delta >= 0n) continue;
        const [bal] = await tx.query<{ n: string }>(`select coalesce(sum(f.amount_paise), 0)::text n ${live}`, [h.bucket_id, h.label]);
        if (BigInt(bal!.n) + delta >= 0n) continue;
        const [last] = await tx.query<{ occurred_on: string; amount_paise: string; note: string; kind: string }>(
          `select f.occurred_on::text, f.amount_paise::text, f.note, f.kind ${live} and f.amount_paise < 0 and f.id::text <> all($3::text[])
            order by f.occurred_on desc, f.as_of desc limit 1`,
          [h.bucket_id, h.label, flowIds]);
        const where = h.label ? `${h.bucket_id} (${h.label})` : h.bucket_id;
        // Only an outflow can be what must go first; the new balance is the sum of live flows
        // outside the set, so when it is below zero one of them is negative and `last` exists.
        throw new Error(`reversing this would take ${where} below zero; reverse the ${formatInr(abs(BigInt(last!.amount_paise)))} ${last!.note || last!.kind} on ${last!.occurred_on} first`);
      }
    }

    const keys: [ReversalEntity, string][] = [[entity, entityId], ...rowIds.map((id): [ReversalEntity, string] => ['bucket_flow', id])];
    for (const [e, id] of keys) {
      await tx.query(`insert into log_reversals (entity, entity_id, reason, as_of, source) values ($1, $2, $3, $4, 'owner-web')`,
        [e, id, reason, now]);
    }
    await tx.query(`insert into audit_log (entity, entity_id, action, actor, payload) values ('reversal', $1, 'REVERSED', 'owner', $2::jsonb)`,
      [`${entity}:${entityId}`, { entity, entityId, reason, rowIds }]);
  });
}

const abs = (n: bigint): Paise => (n < 0n ? -n : n) as Paise;
