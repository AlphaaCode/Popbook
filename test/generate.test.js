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
const fake = extra => job('compat', { baseUrl: base, model: 'm', preset: 'balanced', ...extra }); // compat starts on Budget: the staged tests ask for Balanced

// A fake server that answers by task: reply(task) gets 'outline' or the spread numbers a writer call asks for. answers() gives
// spread k its n-th answer (0-based, counting every call that asked for it). Each answer reports usage like the real API; every
// request is kept in `sent` as { task, body }. A reply that throws answers 400, so a broken test fails instead of hanging.
let server, base, reply, sent = [];
const sse = evs => evs.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const userText = body => { const c = body.messages.at(-1).content; return typeof c === 'string' ? c : c.filter(x => x.type === 'text').map(x => x.text).join('\n\n'); };
const taskOf = body => { const t = userText(body); return /^Task: outline/m.test(t) ? 'outline' : /^Task: the whole book/m.test(t) ? 'book' : [...t.matchAll(/^- spread (\d+)/gm)].map(m => +m[1]); };
const of = task => sent.filter(s => typeof task === 'string' ? s.task === task : Array.isArray(s.task) && s.task.includes(task));
const answers = (spreads, outline = OUTLINE) => task => task === 'outline' ? outline : JSON.stringify({ spreads: task.map(k => spreads[k - 1](of(k).length)) });
const each = f => task => task === 'outline' ? OUTLINE : JSON.stringify({ spreads: task.map(f) }); // one fixed answer per spread number
before(async () => {
  server = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const b = JSON.parse(body), task = taskOf(b); let text;
    try { text = reply(task); } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'test reply failed: ' + e.message } })); }
    sent.push({ task, body: b });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.startsWith('/v1/messages')) return res.end(sse([{ type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } }]));
    res.end(sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } }]) + 'data: [DONE]\n\n');
  }); }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); for (const s of slugs) await fs.rm(path.join(BOOKS, s), { recursive: true, force: true }); });

test('mock provider: an outline call, then one call per 3 neighbouring spreads; usage in the log, book.json and outline.json', async () => {
  const lines = [], j = job('mock');
  const book = await generate(j, m => lines.push(m));
  assert.equal(book.spreads.length, 6);
  assert.deepEqual([book.source.calls, book.source.repairs], [3, 0]);
  assert.ok(book.source.usage.input > 0 && book.source.usage.output > 0);
  assert.ok(lines.some(l => /Outline: answer in .*in [\d,]+ · out [\d,]+/.test(l)) && lines.some(l => l.startsWith('Total usage over 3 calls')));
  const saved = JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'book.json'), 'utf8'));
  assert.deepEqual(saved.source.usage, book.source.usage);
  const outline = JSON.parse(await fs.readFile(path.join(BOOKS, j.slug, 'outline.json'), 'utf8'));
  assert.deepEqual(outline.spreads.map(s => s.block), EX.spreads.map(s => s.scene.type));
});

test('Budget: one call writes the whole book from all the rules and every block spec; a repair resends only the spreads in error', async () => {
  let n = 0; reply = () => JSON.stringify({ title: EX.title, lang: 'fr', spreads: [COVER, n++ ? BARS : { ...BARS, quiz: undefined }] }); sent = [];
  const lines = [], j = fake({ preset: 'budget' }), book = await generate(j, m => lines.push(m)), prompts = await loadPrompts();
  assert.deepEqual(book.spreads.map(s => s.scene.type), ['network', 'bars']);
  assert.deepEqual([book.source.preset, book.source.calls, book.source.repairs, book.source.plannerModel], ['budget', 2, 1, undefined]);
  assert.deepEqual(sent.map(s => s.task), ['book', 'book']);
  assert.equal(sent[0].body.messages[0].content, prompts.single);
  assert.ok(Object.values(prompts.blocks).every(spec => prompts.single.includes(spec)) && prompts.single.startsWith(prompts.core));
  assert.equal(sent[0].body.response_format, undefined); // phase 2's path: no schema
  const fix = userText(sent[1].body);
  assert.ok(fix.includes('spreads[1].quiz') && fix.includes('"spreads[1]":') && !fix.includes('"spreads[0]":')); // only the spread in error
  assert.ok(lines.some(l => /^Budget path: one call writes the whole book, model m$/.test(l)));
  await assert.rejects(fs.access(path.join(BOOKS, j.slug, 'outline.json'))); // nothing to regenerate from

  // more pages than one call takes: one call per 15, the later ones continue the book, without a cover
  reply = () => JSON.stringify({ title: EX.title, lang: 'fr', spreads: [COVER, BARS] }); sent = [];
  const pages = Array.from({ length: 16 }, (_, i) => ({ n: i + 1, text: 'page ' + (i + 1) }));
  const big = await generate(fake({ preset: 'budget', pages, range: [1, 16], totalPages: 16 }), () => {});
  assert.deepEqual(big.spreads.map(s => s.kind), ['cover', 'lesson', 'lesson']);
  const t2 = userText(sent[1].body);
  assert.ok(t2.includes('=== Page 16 ===') && !t2.includes('=== Page 15 ===') && t2.includes('continued') && t2.includes(`already has these spreads: "${COVER.title}"`));
});

const OUTLINE4 = JSON.stringify({ title: EX.title, lang: 'fr', spreads: [{ kind: 'cover', pages: [1], block: 'network', intent: 'the course' },
  { pages: [2], block: 'bars', intent: "Moore's law" }, { pages: [3], block: 'bars', intent: 'clock' }, { pages: [4], block: 'bars', intent: 'cores' }] });
const PAGES4 = ['Amdahl', 'Gustafson', 'Moore', 'Dennard'].map((text, i) => ({ n: i + 1, text }));

test('stages: the planner reads every page; a writer call writes neighbouring spreads from only their pages and blocks, after a shared prefix', async () => {
  reply = answers([() => COVER, () => BARS, () => BARS, () => BARS], OUTLINE4); sent = [];
  const lines = [], book = await generate(fake({ extra: 'Prefer plots.', pages: PAGES4, range: [1, 4], totalPages: 4 }), m => lines.push(m));
  assert.deepEqual(book.spreads.map(s => s.scene.type), ['network', 'bars', 'bars', 'bars']);
  assert.deepEqual([book.source.calls, book.source.repairs], [3, 0]); // an outline, then 2 writer calls of 2 spreads
  const [o] = of('outline'), [w1] = of(1), [w2] = of(3), prompts = await loadPrompts();
  assert.deepEqual([of(2), of(4)], [[w1], [w2]]);
  assert.equal(o.body.messages[0].content, prompts.planner); // each step its own rules…
  for (const s of [w1, w2]) assert.equal(s.body.messages[0].content, prompts.writer); // …the same for every writer: one cached prefix
  const sch = s => s.body.response_format.json_schema.schema; // structured output: the outline's schema, a writer's {spreads: […]}
  const kinds = s => { const it = sch(s).properties.spreads.items; return (it.anyOf || [it]).map(x => [!!x.properties.quiz, x.properties.scene.properties.type.enum]); };
  assert.deepEqual(sch(o).required, ['title', 'spreads']);
  assert.deepEqual(kinds(w1), [[false, ['network']], [true, ['bars']]]); // the cover's schema has no quiz
  assert.deepEqual(sch(w2), sch(w1)); // one writer schema per book: it heads the cached prefix, so every writer shares it
  const ot = userText(o.body);
  assert.ok(ot.includes('=== Page 1 ===\nAmdahl') && ot.includes('=== Page 4 ===\nDennard') && ot.includes('Prefer plots.'));
  assert.ok(!Object.values(prompts.blocks).some(spec => ot.includes(spec))); // the planner needs the table, not the specs
  const t1 = userText(w1.body), t2 = userText(w2.body);
  assert.ok(t1.includes('=== Page 2 ===') && !t1.includes('=== Page 3 ===') && t2.includes('=== Page 3 ===\nMoore') && !t2.includes('=== Page 2 ===')); // only their pages
  assert.ok(t1.includes(prompts.blocks.network) && t1.includes(prompts.blocks.bars) && t2.includes(prompts.blocks.bars) && !t2.includes(prompts.blocks.network));
  const outlineText = t1.slice(0, t1.indexOf('Scene block'));
  assert.ok(outlineText.startsWith('Book outline: "') && t2.startsWith(outlineText)); // the outline: identical bytes for every writer
  assert.match(t2, /Task: spreads 3, 4 of 4\.\n.*\n- spread 3: pages 3, block "bars", intent: clock\n- spread 4: pages 4, block "bars"/);
  assert.ok(t2.indexOf('=== Page 4') < t2.indexOf('Task:') && t2.indexOf('Task:') < t2.indexOf('Prefer plots.')); // the task comes last
  assert.ok(lines.some(l => /^Outline: ".*", 4 spreads — p\. 1 cover\/network · p\. 2 bars · p\. 3 bars · p\. 4 bars$/.test(l)));
  assert.equal(lines.filter(l => /^Spread \d\/4 ✓/.test(l)).length, 4); // the studio's progress counts spreads, not calls
  assert.ok(lines.findIndex(l => l.startsWith('Spread 2/4 ✓')) < lines.findIndex(l => l.startsWith('Spreads 3–4/4 → '))); // the first writer call alone: it fills the cache
});

test('autofix: a spread with fixable mistakes costs no repair', async () => {
  const sloppy = { ...structuredClone(BARS), id: 'x', note: 'extra' }; sloppy.quiz.a = String(sloppy.quiz.a); sloppy.scene.type = 'Bar'; sloppy.scene.colour = 'red';
  reply = answers([() => COVER, () => sloppy]); sent = [];
  const book = await generate(fake(), () => {});
  assert.deepEqual([book.source.calls, book.source.repairs], [2, 0]);
  assert.equal(book.spreads[1].scene.type, 'bars'); assert.equal(book.spreads[1].note, undefined);
});

test('a spread that fails in a shared call is repaired on its own: its pages, its errors and its fixed answer', async () => {
  const bad = structuredClone(BARS); bad.quiz.a = 9;
  reply = answers([() => COVER, n => n ? BARS : bad]); sent = [];
  const lines = [], book = await generate(fake(), m => lines.push(m));
  assert.deepEqual([book.source.calls, book.source.repairs], [3, 1]);
  assert.deepEqual(book.source.usage, { input: 3000, cachedInput: 300, output: 600, reasoning: 0 });
  assert.equal(of(1).length, 1); // the other spread is not written again
  const repair = userText(of(2)[1].body), note = repair.slice(repair.indexOf('Your previous answer was rejected'));
  assert.ok(repair.includes('Task: spread 2/2.') && repair.includes('=== Page 2 ===') && !repair.includes('=== Page 1 ===')); // a call of its own
  assert.ok(repair.startsWith(userText(of(2)[0].body).slice(0, repair.indexOf('Scene block')))); // the shared outline prefix
  assert.match(note, /- spread\.quiz\.a: must be the 0-based index/);
  assert.ok(note.includes(JSON.stringify(BARS.title)) && !note.includes(JSON.stringify(COVER.title))); // that spread's JSON, not the others
  assert.ok(lines.some(l => l.startsWith('Spread 2/2 repair 1 → ')) && lines.some(l => l.startsWith('Spread 1/2 ✓')));
  sent = [];
  reply = task => task === 'outline' ? OUTLINE : task.length > 1 ? 'sorry, no json: ' + 'x'.repeat(5000) : JSON.stringify({ spreads: [task[0] === 1 ? COVER : BARS] });
  const b2 = await generate(fake(), () => {});
  assert.deepEqual([b2.source.calls, b2.source.repairs], [4, 2]); // an unusable shared answer: each spread repaired on its own
  assert.ok(userText(of(2)[1].body).includes('did not return JSON') && !userText(of(2)[1].body).includes('sorry')); // not echoed back
});

test('escalation: the third try goes to the planner model', async () => {
  const bad = structuredClone(BARS); delete bad.why;
  reply = answers([() => COVER, n => n < 2 ? bad : BARS]); sent = [];
  const lines = [], book = await generate(fake({ plannerModel: 'big' }), m => lines.push(m));
  assert.deepEqual(of(2).map(s => s.body.model), ['m', 'm', 'big']);
  assert.equal(of('outline')[0].body.model, 'big'); // the planner writes the outline
  assert.deepEqual([book.source.calls, book.source.repairs, book.source.plannerModel], [4, 2, 'big']);
  assert.ok(lines.some(l => l.startsWith('Spread 2/2 escalated → ')) && !book.spreads[1].fallback);
});

test('fallback: a spread that never validates is written by code from its pages, flagged, and the book still completes', async () => {
  const bad = structuredClone(BARS); bad.scene.items = [bad.scene.items[0]]; // bars needs 2–7 items
  reply = answers([() => COVER, () => bad]); sent = [];
  const lines = [], j = fake(), book = await generate(j, m => lines.push(m));
  assert.deepEqual([book.source.calls, book.source.repairs], [4, 2]);
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

test('output caps: ~2 000 for a 10-page outline, 1 500 per spread of the call, plus room to think', async () => {
  const g = roles({ provider: 'gemini', preset: 'balanced' });
  assert.equal(outlineCap(roles({ provider: 'anthropic' }).planner, 10), 2000); // Claude does not think unasked
  assert.equal(spreadCap(g.writer), 1500 + 1024); // gemini-3.8-flash: its low thinking budget
  assert.equal(spreadCap(g.writer, 3), 4500 + 1024); // three spreads in one answer, thinking once
  assert.equal(outlineCap(g.planner, 10), 2000 + 4096); // gemini-4-argon plans at medium
  assert.equal(spreadCap(roles({ provider: 'openai' }).writer), 1500 + 8000); // an effort has no fixed size
  process.env.SPREAD_MAX_TOKENS = '1000';
  try { assert.equal(spreadCap({ provider: 'anthropic', model: 'x' }), 1000); } finally { delete process.env.SPREAD_MAX_TOKENS; }
  reply = answers([() => COVER, () => BARS]); sent = [];
  const j = fake(), r = roles(j); await generate(j, () => {});
  assert.equal(of('outline')[0].body.max_tokens, outlineCap(r.planner, 2));
  assert.equal(of(2)[0].body.max_tokens, spreadCap(r.writer, 2));
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
  assert.deepEqual(media(of(2)[0]), ['image', 'image']); // the writer of both spreads: their figure pages
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
  const secs = s => s.match(/^## \d+/gm).map(h => +h.slice(3));
  assert.deepEqual([secs(p.planner), secs(p.writer)], [[1, 2, 3, 6], [1, 4, 5, 7]]); // each step only the rules it needs
  assert.ok(p.planner.startsWith(p.core.slice(0, 200)) && p.writer.startsWith(p.core.slice(0, 200))); // both keep the intro
});

test('result cache: the same pages again cost nothing, a changed model misses it', async () => {
  const known = new Set(await fs.readdir(CACHE).catch(() => [])), pages = [{ n: 1, text: `cache test ${process.pid} ${Date.now()}` }, { n: 2, text: 'Gustafson' }];
  try {
    reply = answers([() => COVER, () => BARS]); sent = [];
    const a = await generate(fake({ pages, cache: true }), () => {});
    assert.equal(sent.length, 2);
    sent = []; const lines = [], b = await generate(fake({ pages, cache: true }), m => lines.push(m));
    assert.equal(sent.length, 0);
    assert.deepEqual([b.source.calls, b.source.usage], [0, { input: 0, cachedInput: 0, output: 0, reasoning: 0 }]);
    assert.deepEqual(b.spreads, a.spreads);
    assert.ok(lines.filter(l => /from the result cache/.test(l)).length === 2 && lines.some(l => l.startsWith('Spread 2/2 ✓'))); // the studio's progress still counts it
    sent = []; await generate(fake({ pages, cache: true, model: 'm2' }), () => {});
    assert.equal(sent.length, 1); // a new writer: both spreads again; the planner did not change, so its outline still holds
  } finally { for (const f of await fs.readdir(CACHE)) if (!known.has(f)) await fs.rm(path.join(CACHE, f)); }
});

test('outline review: the spreads written are the edited outline\'s, in its order', async () => {
  reply = each(k => k === 1 ? BARS : COVER); sent = [];
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
  assert.deepEqual(r({ provider: 'gemini' }), ['gemini:gemini-3.8-flash', 'gemini:gemini-3.8-flash', 'budget']); // Gemini and local models start on Budget…
  assert.deepEqual([r({ provider: 'compat' })[2], r({ provider: 'anthropic' })[2], r({ provider: 'openai' })[2], r({ provider: 'claude-cli' })[2]], ['budget', 'balanced', 'balanced', 'balanced']); // …the others on Balanced
  assert.deepEqual(r({ provider: 'gemini', preset: 'balanced' }), ['gemini:gemini-4-argon', 'gemini:gemini-3.8-flash', 'balanced']);
  assert.deepEqual(r({ provider: 'gemini', preset: 'budget' }), ['gemini:gemini-3.8-flash', 'gemini:gemini-3.8-flash', 'budget']);
  assert.deepEqual(r({ provider: 'anthropic', preset: 'best' }).slice(0, 2), ['anthropic:claude-opus-5-5', 'anthropic:claude-opus-5-5']);
  assert.deepEqual(r({ provider: 'openai', preset: 'balanced' }).slice(0, 2), ['openai:gpt-6-astra', 'openai:gpt-6-astra']); // no cheaper sibling known
  assert.deepEqual(r({ provider: 'gemini' }, { PLANNER_MODEL: 'claude-opus-5-5', WRITER_MODEL: 'compat:llama3:8b' }).slice(0, 2), ['anthropic:claude-opus-5-5', 'compat:llama3:8b']);
  assert.deepEqual(r({ provider: 'compat', model: 'qwen3:4b', plannerModel: 'qwen3:32b' }, { WRITER_MODEL: 'gemini-3.8-flash' }).slice(0, 2), ['compat:qwen3:32b', 'compat:qwen3:4b']);
  assert.deepEqual([roles({ provider: 'gemini', preset: 'best' }).writer.reasoning, roles({ provider: 'gemini' }).writer.reasoning], [{ budget: 4096 }, { budget: 1024 }]);
});

test('a role routed to another provider is called there; book.source records both roles', async () => {
  reply = each(k => EX.spreads[k - 1]); sent = [];
  process.env.PLANNER_MODEL = 'mock:mock';
  try {
    const book = await generate(fake(), () => {}); // compat writers, a mock planner (the example book's outline)
    assert.equal(of('outline').length, 0); // the outline never reached the job's server
    assert.equal(sent.length, 2); // its 6 spreads did, 3 per call
    assert.deepEqual([book.source.model, book.source.plannerModel], ['m', 'mock:mock']);
  } finally { delete process.env.PLANNER_MODEL; }
  reply = answers([() => COVER, () => BARS]); sent = [];
  const book = await generate(fake({ model: 'w', plannerModel: 'p' }), () => {});
  assert.deepEqual([book.source.model, book.source.plannerModel, book.source.preset], ['w', 'p', 'balanced']);
  assert.deepEqual([of('outline')[0].body.model, of(1)[0].body.model], ['p', 'w']);
});

test('agent mode: a bundle in input/ (pages.md, the figures, a plan), a PROMPT.md that names what to read, and no PDF', async () => {
  const env = { AGENT_CMD_CLAUDE: 'node test/fake-agent.mjs', PLANNER_MODEL: 'mock:mock' }; // the plan from the mock: no claude call
  Object.assign(process.env, env);
  try {
    const pages = [{ n: 1, text: 'Amdahl' }, { n: 2, text: '', image: 'data:image/jpeg;base64,/9j/AA==' }];
    let j = job('agent-claude', { pages, pdfBase64: Buffer.from('%PDF-1.4').toString('base64') }), dir = path.join(BOOKS, j.slug), lines = [];
    const book = await generate(j, l => lines.push(l));
    assert.equal(book.title, EX.title);
    const md = await fs.readFile(path.join(dir, 'input/pages.md'), 'utf8'), prompt = await fs.readFile(path.join(dir, 'PROMPT.md'), 'utf8');
    assert.ok(md.includes('## Page 1\n\nAmdahl') && md.includes('## Page 2\n\n(no extractable text)\n\n![page 2](fig-2.jpg)'));
    assert.deepEqual([...await fs.readFile(path.join(dir, 'input/fig-2.jpg'))], [0xff, 0xd8, 0xff, 0x00]);
    const outline = JSON.parse(await fs.readFile(path.join(dir, 'input/outline.json'), 'utf8'));
    assert.ok(prompt.includes(`books/${j.slug}/input/outline.json`) && prompt.includes('Do not open source.pdf'));
    for (const b of new Set(outline.spreads.map(s => s.block))) assert.ok(prompt.includes(`prompts/blocks/${b}.md`), b); // only the plan's blocks
    assert.ok(!prompt.includes('prompts/blocks/<name>.md'));
    assert.equal(book.source.plannerModel, 'mock:mock'); // who planned
    await assert.rejects(fs.access(path.join(dir, 'pages'))); // the API-mode page files are not written
    delete process.env.PLANNER_MODEL; process.env.CLAUDE_CLI_CMD = 'popbook-no-such-command';
    j = job('agent-claude'); dir = path.join(BOOKS, j.slug); lines = [];
    await generate(j, l => lines.push(l)); // claude -p is not there: the agent plans the book itself
    assert.ok(lines.some(l => /No outline from .*the agent plans the book itself/.test(l)));
    assert.ok((await fs.readFile(path.join(dir, 'PROMPT.md'), 'utf8')).includes('prompts/blocks/<name>.md for each block you use'));
    await assert.rejects(fs.access(path.join(dir, 'input/outline.json')));
  } finally { for (const k of [...Object.keys(env), 'CLAUDE_CLI_CMD']) delete process.env[k]; }
});
