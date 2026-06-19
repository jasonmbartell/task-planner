/**
 * Cost estimation pre-flight for prose ingestion (M-P6).
 *
 * Heuristic only — no real tokenizer dependency. For Anthropic and most
 * BPE-style tokenizers, ~4 chars per token is a reasonable English-prose
 * ballpark. We add fixed overhead for the system prompt + few-shot examples
 * baked into proseExtractionPrompt.js, and estimate output tokens from the
 * input length (extraction tends to compress 5–10×).
 *
 * The numbers are deliberately rough. Their job is to keep the user from
 * accidentally pasting a 200KB transcript and burning $5 — not to predict
 * the bill to the cent. UI displays as "≈X tok · $0.YZ".
 *
 * Spec: docs/prose-ingestion.md §11 Q6 (cost gating).
 */

const CHARS_PER_TOKEN = 4;

// System-prompt overhead (proseExtractionPrompt.js system + few-shots).
// Conservative — actual ranges 1.5k–2k depending on the prompt revision.
const SYSTEM_PROMPT_TOKENS = 1800;

// Output tokens are bounded but vary with how many tasks the LLM finds.
// Empirically the prompt produces ~80 tokens per extracted task. We can't
// know task count up-front, so use a fraction of input length as a proxy.
const OUTPUT_RATIO = 0.15;
const OUTPUT_FLOOR_TOKENS = 200;
const OUTPUT_CEILING_TOKENS = 4000;

/**
 * Per-million-token pricing in USD. Fallback used when the configured model
 * isn't recognized — set deliberately on the high side so estimates don't
 * understate.
 *
 * Prices reflect Anthropic public pricing as of 2026-04. Cheap to keep in
 * sync; if a future model is missing, the fallback row covers it.
 */
const PRICING = {
  // Anthropic
  'claude-opus-4-7':                { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  'claude-opus-4-6':                { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  'claude-sonnet-4-6':              { inputPerMTok:  3.00, outputPerMTok: 15.00 },
  'claude-sonnet-4-20250514':       { inputPerMTok:  3.00, outputPerMTok: 15.00 },
  'claude-haiku-4-5-20251001':      { inputPerMTok:  1.00, outputPerMTok:  5.00 },
  // OpenAI / OpenAI-compatible
  'gpt-4o':                         { inputPerMTok:  5.00, outputPerMTok: 15.00 },
  'gpt-4o-mini':                    { inputPerMTok:  0.15, outputPerMTok:  0.60 },
  // Generic local (Ollama, LM Studio): assume free
  'local':                          { inputPerMTok:  0.00, outputPerMTok:  0.00 },
};

const FALLBACK_PRICING = { inputPerMTok: 15.00, outputPerMTok: 75.00 };

/**
 * Map model name to pricing row. Case-insensitive prefix-ish matching:
 * `claude-opus-4-7-foo` matches `claude-opus-4-7`. Local-style endpoints
 * (`http://localhost:...`) get the free row.
 */
export function pricingFor(model) {
  if (!model || typeof model !== 'string') return { ...FALLBACK_PRICING, model: 'unknown', exact: false };
  const m = model.trim().toLowerCase();
  if (PRICING[m]) return { ...PRICING[m], model: m, exact: true };
  // Prefix match
  for (const key of Object.keys(PRICING)) {
    if (m.startsWith(key) || key.startsWith(m)) {
      return { ...PRICING[key], model: key, exact: false };
    }
  }
  return { ...FALLBACK_PRICING, model, exact: false };
}

/**
 * Estimate input + output tokens for a parseProse call against `text`.
 *
 * @param {string} text - raw input that will be sent to the LLM.
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
export function estimateTokens(text) {
  const len = typeof text === 'string' ? text.length : 0;
  const contentTokens = Math.ceil(len / CHARS_PER_TOKEN);
  const inputTokens = contentTokens + SYSTEM_PROMPT_TOKENS;
  const outputRaw = Math.ceil(contentTokens * OUTPUT_RATIO);
  const outputTokens = Math.min(OUTPUT_CEILING_TOKENS, Math.max(OUTPUT_FLOOR_TOKENS, outputRaw));
  return { inputTokens, outputTokens };
}

/**
 * Estimate the dollar cost of a single extraction call.
 *
 * @param {string} text
 * @param {string} [model]
 * @returns {{ inputTokens: number, outputTokens: number, costUsd: number, model: string, exactPricing: boolean }}
 */
export function estimateExtractionCost(text, model) {
  const { inputTokens, outputTokens } = estimateTokens(text);
  const price = pricingFor(model);
  const costUsd =
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok;
  return {
    inputTokens,
    outputTokens,
    costUsd,
    model: price.model,
    exactPricing: price.exact,
  };
}

/**
 * Render a compact human-readable cost line for the modal.
 *
 * Examples:
 *   "≈4,200 tok · $0.05 (claude-opus-4-7)"
 *   "≈4,200 tok · ~$0.05 (claude-opus-4-7-future, est)"
 *   "≈4,200 tok · free (local)"
 */
export function formatCostLine(estimate) {
  if (!estimate) return '';
  const totalTok = (estimate.inputTokens || 0) + (estimate.outputTokens || 0);
  const tokStr = `≈${totalTok.toLocaleString()} tok`;
  let costStr;
  if (estimate.costUsd <= 0) {
    costStr = 'free';
  } else if (estimate.costUsd < 0.01) {
    costStr = '<$0.01';
  } else if (estimate.costUsd < 1) {
    costStr = `$${estimate.costUsd.toFixed(2)}`;
  } else {
    costStr = `$${estimate.costUsd.toFixed(2)}`;
  }
  if (!estimate.exactPricing && estimate.costUsd > 0) costStr = `~${costStr}`;
  const modelStr = estimate.model ? ` (${estimate.model}${estimate.exactPricing ? '' : ', est'})` : '';
  return `${tokStr} · ${costStr}${modelStr}`;
}

export const __TEST_ONLY__ = {
  CHARS_PER_TOKEN, SYSTEM_PROMPT_TOKENS, OUTPUT_RATIO,
  OUTPUT_FLOOR_TOKENS, OUTPUT_CEILING_TOKENS, FALLBACK_PRICING, PRICING,
};
