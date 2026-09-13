/**
 * PRD §6.7 narration. The LLM turns the engine's own deterministic bullets into prose.
 *
 * It never originates a number, a rank, a recommendation or a citation: it receives the
 * finished engine output and rewrites it. Nothing it returns feeds back into the engine,
 * so a hallucinated figure can mislead the sentence it sits in but can never change a
 * score, a size or a decision. When there is no key, or the call fails, the report falls
 * back to the deterministic bullets — a missing narrative must never cost the owner the
 * report.
 */

export const NARRATION_PROMPT = [
  'You are writing the narrative section of a single investor\'s weekly portfolio report.',
  'You will be given the engine\'s finished output as bullets and JSON.',
  'Rules, without exception:',
  '- Do NOT introduce any number, percentage, rank, date or instrument that is not in the input.',
  '- Do NOT recommend, rate or advise. The recommendations are already decided; you narrate them.',
  '- Do NOT cite an IPS clause that is not already present in the input.',
  '- If the input is thin, say so plainly rather than padding.',
  'Write at most 200 words of plain prose. No headings, no bullet list, no markdown.',
].join('\n');

export const DEFAULT_NARRATION_MODEL = 'anthropic/claude-sonnet-4-5';

export interface NarrationDeps {
  /** OpenRouter key. Absent ⇒ no narration, and that is a supported state, not an error. */
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: typeof fetch;
  /** The deterministic summary the narrative rewrites. */
  bullets: string[];
  /** Serialized engine output, for grounding. */
  engineJson: string;
}

/**
 * Returns prose, or `null` when narration is unavailable for any reason. Never throws:
 * the report is the product, the narrative is a garnish.
 */
export async function narrate(deps: NarrationDeps): Promise<string | null> {
  if (!deps.apiKey) return null;
  const doFetch = deps.fetchImpl ?? fetch;

  try {
    const res = await doFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: deps.model ?? DEFAULT_NARRATION_MODEL,
        messages: [
          { role: 'system', content: NARRATION_PROMPT },
          { role: 'user', content: `${deps.bullets.join('\n')}\n\nENGINE OUTPUT:\n${deps.engineJson}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text === undefined || text === '' ? null : text;
  } catch {
    return null;
  }
}
