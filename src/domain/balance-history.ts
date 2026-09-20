import type { Db } from '../db/client.js';
import type { BalanceRow } from '../sources/balances.js';

/**
 * Persistence for the daily balance series that the realised-surplus derivation reads.
 *
 * The derivation itself (surplus = d(savings) + d(invested cost) + loan principal repaid
 * - d(card outstanding)) lands here too once there is a series to derive from. Nothing
 * can be backfilled — INDmoney serves only today — so capture comes first and the
 * arithmetic follows once the table has months in it.
 */

/**
 * Writes one day's balances. Returns how many rows were new.
 *
 * `on conflict do nothing` against `(as_of, kind, label)` makes a same-day re-run a
 * no-op rather than a double count, which matters because `balance_snapshots` is
 * append-only: a duplicate could not be deleted afterwards. The daily job may well run
 * twice on a retry, exactly as the weekly report now guards against.
 */
export async function persistBalanceSnapshot(
  db: Db,
  asOf: string,
  rows: readonly BalanceRow[],
  source: string,
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const returned = await db.query<{ id: string }>(
      `insert into balance_snapshots (as_of, source, kind, label, amount_paise)
       values ($1, $2, $3, $4, $5)
       on conflict (as_of, kind, label) do nothing
       returning id`,
      [asOf, source, row.kind, row.label, row.amountPaise.toString()],
    );
    if (returned.length > 0) inserted += 1;
  }
  return inserted;
}

export interface BalanceDay {
  asOf: string;
  /** Every savings account summed. A transfer between two of them nets to zero here,
   *  which is the whole reason the operating account is not read on its own. */
  savingsPaise: bigint;
  investedCostPaise: bigint;
  cardOutstandingPaise: bigint;
  loanBalancePaise: bigint;
}

/** Collapses the per-account rows into one row per day, oldest first. */
export async function loadBalanceDays(db: Db, sinceIso: string): Promise<BalanceDay[]> {
  const rows = await db.query<{
    as_of: string | Date; kind: string; total: string;
  }>(
    `select as_of, kind, sum(amount_paise)::text as total
       from balance_snapshots where as_of >= $1
      group by as_of, kind order by as_of`,
    [sinceIso],
  );

  const byDay = new Map<string, BalanceDay>();
  for (const r of rows) {
    const asOf = r.as_of instanceof Date ? r.as_of.toISOString().slice(0, 10) : String(r.as_of);
    const day = byDay.get(asOf) ?? {
      asOf,
      savingsPaise: 0n,
      investedCostPaise: 0n,
      cardOutstandingPaise: 0n,
      loanBalancePaise: 0n,
    };
    const total = BigInt(r.total);
    if (r.kind === 'savings') day.savingsPaise = total;
    else if (r.kind === 'invested_cost') day.investedCostPaise = total;
    else if (r.kind === 'credit_card') day.cardOutstandingPaise = total;
    else if (r.kind === 'loan') day.loanBalancePaise = total;
    byDay.set(asOf, day);
  }
  return [...byDay.values()];
}
