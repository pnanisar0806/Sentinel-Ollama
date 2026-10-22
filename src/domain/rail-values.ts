/**
 * Rail values and their defaults. A leaf: imports only the `Db` type, so `sips.ts` can
 * read rails and `rails.ts` can read the SIP envelope without an import cycle.
 */
import type { Db } from '../db/client.js';

/** Default owner rails seeded by `seed.ts`. Idempotent — existing values are preserved. */
export const DEFAULT_OWNER_RAILS: Record<string, unknown> = {
  cash_ceiling_pct: 10,
  tactical_monthly_paise: 50_00_000,
  monthly_budget_paise: 50_00_000, // owner deployment budget incl. SIPs (2026-10-13); raised yearly via /cleanup
  max_order_paise: 100_00_000,
  single_stock_cap_pct: 10,
  employer_cap_pct: 25,
  mf_scheme_cap_pct: 10,
  sector_cap_pct: 20,
  issuer_cap_pct: 15,
  // Goal-plan spec §9/§11.2: the owner-signed equity share of new money for the rebalance.
  // 60 is IPS §3.3's ceiling and the revoke value; a raise is a loosening (controls.ts).
  goal_equity_ceiling_pct: 60,
  // Brief 2026-10-22: budget reserved for house (B2) and emergency (B3) set-asides. The free
  // envelope subtracts it, so a raise is a TIGHTENING (controls.ts) and 0 ends it.
  goal_setaside_monthly_paise: 0,
};

/**
 * Rails whose pending change holds the month's advisor run (`loadBudgetMonth`), the budget
 * editor's "keep" button and the goal plan's raise buttons (`pendingBlocks`), with the name
 * each notice uses. The set-aside belongs here: the free envelope subtracts it. Key order is
 * precedence when several are pending. One list, so those surfaces cannot drift.
 */
export const BUDGET_RAIL_NAMES: Record<string, string> = {
  monthly_budget_paise: 'budget', tactical_monthly_paise: 'tactical cap', goal_setaside_monthly_paise: 'goal set-aside',
};
export const pendingBudgetRail = <T extends { key: string }>(pending: readonly T[]): T | undefined =>
  Object.keys(BUDGET_RAIL_NAMES).map((k) => pending.find((c) => c.key === k)).find((c) => c !== undefined);

/** The goal ceiling is a whole percent from IPS §3.3's 60 to 92 (gold keeps its 7.5% band middle). */
export const validGoalCeilingPct = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 60 && v <= 92;

/**
 * A rail the owner can change lives in `settings_rails` (PRD 11), with
 * DEFAULT_OWNER_RAILS as the fallback when the row is absent. `checkRails` used to
 * compare against `100_00_000n` and `50_00_000n` written into the function, so editing
 * either rail in `settings_rails` changed nothing — the same split `checkCashCeiling`
 * already avoids.
 */
export async function railPaise(db: Db, key: string): Promise<bigint> {
  const [row] = await db.query<{ value: number | string }>(
    `select value from settings_rails where key = $1`,
    [key],
  );
  const raw = Number(row ? row.value : DEFAULT_OWNER_RAILS[key]);
  if (!Number.isFinite(raw)) throw new Error(`rail ${key} is not a number`);
  return BigInt(Math.trunc(raw));
}
