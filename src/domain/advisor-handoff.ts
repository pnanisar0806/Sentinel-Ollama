import type { Db } from '../db/client.js';
import { decideProposal, loadProposals } from '../advisor/proposals.js';
import { buildRecommendation, persistRecommendation, type RecLeg } from './recommendations.js';
import { draftPendingOrders } from './order-drafting.js';
import { loadExitCandidates } from './sell-triggers.js';
import { promoteExitCandidate } from './exit-promotion.js';
import { TRANCHE_USED, type Candidate } from './sizing.js';
import { snapshotBenchmark } from './scoring.js';
import { BANDS } from './engine.js';
import { FUND_TYPE_LABEL, type FundType } from './fund-types.js';

export const fundIntent = (t: FundType) => `top up ${FUND_TYPE_LABEL[t]} toward the approved fund mix`;

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

interface SignResult { recommendationId: number | null; approvalRequested: boolean; note: string }

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
  const primary: RecLeg = fresh.fund !== null ? {
    // A top-up toward the signed fund mix (§3.4 core/satellite, §3.5 the single-scheme cap).
    intent: fundIntent(fresh.fund.fundType), instrumentId: fresh.instrumentId, action: 'BUY',
    amountPaise: fresh.amountPaise!.toString(), thesis, ipsClauseRefs: ['3.4', '3.5'],
    // The closed grammar has no fund metric: roce_pct is a company's, and a never-firing price
    // floor would read as a live condition. A fund's exit is the category-rank switch; the
    // model's own falsification words are in the thesis.
    falsification: null,
  } : {
    intent: 'add satellite equity exposure', instrumentId: fresh.instrumentId, action: 'BUY',
    amountPaise: fresh.amountPaise!.toString(), thesis, ipsClauseRefs: ['3.4', '3.6'],
    // The quality gate is the machine-testable kill condition; the model's own words are in the thesis.
    falsification: { metric: 'roce_pct', op: 'lt', value: 15 },
  };
  const other = (Array.isArray(d['alternates']) ? (d['alternates'] as string[]) : [])
    // Eligible, or held back only because the month's single tranche went to the first choice.
    // A fund of another type is another intent, so it cannot be A1 (§6.6); it is dropped, and
    // A2 stays "do nothing this cycle" — hold is visible on every recommendation.
    .map((id) => opts.candidates.find((c) => c.id === id && c.action === 'BUY' && c.instrumentId !== fresh.instrumentId
      && (c.status === 'ELIGIBLE' || c.withheldReason === TRANCHE_USED)
      && (fresh.fund === null || c.fund === null || c.fund.fundType === fresh.fund.fundType)))
    .find(Boolean);
  const alternate: RecLeg | undefined = other ? {
    ...primary, instrumentId: other.instrumentId, amountPaise: other.amountPaise?.toString() ?? null,
    thesis: other.status === 'ELIGIBLE'
      ? `The advisor's second choice: ${other.name}, sized ${other.basis}.`
      : `The advisor's second choice: ${other.name}, not sized this month because the single tranche went to the first choice.`,
  } : fresh.fund !== null ? {
    // A fund never takes the stock index route: the same end, reached through the SIP.
    intent: primary.intent, instrumentId: null, action: 'REDIRECT', amountPaise: primary.amountPaise,
    thesis: `Reach ${FUND_TYPE_LABEL[fresh.fund.fundType]} through next month's SIP instead of a lump sum: `
      + 'slower, but no one-off order, and the money still goes to the fund type below its approved share.',
    ipsClauseRefs: ['3.4'], falsification: null,
  } : undefined;
  const rec = buildRecommendation({
    // A fund top-up toward the signed mix is a rebalance, not a stock idea.
    kind: fresh.fund !== null ? 'rebalance' : 'satellite', createdOn, primary,
    ...(alternate ? { sameIntentAlternates: [alternate] } : {}),
    engineEvidence: {
      advisorProposalId: proposalId, sizing: fresh.basis, units: fresh.units, horizonYears: d['horizonYears'],
      counterargument: d['counterargument'], evidence: p.evidenceIds,
    },
  });
  const persisted = await persistRecommendation(db, rec);
  if (persisted.id === null) throw new Error(`not signed: ${persisted.reason}`);
  await benchmarkSigned(db, persisted.id, fresh.instrumentId, createdOn);
  const drafted = await draftPendingOrders(db, now);
  const asked = drafted.drafted.some((o) => Number(o.recommendationId) === persisted.id);
  await decideProposal(db, proposalId, 'SIGNED', `recommendation #${persisted.id}`);
  return { recommendationId: persisted.id, approvalRequested: asked, note: `recommendation #${persisted.id}` };
}

/**
 * §13: capture the point of comparison when the call is made, so signed advice is scored like
 * any other recommendation. Conviction is the signal band at signing.
 */
export async function benchmarkSigned(db: Db, recommendationId: number, instrumentId: string, asOf: string): Promise<void> {
  const [sig] = await db.query<{ composite: string }>(
    `select composite::text from signal_scores where instrument_id = $1 order by score_date desc limit 1`, [instrumentId]);
  const composite = sig ? Number(sig.composite) : null;
  const conviction = composite === null ? 'UNSCORED' : composite >= BANDS.high ? 'HIGH' : composite >= BANDS.medium ? 'MEDIUM' : 'WATCH';
  await snapshotBenchmark(db, { recommendationId, instrumentId, asOf, conviction });
}

export async function dismissAdvice(db: Db, proposalId: number, reason: string): Promise<void> {
  if (reason.trim() === '') throw new Error('say why — it is kept with the advice');
  await decideProposal(db, proposalId, 'DISMISSED', reason.trim());
}
