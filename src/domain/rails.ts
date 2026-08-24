import type { Db } from '../db/client.js';
import type { Paise } from '../money/paise.js';
import type { AssetClass } from './networth.js';

/**
 * rails.ts — the owner's OWN allocation rules, kept deliberately apart from the IPS.
 *
 * PRD §3.3 states only two allocation rails: an equity ceiling (~60%) and a gold band
 * (5–10%). Debt and cash are "the remainder" — an identity, not a band. Anything else
 * the owner wants enforced is his rule, not policy, and the distinction matters because
 * the PRD's own preamble binds the agent to "cite the IPS clause(s) it serves": a breach
 * of an invented band can cite nothing.
 *
 * These live in `settings_rails`, which already carries `pending_value` / `pending_since`
 * for the §11 48-hour cooling-off, so changing one is a deliberate, auditable act.
 */

/** Seeded on first run. A rail absent from the table simply is not enforced. */
export const DEFAULT_OWNER_RAILS: Record<string, number> = {
  // Idle cash is the thing the owner actually wants flagged — bond maturities land as
  // cash (Sammaan redeems 26-Sep-2026) and it can sit there unnoticed.
  'cash.ceiling': 0.20,
};

export interface OwnerRail {
  key: string;
  value: number;
}

export interface RailBreach {
  key: string;
  actual: number;
  limit: number;
  message: string;
}

export async function loadOwnerRails(db: Db): Promise<OwnerRail[]> {
  const rows = await db.query<{ key: string; value: unknown }>(
    'select key, value from settings_rails order by key',
  );
  return rows
    .map((r) => ({ key: r.key, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

/** Which asset class each rail measures, and in which direction. */
const RAIL_TARGETS: Record<string, { assetClass: AssetClass; direction: 'max' | 'min' }> = {
  'cash.ceiling': { assetClass: 'CASH', direction: 'max' },
};

/**
 * Evaluates owner rails against the current allocation.
 *
 * Deliberately separate from `allocationDrift`: an owner rail must never be reported
 * as an IPS breach, because the owner is entitled to change it and the IPS he is held
 * to at a −20% drawdown is not.
 */
export function evaluateRails(
  rails: OwnerRail[],
  byAssetClass: Map<AssetClass, Paise>,
  totalPaise: Paise,
): RailBreach[] {
  if (totalPaise <= 0n) return [];

  const breaches: RailBreach[] = [];
  for (const rail of rails) {
    const target = RAIL_TARGETS[rail.key];
    if (!target) continue; // a rail nothing knows how to measure is inert, not an error

    const held = byAssetClass.get(target.assetClass) ?? (0n as Paise);
    const actual = Number(held) / Number(totalPaise);
    const over = target.direction === 'max' ? actual > rail.value : actual < rail.value;
    if (!over) continue;

    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    breaches.push({
      key: rail.key,
      actual,
      limit: rail.value,
      message:
        `${target.assetClass} ${pct(actual)} is ${target.direction === 'max' ? 'above' : 'below'} ` +
        `your ${pct(rail.value)} ${target.direction === 'max' ? 'ceiling' : 'floor'} ` +
        `(owner rail, not an IPS clause)`,
    });
  }
  return breaches;
}
