import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { installIps } from '../../src/domain/ips.js';
import { runLumpSumAdvisor } from '../../src/advisor/lump-sum.js';
import { decideProposal, recordProposal } from '../../src/advisor/proposals.js';
import { allocateLumpSum } from '../../src/domain/lump-sizing.js';
import { logLumpSum } from '../../src/domain/owner-log.js';
import { lumpSumAdvice } from '../../src/jobs/report.js';
import type { Candidate } from '../../src/domain/sizing.js';

/**
 * Batch B §3, Task 5. The advisor picks one destination or an ordered split of the sized
 * candidates — or HOLD/WAIT — and never an amount; the system allocates the lump sum across
 * its picks in that order. Model replies are stubbed, as in recommend.test.ts.
 */
let db: Db;
const AS_OF = '2026-10-30';
const NOW = new Date('2026-10-30T06:00:00Z');
const LUMP = 2_069_100n; // ₹20,691 of Edelweiss bond interest
const lump = { id: 'lump-1', from: 'Edelweiss bond interest', remaining: '₹20,691' };

const fund = (id: string, instrumentId: string, amountPaise: bigint, over: Partial<Candidate> = {}): Candidate => ({
  id, action: 'BUY', instrumentId, name: instrumentId, status: 'ELIGIBLE', withheldReason: null, amountPaise, units: null,
  pricePaise: null, quoteAsOf: null, basis: `basis of ${id}`, constraints: [], policyVersion: 'lump-v1', vehicle: 'FUND',
  fund: { fundType: 'MID', actualBps: 1000, midBps: 2000, minBps: 1500, maxBps: 2500, quality: 'q' }, ...over,
});
const cands = [fund('c-mid', 'MFU:120505', 1_500_000n), fund('c-n50', 'MFU:149000', LUMP)];
const allocate = (cs: Candidate[]) => (ids: string[]) => allocateLumpSum(cs, ids, LUMP).map((p) => ({
  candidateId: p.candidate.id, instrumentId: p.candidate.instrumentId, name: p.candidate.name, amountPaise: p.amountPaise, units: p.units,
}));

const reply = (content: unknown) => {
  const sent: string[] = [];
  const f = (async (_u: string, init: { body: string }) => {
    sent.push(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  }) as unknown as typeof fetch;
  return { f, calls: () => sent.length, user: () => JSON.parse(JSON.parse(sent[0]!).messages[1].content), system: () => JSON.parse(sent[0]!).messages[0].content as string };
};
const good = {
  decision: 'BUY', candidateIds: ['c-mid', 'c-n50'], timing: 'this_month', horizonYears: 7,
  rationale: 'Mid caps are below their approved share; the rest goes to the Next 50 index fund nobody holds yet.',
  keyRisk: 'Mid-cap valuations stay stretched.', falsification: 'Mid caps lag the Nifty 50 by 5%+ a year for three years.',
  counterargument: 'One fund is simpler.', evidenceIds: [], alternates: ['WAIT'],
};
const run = (content: unknown, cs = cands, noKey = false) => {
  const apiKey = noKey ? undefined : 'k';
  const r = reply(content);
  return { r, out: runLumpSumAdvisor(db, { lump, asOf: AS_OF, candidates: cs, apiKey, fetchImpl: r.f, now: NOW, allocate: allocate(cs) }) };
};
const last = async () => (await db.query<{ payload: Record<string, unknown>; kind: string; prompt_version: string; schema_version: string; evidence_ids: string[] }>(
  `select payload, kind, prompt_version, schema_version, evidence_ids from advisor_proposals order by id desc limit 1`))[0]!;

beforeEach(async () => { db = await openDb(); await runMigrations(db); });

describe('runLumpSumAdvisor', () => {
  it('a split BUY stores parts allocated in the model\'s order', async () => {
    const { r, out } = run(good);
    expect((await out).decision).toBe('BUY');
    const p = await last();
    expect(p).toMatchObject({ kind: 'LUMP_SUM', prompt_version: 'lump-v1', schema_version: 'lump-schema-v1' });
    expect(p.payload).toMatchObject({ decision: 'BUY', lumpSumId: 'lump-1', horizonYears: 7, falsification: good.falsification });
    const parts = p.payload['parts'] as { candidateId: string; amountPaise: string; units: string | null }[];
    expect(parts.map((x) => [x.candidateId, x.amountPaise])).toEqual([['c-mid', '1500000'], ['c-n50', '569100']]);
    expect(parts.reduce((s, x) => s + BigInt(x.amountPaise), 0n) <= LUMP).toBe(true);
    // The model sees what is left as a formatted rupee string, never a number to echo.
    expect(r.user().lumpSum).toEqual({ from: 'Edelweiss bond interest', remaining: '₹20,691' });
    expect(r.system()).toMatch(/one-off amount on top of the monthly budget/);
    expect(r.system()).toMatch(/"candidateIds"/);
    expect(p.payload).not.toHaveProperty('whyNotFund');
  });

  it('the model naming an amount is invalid and ends UNAVAILABLE', async () => {
    const { r, out } = run({ ...good, amount: '₹20,691' });
    expect((await out).decision).toBe('UNAVAILABLE');
    expect(r.calls()).toBe(2);
    const errs = await db.query<{ outcome: string; error: string; seam: string }>(`select outcome, error, seam from llm_calls order by id`);
    expect(errs.map((e) => [e.seam, e.outcome])).toEqual([['lump', 'invalid'], ['lump', 'invalid']]);
    expect((await last()).payload).toMatchObject({ decision: 'UNAVAILABLE', parts: [] });
  });

  it('an id not offered is invalid', async () => {
    const { out } = run({ ...good, candidateIds: ['c-mid', 'c-invented'] });
    expect((await out).decision).toBe('UNAVAILABLE');
  });

  it('a duplicate id is invalid', async () => {
    const { out } = run({ ...good, candidateIds: ['c-mid', 'c-mid'] });
    expect((await out).decision).toBe('UNAVAILABLE');
  });

  it('a BUY with no ids, or a SELL, is invalid', async () => {
    expect((await run({ ...good, candidateIds: [] }).out).decision).toBe('UNAVAILABLE');
    expect((await run({ ...good, decision: 'SELL' }).out).decision).toBe('UNAVAILABLE');
  });

  it('HOLD is stored as HOLD with no parts', async () => {
    const { out } = run({ ...good, decision: 'HOLD', candidateIds: [] });
    expect((await out).decision).toBe('HOLD');
    expect((await last()).payload).toMatchObject({ decision: 'HOLD', parts: [], rationale: good.rationale });
  });

  it('a stock among the picks must say why not a fund', async () => {
    await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:HAL', 'EQUITY', 'HAL', 'INR')`);
    await db.query(`insert into news_fetch_runs (instrument_id, scope_key, window_from, window_to, state, seen, stored, started_at, completed_at, as_of)
                    values ('NSE:HAL', '541154', '2026-10-01', '2026-10-29', 'success_empty', 0, 0, $1, $1, $1)`, ['2026-10-29T10:00:00Z']);
    const stock = fund('c-hal', 'NSE:HAL', 1_000_000n, { vehicle: 'STOCK', fund: null, name: 'HAL' });
    const cs = [...cands, stock];
    expect((await run({ ...good, candidateIds: ['c-hal', 'c-mid'] }, cs).out).decision).toBe('UNAVAILABLE');
    expect((await run({ ...good, candidateIds: ['c-hal', 'c-mid'], whyNotFund: 'Defence capex no fund holds much of.' }, cs).out).decision).toBe('BUY');
    expect((await last()).payload).toMatchObject({ whyNotFund: 'Defence capex no fund holds much of.' });
  });

  it('news defers an adversely-newsed pick; the rest stay, and with none left it is WAIT', async () => {
    await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:HAL', 'EQUITY', 'HAL', 'INR')`);
    await db.query(`insert into news_fetch_runs (instrument_id, scope_key, window_from, window_to, state, seen, stored, started_at, completed_at, as_of)
                    values ('NSE:HAL', '541154', '2026-10-01', '2026-10-29', 'success_empty', 0, 0, $1, $1, $1)`, ['2026-10-29T10:00:00Z']);
    const [e] = await db.query<{ id: string }>(
      `insert into news_events (dedupe_key, instrument_id, scope, event_type, headline, published_at, received_at, as_of, source)
       values ('bse:x', 'NSE:HAL', 'instrument', 'governance', 'Auditor resigned', $1, $1, $1, 'bse') returning id`, ['2026-10-20T10:00:00Z']);
    await db.query(`insert into event_sentiment (event_id, polarity, materiality, summary, model, prompt_version, schema_version, classified_at, as_of)
                    values ($1, 'NEGATIVE', 'HIGH', 's', 'm', 'p', 's', $2, $2)`, [e!.id, '2026-10-21T00:00:00Z']);
    const stock = fund('c-hal', 'NSE:HAL', 1_000_000n, { vehicle: 'STOCK', fund: null, name: 'HAL' });
    const cs = [...cands, stock];
    const why = { whyNotFund: 'Defence capex no fund holds much of.' };
    expect((await run({ ...good, ...why, candidateIds: ['c-hal', 'c-mid'] }, cs).out).decision).toBe('BUY');
    expect(((await last()).payload['parts'] as { candidateId: string }[]).map((x) => x.candidateId)).toEqual(['c-mid']);
    expect((await last()).payload).not.toHaveProperty('whyNotFund');
    expect((await run({ ...good, ...why, candidateIds: ['c-hal'] }, cs).out).decision).toBe('WAIT');
    expect((await last()).payload).toMatchObject({ decision: 'WAIT', deferredByNews: true, deferredBecause: [`news:${e!.id}`], parts: [] });
  });

  it('an empty allocation is WAIT: no pick could be bought with the amount left', async () => {
    const tooDear = fund('c-gold', 'NSE:GOLDBEES', LUMP, { pricePaise: LUMP + 1n });
    const { out } = run({ ...good, candidateIds: ['c-gold'] }, [tooDear]);
    expect((await out).decision).toBe('WAIT');
    expect((await last()).payload).toMatchObject({ reason: 'no pick could be bought with the amount left', parts: [] });
  });

  it('no eligible candidate is NO_ACTION with no call; no key is UNAVAILABLE, never HOLD', async () => {
    const withheld = [fund('c-mid', 'MFU:120505', null as unknown as bigint, { status: 'WITHHELD', withheldReason: 'Mid cap is at its range max' })];
    const a = run(good, withheld);
    expect((await a.out).decision).toBe('NO_ACTION');
    expect(a.r.calls()).toBe(0);
    const b = run(good, cands, true);
    expect((await b.out).decision).toBe('UNAVAILABLE');
    expect(b.r.calls()).toBe(0);
  });
});

describe('lumpSumAdvice in the weekly report', () => {
  const GEN = '2026-10-30T06:00:00.000Z';
  const opts = { apiKey: undefined, model: undefined };
  const count = async () => (await db.query(`select 1 from advisor_proposals where kind = 'LUMP_SUM'`)).length;
  const prior = (lumpSumId: string, decision: string, asOf: string) => recordProposal(db, {
    kind: 'LUMP_SUM', payload: { decision, lumpSumId, parts: [] }, inputSnapshot: {}, evidenceIds: [], model: null,
    promptVersion: 'lump-v1', schemaVersion: 'lump-schema-v1', asOf,
  });
  let id: string;
  beforeEach(async () => {
    await installIps(db);
    ({ id } = await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, GEN));
  });

  it('advises a lump with no proposal yet, and says so in the report', async () => {
    const line = await lumpSumAdvice(db, AS_OF, GEN, opts);
    expect(await count()).toBe(1);
    expect(line).toMatch(/^\n\nLump sum ₹20,691 \(Edelweiss bond interest\): (NO_ACTION|UNAVAILABLE)\. Review it on the Advisor page\.$/);
  });

  it('skips a lump with an OPEN proposal and re-advises after a dismissal', async () => {
    const p = await prior(id, 'BUY', '2026-09-01T00:00:00Z');
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toBe('');
    expect(await count()).toBe(1);
    await decideProposal(db, p, 'DISMISSED', 'not now');
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toMatch(/Lump sum ₹20,691/);
    expect(await count()).toBe(2);
  });

  it('reads a payload stored as a jsonb string, as prod stores it', async () => {
    await db.query(`insert into advisor_proposals (kind, payload, input_snapshot, prompt_version, schema_version, as_of)
                    values ('LUMP_SUM', to_jsonb($1::text), '{}'::jsonb, 'lump-v1', 'lump-schema-v1', $2)`,
      [JSON.stringify({ decision: 'BUY', lumpSumId: id, parts: [] }), '2026-10-29T00:00:00Z']);
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toBe('');
    expect(await count()).toBe(1);
  });

  it('a signed BUY is left alone', async () => {
    await decideProposal(db, await prior(id, 'BUY', '2026-09-01T00:00:00Z'), 'SIGNED', '');
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toBe('');
    expect(await count()).toBe(1);
  });

  it('a HOLD/WAIT/NO_ACTION/UNAVAILABLE is re-advised only once it is older than 28 days', async () => {
    await prior(id, 'WAIT', '2026-10-10T00:00:00Z');
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toBe('');
    await prior(id, 'UNAVAILABLE', '2026-10-01T00:00:00Z');
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toMatch(/Lump sum/);
    expect(await count()).toBe(3);
  });

  it('another lump sum\'s proposal does not count', async () => {
    await prior('someone-else', 'BUY', '2026-10-29T00:00:00Z');
    expect(await lumpSumAdvice(db, AS_OF, GEN, opts)).toMatch(/Lump sum/);
  });
});
