// The API-mode pipeline against the mock provider and a fake OpenAI/Anthropic server: the outline → spreads stages, usage
// accounting, the repair ladder and the fallback, no real API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
process.env.POPBOOK_MOCK = '1'; // before providers.js is evaluated
const { generate, regenerateSpread, roles, BOOKS, CACHE, outlineCap, spreadCap, loadPrompts } = await import('../lib/generate.js');
delete process.env.PLANNER_MODEL; delete process.env.WRITER_MODEL; // a developer's shell must not reroute the tests
const { BLOCKS, validateBook } = await import('../lib/validate.js');

const EX = JSON.parse(await fs.readFile(new URL('../books/calcul-parallele/book.json', import.meta.url), 'utf8'));
const COVER = EX.spreads[0], BARS = EX.spreads[3]; // a network cover and a bars lesson
const OUTLINE = JSON.stringify({ title: EX.title, lang: 'fr', spreads: [{ kind: 'cover', pages: [1], block: 'network', intent: 'the course' }, { pages: [2], block: 'bars', intent: "Moore's law" }] });
const slugs = [];
const job = (provider, extra = {}) => { const slug = `test-gen-${process.pid}-${slugs.length}`; slugs.push(slug);
  return { provider, slug, fileName: 'x.pdf', totalPages: 2, range: [1, 2], pages: [{ n: 1, text: 'Amdahl' }, { n: 2, text: 'Gustafson' }], lang: 'auto', cache: false, ...extra }; };
const fake = extra => job('compat', { baseUrl: base, model: 'm', ...extra });

// A fake server that answers by task: reply(task, n) gives the n-th answer (0-based) to 'outline' or to spread k. Each answer reports
// usage like the real API; every request is kept in `sent` as { task, body }.
let server, base, reply, sent = [];
const sse = evs => evs.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const taskOf = body => { const t = JSON.stringify(body); return /Task: outline/.test(t) ? 'outline' : +/Task: spread (\d+)\//.exec(t)?.[1]; };
const userText = body => { const c = body.messages.at(-1).content; return typeof c === 'string' ? c : c.filter(x => x.type === 'text').map(x => x.text).join('\n\n'); };
const of = task => sent.filter(s => s.task === task);
const answers = (spreads, outline = OUTLINE) => (task, n) => task === 'outline' ? outline : JSON.stringify(spreads[task - 1](n));
before(async () => {
  server = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const b = JSON.parse(body), task = taskOf(b), text = reply(task, of(task).length); sent.push({ task, body: b });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.startsWith('/v1/messages')) return res.end(sse([{ type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } }]));
    res.end(sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } }]) + 'data: [DONE]\n\n');
  }); }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); for (const s of slugs) await fs.rm(path.join(BOOKS, s), { recursive: true, force: true }); });

test('mock provider: an outline call, then one call per spread; usage in the log, book.json and outline.json', async () => {
  const lines = [], j = job('mock');
  const book = await generate(j, m => lines.push(m));
  assert.equal(book.spreads.length, 6);
  assert.deepEqual([book.source.calls, book.source.repairs], [7, 0]);
  assert.ok(book.source.usage.input > 0 && book.source.usage.output > 0);
  assert.ok(lines.some(l => /Outline: answer in .*in [\d,]+ · out [\d,]+/.test(l)) && lines.some(l => l.startsWith('Total usage over 7 calls')));
  const saved = JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'book.json'), 'utf8'));
  assert.deepEqual(saved.source.usage, book.source.usage);
  const outline = JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'outline.json'), 'utf8'));
  assert.deepEqual(outline.spreads.map(s => s.block), EX.spreads.map(s => s.scene.type));
});

test('stages: the planner reads every page; each writer gets only its pages and its block spec, after a shared prefix', async () => {
  reply = answers([() => COVER, () => BARS]); sent = [];
  const lines = [], book = await generate(fake({ extra: 'Prefer plots.' }), m => lines.push(m));
  assert.deepEqual(book.spreads.map(s => s.scene.type), ['network', 'bars']);
  assert.deepEqual([book.source.calls, book.source.repairs], [3, 0]);
  const [o] = of('outline'), [w1] = of(1), [w2] = of(2), prompts = await loadPrompts();
  for (const s of sent) assert.equal(s.body.messages[0].content, prompts.core); // the same system prompt for every call: one cached prefix
  const ot = userText(o.body);
  assert.ok(ot.includes('=== Page 1 ===\nAmdahl') && ot.includes('=== Page 2 ===\nGustafson') && ot.includes('Prefer plots.'));
  assert.ok(!Object.values(prompts.blocks).some(spec => ot.includes(spec))); // the planner needs the table, not the specs
  const t1 = userText(w1.body), t2 = userText(w2.body);
  assert.ok(t2.includes('=== Page 2 ===') && !t2.includes('=== Page 1 ===')); // only its own pages
  assert.ok(t2.includes(prompts.blocks.bars) && !t2.includes(prompts.blocks.network) && t1.includes(prompts.blocks.network));
  const outlineText = t1.slice(0, t1.indexOf('Scene block'));
  assert.ok(outlineText.startsWith('Book outline: "') && t2.startsWith(outlineText)); // the outline: identical bytes for every writer
  assert.ok(t2.indexOf('=== Page 2') < t2.indexOf('Task: spread 2/2') && t2.indexOf('Task:') < t2.indexOf('Prefer plots.')); // the task comes last
  assert.ok(lines.some(l => /^Outline: ".*", 2 spreads — p\. 1 cover\/network · p\. 2 bars$/.test(l)));
});

test('autofix: a spread with fixable mistakes costs no repair', async () => {
  const sloppy = { ...structuredClone(BARS), id: 'x', note: 'extra' }; sloppy.quiz.a = String(sloppy.quiz.a); sloppy.scene.type = 'Bar'; sloppy.scene.colour = 'red';
  reply = answers([() => COVER, () => ({ spreads: [sloppy] })]); sent = [];
  const book = await generate(fake(), () => {});
  assert.deepEqual([book.source.calls, book.source.repairs], [3, 0]);
  assert.equal(book.spreads[1].scene.type, 'bars'); assert.equal(book.spreads[1].note, undefined);
});

test('a repair resends only that spread, with its errors and its fixed answer', async () => {
  const bad = structuredClone(BARS); bad.quiz.a = 9;
  reply = answers([() => COVER, n => n ? BARS : bad]); sent = [];
  const lines = [], book = await generate(fake(), m => lines.push(m));
  assert.deepEqual([book.source.calls, book.source.repairs], [4, 1]);
  assert.deepEqual(book.source.usage, { input: 4000, cachedInput: 400, output: 800, reasoning: 0 });
  assert.equal(of(1).length, 1); // the other spread is not written again
  const [first, repair] = of(2).map(s => userText(s.body)), note = repair.slice(first.length);
  assert.ok(repair.startsWith(first)); // same prefix, so a cache hit; only the note is new
  assert.match(note, /- spread\.quiz\.a: must be the 0-based index/);
  assert.ok(note.includes(JSON.stringify(BARS.title)) && !note.includes(JSON.stringify(COVER.title))); // that spread's JSON, not the others
  assert.ok(lines.some(l => l.startsWith('Spread 2/2 repair 1 → ')));
  sent = [];
  reply =(t, n) => t === 'outline' ? OUTLINE : t === 1 ? JSON.stringify(COVER) : n ? JSON.stringify(BARS) : 'sorry, no json: ' + 'x'.repeat(5000);
  await generate(fake(), () => {});
  assert.ok(!userText(of(2)[1].body).includes('sorry')); // an unusable answer is not echoed back either
});

test('escalation: the third try goes to the planner model', async () => {
  const bad = structuredClone(BARS); delete bad.why;
  reply = answers([() => COVER, n => n < 2 ? bad : BARS]); sent = [];
  const lines = [], book = await generate(fake({ plannerModel: 'big' }), m => lines.push(m));
  assert.deepEqual(of(2).map(s => s.body.model), ['m', 'm', 'big']);
  assert.equal(of('outline')[0].body.model, 'big'); // the planner writes the outline
  assert.deepEqual([book.source.calls, book.source.repairs, book.source.plannerModel], [5, 2, 'big']);
  assert.ok(lines.some(l => l.startsWith('Spread 2/2 escalated → ')) && !book.spreads[1].fallback);
});

test('fallback: a spread that never validates is written by code from its pages, flagged, and the book still completes', async () => {
  const bad = structuredClone(BARS); bad.scene.items = [bad.scene.items[0]]; // bars needs 2–7 items
  reply = answers([() => COVER, () => bad]); sent = [];
  const lines = [], j = fake(), book = await generate(j, m => lines.push(m));
  assert.deepEqual([book.source.calls, book.source.repairs], [5, 2]);
  assert.equal(book.spreads[1].scene.type, 'stack'); assert.deepEqual(book.spreads[1].fallback, ['scene']);
  assert.equal(book.spreads[1].title, BARS.title); // the rest of the model's spread was fine and is kept
  assert.ok(validateBook(await fs.readFile(path.join(BOOKS, j.slug, 'book.json'), 'utf8')).ok);
  assert.ok(lines.some(l => /^Spread 2\/2 ⚠ .*regenerate it/.test(l)) && lines.some(l => /1 spread\(s\) written by PopBook/.test(l)));
});

test('an outline that never validates stops the run, and the run still reports what it spent', async () => {
  reply = () => '{"spreads":[]}'; sent = [];
  await assert.rejects(generate(fake(), () => {}), e => {
    assert.match(e.message, /valid outline after 3 attempts/);
    assert.deepEqual(e.stats, { usage: { input: 3000, cachedInput: 300, output: 600, reasoning: 0 }, cost: null, calls: 3, repairs: 2 }); // a local model: no price
    return true;
  });
});

test('output caps: ~2 000 for a 10-page outline, 1 500 per spread, plus room to think', async () => {
  const g = roles({ provider: 'gemini', preset: 'balanced' });
  assert.equal(outlineCap(roles({ provider: 'anthropic' }).planner, 10), 2000); // Claude does not think unasked
  assert.equal(spreadCap(g.writer), 1500 + 1024); // gemini-3.8-flash: its low thinking budget
  assert.equal(outlineCap(g.planner, 10), 2000 + 4096); // gemini-4-argon plans at medium
  assert.equal(spreadCap(roles({ provider: 'openai' }).writer), 1500 + 8000); // an effort has no fixed size
  process.env.SPREAD_MAX_TOKENS = '1000';
  try { assert.equal(spreadCap({ provider: 'anthropic', model: 'x' }), 1000); } finally { delete process.env.SPREAD_MAX_TOKENS; }
  reply = answers([() => COVER, () => BARS]); sent = [];
  const j = fake(), r = roles(j); await generate(j, () => {});
  assert.equal(of('outline')[0].body.max_tokens, outlineCap(r.planner, 2));
  assert.equal(of(2)[0].body.max_tokens, spreadCap(r.writer));
});

test('input: text plus images of the figure pages; the planner sees only the pages without text; native PDF only at high fidelity', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  const pdfBase64 = Buffer.from(await pdf.save()).toString('base64'), image = 'data:image/jpeg;base64,/9j/';
  const pages = [{ n: 1, text: 'Amdahl’s law: the serial part of a program limits the speed-up.', image }, { n: 2, text: '', image }];
  const media = s => s.body.messages[0].content.map(c => c.type).filter(t => t !== 'text');
  const anth = extra => generate(job('anthropic', { baseUrl: base, apiKey: 'k', pdfBase64, pages, ...extra }), () => {});
  reply = answers([() => COVER, () => BARS]); sent = [];
  await anth();
  assert.deepEqual(media(of('outline')[0]), ['image']); // page 2 has no text: the planner must see it; page 1's text is enough
  assert.deepEqual([media(of(1)[0]), media(of(2)[0])], [['image'], ['image']]); // each writer: its own figure page
  assert.deepEqual(of(2)[0].body.messages[0].content[0].cache_control, { type: 'ephemeral' }); // the shared outline is a cached prefix
  sent = []; await anth({ fidelity: 'high' });
  assert.deepEqual([media(of('outline')[0]), media(of(2)[0])], [['document'], ['document']]);
  sent = []; await anth({ sendImages: false });
  assert.deepEqual(sent.flatMap(media), []);
});

test('prompts: the core rules plus one file per API block', async () => {
  const p = await loadPrompts();
  assert.deepEqual(Object.keys(p.blocks), BLOCKS.filter(b => b !== 'custom')); // custom scenes are for agents only
  for (const [b, spec] of Object.entries(p.blocks)) assert.ok(spec.startsWith('### `' + b + '`'), b);
  assert.match(p.core, /## 3\. The outline/);
});

test('result cache: the same pages again cost nothing, a changed model misses it', async () => {
  const known = new Set(await fs.readdir(CACHE).catch(() => [])), pages = [{ n: 1, text: `cache test ${process.pid} ${Date.now()}` }, { n: 2, text: 'Gustafson' }];
  try {
    reply = answers([() => COVER, () => BARS]); sent = [];
    const a = await generate(fake({ pages, cache: true }), () => {});
    assert.equal(sent.length, 3);
    sent = []; const lines = [], b = await generate(fake({ pages, cache: true }), m => lines.push(m));
    assert.equal(sent.length, 0);
    assert.deepEqual([b.source.calls, b.source.usage], [0, { input: 0, cachedInput: 0, output: 0, reasoning: 0 }]);
    assert.deepEqual(b.spreads, a.spreads);
    assert.ok(lines.filter(l => /from the result cache/.test(l)).length === 3 && lines.some(l => l.startsWith('Spread 2/2 ✓'))); // the studio's progress still counts it
    sent = []; await generate(fake({ pages, cache: true, model: 'm2' }), () => {});
    assert.equal(sent.length, 2); // a new writer: both spreads again; the planner did not change, so its outline still holds
  } finally { for (const f of await fs.readdir(CACHE)) if (!known.has(f)) await fs.rm(path.join(CACHE, f)); }
});

test('outline review: the spreads written are the edited outline\'s, in its order', async () => {
  reply = (t, n) => t === 'outline' ? OUTLINE : JSON.stringify(t === 1 ? BARS : COVER); sent = [];
  let seen = null;
  const review = async o => { seen = structuredClone(o); return { ...o, title: 'Edited', spreads: [{ ...o.spreads[1], intent: 'growth' }] }; };
  const lines = [], j = fake({ review }), book = await generate(j, m => lines.push(m));
  assert.equal(seen.spreads.length, 2); // the reviewer got the planner's outline
  assert.deepEqual([book.title, book.spreads.length, book.spreads[0].scene.type, sent.length], ['Edited', 1, 'bars', 2]);
  assert.ok(userText(of(1)[0].body).includes('1. pages 2 · bars — growth')); // writers see the edited plan
  assert.ok(lines.some(l => l.startsWith('Outline (reviewed): "Edited", 1 spreads')));
  assert.equal(JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'outline.json'), 'utf8')).title, 'Edited');
});

test('regenerate: one spread written again past the result cache, from the saved pages, image and outline; the rest kept, usage added', async () => {
  const known = new Set(await fs.readdir(CACHE).catch(() => [])), image = 'data:image/jpeg;base64,/9j/';
  const pages = [{ n: 1, text: 'Amdahl' }, { n: 2, text: `regen test ${process.pid} ${Date.now()}`, image }];
  const anth = { baseUrl: base, apiKey: 'k' };
  try {
    reply = answers([() => COVER, () => BARS]); sent = [];
    const j = job('anthropic', { ...anth, pages, lang: 'fr', cache: true }), first = await generate(j, () => {});
    reply = answers([() => COVER, () => ({ ...BARS, title: 'Loi de Moore, encore' })]); sent = [];
    const lines = [], book = await regenerateSpread({ slug: j.slug, index: 1, provider: 'anthropic', ...anth }, m => lines.push(m));
    assert.equal(of(2).length, 1); // the cached answer of the first build was not reused
    assert.ok(userText(of(2)[0].body).includes(pages[1].text) && JSON.stringify(of(2)[0].body).includes('"data":"/9j/"')); // its saved page text and image
    assert.deepEqual([book.spreads[1].title, book.spreads[0], book.source.calls], ['Loi de Moore, encore', first.spreads[0], first.source.calls + 1]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'book.json'), 'utf8')).spreads[1].title, 'Loi de Moore, encore');
    assert.ok(lines.some(l => l.startsWith('Spread 2/2 ✓')));
    await assert.rejects(regenerateSpread({ slug: j.slug, index: 5 }, () => {}), /No spread 6/);
    await assert.rejects(regenerateSpread({ slug: 'calcul-parallele', index: 0 }, () => {}), /no outline\.json/);
  } finally { for (const f of await fs.readdir(CACHE)) if (!known.has(f)) await fs.rm(path.join(CACHE, f)); }
});

test('roles: the preset picks a tier per role, .env may route a role to another provider, the studio fields win', () => {
  const r = (job, env = {}) => { Object.assign(process.env, env); try { const x = roles(job); return [x.planner.provider + ':' + x.planner.model, x.writer.provider + ':' + x.writer.model, x.preset.id]; } finally { for (const k in env) delete process.env[k]; } };
  assert.deepEqual(r({ provider: 'gemini' }), ['gemini:gemini-4-argon', 'gemini:gemini-3.8-flash', 'balanced']); // the default preset
  assert.deepEqual(r({ provider: 'gemini', preset: 'budget' }), ['gemini:gemini-3.8-flash', 'gemini:gemini-3.8-flash', 'budget']);
  assert.deepEqual(r({ provider: 'anthropic', preset: 'best' }).slice(0, 2), ['anthropic:claude-opus-5-5', 'anthropic:claude-opus-5-5']);
  assert.deepEqual(r({ provider: 'openai', preset: 'balanced' }).slice(0, 2), ['openai:gpt-6-astra', 'openai:gpt-6-astra']); // no cheaper sibling known
  assert.deepEqual(r({ provider: 'gemini' }, { PLANNER_MODEL: 'claude-opus-5-5', WRITER_MODEL: 'compat:llama3:8b' }).slice(0, 2), ['anthropic:claude-opus-5-5', 'compat:llama3:8b']);
  assert.deepEqual(r({ provider: 'compat', model: 'qwen3:4b', plannerModel: 'qwen3:32b' }, { WRITER_MODEL: 'gemini-3.8-flash' }).slice(0, 2), ['compat:qwen3:32b', 'compat:qwen3:4b']);
  assert.deepEqual([roles({ provider: 'gemini', preset: 'best' }).writer.reasoning, roles({ provider: 'gemini' }).writer.reasoning], [{ budget: 4096 }, { budget: 1024 }]);
});

test('a role routed to another provider is called there; book.source records both roles', async () => {
  reply = (task) => task === 'outline' ? OUTLINE : JSON.stringify(EX.spreads[task - 1]); sent = [];
  process.env.PLANNER_MODEL = 'mock:mock';
  try {
    const book = await generate(fake(), () => {}); // compat writers, a mock planner (the example book's outline)
    assert.equal(of('outline').length, 0); // the outline never reached the job's server
    assert.equal(sent.length, EX.spreads.length); // its spreads did
    assert.deepEqual([book.source.model, book.source.plannerModel], ['m', 'mock:mock']);
  } finally { delete process.env.PLANNER_MODEL; }
  reply = answers([() => COVER, () => BARS]); sent = [];
  const book = await generate(fake({ model: 'w', plannerModel: 'p' }), () => {});
  assert.deepEqual([book.source.model, book.source.plannerModel, book.source.preset], ['w', 'p', 'balanced']);
  assert.deepEqual([of('outline')[0].body.model, of(1)[0].body.model], ['p', 'w']);
});
