import { loadRedemptions } from './bond-redemptions.js';
import type { Db } from '../db/client.js';
import type { Paise } from '../money/paise.js';

/**
 * Bond redemption events, read straight off `instruments`.
 *
 * Split out of `maturities.ts` on purpose: routing a redemption needs bucket status, and
 * `buckets.ts` re-exports `funded-status`, which no sizing or risk module may reach (the
 * `tests/architecture/no-catch-up.test.ts` firewall). `sell-triggers.ts` needs to know
 * *what matures*, never *how funded the owner is*, so the reader lives apart from the
 * router. `maturities.ts` re-exports both for the reporting surfaces.
 */

export interface Redemption {
  instrumentId: string;
  symbol: string;
  isin: string | null;
  maturityDate: string;
  facePaise: Paise;
  couponDuePaise: Paise | null;
  daysUntil: number;
}

export async function listRedemptionsUntil(
  db: Db,
  horizonDays: number,
  referenceDate?: Date,
): Promise<Redemption[]> {
  const now = referenceDate ?? new Date();
  const horizonDate = new Date(now);
  horizonDate.setDate(horizonDate.getDate() + horizonDays);
  const horizonIso = horizonDate.toISOString().slice(0, 10);

  const rows = await db.query<{
    id: string;
    name: string;
    isin: string | null;
    maturity_date: string | Date | null;
    face_value_paise: string | number | null;
    coupon_rate_bps: string | number | null;
    units: string | number | null;
  }>(
    `select id, name, isin, maturity_date, face_value_paise, coupon_rate_bps, units
     from instruments
     where kind = 'BOND' and maturity_date is not null
       and maturity_date <= $1
     order by maturity_date`,
    [horizonIso],
  );

  const todayIso = now.toISOString().slice(0, 10);
  const redemptions: Redemption[] = [];
  // Paid out already: the digest must stop counting down to it.
  const paid = await loadRedemptions(db);
  const canon = await db.query<{ id: string; canonical_id: string | null }>(
    `select id, canonical_id from instruments where id = any($1::text[])`,
    [rows.map((r) => r.id)],
  );
  const canonicalOf = new Map(canon.map((c) => [c.id, c.canonical_id ?? c.id]));

  for (const row of rows) {
    if (paid.has(canonicalOf.get(row.id) ?? row.id)) continue;
    const maturityDate = row.maturity_date instanceof Date
      ? row.maturity_date.toISOString().slice(0, 10)
      : String(row.maturity_date).slice(0, 10);

    const faceValuePerUnit = row.face_value_paise === null ? null : BigInt(row.face_value_paise.toString());
    const couponRateBps = row.coupon_rate_bps === null ? null : Number(row.coupon_rate_bps);
    const units = row.units === null ? null : Number(row.units);

    let facePaise: Paise | null = null;
    let couponDuePaise: Paise | null = null;

    if (faceValuePerUnit !== null && units !== null && units > 0) {
      facePaise = (faceValuePerUnit * BigInt(Math.floor(units))) as Paise;
      if (couponRateBps !== null) {
        // Annual coupon = total face * coupon_rate_bps / 10000
        couponDuePaise = (facePaise * BigInt(couponRateBps) / 10000n) as Paise;
      }
    }

    const daysUntil = Math.ceil(
      (new Date(maturityDate).getTime() - new Date(todayIso).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (facePaise !== null && daysUntil >= 0 && daysUntil <= horizonDays) {
      redemptions.push({
        instrumentId: row.id,
        symbol: row.name,
        isin: row.isin,
        maturityDate,
        facePaise,
        couponDuePaise,
        daysUntil,
      });
    }
  }

  return redemptions;
}
