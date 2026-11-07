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
const base = { prompts, pages: pages(20), range: [1, 20], provider: 'gemini', model: 'gemini-4-argon' };

test('estimate: one outline call plus one writer call per expected spread', () => {
  const e = estimate(base);
  assert.equal(e.spreads, 12); // 0.6 per page
  assert.equal(e.calls, 13);
  assert.ok(e.input > 13 * countTokens(prompts.core)); // the rules go with every call (uncached: the upper bound)
  assert.ok(estimate({ ...base, range: [1, 10] }).input < e.input / 1.5); // only the selected pages
  assert.equal(estimate({ ...base, pages: pages(1), range: [1, 1] }).calls, 2);
});

test('estimate: figure images by default, the native PDF only at high fidelity', () => {
  const text = estimate(base).input;
  const img = estimate({ ...base, caps: { images: true } }).input;
  assert.equal(img - text, 10 * 580); // the 10 figure pages, once each (Gemini's medium resolution); pages with text skip the planner
  assert.equal(estimate({ ...base, caps: { images: true }, sendImages: false }).input, text);
  const both = { ...base, caps: { images: true, pdf: true }, hasPdf: true };
  assert.equal(estimate(both).input, img); // a PDF is not sent unless asked for
  const pdf = estimate({ ...both, fidelity: 'high' }).input;
  assert.ok(pdf > img); // and then it replaces the images
  assert.equal(estimate({ ...base, caps: { pdf: true }, fidelity: 'high' }).input, text); // notes or photos: no PDF to send
  const blank = { ...base, pages: pages(20).map(p => ({ ...p, text: '' })), caps: { images: true } };
  assert.ok(estimate(blank).input - estimate({ ...blank, caps: {} }).input === 2 * 10 * 580); // no text: the planner sees the images too
});

test('estimate: models that think by default are charged for it', () => {
  const g = estimate(base), a = estimate({ ...base, provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.ok(g.reasoning > 0 && a.reasoning === 0);
  assert.ok(g.output > a.output);
  assert.equal(estimate({ ...base, model: 'gemini-3.8-flash' }).reasoning, 13 * 1024); // its thinking budget, once per call
  assert.ok(estimate({ ...base, model: 'gemini-9-unlisted' }).reasoning > 0); // no budget: the measured default ratio
});

test('cost: priced models only, cache hits are cheaper', () => {
  assert.ok(priceOf('gemini-4-argon') && priceOf('gemini-3.8-flash'));
  assert.equal(priceOf('gemini-3.8-flash-lite'), null); // never a neighbour's price
  const u = { input: 1e6, cachedInput: 5e5, output: 1e5, reasoning: 0 };
  assert.ok(Math.abs(costOf('gemini-4-argon', u) - 2.05) < 1e-9); // 0.5M×$2 + 0.5M×$0.10 + 0.1M×$10
  assert.equal(costOf('some-local-model', u), null);
  assert.equal(costOf('gemini-4-argon', null), null);
  assert.equal(estimate({ ...base, model: 'qwen2.5:14b' }).cost, null);
  assert.ok(estimate(base).cost > 0);
});

test('capability table: provider defaults for unknown models, a row wins; reasoning only where the model has a setting', () => {
  assert.deepEqual([capsOf('compat', 'qwen2.5:14b').schema, capsOf('compat', 'qwen2.5:14b').images, capsOf('anthropic', 'claude-x').caching], [true, undefined, 'explicit']);
  assert.equal(capsOf('gemini', 'gemini-3.8-flash').price[0], 0.75);
  assert.deepEqual([reasoningFor('gpt-6-astra'), reasoningFor('gemini-4-argon', 'medium'), reasoningFor('claude-opus-5-5'), reasoningFor('llama3')], [{ effort: 'low' }, { budget: 4096 }, undefined, undefined]);
});
