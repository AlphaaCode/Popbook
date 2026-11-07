// The API-mode pipeline against the mock provider and a fake OpenAI-compatible server: usage accounting and repairs, no real API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
process.env.POPBOOK_MOCK = '1'; // before providers.js is evaluated
const { generate, BOOKS, outputCap } = await import('../lib/generate.js');

const EXAMPLE = await fs.readFile(new URL('../books/calcul-parallele/book.json', import.meta.url), 'utf8');
const slugs = [];
const job = (provider, extra = {}) => { const slug = `test-gen-${process.pid}-${slugs.length}`; slugs.push(slug);
  return { provider, slug, fileName: 'x.pdf', totalPages: 2, range: [1, 2], pages: [{ n: 1, text: 'Amdahl' }, { n: 2, text: 'Gustafson' }], lang: 'auto', ...extra }; };

// a fake server whose k-th answer comes from `answers[k]` (OpenAI or Anthropic stream, by path); each one reports usage like the
// real API does, and every request body is kept in `sent`
let server, base, answers = [], calls = 0, sent = [];
const sse = evs => evs.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
before(async () => {
  server = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
    sent.push(JSON.parse(body));
    const text = answers[Math.min(calls++, answers.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.startsWith('/v1/messages')) return res.end(sse([{ type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } }]));
    res.end(sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } }]) + 'data: [DONE]\n\n');
  }); }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); for (const s of slugs) await fs.rm(path.join(BOOKS, s), { recursive: true, force: true }); });

test('mock provider: a first-try book carries its usage, in the log and in book.json', async () => {
  const lines = [], j = job('mock');
  const book = await generate(j, m => lines.push(m));
  assert.equal(book.source.calls, 1);
  assert.equal(book.source.repairs, 0);
  assert.ok(book.source.usage.input > 0 && book.source.usage.output > 0);
  assert.ok(lines.some(l => /answer received.*in [\d,]+ · out [\d,]+/.test(l)));
  const saved = JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'book.json'), 'utf8'));
  assert.deepEqual(saved.source.usage, book.source.usage);
});

test('a rejected answer is repaired, and every call is counted', async () => {
  answers = ['sorry, here is no json', EXAMPLE]; calls = 0;
  const lines = [];
  const book = await generate(job('compat', { baseUrl: base, model: 'm' }), m => lines.push(m));
  assert.equal(book.source.calls, 2);
  assert.equal(book.source.repairs, 1);
  assert.deepEqual(book.source.usage, { input: 2000, cachedInput: 200, output: 400, reasoning: 0 });
  assert.ok(lines.some(l => l.includes('repair attempt 2')));
  assert.ok(lines.some(l => l.startsWith('Total usage over 2 calls')));
});

test('a run that never validates still reports what it spent', async () => {
  answers = ['nope']; calls = 0;
  await assert.rejects(generate(job('compat', { baseUrl: base, model: 'm' }), () => {}), e => {
    assert.match(e.message, /after 3 attempts/);
    assert.deepEqual(e.stats, { usage: { input: 3000, cachedInput: 300, output: 600, reasoning: 0 }, calls: 3, repairs: 2 });
    return true;
  });
});

test('prompt layout: system → pages → task, and a repair keeps that prefix byte for byte', async () => {
  answers = ['nope', EXAMPLE]; calls = 0; sent = [];
  await generate(job('compat', { baseUrl: base, model: 'm', extra: 'Prefer plots.' }), () => {});
  const [first, repair] = sent.map(b => b.messages);
  assert.equal(first[0].role, 'system'); assert.equal(repair[0].content, first[0].content);
  const user = first[1].content;
  assert.ok(user.indexOf('=== Page 1 ===\nAmdahl') < user.indexOf('The pages above are pages 1–2') && user.indexOf('The pages above') < user.indexOf('Prefer plots.'));
  assert.ok(repair[1].content.startsWith(user) && repair[1].content.length > user.length); // only the repair note is new
});

test('output cap: 1 500 tokens per possible spread, plus room to think', async () => {
  assert.equal(outputCap('anthropic', 'claude-opus-5-5', 10), 1500 * 9); // up to 8 spreads + the cover; Claude does not think unasked
  assert.equal(outputCap('gemini', 'gemini-3.8-flash', 10), 1500 * 9 + 1024); // its thinking budget
  assert.equal(outputCap('openai', 'gpt-6-astra', 10), 1500 * 9 + 8000); // effort "low" has no fixed size
  process.env.SPREAD_MAX_TOKENS = '1000';
  try { assert.equal(outputCap('anthropic', 'x', 10), 9000); } finally { delete process.env.SPREAD_MAX_TOKENS; }
  answers = [EXAMPLE]; sent = [];
  await generate(job('compat', { baseUrl: base, model: 'm' }), () => {});
  assert.equal(sent[0].max_tokens, outputCap('compat', 'm', 2)); // was 16 000 whatever the batch
});

test('input: text plus images of the figure pages; the native PDF only at high fidelity', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  const pdfBase64 = Buffer.from(await pdf.save()).toString('base64'), image = 'data:image/jpeg;base64,/9j/';
  const pages = [{ n: 1, text: 'Amdahl' }, { n: 2, text: '', image }];
  const media = () => sent.at(-1).messages[0].content.map(c => c.type).filter(t => t !== 'text');
  answers = [EXAMPLE];
  await generate(job('anthropic', { baseUrl: base, apiKey: 'k', pdfBase64, pages }), () => {});
  assert.deepEqual(media(), ['image']); // page 2 only, no PDF
  await generate(job('anthropic', { baseUrl: base, apiKey: 'k', pdfBase64, pages, fidelity: 'high' }), () => {});
  assert.deepEqual(media(), ['document']);
  await generate(job('anthropic', { baseUrl: base, apiKey: 'k', pdfBase64, pages, sendImages: false }), () => {});
  assert.deepEqual(media(), []);
});
