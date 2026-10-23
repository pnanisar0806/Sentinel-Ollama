import type { Db } from '../db/client.js';

/**
 * The one reader of bucket balances (spec §7.1). Sizing, the cash ceiling, the bucket
 * page and the goal tracker all go through it, so a reversal is seen everywhere.
 *
 * Reads `bucket_flows` and `log_reversals` only. It must not import goal status: sizing
 * and rails import this module, and the no-catch-up firewall forbids them reaching it.
 */
const LIVE = `from bucket_flows f
  where not exists (select 1 from log_reversals r where r.entity = 'bucket_flow' and r.entity_id = f.id::text)`;

/** Sum of non-reversed flows per bucket. A bucket with no rows is absent, not 0. */
export async function loadBucketBalances(db: Db): Promise<Map<string, bigint>> {
  const rows = await db.query<{ bucket_id: string; n: string }>(
    `select f.bucket_id, sum(f.amount_paise)::text as n ${LIVE} group by f.bucket_id`);
  return new Map(rows.map((r) => [r.bucket_id, BigInt(r.n)]));
}

/** Open Planned-spending pots: SP labels whose non-reversed balance is above zero. */
export async function loadSpLabels(db: Db): Promise<{ label: string; balancePaise: bigint }[]> {
  const rows = await db.query<{ label: string; n: string }>(
    `select f.label, sum(f.amount_paise)::text as n ${LIVE} and f.bucket_id = 'SP' and f.label is not null
      group by f.label having sum(f.amount_paise) > 0 order by f.label`);
  return rows.map((r) => ({ label: r.label, balancePaise: BigInt(r.n) }));
}

/**
 * Bank cash not set aside: CASH-class positions less B3 and SP, which are bank cash too.
 * Null when no CASH position is known. Shared by sizing and earmarks so they cannot drift.
 */
export function idleBankCash(positions: readonly { assetClass: string; valuePaise: bigint }[], balances: Map<string, bigint>): bigint | null {
  const cash = positions.filter((p) => p.assetClass === 'CASH');
  if (cash.length === 0) return null;
  return cash.reduce((s, p) => s + p.valuePaise, 0n) - (balances.get('B3') ?? 0n) - (balances.get('SP') ?? 0n);
}
