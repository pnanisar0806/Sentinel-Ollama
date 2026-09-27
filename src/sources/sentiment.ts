import type { Db } from '../db/client.js';
import { OPENROUTER_CHAT_URL, TEXT_MODEL } from '../config/models.js';
import { recordLlmCall } from '../advisor/proposals.js';

/**
 * The model's reading of each material filing (Phase 2.5 Task 3): which way it cuts for
 * a long-term holder, and how much it matters. It reads the filing's headline and
 * subject only — BSE's PDFs are not parsed — so UNKNOWN is a normal, honest answer.
 *
 * Never a guess: a closed vocabulary, events it was actually shown, and a failure leaves
 * the event PENDING (no row), which the advisor treats as "not yet understood", not neutral.
 */

export const PROMPT_VERSION = 'sentiment-v1';
export const SCHEMA_VERSION = 'sentiment-schema-v1';
export const BATCH = 20;

const POLARITY = ['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNKNOWN'] as const;
const MATERIALITY = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type Polarity = typeof POLARITY[number];
export type Materiality = typeof MATERIALITY[number];

export interface Classification { eventId: number; polarity: Polarity; materiality: Materiality; summary: string }

const PROMPT = [
  'You read Indian stock-exchange filings for a long-term investor (5-year horizon) who',
  'does not trade. For each filing say how it bears on the long-term thesis of owning the',
  'company, NOT on next week\'s price.',
  'polarity: POSITIVE | NEGATIVE | NEUTRAL | UNKNOWN. materiality: HIGH | MEDIUM | LOW | UNKNOWN.',
  'Use UNKNOWN whenever the headline alone does not tell you — you only see the headline and',
  'subject, not the document. A buyback or an order win is not automatically positive.',
  'summary: at most 80 words, plain English, only what the filing says.',
  'Reply with JSON only: {"items":[{"eventId":<number>,"polarity":..,"materiality":..,"summary":..}]}.',
  'Include only eventIds you were given.',
].join('\n');

export function parseClassification(raw: unknown, shown: number[]): Classification[] {
  // Some replies are a bare array rather than {items: [...]}; the content rules are the same.
  const items = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error('reply has no items array');
  return items.map((it) => {
    const i = it as Record<string, unknown>;
    const eventId = Number(i['eventId']);
    if (!shown.includes(eventId)) throw new Error(`event ${String(i['eventId'])} was not shown to the model`);
    const polarity = String(i['polarity']);
    const materiality = String(i['materiality']);
    if (!(POLARITY as readonly string[]).includes(polarity)) throw new Error(`bad polarity ${polarity}`);
    if (!(MATERIALITY as readonly string[]).includes(materiality)) throw new Error(`bad materiality ${materiality}`);
    const summary = String(i['summary'] ?? '').trim();
    if (summary === '') throw new Error(`event ${eventId}: empty summary`);
    if (summary.split(/\s+/).length > 80) throw new Error(`event ${eventId}: summary over 80 words`);
    return { eventId, polarity: polarity as Polarity, materiality: materiality as Materiality, summary };
  });
}

/**
 * The first complete JSON value in a reply: drops a ```json fence and any prose the model
 * appends after the JSON. Nothing inside the value is repaired or guessed.
 */
export function firstJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '');
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('reply contains no JSON');
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i]!;
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error('reply JSON is incomplete');
}

export async function classifyPending(
  db: Db,
  opts: { apiKey: string | undefined; model?: string; fetchImpl?: typeof fetch; now?: Date; reclassify?: number[] },
): Promise<{ classified: number; pending: number; rejected: number }> {
  const now = opts.now ?? new Date();
  const model = opts.model || TEXT_MODEL;
  const events = await db.query<{ id: string; headline: string; snippet: string | null; event_type: string; raw_subcategory: string | null; name: string | null }>(
    `select e.id, e.headline, e.snippet, e.event_type, e.raw_subcategory, i.name
       from news_events e left join instruments i on i.id = e.instrument_id
      where ${opts.reclassify ? 'e.id = any($1)' : 'not exists (select 1 from event_sentiment s where s.event_id = e.id) and $1::bigint[] is null'}
      order by e.published_at desc`,
    [opts.reclassify ?? null],
  );
  const out = { classified: 0, pending: events.length, rejected: 0 };
  if (!opts.apiKey || events.length === 0) return out;

  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    const shown = batch.map((e) => Number(e.id));
    const started = Date.now();
    let outcome: 'ok' | 'unavailable' | 'invalid' | 'error' = 'ok';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let error: string | null = null;
    let parsed: Classification[] = [];
    try {
      const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: JSON.stringify(batch.map((e) => ({
              eventId: Number(e.id), company: e.name, type: e.event_type, subject: e.raw_subcategory, headline: e.headline, detail: e.snippet,
            }))) },
          ],
        }),
      });
      if (!res.ok) { outcome = 'unavailable'; error = `HTTP ${res.status}`; }
      else {
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: typeof usage };
        usage = body.usage;
        try { parsed = parseClassification(firstJson(body.choices?.[0]?.message?.content ?? ''), shown); }
        catch (e) { outcome = 'invalid'; error = e instanceof Error ? e.message : String(e); }
      }
    } catch (e) { outcome = 'error'; error = e instanceof Error ? e.message : String(e); }

    await recordLlmCall(db, {
      seam: 'sentiment', model, latencyMs: Date.now() - started, outcome,
      promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null, error,
    });
    if (outcome !== 'ok') { out.rejected += outcome === 'invalid' ? batch.length : 0; continue; }
    for (const c of parsed) {
      await db.query(
        `insert into event_sentiment (event_id, polarity, materiality, summary, model, prompt_version, schema_version, classified_at, as_of)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [c.eventId, c.polarity, c.materiality, c.summary, model, PROMPT_VERSION, SCHEMA_VERSION, now.toISOString()],
      );
      out.classified++;
      out.pending--;
    }
  }
  return out;
}

export interface StoredSentiment extends Omit<Classification, 'eventId'> { model: string; promptVersion: string; classifiedAt: string }

/** The latest reading available at `cutoff` — not the latest now, so a replay cannot see the future. */
export async function latestSentiment(db: Db, eventId: number, cutoff = new Date()): Promise<StoredSentiment | null> {
  const [r] = await db.query<{ polarity: Polarity; materiality: Materiality; summary: string; model: string; prompt_version: string; classified_at: string | Date }>(
    `select polarity, materiality, summary, model, prompt_version, classified_at from event_sentiment
      where event_id = $1 and classified_at <= $2 order by classified_at desc, id desc limit 1`,
    [eventId, cutoff.toISOString()],
  );
  return r ? {
    polarity: r.polarity, materiality: r.materiality, summary: r.summary, model: r.model,
    promptVersion: r.prompt_version, classifiedAt: new Date(r.classified_at).toISOString(),
  } : null;
}
