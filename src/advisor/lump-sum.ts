import type { Db } from '../db/client.js';
import { TEXT_MODEL } from '../config/models.js';
import type { Candidate } from '../domain/sizing.js';
import { recordProposal } from './proposals.js';
import {
  ADVISOR_RULES, adverseNews, callModel, showCandidates, validateDecision,
  type CandidateContext, type Decision, type ModelDecision,
} from './recommend.js';

/**
 * The lump-sum advisor (batch B §3, Task 5). The model picks one destination or an ordered
 * split of the sized candidates, or HOLD/WAIT ("keep it in the bank for now"); it never
 * states an amount. The system fills the picks in the model's order through `allocate`.
 *
 * Firewall: candidates and `allocate` are handed in by src/jobs/report.ts, because the lump
 * sizer reaches fund-mix.ts (the owner's signature), which src/advisor/ must never import.
 */
const LUMP_PROMPT_VERSION = 'lump-v1';
const LUMP_SCHEMA_VERSION = 'lump-schema-v1';

const PROMPT = [
  ...ADVISOR_RULES,
  'This is a one-off amount on top of the monthly budget ("lumpSum": where it came from and what is left).',
  'Choose one or more candidateIds in priority order: the system fills them in that order with what is left.',
  'Or HOLD/WAIT: keep it in the bank for now, and say why. You never state an amount.',
  'Reply with JSON only:',
  '{"decision":"BUY|HOLD|WAIT","candidateIds":["<id>",...],"timing":"this_month|next_review",',
  ' "horizonYears":<number >= 1>,"rationale":"<= 120 words","keyRisk":"...","falsification":"what would prove it wrong",',
  ' "counterargument":"the best case against","evidenceIds":["news:<id>",...],"alternates":["<candidateId>","WAIT"|"HOLD"],',
  ' "whyNotFund":"<required if a stock is among the picks>"}',
].join('\n');

type Part = { candidateId: string; instrumentId: string; name: string; amountPaise: bigint; units: string | null };

/** ADVISE's validation, per pick: offered, a BUY, a stock says why not a fund; plus no numbers, a horizon, the texts. */
function validateLump(raw: unknown, shown: CandidateContext[]): { d: ModelDecision; ids: string[] } {
  const r = raw as Record<string, unknown>;
  const decision = String(r['decision']);
  if (!['BUY', 'HOLD', 'WAIT'].includes(decision)) throw new Error(`unknown decision ${decision}`);
  const ids = Array.isArray(r['candidateIds']) ? r['candidateIds'].map(String) : [];
  if (decision === 'BUY' && ids.length === 0) throw new Error('a BUY must name at least one candidateId');
  if (new Set(ids).size !== ids.length) throw new Error('a candidateId is repeated');
  const checked = (ids.length > 0 ? ids : [null]).map((id) => validateDecision({ ...r, candidateId: id }, shown));
  return { d: checked[0]!, ids };
}

export async function runLumpSumAdvisor(
  db: Db,
  opts: {
    lump: { id: string; from: string; remaining: string }; asOf: string; candidates: Candidate[];
    apiKey: string | undefined; model?: string | undefined; fetchImpl?: typeof fetch; now?: Date;
    allocate: (ids: string[]) => Part[];
  },
): Promise<{ proposalId: number; decision: Decision }> {
  const now = opts.now ?? new Date();
  const model = opts.model || TEXT_MODEL;
  const { shown, excluded } = await showCandidates(db, opts.candidates, now);
  const lumpSum = { from: opts.lump.from, remaining: opts.lump.remaining };
  const snapshot = { asOf: opts.asOf, lumpSum: { id: opts.lump.id, ...lumpSum }, shown, excluded };
  const save = async (decision: Decision, payload: object, usedModel: string | null, evidence: string[] = []) => ({
    decision,
    proposalId: await recordProposal(db, {
      kind: 'LUMP_SUM', payload: { decision, lumpSumId: opts.lump.id, parts: [], ...payload }, inputSnapshot: snapshot,
      evidenceIds: evidence, model: usedModel, promptVersion: LUMP_PROMPT_VERSION, schemaVersion: LUMP_SCHEMA_VERSION, asOf: now.toISOString(),
    }),
  });

  if (shown.length === 0) return save('NO_ACTION', { reason: 'no destination is eligible for this lump sum', excluded }, null);
  if (!opts.apiKey) return save('UNAVAILABLE', { reason: 'no model key configured', excluded }, null);

  const { decided, failure } = await callModel(db, {
    apiKey: opts.apiKey, model, fetchImpl: opts.fetchImpl, seam: 'lump', system: PROMPT,
    user: JSON.stringify({ asOf: opts.asOf, lumpSum, candidates: shown }),
  }, (raw) => validateLump(raw, shown));
  if (!decided) return save('UNAVAILABLE', { reason: failure, excluded }, model);

  const { d, ids } = decided;
  const base = {
    timing: d.timing, horizonYears: d.horizonYears, rationale: d.rationale, keyRisk: d.keyRisk,
    falsification: d.falsification, counterargument: d.counterargument, alternates: d.alternates, excluded,
  };
  if (d.decision !== 'BUY') return save(d.decision, base, model, d.evidenceIds);

  // News may defer a pick, never start one: an adversely-newsed pick is dropped.
  const adverse = new Map(ids.map((id) => [id, adverseNews(shown.find((s) => s.candidate.id === id)!, now)]));
  const keep = ids.filter((id) => adverse.get(id)!.length === 0);
  const deferredBecause = [...adverse.values()].flat().map((n) => n.evidenceId);
  const evidence = [...d.evidenceIds, ...deferredBecause];
  if (keep.length === 0) return save('WAIT', { ...base, deferredByNews: true, deferredBecause }, model, evidence);
  const deferred = keep.length < ids.length ? { deferredPicks: ids.filter((id) => !keep.includes(id)), deferredBecause } : {};

  const parts = opts.allocate(keep);
  if (parts.length === 0) return save('WAIT', { ...base, reason: 'no pick could be bought with the amount left', ...deferred }, model, evidence);
  const byId = new Map(opts.candidates.map((c) => [c.id, c]));
  // Payload parts: { candidateId, instrumentId, name, amountPaise (string), units, basis } — `basis`
  // is the sizer's own explanation of the candidate's ceiling, shown on /advisor beside the part.
  // whyNotFund is kept only where it is required: a stock among the parts.
  const whyNotFund = parts.some((p) => byId.get(p.candidateId)?.vehicle === 'STOCK') ? { whyNotFund: d.whyNotFund } : {};
  return save('BUY', {
    ...base, ...deferred, ...whyNotFund,
    parts: parts.map((p) => ({ ...p, amountPaise: p.amountPaise.toString(), basis: byId.get(p.candidateId)?.basis ?? null })),
  }, model, evidence);
}
