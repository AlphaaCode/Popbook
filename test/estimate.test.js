import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens, planBatches, estimate } from '../lib/estimate.js';
import { costOf, priceOf } from '../lib/models.js';

test('countTokens copes with special-token text', () => {
  assert.ok(countTokens('Hello world') > 0);
  assert.ok(countTokens('a PDF about LLMs: <|endoftext|> ends the text') > 0); // the tokenizer refuses this by default
  assert.equal(countTokens(undefined), 0);
});

test('planBatches splits like generate() and never goes below 3 pages per call', () => {
  assert.deepEqual(planBatches(1, 40, 15), [[1, 15], [16, 30], [31, 40]]);
  assert.deepEqual(planBatches(1, 5, 1), [[1, 3], [4, 5]]);
  assert.deepEqual(planBatches(7, 7), [[7, 7]]);
});

const pages = n => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: 'word '.repeat(100), image: i % 2 === 0 }));
const base = { system: 'rules '.repeat(50), pages: pages(20), range: [1, 20], pagesPerCall: 15, provider: 'gemini', model: 'gemini-4-argon' };

test('estimate: one call per batch, the system prompt is paid every time', () => {
  const e = estimate(base);
  assert.equal(e.calls, 2);
  assert.equal(e.perCall.length, 2);
  assert.ok(e.perCall[0].input > e.perCall[1].input); // 15 pages vs 5 pages
  assert.equal(e.input, e.perCall[0].input + e.perCall[1].input);
  assert.ok(e.output > 0);
});

test('estimate: native PDF and page images add tokens only when they are really sent', () => {
  const text = estimate(base).input;
  const pdf = estimate({ ...base, caps: { pdf: true }, hasPdf: true }).input;
  assert.ok(pdf > text);
  assert.equal(estimate({ ...base, caps: { pdf: true }, hasPdf: true, sendPdf: false }).input, text); // pdf switched off, no images capability
  const img = estimate({ ...base, caps: { images: true } }).input;
  assert.ok(img > text); // only the 10 pages flagged with an image
  assert.equal(estimate({ ...base, caps: { images: true }, sendImages: false }).input, text);
  assert.equal(estimate({ ...base, caps: { images: true, pdf: true }, hasPdf: true }).input, estimate({ ...base, caps: { pdf: true }, hasPdf: true }).input); // pdf wins over images, like generate()
});

test('estimate: models that think by default are charged for it', () => {
  const g = estimate(base), a = estimate({ ...base, provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.ok(g.reasoning > 0 && a.reasoning === 0);
  assert.ok(g.output > a.output);
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
