import type { Db } from '../db/client.js';
import { OPENROUTER_CHAT_URL, TEXT_MODEL } from '../config/models.js';
import { firstJson } from '../sources/sentiment.js';
import { recordLlmCall, recordProposal } from './proposals.js';

/**
 * Bounded commentary (Phase 2.5 Task 8).
 *
 * The model writes prose about facts the system computed. Every number in a section must
 * be bound to a fact, quoted exactly as the fact renders it, in a sentence that names the
 * fact's subject. That catches the failure a "does the number appear anywhere" check
 * misses: the right number given to the wrong company. The prose itself stays the model's
 * reasoning, not verified fact; it never changes a score, a size or a decision.
 * A section that fails validation is dropped; with no valid section the deterministic
 * bullets are the whole report.
 */

export const COMMENTARY_PROMPT_VERSION = 'commentary-v1';
const MAX_WORDS = 300;

export interface Fact { id: string; subject: string; field: string; value: string; period: string }
export interface Section { title: string; text: string; claims: { factId: string; quoted: string }[]; evidenceIds: string[] }

const NUMBER = /[-+]?₹?\d[\d,]*(?:\.\d+)?%?/g;
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);
const numbersIn = (t: string): string[] => t.match(NUMBER) ?? [];

export function validateSection(s: Section, facts: Fact[]): void {
  const byId = new Map(facts.map((f) => [f.id, f]));
  if (s.text.trim().split(/\s+/).length > MAX_WORDS) throw new Error(`section "${s.title}" is over ${MAX_WORDS} words`);
  for (const e of s.evidenceIds) if (!byId.has(e)) throw new Error(`section "${s.title}" cites unknown fact ${e}`);

  for (const c of s.claims) {
    const f = byId.get(c.factId);
    if (!f) throw new Error(`section "${s.title}" binds an unknown fact ${c.factId}`);
    // `quoted` may be the value or a phrase around it; either way every number in it must
    // be one of the fact's own numbers.
    const nums = numbersIn(c.quoted);
    const factNums = numbersIn(f.value);
    if (nums.length === 0 || !nums.every((n) => factNums.includes(n))) {
      throw new Error(`"${c.quoted}" does not match ${f.subject} ${f.field} (${f.value})`);
    }
    for (const n of nums) {
      const where = sentences(s.text).filter((x) => numbersIn(x).includes(n));
      if (where.length === 0) throw new Error(`"${n}" is bound but not in the text`);
      if (!where.every((x) => x.toLowerCase().includes(f.subject.toLowerCase()))) {
        throw new Error(`"${n}" appears in a sentence that does not name its subject ${f.subject}`);
      }
    }
  }
  const bound = s.claims.flatMap((c) => numbersIn(c.quoted));
  for (const n of numbersIn(s.text)) {
    if (!bound.includes(n)) throw new Error(`unbound number "${n}" in section "${s.title}"`);
  }
}

const PROMPT = [
  'Write a short weekly commentary for a long-term investor from the facts given. Plain English.',
  'At most 3 sections, each at most 300 words. Do not predict prices. Do not suggest trades.',
  'Every number you write must be copied exactly from a fact\'s "value", in a sentence that names that fact\'s "subject",',
  'and listed in "claims" as {"factId","quoted"}. Write no number that is not a fact.',
  'Reply with JSON only: {"sections":[{"title":"..","text":"..","claims":[{"factId":"..","quoted":".."}],"evidenceIds":[".."]}]}',
].join('\n');

export async function writeCommentary(
  db: Db,
  opts: { facts: Fact[]; apiKey: string | undefined; model?: string | undefined; fetchImpl?: typeof fetch; asOf: string },
): Promise<{ sections: Section[]; dropped: string[]; unavailable: boolean }> {
  if (!opts.apiKey) return { sections: [], dropped: [], unavailable: true };
  const model = opts.model || TEXT_MODEL;
  const started = Date.now();
  let outcome: 'ok' | 'unavailable' | 'invalid' | 'error' = 'ok';
  let error: string | null = null;
  let raw: Section[] = [];
  try {
    const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify({ asOf: opts.asOf, facts: opts.facts }) }] }),
    });
    if (!res.ok) { outcome = 'unavailable'; error = `HTTP ${res.status}`; }
    else {
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      try {
        const parsed = firstJson(body.choices?.[0]?.message?.content ?? '') as { sections?: unknown };
        if (!Array.isArray(parsed.sections)) throw new Error('no sections array');
        raw = (parsed.sections as Record<string, unknown>[]).slice(0, 3).map((s) => ({
          title: String(s['title'] ?? ''), text: String(s['text'] ?? ''),
          claims: Array.isArray(s['claims']) ? (s['claims'] as Record<string, unknown>[]).map((c) => ({ factId: String(c['factId']), quoted: String(c['quoted']) })) : [],
          evidenceIds: Array.isArray(s['evidenceIds']) ? (s['evidenceIds'] as unknown[]).map(String) : [],
        }));
      } catch (e) { outcome = 'invalid'; error = e instanceof Error ? e.message : String(e); }
    }
  } catch (e) { outcome = 'error'; error = e instanceof Error ? e.message : String(e); }
  await recordLlmCall(db, { seam: 'commentary', model, latencyMs: Date.now() - started, outcome, promptTokens: null, completionTokens: null, error });

  const sections: Section[] = []; const dropped: string[] = [];
  for (const s of raw) {
    try { validateSection(s, opts.facts); sections.push(s); } catch (e) { dropped.push(e instanceof Error ? e.message : String(e)); }
  }
  if (sections.length > 0) {
    await recordProposal(db, {
      kind: 'COMMENTARY', payload: { sections, dropped }, inputSnapshot: { facts: opts.facts },
      evidenceIds: [...new Set(sections.flatMap((s) => s.evidenceIds))], model,
      promptVersion: COMMENTARY_PROMPT_VERSION, schemaVersion: 'commentary-schema-v1', asOf: new Date().toISOString(),
    });
  }
  return { sections, dropped, unavailable: outcome !== 'ok' };
}
