import type { Db } from '../db/client.js';

/**
 * FR-12's repeat-buy hold, shared by the recommendation gate and the order gate (rails).
 * Imports nothing from the recommendation path, which the advisor may not reach.
 */
export const MIN_HOLD_MONTHS = 12;

/**
 * Owner amendment to FR-12, 2026-10-27: a fund top-up (MF, ETF or gold) is exempt from the hold;
 * a stock is not. The instrument's own kind decides, so a stock is never exempt whatever the
 * recommendation is labelled; the 'rebalance' kind keeps a fund switch (mf_switch) under it.
 */
export async function isFundTopUp(db: Db, recKind: string, instrumentId: string): Promise<boolean> {
  if (recKind !== 'rebalance') return false;
  const [row] = await db.query<{ kind: string }>(`select kind from instruments where id = $1`, [instrumentId]);
  return row?.kind === 'MF' || row?.kind === 'ETF' || row?.kind === 'GOLD';
}

/** The latest non-suppressed recommendation whose primary is a BUY of `instrumentId`. */
export async function lastRecommendedOn(db: Db, instrumentId: string): Promise<string | null> {
  const [prior] = await db.query<{ created_on: string | Date }>(
    `select created_on from recommendations
      where suppressed = false
        and (primary_rec::jsonb)->>'instrumentId' = $1
        and (primary_rec::jsonb)->>'action' = 'BUY'
      order by created_on desc limit 1`,
    [instrumentId],
  );
  if (prior === undefined) return null;
  return prior.created_on instanceof Date ? prior.created_on.toISOString().slice(0, 10) : String(prior.created_on).slice(0, 10);
}

export function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth()) -
    (b.getUTCDate() < a.getUTCDate() ? 1 : 0)
  );
}
