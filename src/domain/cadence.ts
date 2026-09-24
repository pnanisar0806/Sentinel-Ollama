import type { Db } from '../db/client.js';

/**
 * How often the advisor proposes buying or selling: ONCE A MONTH.
 *
 * Owner decision, 2026-09-24: "the advisor will not tell me every day something to buy
 * or sell right? that will be bad. weekly once is fine but monthly once is better."
 *
 * Before this, the weekly report generated rebalance and satellite recommendations every
 * Sunday and the cleanup job tried every day. FR-12 capped the result at four a month,
 * but a cap is not a cadence: the four could arrive on four different days, each as its
 * own approval request. The advisor invests for the long term, and a quiet month is a
 * good month.
 *
 * **The review happens in the first run of the month that succeeds**, not on a fixed
 * date. GitHub Actions drops scheduled runs, and a review pinned to "the first Sunday"
 * would silently skip a month whenever that one run was dropped. Recording the review in
 * `audit_log` makes the next run of the same month a no-op and the first run of the next
 * month the review.
 *
 * **What does not wait for the monthly review** — events on their own clock: a bond
 * maturity, and an exit the owner promotes on /cleanup. Neither is a new opinion; one is
 * a date and the other the owner's own request.
 */
export type ReviewKind = 'recommendations' | 'cleanup';

export async function monthlyReviewDone(db: Db, kind: ReviewKind, month: string): Promise<boolean> {
  const rows = await db.query<{ one: number }>(
    `select 1 as one from audit_log
      where entity = 'monthly_review' and entity_id = $1 and action = 'REVIEWED' limit 1`,
    [`${kind}:${month}`],
  );
  return rows.length > 0;
}

export async function recordMonthlyReview(
  db: Db, kind: ReviewKind, month: string, detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('monthly_review', $1, 'REVIEWED', 'agent', $2::jsonb)`,
    [`${kind}:${month}`, JSON.stringify({ kind, month, ...detail })],
  );
}

/** The first day of the month after `month` ('YYYY-MM'), for "next review" messages. */
export function nextMonthStart(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, 1));
  return d.toISOString().slice(0, 10);
}
