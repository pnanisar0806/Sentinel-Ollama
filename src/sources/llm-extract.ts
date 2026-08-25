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

  const res = await deps.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.apiKey}`,
    },
    body: JSON.stringify({
      model: deps.model ?? DEFAULT_LLM_MODEL,
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
    error?: { message?: string };
  };
  if (!res.ok || body.error) {
    throw new Error(`OpenRouter failed: ${body.error?.message ?? res.status}`);
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
