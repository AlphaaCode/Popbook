import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens, estimate } from '../lib/estimate.js';
import { costOf, priceOf, capsOf, reasoningFor } from '../lib/models.js';

test('countTokens copes with special-token text', () => {
  assert.ok(countTokens('Hello world') > 0);
  assert.ok(countTokens('a PDF about LLMs: <|endoftext|> ends the text') > 0); // the tokenizer refuses this by default
  assert.equal(countTokens(undefined), 0);
});

const pages = n => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: 'word '.repeat(100), image: i % 2 === 0 }));
const prompts = { core: 'rules '.repeat(500), blocks: { race: 'race '.repeat(100), flow: 'flow '.repeat(50) } };
const role = (provider, model, reasoning) => ({ provider, model, reasoning });
const argon = role('gemini', 'gemini-4-argon'), both = r => ({ planner: r, writer: r });
const base = { prompts, pages: pages(20), range: [1, 20], ...both(argon) };

test('estimate: one outline call plus one writer call per 3 expected spreads', () => {
  const e = estimate(base);
  assert.equal(e.spreads, 12); // 0.6 per page
  assert.equal(e.calls, 5);
  assert.ok(e.input > 5 * countTokens(prompts.core)); // the rules go with every call (uncached: the upper bound)
  assert.ok(estimate({ ...base, range: [1, 10] }).input < e.input / 1.5); // only the selected pages
  assert.equal(estimate({ ...base, pages: pages(1), range: [1, 1] }).calls, 2);
});

test('estimate: figure images when the model reads them, the native PDF only at high fidelity', () => {
  const text = estimate({ ...base, sendImages: false }).input, img = estimate(base).input;
  assert.equal(img - text, 10 * 580); // the 10 figure pages, once each (Gemini's medium resolution); pages with text skip the planner
  assert.equal(estimate({ ...base, hasPdf: true }).input, img); // a PDF is not sent unless asked for
  assert.ok(estimate({ ...base, hasPdf: true, fidelity: 'high' }).input > img); // and then it replaces the images
  const gpt = both(role('openai', 'gpt-6-astra')); // reads images, not PDFs
  assert.equal(estimate({ ...base, ...gpt, hasPdf: true, fidelity: 'high' }).input, estimate({ ...base, ...gpt }).input);
  const local = both(role('compat', 'qwen2.5:14b')); // text only
  assert.equal(estimate({ ...base, ...local }).input, estimate({ ...base, ...local, sendImages: false }).input);
  const blank = { ...base, pages: pages(20).map(p => ({ ...p, text: '' })) };
  assert.equal(estimate(blank).input - estimate({ ...blank, sendImages: false }).input, 2 * 10 * 580); // no text: the planner sees the images too
});

test('estimate: models that think are charged for it, at their role budget', () => {
  const opus = both(role('anthropic', 'claude-opus-5-5'));
  assert.ok(estimate(base).reasoning > 0 && estimate({ ...base, ...opus }).reasoning === 0);
  assert.ok(estimate(base).output > estimate({ ...base, ...opus }).output);
  const flash = role('gemini', 'gemini-3.8-flash', { budget: 1024 });
  assert.equal(estimate({ ...base, ...both(flash) }).reasoning, 5 * 1024); // its thinking budget, once per call
  assert.equal(estimate({ ...base, planner: { ...flash, reasoning: { budget: 4096 } }, writer: flash }).reasoning, 4096 + 4 * 1024);
  assert.ok(estimate({ ...base, ...both(role('gemini', 'gemini-9-unlisted')) }).reasoning > 0); // no budget: the measured default ratio
});

test('cost: priced models only, each role at its own price, cache hits are cheaper', () => {
  assert.ok(priceOf('gemini-4-argon') && priceOf('gemini-3.8-flash'));
  assert.equal(priceOf('gemini-3.8-flash-lite'), null); // never a neighbour's price
  const u = { input: 1e6, cachedInput: 5e5, output: 1e5, reasoning: 0 };
  assert.ok(Math.abs(costOf('gemini-4-argon', u) - 2.05) < 1e-9); // 0.5M×$2 + 0.5M×$0.10 + 0.1M×$10
  assert.equal(costOf('some-local-model', u), null);
  assert.equal(costOf('gemini-4-argon', null), null);
  assert.equal(estimate({ ...base, writer: role('compat', 'qwen2.5:14b') }).cost, null);
  const flash = role('gemini', 'gemini-3.8-flash'), mixed = estimate({ ...base, writer: flash });
  assert.ok(mixed.cost > estimate({ ...base, ...both(flash) }).cost && mixed.cost < estimate(base).cost);
});

test('capability table: provider defaults for unknown models, a row wins; reasoning only where the model has a setting', () => {
  assert.deepEqual([capsOf('compat', 'qwen2.5:14b').schema, capsOf('compat', 'qwen2.5:14b').images, capsOf('anthropic', 'claude-x').caching], [true, undefined, 'explicit']);
  assert.equal(capsOf('gemini', 'gemini-3.8-flash').price[0], 0.75);
  assert.deepEqual([reasoningFor('gpt-6-astra'), reasoningFor('gemini-4-argon', 'medium'), reasoningFor('claude-opus-5-5'), reasoningFor('llama3')], [{ effort: 'low' }, { budget: 4096 }, undefined, undefined]);
});
