import type { Db } from '../db/client.js';

/**
 * A bond that has actually paid out, as the owner confirms it.
 *
 * Sammaan Capital 9% 26-Sep-2026 was credited to the owner's bank on 2026-09-24, while
 * INDmoney — which lags the depository — still listed the bond at ₹2,99,670. Until the
 * feed caught up, three things were wrong at once: the next daily run would draft a
 * REDEEM approval for money already received, the digest kept announcing the maturity,
 * and net worth counted the same ₹3L twice, once as the bond and once in the bank.
 *
 * The record keys on the instrument's `canonical_id`, because one bond appears under
 * several ids: the seed `BOND:SAMMAAN-2026`, the live `ISIN:INE148I07GL3` and the
 * exchange `BSE:9SCL26BA` all resolve to `ISIN:INE148I07GL3`.
 *
 * Append-only, in `audit_log`: a redemption is a fact that happened on a date.
 */
export interface RedemptionRecord {
  canonicalId: string;
  receivedOn: string;
  /** What reached the bank. NULL until the owner states it — never assumed. */
  amountPaise: bigint | null;
}

async function canonicalOf(db: Db, instrumentId: string): Promise<string> {
  const [row] = await db.query<{ canonical_id: string | null }>(
    `select canonical_id from instruments where id = $1`, [instrumentId],
  );
  return row?.canonical_id ?? instrumentId;
}

/** Idempotent: a second confirmation of the same bond writes nothing. */
export async function recordRedemption(
  db: Db,
  instrumentId: string,
  opts: { receivedOn: string; amountPaise: bigint | null; note?: string },
): Promise<boolean> {
  const canonicalId = await canonicalOf(db, instrumentId);
  if ((await loadRedemptions(db)).has(canonicalId)) return false;
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('bond_redemption', $1, 'REDEEMED', 'owner', $2::jsonb)`,
    [canonicalId, JSON.stringify({
      canonicalId, instrumentId, receivedOn: opts.receivedOn,
      amountPaise: opts.amountPaise === null ? null : opts.amountPaise.toString(),
      note: opts.note ?? '',
    })],
  );
  return true;
}

/**
 * States what actually reached the bank, for a redemption already recorded.
 *
 * A second event rather than an edit: `audit_log` is append-only, and "the owner said
 * it was credited" and "the owner said how much" are two facts on two occasions. For
 * Sammaan 2026 the owner reported ₹3,24,300 against a modelled ₹3,27,000; the ₹2,700
 * gap is exactly 10% TDS on the ₹27,000 final coupon.
 */
export async function stateRedemptionAmount(
  db: Db, instrumentId: string, amountPaise: bigint, note = '',
): Promise<void> {
  if (amountPaise <= 0n) throw new Error('a redemption amount must be positive');
  const canonicalId = await canonicalOf(db, instrumentId);
  if (!(await loadRedemptions(db)).has(canonicalId)) {
    throw new Error(`no redemption recorded for ${instrumentId}; record it first`);
  }
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('bond_redemption', $1, 'AMOUNT_STATED', 'owner', $2::jsonb)`,
    [canonicalId, JSON.stringify({ canonicalId, amountPaise: amountPaise.toString(), note })],
  );
}

/** Every confirmed redemption, by canonical id. A later stated amount wins. */
export async function loadRedemptions(db: Db): Promise<Map<string, RedemptionRecord>> {
  const rows = await db.query<{ entity_id: string; action: string; payload: unknown }>(
    `select entity_id, action, payload from audit_log
      where entity = 'bond_redemption' and action in ('REDEEMED', 'AMOUNT_STATED')
      order by at, id`,
  );
  const out = new Map<string, RedemptionRecord>();
  for (const r of rows) {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as
      { receivedOn?: string; amountPaise: string | null };
    const amount = p.amountPaise === null ? null : BigInt(p.amountPaise);
    if (r.action === 'REDEEMED') {
      out.set(r.entity_id, { canonicalId: r.entity_id, receivedOn: p.receivedOn!, amountPaise: amount });
    } else {
      const known = out.get(r.entity_id);
      if (known) known.amountPaise = amount;
    }
  }
  return out;
}

/** The redemption for this instrument, whichever of its ids is asked about. */
export async function redemptionFor(db: Db, instrumentId: string): Promise<RedemptionRecord | null> {
  return (await loadRedemptions(db)).get(await canonicalOf(db, instrumentId)) ?? null;
}
