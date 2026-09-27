import type { Db } from '../db/client.js';
import { decideProposal, loadProposals } from '../advisor/proposals.js';
import { buildRecommendation, persistRecommendation, type RecLeg } from './recommendations.js';
import { draftPendingOrders } from './order-drafting.js';
import { loadExitCandidates } from './sell-triggers.js';
import { promoteExitCandidate } from './exit-promotion.js';
import type { Candidate } from './sizing.js';
import { snapshotBenchmark } from './scoring.js';
import { BANDS } from './engine.js';

/**
 * The owner's sign-off on advice (Phase 2.5 Task 6) — outside src/advisor/, which may not
 * reach recommendation or order code. Signing is not approving: a BUY becomes an ordinary
 * recommendation (FR-12's cap and repeat-buy hold apply) and an approval request the owner
 * still approves separately. HOLD and WAIT create nothing to approve.
 *
 * The size is re-checked against a fresh sizing run at the moment of signing: if the
 * candidate is no longer eligible at the same size, nothing is signed and the owner re-runs
 * the advisor rather than approving a stale number.
 */

export interface SignResult { recommendationId: number | null; approvalRequested: boolean; note: string }

export async function signAdvice(
  db: Db, proposalId: number, opts: { candidates: Candidate[]; now?: Date },
): Promise<SignResult> {
  const now = opts.now ?? new Date();
  const p = (await loadProposals(db, 'ADVISE', 500)).find((x) => x.id === proposalId);
  if (!p) throw new Error(`no advice ${proposalId}`);
  if (p.status !== 'OPEN') throw new Error(`advice ${proposalId} is already ${p.status.toLowerCase()}`);
  const d = p.payload as Record<string, unknown>;
  const decision = String(d['decision']);
  const createdOn = now.toISOString().slice(0, 10);

  if (decision === 'HOLD' || decision === 'WAIT') {
    await decideProposal(db, proposalId, 'SIGNED', `${decision} accepted; nothing to order`);
    return { recommendationId: null, approvalRequested: false, note: `${decision} accepted` };
  }
  if (decision !== 'BUY' && decision !== 'SELL') throw new Error(`advice ${proposalId} is ${decision}: nothing to sign`);

  if (decision === 'SELL') {
    const exit = (await loadExitCandidates(db, createdOn.slice(0, 7))).find((e) => e.instrumentId === d['instrumentId']);
    if (!exit) throw new Error(`the exit for ${String(d['instrumentId'])} is no longer a candidate this month`);
    const r = await promoteExitCandidate(db, exit, createdOn);
    if (r.id === null) throw new Error(`not signed: ${r.reason}`);
    await draftPendingOrders(db, now);
    await decideProposal(db, proposalId, 'SIGNED', `recommendation #${r.id}`);
    return { recommendationId: r.id, approvalRequested: true, note: `recommendation #${r.id}` };
  }

  const fresh = opts.candidates.find((c) => c.id === d['candidateId'] && c.status === 'ELIGIBLE');
  if (!fresh) throw new Error('the size has changed since this advice was given (prices, cash or the budget moved) — re-run the advisor');

  const thesis = `${String(d['rationale'])} Key risk: ${String(d['keyRisk'])} Would be wrong if: ${String(d['falsification'])}`
    .split(/\s+/).slice(0, 150).join(' ');
  const primary: RecLeg = {
    intent: 'add satellite equity exposure', instrumentId: fresh.instrumentId, action: 'BUY',
    amountPaise: fresh.amountPaise!.toString(), thesis, ipsClauseRefs: ['3.4', '3.6'],
    // The quality gate is the machine-testable kill condition; the model's own words are in the thesis.
    falsification: { metric: 'roce_pct', op: 'lt', value: 15 },
  };
  const other = (Array.isArray(d['alternates']) ? (d['alternates'] as string[]) : [])
    .map((id) => opts.candidates.find((c) => c.id === id && c.action === 'BUY' && c.instrumentId !== fresh.instrumentId))
    .find(Boolean);
  const rec = buildRecommendation({
    kind: 'satellite', createdOn, primary,
    ...(other ? { sameIntentAlternates: [{
      ...primary, instrumentId: other.instrumentId, amountPaise: other.amountPaise?.toString() ?? null,
      thesis: `The advisor's second choice: ${other.name}, sized ${other.basis}.`,
    }] } : {}),
    engineEvidence: {
      advisorProposalId: proposalId, sizing: fresh.basis, units: fresh.units, horizonYears: d['horizonYears'],
      counterargument: d['counterargument'], evidence: p.evidenceIds,
    },
  });
  const persisted = await persistRecommendation(db, rec);
  if (persisted.id === null) throw new Error(`not signed: ${persisted.reason}`);
  // §13: capture the point of comparison when the call is made, so signed advice is
  // scored like any other recommendation. Conviction is the signal band at signing.
  const [sig] = await db.query<{ composite: string }>(
    `select composite::text from signal_scores where instrument_id = $1 order by score_date desc limit 1`, [fresh.instrumentId]);
  const composite = sig ? Number(sig.composite) : null;
  const conviction = composite === null ? 'UNSCORED' : composite >= BANDS.high ? 'HIGH' : composite >= BANDS.medium ? 'MEDIUM' : 'WATCH';
  await snapshotBenchmark(db, { recommendationId: persisted.id, instrumentId: fresh.instrumentId, asOf: createdOn, conviction });
  const drafted = await draftPendingOrders(db, now);
  const asked = drafted.drafted.some((o) => Number(o.recommendationId) === persisted.id);
  await decideProposal(db, proposalId, 'SIGNED', `recommendation #${persisted.id}`);
  return { recommendationId: persisted.id, approvalRequested: asked, note: `recommendation #${persisted.id}` };
}

export async function dismissAdvice(db: Db, proposalId: number, reason: string): Promise<void> {
  if (reason.trim() === '') throw new Error('say why — it is kept with the advice');
  await decideProposal(db, proposalId, 'DISMISSED', reason.trim());
}
