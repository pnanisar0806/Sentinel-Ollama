import type { Db } from '../db/client.js';
import { currentIps } from './ips.js';
import { bucketStatuses } from './buckets.js';
import { formatInr, type Paise } from '../money/paise.js';

export interface Redemption {
  instrumentId: string;
  symbol: string;
  isin: string | null;
  maturityDate: string;
  facePaise: Paise;
  couponDuePaise: Paise | null;
  daysUntil: number;
}

export interface MaturityRouting {
  intent: string;
  action: 'REDEEM→CASH';
  bucket: string;
  ipsClauseRefs: string[];
  thesis: string;
  note: string;
}

export async function listRedemptionsUntil(db: Db, horizonDays: number, referenceDate?: Date): Promise<Redemption[]> {
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

  for (const row of rows) {
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

export async function maturityRoutingRec(
  redemption: Redemption,
  db: Db,
): Promise<MaturityRouting> {
  const ips = await currentIps(db);
  const buckets = await bucketStatuses(db);

  // Per IPS 3.9: "Sammaan Sep-2026 maturity proceeds route to B3 (emergency fund)"
  // Per IPS 3.3: "Debt/EPF/cash: remainder"
  const targetBucket = 'B3';
  const bucket = buckets.find(b => b.id === targetBucket);

  const totalProceeds = (redemption.facePaise + (redemption.couponDuePaise ?? 0n)) as Paise;
  const thesis = `Sammaan Capital bond (ISIN: ${redemption.isin}) matures on ${redemption.maturityDate}. Face value ${formatInr(redemption.facePaise, { compact: true })} + final coupon ${redemption.couponDuePaise ? formatInr(redemption.couponDuePaise, { compact: true }) : '₹0'} = ${formatInr(totalProceeds, { compact: true })} total redemption. Per IPS §3.9, proceeds route to B3 (Emergency fund) — pre-approved standing instruction. Per IPS §3.3, debt/EPF/cash is the remainder bucket.`;

  return {
    intent: `Bond maturity: ${redemption.symbol}`,
    action: 'REDEEM→CASH',
    bucket: targetBucket,
    ipsClauseRefs: ['3.3', '3.9'],
    thesis,
    note: bucket
      ? `B3 target: ${formatInr(bucket.targetPaise!, { compact: true })}; current: ${bucket.balancePaise === null ? 'not yet allocated' : formatInr(bucket.balancePaise, { compact: true })}.`
      : 'B3 bucket not found.',
  };
}