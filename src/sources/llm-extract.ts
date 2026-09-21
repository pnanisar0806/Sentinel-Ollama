import { rupees, type Paise } from '../money/paise.js';

/**
 * LLM-powered statement extraction: a screenshot goes to a free vision model on
 * OpenRouter, anchored against the owner's CURRENT portfolio list so the model maps
 * what it sees onto known instruments (line numbers) instead of inventing identities.
 *
 * The output is a PROPOSAL — nothing writes until the owner confirms in Telegram
 * (same approval-gate philosophy as trading). FR-02 applies: unreadable cost is
 * dropped, never inferred.
 */

import { VISION_MODEL_CHAIN } from '../config/models.js';

export { VISION_MODEL_CHAIN };

/**
 * Vision extraction runs on the Ling 3.0 VL model first (owner decision 2026-09-13 — one
 * model family for the whole project), then walks the free chain when the pool saturates.
 * The finance-tuned `ling-3.0-flash-fin` cannot appear here: it is text-only.
 */
export const DEFAULT_LLM_MODEL = VISION_MODEL_CHAIN[0];
export const LLM_MODEL_CHAIN = [...VISION_MODEL_CHAIN];

export interface LlmProposal {
  /** Zero-based index into the positions list passed in; null = unmatched. */
  line: number | null;
  name: string;
  costPaise: Paise;
  acquiredOn: string;
  confidence: 'high' | 'low';
}

const SYSTEM_RULES = [
  'You read brokerage / mutual-fund statement screenshots for one user.',
  'Below is the user\u2019s CURRENT portfolio, numbered. Each row may show fund/stock names,',
  '"Invested" amounts, quantities and dates. For every holding visible in the image, return',
  'its TOTAL INVESTED (cost) amount in INR.',
  'Respond ONLY with JSON, no prose: {"items":[{"line":<number from the list, or null>,',
  '"name":"<as printed in the image>","totalCostInr":"<digits only>","acquiredOn":"YYYY-MM-DD or omit",',
  '"confidence":"high"|"low"}]}',
  'Rules: totalCostInr is the WHOLE position\u2019s cost (Invested Rs 6.12L -> "612000"). If only a',
  'per-unit price is visible, multiply by units when units are visible, else answer with your',
  'best total at confidence "low". Never invent: omit items you cannot read. Set "line" only',
  'when the image row clearly corresponds to a listed portfolio row; otherwise null.',
].join('\n');

/**
 * Shared OpenRouter vision pass: send one or more images with a task prompt to the free
 * vision-model chain, retry once on the primary, walk the chain on 429, strip JSON fences
 * and return whatever JSON the model produced — ANY shape. Callers map the shape they
 * expect (brokerage `{items:[…]}`, Fidelity `{vests:[…]}`, …).
 */
export async function extractJsonFromImage(deps: {
  fetchImpl: typeof fetch;
  apiKey: string;
  /** Explicit model override; when absent the free-model chain is walked. */
  model?: string;
  /** One or more pages of the same statement — all sent in a single request. */
  images: { base64: string; mimeType: string }[];
  prompt: string;
}): Promise<unknown> {
  const models = deps.model ? [deps.model] : LLM_MODEL_CHAIN;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const imageParts = deps.images.map((im) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${im.mimeType};base64,${im.base64}` },
  }));

  // Why each model was given up on, so a total failure names what was tried rather than
  // reporting only whichever one happened to be last.
  const failures: string[] = [];
  for (let m = 0; m < models.length; m++) {
    const model = models[m]!;
    // Primary model earns one retry (transient upstream blips); the rest get one shot
    // so the worst-case walk stays under ~30s.
    const attempts = m === 0 ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const res = await deps.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: deps.prompt }, ...imageParts],
          }],
        }),
      });

      const body = await res.json() as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string; code?: number; metadata?: { raw?: string } };
      };
      if (!res.ok || body.error) {
        const code = body.error?.code ?? res.status;
        failures.push(`${model}: ${code} ${body.error?.message ?? `HTTP ${res.status}`}`);
        // The primary earns one quick retry on saturation, since the free pool frees up
        // in bursts.
        if (code === 429 && attempt === 0 && m === 0) {
          failures.pop();
          await sleep(2_000);
          continue;
        }
        // Everything else moves to the next model. This used to walk the chain ONLY on
        // 429 and throw on anything else, so when OpenRouter retired
        // `minimax/minimax-m3:free` the 404 killed the whole extraction and the five
        // healthy models behind it were never tried — a fallback chain that gave up on
        // the second most likely failure it exists to survive.
        if (code === 429) await sleep(1_500); // be polite to the next free pool
        break;
      }

      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenRouter returned no message content');

      // Models love wrapping JSON in fences even when told not to.
      return JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    }
  }
  throw new Error(
    `OpenRouter failed after trying ${models.length} model(s) — ${failures.join('; ')}`,
  );
}

/** Brokerage-schema extraction: `{items:[{line,name,totalCostInr,acquiredOn,confidence}]}`. */
export async function extractHoldingsFromImage(deps: {
  fetchImpl: typeof fetch;
  apiKey: string;
  /** Explicit model override; when absent the free-model chain is walked. */
  model?: string;
  /** One or more pages of the same statement — all sent in a single request. */
  images: { base64: string; mimeType: string }[];
  positions: { name: string; instrumentId: string; account: string }[];
  /** Owner-verified "TICKER = Holding name" lines. Statement screenshots show exchange
   *  symbols; without these the model must fuzzy-match tickers to long names, which is
   *  where near-identical rows (TMCV/TMPV) get swapped. */
  knownTickers?: string[];
  now?: Date;
}): Promise<LlmProposal[]> {
  const now = deps.now ?? new Date();
  const list = deps.positions
    .map((p, i) => `${i + 1}. ${p.name} (${p.account})`)
    .join('\n');
  const hints = deps.knownTickers?.length
    ? `\n\nKNOWN SYMBOL MAPPINGS — a row displaying one of these symbols belongs to exactly this holding:\n${deps.knownTickers.map((s) => `- ${s}`).join('\n')}\nUse the symbol to pick the line with certainty; do not guess between similar names.`
    : '';
  const prompt = `${SYSTEM_RULES}\n\nYou may be given several images: they are consecutive\npages of the SAME statement — treat them as one document.\n\nCURRENT PORTFOLIO:\n${list || '(empty)'}${hints}`;

  const parsed = await extractJsonFromImage({
    fetchImpl: deps.fetchImpl,
    apiKey: deps.apiKey,
    ...(deps.model ? { model: deps.model } : {}),
    images: deps.images,
    prompt,
  });
  if (typeof parsed !== 'object' || parsed === null) return [];
  const items = (parsed as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];

  const proposals: LlmProposal[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.totalCostInr !== 'string') continue;
    let costPaise: Paise;
    try {
      costPaise = rupees(r.totalCostInr.replace(/[₹,\s]/g, ''));
    } catch {
      continue; // unreadable cost is dropped, never guessed
    }
    if (costPaise <= 0n) continue;
    const line = typeof r.line === 'number' && r.line >= 1 && r.line <= deps.positions.length
      ? r.line - 1
      : null;
    const acquiredOn = typeof r.acquiredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.acquiredOn)
      ? r.acquiredOn
      : now.toISOString().slice(0, 10);
    proposals.push({
      line,
      name: typeof r.name === 'string' ? r.name : '(unnamed)',
      costPaise,
      acquiredOn,
      confidence: r.confidence === 'high' ? 'high' : 'low',
    });
  }
  return proposals;
}
