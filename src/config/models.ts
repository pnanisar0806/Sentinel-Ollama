/**
 * The one place a model id is chosen. Owner decision 2026-09-13, clarified the same day:
 * the finance-tuned Ling text model does the project's TEXT work; statement extraction
 * keeps the previously-tuned free vision chain.
 *
 * `ling-3.0-flash-fin:free` is a FINANCE-TUNED TEXT model — verified against OpenRouter's
 * own catalogue, `input_modalities: ["text"]`, 262k context. It cannot read an image, so
 * it can never be the extraction model. The vision chain below is the pre-existing,
 * task-tuned free pool (gemma-led) that was in place before Ling arrived; the Ling VL
 * sibling was trialled as the leader and retired the same day because the owner wants the
 * proven extraction model back.
 *
 * What the LLM may and may not do is unchanged (PRD §6.7): text work proposes candidates
 * and writes prose; extraction returns a proposal nothing writes until the owner confirms.
 * It never originates a score, a rank, a size or a price — those come from the engine,
 * out of real fundamentals and real closes.
 */

/**
 * Text jobs: watchlist shortlisting, weekly narration, any future advisory prose.
 * Owner decision 2026-09-13: finance-tuned, text-only.
 */
export const TEXT_MODEL = 'inclusionai/ling-3.0-flash-fin:free';

/**
 * Vision jobs: statement and RSU screenshots. The previously-tuned free chain (gemma-led),
 * restored as the extraction model on 2026-09-13 — free pool saturates (429) so the caller
 * walks the chain with a pause between models.
 */
export const VISION_MODEL_CHAIN = [
  'google/gemma-4-31b-it:free',
  // `minimax/minimax-m3:free` sat here until 2026-09-21, when OpenRouter retired the
  // free tier: "This model is unavailable for free. The paid version is available now".
  // Checked against OpenRouter's catalogue on that date — it is the only one of the
  // seven that has gone, and the paid slug is deliberately NOT substituted: this pool
  // is free by the owner's decision, and adding a billed model is the owner's call.
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
] as const;

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
