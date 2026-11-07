// What PopBook knows about each model: who serves it, what it can take, what it costs. Matched by exact id: an unknown model gets
// its provider's defaults and no price, so cost shows as "unknown" instead of a guess (a prefix match would price
// gemini-3.8-flash-lite as gemini-3.8-flash). Prices change: check the vendor page before trusting a figure.
//   price      USD per 1M tokens: [input, output, cached input]
//   schema     answers to a JSON schema (lib/providers.js sends it each API's way; a server that refuses it is called without)
//   images     reads page images · pdf: reads a PDF itself (sent only at high fidelity)
//   caching    'explicit': PopBook marks the shared prefix (Anthropic) · 'auto': the API reuses an identical prefix by itself
//   reasoning  how its thinking is set: 'effort' (OpenAI reasoning_effort) or 'budget' (Gemini thinking tokens). None for Claude,
//              which thinks only when asked, and for unknown models, because a parameter a model does not know is a 400 error.
export const MODELS = {
  'claude-opus-5-5': { provider: 'anthropic', price: [4, 20, 0.20], images: true }, // third-party price sites; not yet checked against Anthropic's own page
  'claude-sonnet-5-5': { provider: 'anthropic', price: [2, 10, 0.20], images: true }, // same; sites disagree on the cache read (0.10 or 0.20)
  'claude-haiku-5-5': { provider: 'anthropic', price: [0.10, 0.50, 0.01], images: true }, // same; prompts over 100k tokens cost 5×
  'gpt-6-astra': { provider: 'openai', price: [10, 50, 1], images: true, reasoning: 'effort' }, // OpenAI help-center table; one aggregator lists 5 / 25 / 0.5
  'gemini-4-argon': { provider: 'gemini', price: [2, 10, 0.10], images: true, reasoning: 'budget' }, // ai.google.dev/gemini-api/docs/pricing — doubles on 2026-12-01 (4 / 20 / 0.20)
  'gemini-3.8-flash': { provider: 'gemini', price: [0.75, 3.75, 0.075], images: true, reasoning: 'budget' }, // same page; introductory until 2026-12-31, then 1.50 / 7.50 / 0.15
};

/** A provider's defaults, for the models it serves that have no row above. */
const DEFAULTS = {
  anthropic: { schema: true, images: true, pdf: true, caching: 'explicit' },
  openai: { schema: true, images: true, caching: 'auto' },
  gemini: { schema: true, images: true, pdf: true, caching: 'auto' },
  compat: { schema: true }, // Ollama, llama.cpp, LM Studio, vLLM turn the schema into a grammar; text only unless a row says otherwise
};
export const capsOf = (provider, model) => ({ ...DEFAULTS[provider], ...MODELS[model] });
export const priceOf = model => MODELS[model]?.price || null;

/** What a model gets besides the page text: { pdf } the PDF pages themselves (high fidelity, opt-in), else { images } of the figure
 *  pages, when it reads them and they are wanted (sendImages: the studio's switch, else the preset's choice). */
export function inputsFor({ provider, model }, { hasPdf, fidelity, sendImages }) {
  const c = capsOf(provider, model), pdf = !!(hasPdf && c.pdf && fidelity === 'high');
  return { pdf, images: !pdf && !!c.images && sendImages !== false };
}

/* Reasoning, set explicitly per role: writing a spread needs little, and hidden thinking is billed as output. */
const LEVELS = { effort: { low: 'low', medium: 'medium' }, budget: { low: 1024, medium: 4096 } }; // gpt-6-astra has no none / minimal
/** { effort } or { budget } for a model at a level ('low' | 'medium'); undefined: leave the model's default. */
export function reasoningFor(model, level = 'low') {
  const kind = MODELS[model]?.reasoning;
  return kind === 'effort' ? { effort: LEVELS.effort[level] } : kind === 'budget' ? { budget: LEVELS.budget[level] } : undefined;
}

/* Presets: a goal instead of knobs. Each picks a tier for the planner (the outline call) and the writer (one call per spread), whether
 * figure pages go as images, and each role's reasoning level. The strong tier is the provider's default model (ANTHROPIC_MODEL…
 * in .env); the cheap one a known cheaper sibling, or the default model again. PLANNER_MODEL / WRITER_MODEL in .env, then the
 * studio's model fields, override the preset's models (lib/generate.js roles()). */
export const PRESETS = {
  budget: { label: 'Budget', planner: 'cheap', writer: 'cheap', images: false, reasoning: { planner: 'low', writer: 'low' } },
  balanced: { label: 'Balanced', planner: 'strong', writer: 'cheap', images: true, reasoning: { planner: 'medium', writer: 'low' } },
  best: { label: 'Best', planner: 'strong', writer: 'strong', images: true, reasoning: { planner: 'medium', writer: 'medium' } },
};
export const CHEAP = { anthropic: 'claude-haiku-5-5', gemini: 'gemini-3.8-flash' };
/** --model for a local agent CLI per preset (Claude Code takes these aliases); Codex and Gemini CLI keep their own default. */
export const AGENT_MODEL = { claude: { budget: 'haiku', balanced: 'sonnet', best: 'opus' } };

/** Cost in USD of a usage object ({input, cachedInput, output}); null when the model has no price or no usage. */
export function costOf(model, usage) {
  const p = priceOf(model); if (!p || !usage) return null;
  const [pin, pout, pcache = pin] = p;
  return ((usage.input - usage.cachedInput) * pin + usage.cachedInput * pcache + usage.output * pout) / 1e6;
}
