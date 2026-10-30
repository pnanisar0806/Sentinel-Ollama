import type { Db } from '../db/client.js';
import { liveLumpSql, ORDER_PAISE_SQL, orderHeldSql, RELEASED_STATUSES } from './sips.js';

/**
 * A lump sum received (batch B spec §3): money the owner wants invested on top of the month,
 * e.g. ₹20,691 of bond interest. Purchases (`owner_purchases.lump_sum_id`) and BUY orders on a
 * recommendation carrying `lump_sum_id` spend it; that spending is not the month's
 * (`loadMonthSpend`). Reversing the lump sum returns its purchases and orders to their months.
 * Logged by `logLumpSum` (owner-log.ts), with the other /log entries.
 */
export interface LumpSum {
  id: string; receivedOn: string; amountPaise: bigint; from: string; note: string | null;
  spentPaise: bigint; remainingPaise: bigint;
}

/** Every lump sum not reversed, with what its linked purchases and held orders spent; oldest first. */
async function loadLive(db: Db, id?: string): Promise<LumpSum[]> {
  const rows = await db.query<{ id: string; received_on: string; amount_paise: string; from_text: string; note: string | null; spent: string }>(
    `select l.id::text, l.received_on::text, l.amount_paise::text, l.from_text, l.note,
            (coalesce((select sum(p.amount_paise) from owner_purchases p
                        where p.lump_sum_id = l.id
                          and not exists (select 1 from log_reversals r where r.entity = 'owner_purchase' and r.entity_id = p.id::text)), 0)
           + coalesce((select sum(${ORDER_PAISE_SQL}) from order_intents o join recommendations rec on rec.id = o.recommendation_id
                        where rec.lump_sum_id = l.id and o.intent = 'BUY' and ${orderHeldSql(1)}), 0))::bigint::text spent
       from lump_sums l
      where ${liveLumpSql('l.id')} and ($2::text is null or l.id::text = $2)
      order by l.received_on, l.as_of`,
    [RELEASED_STATUSES, id ?? null]);
  return rows.map((r) => {
    const amountPaise = BigInt(r.amount_paise);
    const spentPaise = BigInt(r.spent);
    return { id: r.id, receivedOn: r.received_on, amountPaise, from: r.from_text, note: r.note, spentPaise, remainingPaise: amountPaise - spentPaise };
  });
}

/** Lump sums not reversed with money left, oldest first. */
export async function loadOpenLumpSums(db: Db): Promise<LumpSum[]> {
  return (await loadLive(db)).filter((l) => l.remainingPaise > 0n);
}

/** One lump sum; null if missing or reversed. */
export async function loadLumpSum(db: Db, id: string): Promise<LumpSum | null> {
  return (await loadLive(db, id))[0] ?? null;
}

/** What is left over every open lump sum, optionally leaving one out. */
export async function openLumpSumPaise(db: Db, exceptId?: string): Promise<bigint> {
  return (await loadOpenLumpSums(db)).filter((l) => l.id !== exceptId).reduce((s, l) => s + l.remainingPaise, 0n);
}
