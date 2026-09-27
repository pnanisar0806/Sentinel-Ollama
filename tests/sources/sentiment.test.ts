import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { classifyPending, firstJson, latestSentiment, parseClassification } from '../../src/sources/sentiment.js';

/**
 * Phase 2.5 Task 3. The model reads each material filing and says which way it cuts and
 * how much it matters. It never guesses: unsure is UNKNOWN, a failure leaves the event
 * pending, and nothing it says becomes a number in an engine score. The model replies
 * here are stubbed — a real model's economic judgement is not something a test can pin.
 */
let db: Db;
const NOW = new Date('2026-09-27T10:00:00Z');

async function event(id: string, headline: string, type = 'results'): Promise<number> {
  const [r] = await db.query<{ id: string }>(
    `insert into news_events (dedupe_key, instrument_id, scope, event_type, headline, published_at, received_at, as_of, source)
     values ($1, 'NSE:X', 'instrument', $2, $3, '2026-09-20T10:00:00Z', $4, $4, 'bse') returning id`,
    [`bse:${id}`, type, headline, NOW.toISOString()]);
  return Number(r!.id);
}

const model = (content: unknown, ok = true) => {
  const calls: unknown[] = [];
  const f = (async (_u: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return { ok, status: ok ? 200 : 503, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
  }) as unknown as typeof fetch;
  return { f, calls };
};

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:X', 'EQUITY', 'X Ltd', 'INR')`);
});

describe('reading the model\'s answer', () => {
  it('accepts only the closed vocabulary, and only events it was shown', () => {
    const ok = parseClassification({ items: [{ eventId: 1, polarity: 'NEGATIVE', materiality: 'HIGH', summary: 'Auditor resigned.' }] }, [1]);
    expect(ok).toEqual([{ eventId: 1, polarity: 'NEGATIVE', materiality: 'HIGH', summary: 'Auditor resigned.' }]);
    expect(() => parseClassification({ items: [{ eventId: 1, polarity: 'BULLISH', materiality: 'HIGH', summary: 's' }] }, [1])).toThrow(/polarity/);
    expect(() => parseClassification({ items: [{ eventId: 9, polarity: 'NEUTRAL', materiality: 'LOW', summary: 's' }] }, [1])).toThrow(/not shown/);
    expect(() => parseClassification({ items: [{ eventId: 1, polarity: 'NEUTRAL', materiality: 'LOW', summary: Array(90).fill('w').join(' ') }] }, [1])).toThrow(/80 words/);
  });
});

describe('extracting the JSON', () => {
  it('takes the first JSON value, ignoring a fence and trailing prose, and repairs nothing', () => {
    expect(firstJson('```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(firstJson('{"items":[{"summary":"a } in \\"text\\""}]} Hope this helps!')).toEqual({ items: [{ summary: 'a } in "text"' }] });
    expect(parseClassification([{ eventId: 1, polarity: 'NEUTRAL', materiality: 'LOW', summary: 's' }], [1])).toHaveLength(1);
    expect(() => firstJson('{"items":[')).toThrow(/incomplete/);
  });
});

describe('classifying pending events', () => {
  it('stores each classification with its provenance and logs the call', async () => {
    const id = await event('1', 'Resignation of statutory auditor', 'governance');
    const { f } = model({ items: [{ eventId: id, polarity: 'NEGATIVE', materiality: 'HIGH', summary: 'The auditor resigned mid-term.' }] });
    const r = await classifyPending(db, { apiKey: 'k', fetchImpl: f, now: NOW });
    expect(r).toMatchObject({ classified: 1, pending: 0 });
    expect(await latestSentiment(db, id, NOW)).toMatchObject({ polarity: 'NEGATIVE', materiality: 'HIGH', promptVersion: expect.any(String) });
    const [call] = await db.query<{ outcome: string; prompt_tokens: number }>(`select outcome, prompt_tokens from llm_calls`);
    expect(call).toEqual({ outcome: 'ok', prompt_tokens: 100 });
    await db.close();
  });

  it('leaves events pending — never neutral — when there is no key or the call fails', async () => {
    const id = await event('1', 'Financial results');
    expect(await classifyPending(db, { apiKey: undefined, now: NOW })).toMatchObject({ classified: 0, pending: 1 });
    const { f } = model({}, false);
    expect(await classifyPending(db, { apiKey: 'k', fetchImpl: f, now: NOW })).toMatchObject({ classified: 0, pending: 1 });
    expect(await latestSentiment(db, id, NOW)).toBeNull();
    const [call] = await db.query<{ outcome: string }>(`select outcome from llm_calls`);
    expect(call!.outcome).toBe('unavailable');
    await db.close();
  });

  it('asks about at most 20 events per call', async () => {
    for (let i = 0; i < 25; i++) await event(String(i), `Filing ${i}`);
    const { f, calls } = model({ items: [] });
    await classifyPending(db, { apiKey: 'k', fetchImpl: f, now: NOW });
    const sizes = (calls as { messages: { content: string }[] }[]).map((c) => (c.messages[1]!.content.match(/"eventId"/g) ?? []).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(25);
    await db.close();
  });

  it('a reclassification appends; readers see what was known by their cutoff', async () => {
    const id = await event('1', 'Financial results');
    await classifyPending(db, { apiKey: 'k', fetchImpl: model({ items: [{ eventId: id, polarity: 'POSITIVE', materiality: 'MEDIUM', summary: 'Profit up.' }] }).f, now: NOW });
    const later = new Date(NOW.getTime() + 86_400_000);
    await classifyPending(db, { apiKey: 'k', fetchImpl: model({ items: [{ eventId: id, polarity: 'NEGATIVE', materiality: 'MEDIUM', summary: 'Restated.' }] }).f, now: later, reclassify: [id] });
    expect((await latestSentiment(db, id, NOW))!.polarity).toBe('POSITIVE');
    expect((await latestSentiment(db, id, later))!.polarity).toBe('NEGATIVE');
    await db.close();
  });
});
