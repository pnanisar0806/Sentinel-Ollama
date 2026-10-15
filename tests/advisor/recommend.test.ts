import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runAdvisor } from '../../src/advisor/recommend.js';
import type { Candidate } from '../../src/domain/sizing.js';

/**
 * Phase 2.5 Task 6. The model chooses among sized candidates — or HOLD/WAIT — and explains
 * itself for a five-year holder. Deterministic code keeps the size, refuses anything it
 * was not shown, and applies the owner's news rule: news may defer a BUY, never start one.
 * Model replies are stubbed; what is tested is what the system does with them.
 */
let db: Db;
const AS_OF = '2026-09-27';
const NOW = new Date('2026-09-27T10:00:00Z');

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'c-bajaj', action: 'BUY', instrumentId: 'NSE:BAJAJ-AUTO', name: 'Bajaj Auto', status: 'ELIGIBLE', withheldReason: null,
  amountPaise: 4_512_400n, units: '4', pricePaise: 1_128_100n, quoteAsOf: '2026-09-26', basis: 'b', constraints: [], policyVersion: 'sizing-v1',
  ...over,
});

const reply = (content: unknown, ok = true) => {
  let calls = 0;
  const f = (async () => {
    calls++;
    return { ok, status: ok ? 200 : 503, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
};

const good = {
  decision: 'BUY', candidateId: 'c-bajaj', timing: 'this_month', horizonYears: 5,
  rationale: 'Quality franchise with export growth; valuation reasonable.', keyRisk: 'Two-wheeler demand slowdown.',
  falsification: 'Return on capital falls below 15% for two years.', counterargument: 'EV transition may erode margins.',
  evidenceIds: [], alternates: ['WAIT'],
};

async function covered(instrumentId: string, completedAt = '2026-09-26T10:00:00Z'): Promise<void> {
  await db.query(
    `insert into news_fetch_runs (instrument_id, scope_key, window_from, window_to, state, seen, stored, started_at, completed_at, as_of)
     values ($1, '532977', '2026-09-01', '2026-09-26', 'success_empty', 0, 0, $2, $2, $2)`, [instrumentId, completedAt]);
}
async function news(instrumentId: string, polarity: string | null, materiality = 'HIGH', published = '2026-09-20T10:00:00Z'): Promise<number> {
  const [r] = await db.query<{ id: string }>(
    `insert into news_events (dedupe_key, instrument_id, scope, event_type, headline, published_at, received_at, as_of, source)
     values ($1, $2, 'instrument', 'governance', 'Auditor resigned', $3, $3, $3, 'bse') returning id`,
    [`bse:${Math.random()}`, instrumentId, published]);
  if (polarity) {
    await db.query(
      `insert into event_sentiment (event_id, polarity, materiality, summary, model, prompt_version, schema_version, classified_at, as_of)
       values ($1, $2, $3, 's', 'm', 'p', 's', $4, $4)`, [r!.id, polarity, materiality, '2026-09-21T00:00:00Z']);
  }
  return Number(r!.id);
}
const lastProposal = async () => (await db.query<{ payload: Record<string, unknown>; model: string | null }>(
  `select payload, model from advisor_proposals order by id desc limit 1`))[0]!;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:BAJAJ-AUTO', 'EQUITY', 'Bajaj Auto', 'INR'), ('NSE:HAL', 'EQUITY', 'HAL', 'INR')`);
});

describe('before the model is asked', () => {
  it('with no key it records the advisor as unavailable — not HOLD, not WAIT', async () => {
    await covered('NSE:BAJAJ-AUTO');
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: undefined, now: NOW });
    expect(r.decision).toBe('UNAVAILABLE');
    expect((await lastProposal()).model).toBeNull();
    expect(await db.query(`select 1 from llm_calls`)).toHaveLength(0);
    await db.close();
  });

  it('drops a candidate whose news has not been checked in 7 days, and says so', async () => {
    await covered('NSE:BAJAJ-AUTO', '2026-09-10T10:00:00Z');
    const { f, calls } = reply(good);
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: f, now: NOW });
    expect(r.decision).toBe('NO_ACTION');
    expect(calls()).toBe(0);
    expect(JSON.stringify((await lastProposal()).payload)).toMatch(/stale/);
    await db.close();
  });

  it('drops a candidate with news the model has not yet read', async () => {
    await covered('NSE:BAJAJ-AUTO');
    await news('NSE:BAJAJ-AUTO', null);
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: reply(good).f, now: NOW });
    expect(r.decision).toBe('NO_ACTION');
    expect(JSON.stringify((await lastProposal()).payload)).toMatch(/not yet classified/);
    await db.close();
  });
});

describe('what the model decides', () => {
  beforeEach(async () => { await covered('NSE:BAJAJ-AUTO'); });

  it('stores a BUY with the size the sizer set, not one the model supplied', async () => {
    await db.query(`insert into signal_scores (instrument_id, score_date, composite, quality_passed, reg_valuation) values ('NSE:BAJAJ-AUTO', '2026-09-20', 73.2, true, 9.07)`);
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: reply(good).f, now: NOW });
    expect(r.decision).toBe('BUY');
    const p = await lastProposal();
    expect(p.payload).toMatchObject({ decision: 'BUY', candidateId: 'c-bajaj', amountPaise: '4512400', units: '4' });
    // The model is told the scale of every signal part.
    const [snap] = await db.query<{ s: { shown: { signal: { valuation: { score: number; outOf: number } } }[] } }>(`select input_snapshot as s from advisor_proposals order by id desc limit 1`);
    const shown = typeof snap!.s === 'string' ? JSON.parse(snap!.s as unknown as string) : snap!.s;
    expect(shown.shown[0].signal.valuation).toEqual({ score: 9.07, outOf: 30 });
    await db.close();
  });

  it('refuses a candidate it was not shown, an action that does not match, a number, or a short horizon', async () => {
    for (const bad of [
      { ...good, candidateId: 'c-invented' },
      { ...good, decision: 'SELL' },
      { ...good, amountPaise: 99_999_999 },
      { ...good, horizonYears: 0.25 },
    ]) {
      const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: reply(bad).f, now: NOW });
      expect(r.decision).toBe('UNAVAILABLE');
    }
    const outcomes = await db.query<{ outcome: string }>(`select outcome from llm_calls`);
    expect(outcomes.every((o) => o.outcome === 'invalid')).toBe(true);
    await db.close();
  });

  it('accepts HOLD and WAIT as real decisions with no order attached', async () => {
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: reply({ ...good, decision: 'WAIT', candidateId: 'c-bajaj' }).f, now: NOW });
    expect(r.decision).toBe('WAIT');
    expect((await lastProposal()).payload).not.toHaveProperty('amountPaise');
    await db.close();
  });

  it('turns a BUY into WAIT when the company has recent material negative news', async () => {
    await news('NSE:BAJAJ-AUTO', 'NEGATIVE', 'HIGH');
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: reply(good).f, now: NOW });
    expect(r.decision).toBe('WAIT');
    expect((await lastProposal()).payload).toMatchObject({ deferredByNews: true });
    await db.close();
  });

  it('retries a malformed reply once, logging both attempts', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      const content = n === 1 ? '{"decision": BUY broken' : JSON.stringify(good);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    }) as unknown as typeof fetch;
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: f, now: NOW });
    expect(r.decision).toBe('BUY');
    expect((await db.query<{ outcome: string }>(`select outcome from llm_calls order by id`)).map((c) => c.outcome)).toEqual(['invalid', 'ok']);
    await db.close();
  });

  it('a model failure is unavailable and logged', async () => {
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: reply({}, false).f, now: NOW });
    expect(r.decision).toBe('UNAVAILABLE');
    const calls = await db.query<{ outcome: string }>(`select outcome from llm_calls`);
    expect(calls.map((c) => c.outcome)).toEqual(['unavailable', 'unavailable']);
    await db.close();
  });
});

describe('the budget the model sees (SIP tracking Task 8)', () => {
  beforeEach(async () => { await covered('NSE:BAJAJ-AUTO'); });
  const budget = {
    monthlyBudget: '₹50,000', sipTotal: '₹30,254', sipAsOf: '2026-10-14', freeEnvelope: '₹19,746',
    spentThisMonth: '₹5,000', remaining: '₹14,746',
    sips: [{ fund: 'ICICI Nifty 50', amount: '₹14,001', assetClass: 'EQUITY' }],
  };
  const capture = () => {
    const sent: string[] = [];
    const f = (async (_u: string, init: { body: string }) => {
      sent.push(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ...good, decision: 'HOLD', candidateId: null }) } }] }) };
    }) as unknown as typeof fetch;
    return { f, user: () => JSON.parse(JSON.parse(sent[0]!).messages[1].content) };
  };
  const snapshot = async () => {
    const [r] = await db.query<{ s: unknown }>(`select input_snapshot as s from advisor_proposals order by id desc limit 1`);
    return (typeof r!.s === 'string' ? JSON.parse(r!.s) : r!.s) as Record<string, unknown>;
  };

  it('shows the model the budget, SIPs and free envelope, and records exactly that in the snapshot', async () => {
    const { f, user } = capture();
    await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: f, now: NOW, budget });
    expect(user().budget).toEqual(budget);
    expect((await snapshot())['budget']).toEqual(budget);
  });

  it('an unknown envelope still goes in, as null, so the model sees sizing is withheld', async () => {
    const unknown = { monthlyBudget: '₹50,000', sipTotal: null, sipAsOf: null, freeEnvelope: null, spentThisMonth: '₹0', remaining: null, sips: [] };
    const { f, user } = capture();
    await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: f, now: NOW, budget: unknown });
    expect(user().budget).toEqual(unknown);
    expect((await snapshot())['budget']).toEqual(unknown);
  });

  it('no budget given: none is sent or recorded', async () => {
    const { f, user } = capture();
    await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: f, now: NOW });
    expect(user()).not.toHaveProperty('budget');
    expect(await snapshot()).not.toHaveProperty('budget');
  });

  it('a reply echoing an amount from the budget is still rejected', async () => {
    const { f, calls } = reply({ ...good, amount: '₹19,746' });
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: f, now: NOW, budget });
    expect(r.decision).toBe('UNAVAILABLE');
    expect(calls()).toBe(2);
    expect((await db.query<{ error: string }>(`select error from llm_calls`)).every((c) => /"amount"/.test(c.error))).toBe(true);
  });

  it('the prompt tells the model the budget is context, and the version is advise-v2', async () => {
    const { f } = capture();
    let system = '';
    const spy = (async (u: string, init: { body: string }) => { system = JSON.parse(init.body).messages[0].content; return f(u, init as never); }) as unknown as typeof fetch;
    await runAdvisor(db, { asOf: AS_OF, candidates: [cand()], apiKey: 'k', fetchImpl: spy, now: NOW, budget });
    expect(system).toMatch(/"budget" shows his monthly budget.*you still never state an amount/);
    const [p] = await db.query<{ prompt_version: string }>(`select prompt_version from advisor_proposals order by id desc limit 1`);
    expect(p!.prompt_version).toBe('advise-v2');
  });
});
