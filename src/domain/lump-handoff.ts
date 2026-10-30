import type { Db } from '../db/client.js';
import { decideProposal, loadProposals } from '../advisor/proposals.js';
import { buildRecommendation, persistRecommendation, type RecLeg } from './recommendations.js';
import { draftPendingOrders } from './order-drafting.js';
import { benchmarkSigned, dismissAdvice, fundIntent } from './advisor-handoff.js';
import { allocateLumpSum, type LumpLimits } from './lump-sizing.js';
import { loadLumpSum } from './lump-sums.js';
import type { Candidate } from './sizing.js';
import { FUND_TYPE_LABEL } from './fund-types.js';

/**
 * The owner's sign-off on lump-sum advice (batch B §3, Task 6) — `signAdvice`'s pattern, part
 * by part. Signing is not approving: each part becomes an ordinary recommendation linked to the
 * lump sum (FR-12's monthly cap and the stock repeat-buy hold apply to each) and an approval
 * request. Its orders spend the lump sum, never the month (`loadMonthSpend`, `checkRails`).
 *
 * The split is re-allocated at signing, in the advisor's order, against fresh sizing and what
 * is left of the lump sum now. Any part that moved refuses the whole split: the owner signs the
 * numbers he was shown or nothing.
 */
export const STALE_LUMP = 'the size has changed since this advice was given — it is re-advised at the next weekly report';

interface StoredPart { candidateId: string; instrumentId: string; name: string; amountPaise: string; units: string | null }

export async function signLumpSum(
  db: Db, proposalId: number, opts: { candidates: Candidate[]; limits: LumpLimits; now?: Date },
): Promise<{ recommendationIds: number[]; refused: { name: string; reason: string }[]; note: string }> {
  const now = opts.now ?? new Date();
  const p = (await loadProposals(db, 'LUMP_SUM', 500)).find((x) => x.id === proposalId);
  if (!p) throw new Error(`no lump-sum advice ${proposalId}`);
  if (p.status !== 'OPEN') throw new Error(`lump-sum advice ${proposalId} is already ${p.status.toLowerCase()}`);
  const d = p.payload;
  const lumpSumId = String(d['lumpSumId']);
  const lump = await loadLumpSum(db, lumpSumId);
  if (lump === null) throw new Error(`no open lump sum ${lumpSumId}`);
  const decision = String(d['decision']);

  if (decision === 'HOLD' || decision === 'WAIT') {
    const note = `${decision} accepted; nothing to order`;
    await decideProposal(db, proposalId, 'SIGNED', note);
    return { recommendationIds: [], refused: [], note };
  }
  if (decision !== 'BUY') throw new Error(`lump-sum advice ${proposalId} is ${decision}: nothing to sign`);

  // Matched by instrument, not candidate id: a candidate's id hashes the sizing date, so it
  // would never match on the day after the report. The amounts are what must not have moved.
  const stored = d['parts'] as StoredPart[];
  const fresh = stored.map((s) => opts.candidates.find((c) => c.instrumentId === s.instrumentId && c.status === 'ELIGIBLE'));
  const parts = allocateLumpSum(opts.candidates, fresh.flatMap((c) => (c ? [c.id] : [])), lump.remainingPaise, opts.limits);
  const total = parts.reduce((s, x) => s + x.amountPaise, 0n);
  const same = parts.length === stored.length
    && parts.every((x, i) => x.candidate.instrumentId === stored[i]!.instrumentId && x.amountPaise.toString() === stored[i]!.amountPaise);
  // A part never exceeds what is left of the lump sum (allocateLumpSum caps at it; checked, not assumed).
  if (!same || total > lump.remainingPaise) {
    // Closed, so the weekly report re-advises it: an open BUY would block re-advice for ever.
    await decideProposal(db, proposalId, 'DISMISSED', 'the size changed before it was signed');
    throw new Error(STALE_LUMP);
  }

  const createdOn = now.toISOString().slice(0, 10);
  const thesis = `${String(d['rationale'])} Key risk: ${String(d['keyRisk'])} Would be wrong if: ${String(d['falsification'])}`
    .split(/\s+/).slice(0, 150).join(' ');
  const recommendationIds: number[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const { candidate: c, amountPaise } of parts) {
    const amount = amountPaise.toString();
    const isGold = c.vehicle === 'FUND' && c.fund === null;
    const primary: RecLeg = c.fund !== null ? {
      // As signAdvice: a fund's exit is the category-rank switch; the model's words are in the thesis.
      intent: fundIntent(c.fund.fundType), instrumentId: c.instrumentId, action: 'BUY', amountPaise: amount, thesis,
      ipsClauseRefs: ['3.4', '3.5'], falsification: null,
    } : isGold ? {
      intent: 'top up gold toward its IPS band', instrumentId: c.instrumentId, action: 'BUY', amountPaise: amount, thesis,
      ipsClauseRefs: ['3.3'], falsification: null,
    } : {
      intent: 'add satellite equity exposure', instrumentId: c.instrumentId, action: 'BUY', amountPaise: amount, thesis,
      ipsClauseRefs: ['3.4', '3.6'], falsification: { metric: 'roce_pct', op: 'lt', value: 15 },
    };
    // A1: a fund or gold reaches the same end through the monthly plan; a stock takes the index route (buildRecommendation's default).
    const alternate: RecLeg | undefined = c.fund !== null || isGold ? {
      intent: primary.intent, instrumentId: null, action: 'REDIRECT', amountPaise: amount, ipsClauseRefs: primary.ipsClauseRefs.slice(0, 1), falsification: null,
      thesis: `Reach ${c.fund !== null ? FUND_TYPE_LABEL[c.fund.fundType] : 'the gold band'} through the monthly plan instead of this lump sum: `
        + 'slower, but no one-off order, and the lump sum stays in the bank.',
    } : undefined;
    const rec = buildRecommendation({
      kind: c.fund !== null || isGold ? 'rebalance' : 'satellite', createdOn, primary,
      ...(alternate ? { sameIntentAlternates: [alternate] } : {}),
      engineEvidence: {
        advisorProposalId: proposalId, lumpSumId, sizing: c.basis, units: c.units, horizonYears: d['horizonYears'],
        counterargument: d['counterargument'], evidence: p.evidenceIds,
      },
    });
    const persisted = await persistRecommendation(db, rec, { lumpSumId });
    if (persisted.id === null) { refused.push({ name: c.name, reason: persisted.reason ?? 'refused' }); continue; }
    // The same part from this lump sum is already a recommendation this month: not signed again.
    if (persisted.duplicate) { refused.push({ name: c.name, reason: 'already recommended this month' }); continue; }
    recommendationIds.push(persisted.id);
    await benchmarkSigned(db, persisted.id, c.instrumentId, createdOn);
  }
  if (recommendationIds.length === 0) throw new Error(`not signed: ${refused.map((r) => `${r.name}: ${r.reason}`).join('; ')}`);

  const drafted = await draftPendingOrders(db, now);
  const asked = drafted.drafted.filter((o) => recommendationIds.includes(Number(o.recommendationId))).length;
  const note = `recommendation${recommendationIds.length === 1 ? '' : 's'} ${recommendationIds.map((id) => `#${id}`).join(', ')}`
    + (refused.length > 0 ? `; refused: ${refused.map((r) => `${r.name} (${r.reason})`).join('; ')}` : '');
  await decideProposal(db, proposalId, 'SIGNED', note);
  return { recommendationIds, refused, note: `${note}; ${asked} approval request${asked === 1 ? '' : 's'}` };
}

export async function dismissLumpSum(db: Db, proposalId: number, reason: string): Promise<void> {
  const p = (await loadProposals(db, 'LUMP_SUM', 500)).find((x) => x.id === proposalId);
  if (!p) throw new Error(`no lump-sum advice ${proposalId}`);
  await dismissAdvice(db, proposalId, reason);
}
