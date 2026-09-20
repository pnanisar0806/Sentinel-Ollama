import { rupees, type Paise } from '../money/paise.js';
import type { McpClient } from './mcp-client.js';

/**
 * Daily balance capture for the realised-surplus derivation.
 *
 * `surplus.ts` models surplus as take-home minus five fixed outflows and therefore cannot
 * see credit-card spend. Realised surplus is instead derivable from balance deltas:
 *
 *     realised surplus = d(savings) + d(invested cost) + loan principal repaid
 *                        - d(card outstanding)
 *
 * Card payments cancel out of that derivation, so the three different card billing dates
 * never have to be aligned and nothing can be counted twice.
 *
 * Two calls: `networth_snapshot` for invested cost, card dues and loan balances, and
 * `networth_holdings('SA')` for savings PER BANK. The snapshot's own `SA` row is an
 * aggregate across banks, and an aggregate cannot distinguish the operating account from
 * the rest — see `OPERATING_SAVINGS_BANK`. Two calls cost 3 against a 15-per-minute
 * budget, which is affordable once a day.
 */

export type BalanceKind = 'savings' | 'credit_card' | 'invested_cost' | 'loan';

export interface BalanceRow {
  kind: BalanceKind;
  /** Bank, card name, asset type or lender — scopes the amount within its kind. */
  label: string;
  /** Cards and loans are POSITIVE amounts owed, never negative assets. */
  amountPaise: Paise;
}

/** The `networth_snapshot` shape, from a real capture on 2026-09-20. */
interface SnapshotPayload {
  investments?: { asset_type?: string; invested_value?: number; current_value?: number }[];
  liabilities?: {
    credit_cards?: { name?: string; total_due?: number }[];
    loans?: { lender?: string; loan_type?: string; current_balance?: number }[];
  };
  error?: string;
  message?: string;
}

/** `networth_holdings('SA')` — one row per bank. */
interface SavingsPayload {
  holdings?: { investment?: string; market_value?: number }[];
  error?: string;
  message?: string;
  holding_error?: boolean;
}

/**
 * HDFC is where salary lands, investments are funded and card bills are paid. SBI is not
 * idle: the housing-loan EMI is debited from it, and ₹1L moves HDFC->SBI once a year for
 * an LIC premium.
 *
 * **The savings term therefore sums EVERY account, not just the operating one.** Watching
 * HDFC alone would read each HDFC->SBI transfer as spending — money gone from the only
 * balance being watched, reappearing nowhere — and the housing EMI would be double
 * counted, once as the phantom spend of the transfer and again in the loan term. Summing
 * both makes a transfer net to zero and lets the EMI resolve correctly: its principal
 * lands in the loan term and only its interest survives as real cost.
 *
 * Kept as a named constant because which account is operating still matters for
 * diagnosis — a salary credit is a jump in THIS balance, not in the total.
 */
export const OPERATING_SAVINGS_BANK = 'HDFC Bank';

/**
 * The annual ₹1L LIC premium is a known distortion, not a bug to be quietly netted out.
 * INDmoney does not serve INSURANCE, so the policy's value is invisible: the premium
 * leaves savings and reappears in no tracked asset, and one month a year will therefore
 * read ₹1L lighter than it really was. Surfaced on the derived row rather than corrected
 * by an invented adjustment.
 */
export const LIC_PREMIUM_FLAG =
  'an annual ~₹1L LIC premium leaves savings for an asset INDmoney does not track ' +
  '(INSURANCE is unserved), so the month it falls in understates realised surplus';

/** INDmoney sends rupees as JS floats. Money never crosses a float boundary here: the
 *  value goes through a fixed-2 string exactly as the holdings path already does. */
function toPaise(rupeeValue: number): Paise {
  return rupees(rupeeValue.toFixed(2));
}

/**
 * A savings balance is cash, not an investment, so it is recorded under `savings` and
 * excluded from `invested_cost` — double-counting it would inflate realised surplus by
 * the whole cash balance every month.
 */
const SAVINGS_ASSET_TYPES = new Set(['SA']);

/** Carried at market value, not cost, so they cannot join the invested-cost delta. */
const NOT_INVESTED_COST = new Set(['CRYPTO', 'US_STOCK_WALLET']);

export function parseBalanceSnapshot(
  payload: SnapshotPayload,
  savings: SavingsPayload,
): BalanceRow[] {
  // A throttled or refused call answers successfully with an error body. Reading that as
  // "no balances" would record a day of zeros into an append-only table.
  if (payload.error) {
    throw new Error(
      `INDmoney refused networth_snapshot: ${payload.error} — ${payload.message ?? '(no message)'}`,
    );
  }
  if (!Array.isArray(payload.investments)) {
    throw new Error(
      'could not parse INDmoney networth_snapshot — no investments array; the tool ' +
      'contract changed, recapture the fixture before trusting this snapshot',
    );
  }

  const rows: BalanceRow[] = [];

  for (const inv of payload.investments) {
    const assetType = inv.asset_type;
    if (typeof assetType !== 'string' || assetType === '') continue;

    // Savings comes from networth_holdings('SA') below, per bank. The aggregate here
    // would collapse the banks into one row and make the operating account unreadable.
    if (SAVINGS_ASSET_TYPES.has(assetType)) continue;
    if (NOT_INVESTED_COST.has(assetType)) continue;

    // `invested_value` is CUMULATIVE COST, so its month-on-month delta is money actually
    // deployed. `current_value` would fold in market movement and read a rally as saving.
    if (typeof inv.invested_value === 'number') {
      rows.push({
        kind: 'invested_cost',
        label: assetType,
        amountPaise: toPaise(inv.invested_value),
      });
    }
  }

  if (savings.error) {
    throw new Error(
      `INDmoney refused networth_holdings('SA'): ${savings.error} — ${savings.message ?? '(no message)'}`,
    );
  }
  if (savings.holding_error) {
    throw new Error("INDmoney reported holding_error for SA; refusing to record a partial cash position");
  }
  if (!Array.isArray(savings.holdings)) {
    throw new Error(
      "could not parse INDmoney networth_holdings('SA') — the tool contract changed; " +
      'recapture the fixture before trusting this snapshot',
    );
  }
  for (const bank of savings.holdings) {
    if (typeof bank.market_value !== 'number' || typeof bank.investment !== 'string') continue;
    rows.push({ kind: 'savings', label: bank.investment, amountPaise: toPaise(bank.market_value) });
  }

  for (const card of payload.liabilities?.credit_cards ?? []) {
    if (typeof card.total_due !== 'number' || typeof card.name !== 'string') continue;
    rows.push({ kind: 'credit_card', label: card.name, amountPaise: toPaise(card.total_due) });
  }

  // The owner holds TWO State Bank of India HOUSING LOANs, so lender+type is not unique
  // and the label is the snapshot table's uniqueness key within a day — a collision would
  // silently drop one loan through `on conflict do nothing`, in an append-only table where
  // the loss is unrecoverable. Disambiguate by balance rank, descending.
  //
  // ponytail: rank-by-balance is stable only while two same-label loans do not cross in
  // size. That is safe for the live pair (₹28.9L against ₹53.8K) and would need a real
  // account identifier if INDmoney ever exposes one.
  const loans = (payload.liabilities?.loans ?? []).filter(
    (l) => typeof l.current_balance === 'number' && typeof l.lender === 'string',
  );
  const labelCounts = new Map<string, number>();
  for (const loan of loans) {
    const base = `${loan.lender} ${loan.loan_type ?? 'LOAN'}`;
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const loan of [...loans].sort((a, b) => b.current_balance! - a.current_balance!)) {
    const base = `${loan.lender} ${loan.loan_type ?? 'LOAN'}`;
    const label = (labelCounts.get(base) ?? 0) > 1
      ? `${base} #${(seen.set(base, (seen.get(base) ?? 0) + 1), seen.get(base))}`
      : base;
    rows.push({ kind: 'loan', label, amountPaise: toPaise(loan.current_balance!) });
  }

  if (rows.length === 0) {
    throw new Error(
      'INDmoney networth_snapshot yielded no balances at all — refusing to record an ' +
      'empty day into an append-only table',
    );
  }
  return rows;
}

export async function fetchBalanceSnapshot(client: McpClient): Promise<BalanceRow[]> {
  const snapshot = await client.callTool<{ result?: string }>('networth_snapshot', {});
  if (typeof snapshot?.result !== 'string') {
    throw new Error(
      'could not parse INDmoney networth_snapshot payload — the tool contract changed; ' +
      'recapture the fixture before trusting this snapshot',
    );
  }
  const savings = await client.callTool<{ result?: string }>(
    'networth_holdings', { asset_type: 'SA' },
  );
  if (typeof savings?.result !== 'string') {
    throw new Error(
      "could not parse INDmoney networth_holdings('SA') payload — the tool contract " +
      'changed; recapture the fixture before trusting this snapshot',
    );
  }
  return parseBalanceSnapshot(
    JSON.parse(snapshot.result) as SnapshotPayload,
    JSON.parse(savings.result) as SavingsPayload,
  );
}
