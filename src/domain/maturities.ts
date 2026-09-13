import type { Db } from '../db/client.js';
import { currentIps } from './ips.js';
import { bucketStatuses } from './buckets.js';
import { formatInr, type Paise } from '../money/paise.js';
import { listRedemptionsUntil, type Redemption } from './redemptions.js';

/**
 * Maturity ROUTING. The redemption reader lives in `redemptions.ts` because routing needs
 * `buckets.ts`, which re-exports `funded-status` — off limits to any sizing or risk module
 * (see the no-catch-up architecture test). Re-exported here so reporting surfaces have one
 * import for the maturity story.
 */
export { listRedemptionsUntil, type Redemption };

export interface MaturityRouting {
  intent: string;
  action: 'REDEEM→CASH';
  bucket: string;
  ipsClauseRefs: string[];
  thesis: string;
  note: string;
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