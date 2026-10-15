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
};

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
