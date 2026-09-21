import type { Db } from '../db/client.js';
import { buildRecommendation, persistRecommendation, type PersistResult } from './recommendations.js';
import type { ExitCandidate } from './sell-triggers.js';

/**
 * Turns one exit candidate into an FR-11 recommendation, because the owner asked for it.
 *
 * Candidates are recorded as findings and shown on `/cleanup`; they are deliberately not
 * promoted automatically. Promotion spends one of FR-12's four recommendation slots for
 * the month, and the same standing breach re-fires every month — three cap breaches on
 * one holding would consume the whole budget on an unchanged fact, every month, forever.
 * Making it an explicit act keeps the budget for what the owner actually intends to do.
 *
 * `persistRecommendation` already enforces the monthly cap and records a refusal in
 * `suppressed_actions`, so this surfaces that reason rather than duplicating the rule.
 */
export interface PromotionResult extends PersistResult {
  /** Set when the candidate was refused before the FR-12 gate was even consulted. */
  blocked?: string;
}

/** A thesis the owner will read, built from the trigger's own evidence. */
function thesisFor(c: ExitCandidate): string {
  const action = c.action === 'TRIM' ? 'Trim' : c.action === 'REDEEM' ? 'Redeem' : 'Exit';
  const hold = c.overridesMinimumHold
    ? 'This trigger overrides the twelve-month minimum hold under IPS §3.7.'
    : 'This trigger does not override the twelve-month minimum hold.';
  return `${action} ${c.instrumentId}: ${c.evidence}. ${hold} Raised by the ${c.trigger} `
    + `sell trigger for ${c.month} and promoted by the owner rather than automatically.`;
}

export async function promoteExitCandidate(
  db: Db,
  candidate: ExitCandidate,
  createdOn: string,
): Promise<PromotionResult> {
  if (candidate.blockedByMinimumHold) {
    // §3.7 is a hold, not a preference. Surfacing the candidate is right; turning one
    // into a recommendation to act inside the minimum hold is not.
    return {
      id: null, suppressed: true,
      reason: `IPS §3.7: ${candidate.instrumentId} is inside its twelve-month minimum hold `
        + `and the ${candidate.trigger} trigger does not override it`,
      blocked: 'minimum-hold',
    };
  }

  const existing = await db.query<{ id: string }>(
    `select id from recommendations
      where suppressed = false and kind = 'sell'
        and to_char(created_on, 'YYYY-MM') = $1
        and (primary_rec::jsonb)->>'instrumentId' = $2`,
    [createdOn.slice(0, 7), candidate.instrumentId],
  );
  if (existing.length > 0) {
    // Promoting the same standing breach twice in a month would spend two of four slots
    // on one unchanged fact.
    return {
      id: null, suppressed: true,
      reason: `${candidate.instrumentId} already has a sell recommendation this month`,
      blocked: 'already-promoted',
    };
  }

  // `buildRecommendation` throws when FR-11 cannot be satisfied — notably when the name
  // being exited IS the index route it would otherwise offer as alternate A1. That is a
  // legitimate refusal, not a server error, so it comes back as a suppression.
  let rec;
  try {
    rec = buildRecommendation({
      kind: 'sell',
      createdOn,
      primary: {
        intent: `${candidate.trigger} exit for ${candidate.instrumentId}`,
        instrumentId: candidate.instrumentId,
        action: candidate.action,
        // NULL when no position sized it. Never 0 — an exit worth nothing is not an exit.
        amountPaise: candidate.amountPaise === null ? null : candidate.amountPaise.toString(),
        thesis: thesisFor(candidate),
        ipsClauseRefs: candidate.ipsClauseRefs,
        // An exit has no falsification condition: the thesis being tested is already the
        // one that failed. FR-11 requires the field, not a fabricated value in it.
        falsification: null,
      },
      sameIntentAlternates: [],
      engineEvidence: {
        trigger: candidate.trigger,
        month: candidate.month,
        heldMonths: candidate.heldMonths,
        promotedBy: 'owner',
      },
      paperMode: true,
    });
  } catch (e) {
    return {
      id: null, suppressed: true,
      reason: `cannot build an FR-11 recommendation for ${candidate.instrumentId}: `
        + (e instanceof Error ? e.message : String(e)),
      blocked: 'fr-11',
    };
  }
  return persistRecommendation(db, rec);
}
