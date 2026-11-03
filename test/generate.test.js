// The API-mode pipeline against the mock provider and a fake OpenAI-compatible server: usage accounting and repairs, no real API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
process.env.POPBOOK_MOCK = '1'; // before providers.js is evaluated
const { generate, BOOKS } = await import('../lib/generate.js');

const EXAMPLE = await fs.readFile(new URL('../books/calcul-parallele/book.json', import.meta.url), 'utf8');
const slugs = [];
const job = (provider, extra = {}) => { const slug = `test-gen-${process.pid}-${slugs.length}`; slugs.push(slug);
  return { provider, slug, fileName: 'x.pdf', totalPages: 2, range: [1, 2], pages: [{ n: 1, text: 'Amdahl' }, { n: 2, text: 'Gustafson' }], lang: 'auto', ...extra }; };

// a fake server whose k-th answer comes from `answers[k]`; each one reports usage like the real API does
let server, base, answers = [], calls = 0;
before(async () => {
  server = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    const text = answers[Math.min(calls++, answers.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } })}\n\ndata: [DONE]\n\n`);
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
