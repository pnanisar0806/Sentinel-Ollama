import type { Db } from '../db/client.js';
import { OPENROUTER_CHAT_URL, TEXT_MODEL } from '../config/models.js';
import type { Candidate } from '../domain/sizing.js';
import { SATELLITE_WEIGHTS } from '../domain/engine.js';
import { newsCoverage } from '../sources/news.js';
import { firstJson } from '../sources/sentiment.js';
import { recordLlmCall, recordProposal } from './proposals.js';

/**
 * The ADVISE decision (Phase 2.5 Task 6).
 *
 * The model chooses among deterministically sized candidates, or HOLD/WAIT, for a
 * five-year holder. It cannot invent a candidate, change an action or supply a number;
 * the size stays the sizer's. Owner policy (2026-09-27): news may DEFER a BUY, never
 * start one — enforced here in code, not by asking the model nicely.
 *
 * Outcomes are distinct: BUY/SELL/HOLD/WAIT are the model's decisions; NO_ACTION means
 * nothing was eligible (no call made); UNAVAILABLE means no key, a failed call or an
 * invalid reply. Neither of the last two is ever reported as HOLD.
 */

const ADVISE_PROMPT_VERSION = 'advise-v1';
const ADVISE_SCHEMA_VERSION = 'advise-schema-v1';
export type Decision = 'BUY' | 'SELL' | 'HOLD' | 'WAIT' | 'NO_ACTION' | 'UNAVAILABLE';

const NEWS_LOOKBACK_DAYS = 90;
const DEFER_WINDOW_DAYS = 30;
const FORBIDDEN_NUMBERS = ['amountPaise', 'amount', 'units', 'quantity', 'price', 'pricePaise', 'size'];

const PROMPT = [
  'You advise one long-term Indian investor. Horizon: years. He does not trade.',
  'Rules that are not negotiable:',
  '- The default answer is HOLD or WAIT. A BUY or SELL must clear a bar to exist at all.',
  '- Never justify an action by short-term price movement, momentum, a dip or a week of news.',
  '- An exit needs a reason that is not price. Good news is never a reason to buy.',
  '- You may only choose a candidateId you were given, with that candidate\'s action.',
  '- You never state an amount, a number of shares or a price: sizes are fixed by the system.',
  '- Signal parts are scores out of the stated maximum ("outOf"): 9 of 30 is weak, not good value.',
  'Ask: would he be content holding this for five years, and what would have to be true for that to be wrong?',
  'Reply with JSON only:',
  '{"decision":"BUY|SELL|HOLD|WAIT","candidateId":"<id or null>","timing":"this_month|next_review",',
  ' "horizonYears":<number >= 1>,"rationale":"<= 120 words","keyRisk":"...","falsification":"what would prove it wrong",',
  ' "counterargument":"the best case against","evidenceIds":["news:<id>",...],"alternates":["<candidateId>","WAIT"|"HOLD"]}',
].join('\n');

type Part = { score: number | null; outOf: number };

interface CandidateContext {
  candidate: { id: string; action: string; instrument: string; name: string; basis: string; constraints: string[] };
  /** Each component with its maximum, so a model cannot read 9 of 30 as "good value". */
  signal: { composite: Part; valuation: Part; trend: Part; earnings: Part; fit: Part; scoreDate: string } | null;
  news: { evidenceId: string; publishedAt: string; type: string; headline: string; polarity: string; materiality: string; summary: string }[];
  coverage: string;
}

async function contextFor(db: Db, c: Candidate, now: Date): Promise<{ ctx: CandidateContext | null; excluded: string | null }> {
  const cov = await newsCoverage(db, c.instrumentId, now);
  if (cov.state !== 'fresh') return { ctx: null, excluded: `${c.name}: news coverage is ${cov.state}` };

  const since = new Date(now.getTime() - NEWS_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await db.query<{ id: string; published_at: string | Date; event_type: string; headline: string; polarity: string | null; materiality: string | null; summary: string | null }>(
    `select e.id, e.published_at, e.event_type, e.headline, s.polarity, s.materiality, s.summary
       from news_events e
       left join lateral (select polarity, materiality, summary from event_sentiment x
                           where x.event_id = e.id and x.classified_at <= $3 order by x.classified_at desc, x.id desc limit 1) s on true
      where e.instrument_id = $1 and e.published_at >= $2 and e.received_at <= $3
      order by e.published_at desc`,
    [c.instrumentId, since, now.toISOString()],
  );
  const recent = new Date(now.getTime() - DEFER_WINDOW_DAYS * 86_400_000);
  if (rows.some((r) => r.polarity === null && new Date(r.published_at) >= recent)) {
    return { ctx: null, excluded: `${c.name}: recent material news is not yet classified` };
  }
  const [sig] = await db.query<{ composite: string; reg_valuation: string | null; reg_trend: string | null; reg_earnings: string | null; reg_fit: string | null; score_date: string }>(
    `select composite::text, reg_valuation::text, reg_trend::text, reg_earnings::text, reg_fit::text, score_date::text
       from signal_scores where instrument_id = $1 order by score_date desc limit 1`, [c.instrumentId]);
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    excluded: null,
    ctx: {
      candidate: { id: c.id, action: c.action, instrument: c.instrumentId, name: c.name, basis: c.basis, constraints: c.constraints },
      signal: sig ? {
        composite: { score: Number(sig.composite), outOf: 100 },
        valuation: { score: n(sig.reg_valuation), outOf: SATELLITE_WEIGHTS.valuation },
        trend: { score: n(sig.reg_trend), outOf: SATELLITE_WEIGHTS.trend },
        earnings: { score: n(sig.reg_earnings), outOf: SATELLITE_WEIGHTS.earnings },
        fit: { score: n(sig.reg_fit), outOf: SATELLITE_WEIGHTS.fit },
        scoreDate: sig.score_date,
      } : null,
      news: rows.filter((r) => r.polarity !== null).map((r) => ({
        evidenceId: `news:${r.id}`, publishedAt: new Date(r.published_at).toISOString().slice(0, 10), type: r.event_type,
        headline: r.headline, polarity: r.polarity!, materiality: r.materiality!, summary: r.summary!,
      })),
      coverage: cov.state,
    },
  };
}

interface ModelDecision {
  decision: 'BUY' | 'SELL' | 'HOLD' | 'WAIT'; candidateId: string | null; timing: string; horizonYears: number;
  rationale: string; keyRisk: string; falsification: string; counterargument: string; evidenceIds: string[]; alternates: string[];
}

function validateDecision(raw: unknown, shown: CandidateContext[]): ModelDecision {
  const d = raw as Record<string, unknown>;
  for (const k of FORBIDDEN_NUMBERS) if (k in d) throw new Error(`the model supplied "${k}"; sizes are the system's`);
  const decision = String(d['decision']);
  if (!['BUY', 'SELL', 'HOLD', 'WAIT'].includes(decision)) throw new Error(`unknown decision ${decision}`);
  const candidateId = d['candidateId'] === null || d['candidateId'] === undefined ? null : String(d['candidateId']);
  const byId = new Map(shown.map((s) => [s.candidate.id, s]));
  if (decision === 'BUY' || decision === 'SELL') {
    const c = candidateId ? byId.get(candidateId) : undefined;
    if (!c) throw new Error(`candidate ${candidateId} was not offered`);
    const allowed = c.candidate.action === 'BUY' ? ['BUY'] : ['SELL'];
    if (!allowed.includes(decision)) throw new Error(`${decision} does not match candidate action ${c.candidate.action}`);
  } else if (candidateId !== null && !byId.has(candidateId)) {
    throw new Error(`candidate ${candidateId} was not offered`);
  }
  const horizonYears = Number(d['horizonYears']);
  if (decision !== 'WAIT' && decision !== 'HOLD' && !(horizonYears >= 1)) throw new Error('a thesis is measured in years: horizon below 1 year');
  const text = (k: string) => {
    const v = String(d[k] ?? '').trim();
    if (v === '') throw new Error(`missing ${k}`);
    return v;
  };
  const rationale = text('rationale');
  if (rationale.split(/\s+/).length > 120) throw new Error('rationale over 120 words');
  const allEvidence = new Set(shown.flatMap((s) => s.news.map((n) => n.evidenceId)));
  const evidenceIds = (Array.isArray(d['evidenceIds']) ? d['evidenceIds'] : []).map(String);
  for (const e of evidenceIds) if (!allEvidence.has(e)) throw new Error(`evidence ${e} was not shown`);
  const alternates = (Array.isArray(d['alternates']) ? d['alternates'] : []).map(String)
    .filter((a) => a === 'WAIT' || a === 'HOLD' || byId.has(a));
  return {
    decision: decision as ModelDecision['decision'], candidateId, timing: String(d['timing'] ?? 'next_review'),
    horizonYears: Number.isFinite(horizonYears) ? horizonYears : 0, rationale,
    keyRisk: text('keyRisk'), falsification: text('falsification'), counterargument: text('counterargument'), evidenceIds, alternates,
  };
}

export async function runAdvisor(
  db: Db,
  opts: { asOf: string; candidates: Candidate[]; apiKey: string | undefined; model?: string | undefined; fetchImpl?: typeof fetch; now?: Date },
): Promise<{ proposalId: number; decision: Decision }> {
  const now = opts.now ?? new Date();
  const model = opts.model || TEXT_MODEL;
  const shown: CandidateContext[] = [];
  const excluded: string[] = opts.candidates.filter((c) => c.status !== 'ELIGIBLE').map((c) => `${c.name}: ${c.withheldReason}`);
  for (const c of opts.candidates.filter((x) => x.status === 'ELIGIBLE')) {
    const { ctx, excluded: why } = await contextFor(db, c, now);
    if (ctx) shown.push(ctx); else excluded.push(why!);
  }
  const snapshot = { asOf: opts.asOf, shown, excluded };
  const save = async (decision: Decision, payload: object, usedModel: string | null, evidence: string[] = []) => ({
    decision,
    proposalId: await recordProposal(db, {
      kind: 'ADVISE', payload: { decision, ...payload }, inputSnapshot: snapshot, evidenceIds: evidence,
      model: usedModel, promptVersion: ADVISE_PROMPT_VERSION, schemaVersion: ADVISE_SCHEMA_VERSION, asOf: now.toISOString(),
    }),
  });

  if (shown.length === 0) return save('NO_ACTION', { reason: 'no candidate is eligible for advice this cycle', excluded }, null);
  if (!opts.apiKey) return save('UNAVAILABLE', { reason: 'no model key configured', excluded }, null);

  // Two attempts: free models occasionally return malformed JSON. Each attempt is logged.
  let decided: ModelDecision | null = null;
  let lastFailure = '';
  for (let attempt = 1; attempt <= 2 && decided === null; attempt++) {
    const started = Date.now();
    let outcome: 'ok' | 'unavailable' | 'invalid' | 'error' = 'ok';
    let error: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    try {
      const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify({ asOf: opts.asOf, candidates: shown }) }] }),
      });
      if (!res.ok) { outcome = 'unavailable'; error = `HTTP ${res.status}`; }
      else {
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: typeof usage };
        usage = body.usage;
        try { decided = validateDecision(firstJson(body.choices?.[0]?.message?.content ?? ''), shown); }
        catch (e) { outcome = 'invalid'; error = e instanceof Error ? e.message : String(e); }
      }
    } catch (e) { outcome = 'error'; error = e instanceof Error ? e.message : String(e); }
    await recordLlmCall(db, {
      seam: 'advise', model, latencyMs: Date.now() - started, outcome,
      promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null, error,
    });
    if (decided === null) lastFailure = `model ${outcome}: ${error}`;
  }
  if (!decided) return save('UNAVAILABLE', { reason: lastFailure, excluded }, model);

  const chosen = decided.candidateId ? opts.candidates.find((c) => c.id === decided!.candidateId) : undefined;
  const chosenCtx = decided.candidateId ? shown.find((s) => s.candidate.id === decided!.candidateId) : undefined;
  const recent = new Date(now.getTime() - DEFER_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const adverse = chosenCtx?.news.filter((n) => n.polarity === 'NEGATIVE' && n.materiality !== 'LOW' && n.publishedAt >= recent) ?? [];
  const base = {
    candidateId: decided.candidateId, instrumentId: chosen?.instrumentId ?? null, name: chosen?.name ?? null,
    timing: decided.timing, horizonYears: decided.horizonYears, rationale: decided.rationale, keyRisk: decided.keyRisk,
    falsification: decided.falsification, counterargument: decided.counterargument, alternates: decided.alternates, excluded,
  };
  if (decided.decision === 'BUY' && adverse.length > 0) {
    return save('WAIT', { ...base, deferredByNews: true, deferredBecause: adverse.map((a) => a.evidenceId) }, model,
      [...decided.evidenceIds, ...adverse.map((a) => a.evidenceId)]);
  }
  if (decided.decision === 'BUY' || decided.decision === 'SELL') {
    return save(decided.decision, { ...base, amountPaise: chosen!.amountPaise?.toString() ?? null, units: chosen!.units }, model, decided.evidenceIds);
  }
  return save(decided.decision, base, model, decided.evidenceIds);
}
