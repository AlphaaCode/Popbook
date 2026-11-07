// Price table, USD per 1M tokens: [input, output, cachedInput]. Matched by exact model id; unknown models have no
// price, so cost shows as "unknown" instead of a guess (a prefix match would price gemini-3.8-flash-lite as gemini-3.8-flash). Prices change: check the vendor page before trusting a figure.
// (Phase 4 adds capability flags — json_schema, images, caching — to these rows.)
export const PRICES = {
  'gemini-4-argon': [2, 10, 0.10],  // ai.google.dev/gemini-api/docs/pricing — doubles on 2026-12-01 (4 / 20 / 0.20)
  'gemini-3.8-flash': [0.75, 3.75, 0.075], // same page; introductory rate until 2026-12-31, then 1.50 / 7.50 / 0.15. Thinking is billed as output
  'claude-opus-5-5': [4, 20, 0.20], // third-party price sites; not yet checked against Anthropic's own page
  'gpt-6-astra': [10, 50, 1],       // OpenAI help-center table; one aggregator lists 5 / 25 / 0.5
};

export const priceOf = model => PRICES[model] || null;

/* Reasoning, set explicitly: writing spreads needs little of it, and hidden thinking is billed as output.
 * effort → OpenAI reasoning_effort; budget → Gemini thinkingBudget (tokens). Unlisted models get no setting, because a parameter
 * a model does not know is a 400 error; their output cap keeps room for their default thinking instead (generate.js).
 * Claude thinks only when asked to, so it needs no row. */
export const REASONING = {
  'gpt-6-astra': { effort: 'low' },       // has no none / minimal
  'gemini-4-argon': { budget: 1024 },    // thinks at medium by default
  'gemini-3.8-flash': { budget: 1024 },  // thought ~6.5k tokens per 10-page call by default (phase 1 eval)
};

/** Cost in USD of a usage object ({input, cachedInput, output}); null when the model has no price or no usage. */
export function costOf(model, usage) {
  const p = priceOf(model); if (!p || !usage) return null;
  const [pin, pout, pcache = pin] = p;
  return ((usage.input - usage.cachedInput) * pin + usage.cachedInput * pcache + usage.output * pout) / 1e6;
}
