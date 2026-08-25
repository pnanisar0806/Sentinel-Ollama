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

export const DEFAULT_LLM_MODEL = 'google/gemma-4-31b-it:free';
/**
 * Every free vision-capable model on OpenRouter, ordered for THIS task (reading
 * financial-statement screenshots, returning strict JSON):
 *
 *  1. gemma-4-31b-it        — strongest dense generalist vision; reliable JSON discipline
 *  2. minimax-m3            — frontier-class generalist, 1M ctx; strong doc understanding
 *  3. dots-3-note-preview   — document/OCR specialist (great at tables); 'preview' = less stable
 *  4. gemma-4-26b-a4b-it    — lighter/faster Gemma MoE; solid second Gemma
 *  5. inkling               — serious lab, 1M ctx, but unproven at OCR-style extraction
 *  6. inkling-small         — its smaller sibling
 *  7. nemotron-3-nano-omni  — tiny active params (A3B); last resort
 *
 * EXCLUDED: nvidia/nemotron-3.5-content-safety:free — it is a safety CLASSIFIER,
 * not an extraction model; it would refuse or nonsense the task.
 *
 * Free models share OpenRouter's public upstream pool, which is regularly saturated
 * (429 'temporarily rate-limited upstream'): the primary retries once, then the chain
 * walks with a short pause between models. Order = preference.
 */
export const LLM_MODEL_CHAIN = [
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m3:free',
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
];

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

export async function extractHoldingsFromImage(deps: {
  fetchImpl: typeof fetch;
  apiKey: string;
  /** Explicit model override; when absent the free-model chain is walked. */
  model?: string;
  imageBase64: string;
  imageMimeType: string;
  positions: { name: string; instrumentId: string; account: string }[];
  now?: Date;
}): Promise<LlmProposal[]> {
  const now = deps.now ?? new Date();
  const list = deps.positions
    .map((p, i) => `${i + 1}. ${p.name} (${p.account})`)
    .join('\n');
  const prompt = `${SYSTEM_RULES}\n\nCURRENT PORTFOLIO:\n${list || '(empty)'}`;
  const models = deps.model ? [deps.model] : LLM_MODEL_CHAIN;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let lastRaw = '';
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
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${deps.imageMimeType};base64,${deps.imageBase64}` } },
            ],
          }],
        }),
      });

      const body = await res.json() as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string; code?: number; metadata?: { raw?: string } };
      };
      if (!res.ok || body.error) {
        lastRaw = JSON.stringify(body.error ?? { status: res.status });
        const code = body.error?.code ?? res.status;
        if (code === 429 && attempt === 0 && m === 0) {
          await sleep(2_000); // free-pool saturation: one quick retry, then next model
          continue;
        }
        if (code === 429 && m < models.length - 1) {
          await sleep(1_500); // be polite to the next free pool
          break; // next model
        }
        throw new Error(`OpenRouter failed: ${lastRaw}`);
      }

      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenRouter returned no message content');

      // Models love wrapping JSON in fences even when told not to.
      const json = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(json) as {
        items?: { line?: number | null; name?: string; totalCostInr?: string; acquiredOn?: string; confidence?: string }[];
      };

      const proposals: LlmProposal[] = [];
      for (const item of parsed.items ?? []) {
        if (typeof item.totalCostInr !== 'string') continue;
        let costPaise: Paise;
        try {
          costPaise = rupees(item.totalCostInr.replace(/[₹,\s]/g, ''));
        } catch {
          continue; // unreadable cost is dropped, never guessed
        }
        if (costPaise <= 0n) continue;
        const line = typeof item.line === 'number' && item.line >= 1 && item.line <= deps.positions.length
          ? item.line - 1
          : null;
        const acquiredOn = typeof item.acquiredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.acquiredOn)
          ? item.acquiredOn
          : now.toISOString().slice(0, 10);
        proposals.push({
          line,
          name: item.name ?? '(unnamed)',
          costPaise,
          acquiredOn,
          confidence: item.confidence === 'high' ? 'high' : 'low',
        });
      }
      return proposals;
    }
  }
  throw new Error(`OpenRouter failed after walking the model chain: ${lastRaw}`);
}
