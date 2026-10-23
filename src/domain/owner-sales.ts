import type { Db } from '../db/client.js';

/**
 * The one reader of `owner_sales` (spec §3.1), shared by `loadPositions`, the goal tracker
 * and `logSale` so they cannot drift. Quantities are whole millionths as bigint:
 * `holdings.quantity` and `owner_sales.units` are both numeric(20,6).
 */

/** Exact millionths of a numeric(20,6) rendered as text ('78.000000', '2.5'). */
export function toMicro(q: string): bigint {
  const [whole, frac = ''] = q.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
}

/** Millionths back to decimal text, trailing zeros dropped (78000000n → '78', 500000n → '0.5'). */
export function fromMicro(m: bigint): string {
  const sign = m < 0n ? '-' : '';
  const a = m < 0n ? -m : m;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${a / 1_000_000n}${frac ? `.${frac}` : ''}`;
}

export interface LiveSale { instrumentId: string; soldOn: string; microUnits: bigint }

/**
 * Non-reversed sales with units, sold on or before `until` when given. A sale is reversed
 * when its audit row (payload `rowId` = owner_sales.id) has a `log_reversals` row, entity
 * 'owner_sale', keyed by the audit id (src/domain/reversals.ts). A sale without units (an
 * MF redemption logged by amount) cannot reduce a quantity and is not returned.
 */
export async function loadLiveSales(db: Db, until: string | null = null): Promise<LiveSale[]> {
  const rows = await db.query<{ instrument_id: string; sold_on: string; micro: string }>(
    `select s.instrument_id, s.sold_on::text sold_on, (s.units * 1000000)::bigint::text micro from owner_sales s
      where s.units is not null and ($1::date is null or s.sold_on <= $1::date)
        and not exists (select 1 from audit_log a join log_reversals x on x.entity = 'owner_sale' and x.entity_id = a.id::text
                         where a.entity = 'owner_sale' and a.payload->>'rowId' = s.id::text)`,
    [until]);
  return rows.map((r) => ({ instrumentId: r.instrument_id, soldOn: r.sold_on, microUnits: BigInt(r.micro) }));
}

/**
 * A manual-seed holding row after the owner's logged sales: `qty` is the row's quantity,
 * `held` what remains after the sales dated on or after `since` (the row's as_of, IST date;
 * an earlier sale is already in the seed). Only manual-seed rows are adjusted: a synced
 * feed is the truth for its own holdings.
 */
export function heldAfterSales(
  sales: readonly LiveSale[], row: { instrumentId: string; quantity: string; since: string },
): { qty: bigint; held: bigint } {
  const qty = toMicro(row.quantity);
  const sold = sales.filter((s) => s.instrumentId === row.instrumentId && s.soldOn >= row.since)
    .reduce((n, s) => n + s.microUnits, 0n);
  return { qty, held: qty - sold };
}
