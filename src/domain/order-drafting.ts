import type { Db } from '../db/client.js';
import { createOrder, type OrderIntent } from './orders.js';
import { redemptionFor } from './bond-redemptions.js';
import type { Recommendation, RecKind, RecLeg } from './recommendations.js';

/**
 * FR-20: "Every actionable recommendation becomes an approval request."
 *
 * Nothing did that. `createOrder` had zero production callers, so recommendations were
 * written and shown and never reached an approval queue — which made the Phase 2 DoD's
 * "owner completes ≥5 approval-flow interactions" impossible to start, whatever else
 * was built. This is the missing link.
 *
 * Drafting passes through `createOrder`, so every rail, freeze, breaker and freshness
 * check applies before a DRAFT exists (FR-30). A refused draft is not an invalid row:
 * it is an `audit_log` entry saying why, which is what FR-30 asks for.
 */

/** A recommendation older than this is not drafted: its facts have moved on. */
export const DRAFT_WINDOW_DAYS = 7;

export interface DraftReport {
  drafted: OrderIntent[];
  /** Rails, freeze, breaker or freshness refused it. Retried on the next run. */
  refused: { recommendationId: number; reason: string }[];
  /** Not an order at all — a HOLD, or a leg that names no instrument. */
  notActionable: { recommendationId: number; reason: string }[];
  /** Another recommendation for the same action already has an order. */
  duplicates: number[];
}

interface Row {
  id: string | number;
  created_on: string | Date;
  kind: RecKind;
  primary_rec: string;
  alternates: string;
  engine_evidence: string;
}

const isoDate = (v: string | Date): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

function toRecommendation(r: Row): Recommendation {
  return {
    kind: r.kind,
    createdOn: isoDate(r.created_on),
    primary: JSON.parse(r.primary_rec) as RecLeg,
    alternates: JSON.parse(r.alternates) as [RecLeg, RecLeg],
    engineEvidence: JSON.parse(r.engine_evidence) as Record<string, unknown>,
    // Phase 2 is paper by definition; the column does not exist to say otherwise.
    paperMode: true,
  };
}

/**
 * Why a recommendation cannot become an order, or null when it can.
 *
 * HOLD is a decision, not an instruction — it is the default answer and needs no
 * approval. A leg with no instrument cannot be ordered: the rebalance engine currently
 * emits "BUY equity" at the asset-class level, which has nowhere to send an order.
 */
export function notActionableReason(primary: RecLeg): string | null {
  if (primary.action === 'HOLD') return 'HOLD needs no approval';
  if (primary.instrumentId === null) return `${primary.action} names no instrument, so there is nothing to order`;
  return null;
}

/** One logical action: two recommendations for the same thing are one approval. */
const actionKey = (kind: string, p: RecLeg): string => `${kind}|${p.action}|${p.instrumentId ?? ''}`;

export async function draftPendingOrders(db: Db, now: Date = new Date()): Promise<DraftReport> {
  const since = new Date(now.getTime() - DRAFT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.query<Row>(
    `select r.id, r.created_on, r.kind, r.primary_rec, r.alternates, r.engine_evidence
       from recommendations r
      where r.suppressed = false
        and r.created_on >= $1
        and not exists (select 1 from order_intents o where o.recommendation_id = r.id)
      order by r.created_on, r.id`,
    [since],
  );

  // Actions that already have an order, from any recommendation in the window. The
  // weekly report once ran twice on one day and wrote every recommendation twice;
  // without this each would have become its own approval request.
  const ordered = await db.query<{ kind: string; primary_rec: string }>(
    `select r.kind, r.primary_rec from recommendations r
      where r.created_on >= $1
        and exists (select 1 from order_intents o where o.recommendation_id = r.id)`,
    [since],
  );
  const taken = new Set(ordered.map((o) => actionKey(o.kind, JSON.parse(o.primary_rec) as RecLeg)));

  const report: DraftReport = { drafted: [], refused: [], notActionable: [], duplicates: [] };
  for (const row of rows) {
    const recommendationId = Number(row.id);
    const rec = toRecommendation(row);

    const why = notActionableReason(rec.primary);
    if (why !== null) { report.notActionable.push({ recommendationId, reason: why }); continue; }

    // Asking the owner to approve redeeming a bond that has already paid out would be
    // an approval for something that happened without them.
    const paid = await redemptionFor(db, rec.primary.instrumentId!);
    if (paid !== null) {
      report.notActionable.push({
        recommendationId, reason: `already redeemed — received ${paid.receivedOn}`,
      });
      continue;
    }

    const key = actionKey(rec.kind, rec.primary);
    if (taken.has(key)) { report.duplicates.push(recommendationId); continue; }

    try {
      report.drafted.push(await createOrder(db, {
        recommendationId, recommendation: rec, createdBy: 'advisor',
        // No broker in Phase 2: the owner executes, the system records.
        advisoryPath: true,
      }));
      taken.add(key);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      report.refused.push({ recommendationId, reason });
      await db.query(
        `insert into audit_log (entity, entity_id, action, actor, payload)
         values ('order_draft', $1, 'DRAFT_REFUSED', 'agent', $2::jsonb)`,
        [String(recommendationId), JSON.stringify({ recommendationId, reason, at: now.toISOString() })],
      );
    }
  }
  return report;
}

/** The Telegram message announcing new approval requests. Null when there are none. */
export function draftAnnouncement(report: DraftReport): string | null {
  if (report.drafted.length === 0) return null;
  const lines = report.drafted.map((o) => {
    const amount = o.quantity !== null && o.quantity !== '0'
      ? ` · ₹${(Number(o.quantity) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
      : '';
    return `• ${o.intent} ${o.instrumentId}${amount}\n  /approve ${o.id}   /alternates ${o.id}`;
  });
  return [
    `🗳 ${report.drafted.length} new approval request${report.drafted.length === 1 ? '' : 's'} (PAPER)`,
    '',
    ...lines,
    '',
    'Nothing executes without your approval. Unanswered requests expire on schedule.',
  ].join('\n');
}
