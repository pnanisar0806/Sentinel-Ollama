/**
 * The one place a model id is chosen. Owner decision 2026-09-13: the InclusionAI Ling 3.0
 * family does every LLM job in this project, on the existing OpenRouter key.
 *
 * `ling-3.0-flash-fin:free` is a FINANCE-TUNED TEXT model — verified against OpenRouter's
 * own catalogue, `input_modalities: ["text"]`, 262k context. It cannot read an image, so it
 * cannot do statement extraction; its sibling `ling-3.0-flash-vl:free` takes
 * `["text","image","video"]` and handles that. Same family, same key, split by capability
 * rather than by preference.
 *
 * What the LLM may and may not do is unchanged by this (PRD §6.7): it proposes candidates
 * and writes prose. It never originates a score, a rank, a size or a price — those come
 * from the engine, out of real fundamentals and real closes.
 */

/** Text jobs: watchlist shortlisting, weekly narration, any future advisory prose. */
export const TEXT_MODEL = 'inclusionai/ling-3.0-flash-fin:free';

/**
 * Vision jobs: statement and RSU screenshots. Ling's own VL model leads; the rest is the
 * previously-tuned free chain, kept because the free pool saturates (429) and the caller
 * walks it.
 */
export const VISION_MODEL_CHAIN = [
  'inclusionai/ling-3.0-flash-vl:free',
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m3:free',
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
] as const;

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
