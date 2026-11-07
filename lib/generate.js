// Generation pipeline: source pages -> model/agent -> validated book.json in books/<slug>/
// API mode is staged: an outline call plans the book from all the page text, then one writer call per spread (WRITERS at a time)
// writes it from its own pages and its block's spec only. Every answer is fixed in code (lib/autofix.js) and validated; a spread
// that still fails gets a repair, then the planner model once, then a spread written by code from its pages, flagged in the book.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { callModel, runAgent, PROVIDERS, emptyUsage, addUsage, fmtUsage } from './providers.js';
import { validateBook, validateSpread, BLOCKS } from './validate.js';
import { fixSpread, fixOutline, fallbackSpread } from './autofix.js';
import { costOf, reasoningFor, inputsFor, PRESETS, CHEAP, MODELS, AGENT_MODEL } from './models.js';
import { MIN_TEXT } from './pages.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BOOKS = path.join(ROOT, 'books');
export const slugify = s => (String(s || 'book').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)) || 'book';

/** Pulls the JSON object out of a model answer (fenced, chatty, or bare). Throws if there is none. */
export function extractJson(text) {
  const t = String(text);
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(t);
  const src = fence && fence[1].includes('{') ? fence[1] : t;
  const a = src.indexOf('{');
  if (a < 0) throw new Error('The model did not return JSON');
  // scan to the matching closing brace, ignoring braces inside strings
  let depth = 0, inStr = false;
  for (let i = a; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('The JSON in the answer is cut off (the model probably hit its output limit)');
}

/** The given pages (1-based) of a PDF, as a new PDF in base64. */
async function slicePdf(buf, ns) {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true }), out = await PDFDocument.create();
  (await out.copyPages(src, ns.filter(n => n >= 1 && n <= src.getPageCount()).map(n => n - 1))).forEach(p => out.addPage(p));
  return Buffer.from(await out.save()).toString('base64');
}

/** The prompt parts: prompts/core.md (the rules; agents read it whole), cut by step into the system prompt of each call (planner:
 *  its intro and sections 1, 2, 3, 6; writer: 1, 4, 5, 7), and prompts/blocks/<name>.md (one scene block each, sent only to the
 *  writer of a spread that uses it; `custom` is agent-only). Section numbers stay, so the rules' cross-references still hold. */
export async function loadPrompts() {
  const dir = path.join(ROOT, 'prompts'), blocks = {};
  for (const b of BLOCKS) if (b !== 'custom') blocks[b] = (await fs.readFile(path.join(dir, 'blocks', b + '.md'), 'utf8')).trim();
  const core = (await fs.readFile(path.join(dir, 'core.md'), 'utf8')).trim(), [intro, ...secs] = core.split(/\r?\n(?=## \d+\.)/);
  const pick = ns => [intro, ...secs.filter(s => ns.includes(+/^## (\d+)/.exec(s)[1]))].join('\n').trim();
  return { core, blocks, planner: pick([1, 2, 3, 6]), writer: pick([1, 4, 5, 7]) };
}

/* Output caps (the single call of v0.1 had 32 000). An outline is ~50 tokens per spread: 1 000 + 100 per page is room for two
 * spreads a page. A spread is capped at SPREAD_MAX_TOKENS (1 500). Both plus room to think: the model's budget, or THINK_ROOM when
 * it thinks at its own default level (OpenAI and Gemini count thinking against the cap; Claude does not think unless asked). */
const THINK_ROOM = 8000;
const thinkRoom = r => r.reasoning?.budget ?? (r.provider === 'anthropic' ? 0 : THINK_ROOM); // r: a role, see roles()
export const outlineCap = (r, pages) => 1000 + 100 * pages + thinkRoom(r);
export const spreadCap = r => (Number(process.env.SPREAD_MAX_TOKENS) || 1500) + thinkRoom(r);
export const WRITERS = 3; // spread calls in flight at once

/* Result cache: one file per validated outline or spread. The key is everything its first call sends — rules, block spec, outline,
 * pages, images, task, so the prompt version too — plus the provider and models. ponytail: never evicted; delete .cache/ to reset. */
export const CACHE = path.join(ROOT, '.cache');
const cacheKey = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** "in 12,345 · out 3,210 · ≈ $0.0421" for the job log (cost only when the model has a known price). */
function usageLine(model, u) {
  const c = costOf(model, u);
  return fmtUsage(u) + (c == null ? '' : ` · ≈ $${c.toFixed(c < 0.1 ? 4 : 2)}`);
}

/* ---------- prompt pieces. Layout of every call, most stable first so providers reuse a cached prefix: the step's rules (system) →
 * the outline (writers) → the block spec (writers) → the pages → the task. Nothing per job comes before the pages. ---------- */
const pagesText = ps => ps.map(p => `=== Page ${p.n} ===\n${(p.text || '').trim() || '(no extractable text)'}`).join('\n\n');
const pageList = ns => ns.length > 1 && ns.at(-1) - ns[0] === ns.length - 1 ? `${ns[0]}–${ns.at(-1)}` : ns.join(', ');
const langLine = (job, lang) => job.lang && job.lang !== 'auto' ? `Write in this language: ${job.lang}.` : lang ? `Write in the book's language: ${lang}.` : 'Write in the language of the source.';
/** The outline as every writer of a job sees it: identical bytes for each spread, so it caches along with the system prompt. */
export const outlineText = o => [`Book outline: "${o.title}"${o.subtitle ? ` — ${o.subtitle}` : ''}${o.lang ? ` (lang: ${o.lang})` : ''}`,
  ...o.spreads.map((s, i) => `${i + 1}. ${s.kind === 'cover' ? 'cover · ' : ''}pages ${pageList(s.pages)} · ${s.block} — ${s.intent}`)].join('\n');
/** The job log's summary of an outline (the studio's progress bar reads the spread count from the last one). */
const outlineLine = (o, note = '') => `Outline${note}: "${o.title}", ${o.spreads.length} spreads — ${o.spreads.map(s => `p. ${pageList(s.pages)} ${s.kind === 'cover' ? 'cover/' : ''}${s.block}`).join(' · ')}`;
/** A repair resends the call as it was (same prefix, a cache hit) plus this note: the errors and the rejected answer after
 *  autofix — one spread or the outline, a few hundred tokens. An answer that was not even JSON is not echoed back. */
const repairNote = (errors, last) => ['Your previous answer was rejected:', ...errors.slice(0, 20).map(e => '- ' + e),
  ...(last ? ['Your answer, after automatic fixes:', JSON.stringify(last)] : []), 'Write it again with these errors fixed. Return only the minified JSON.'].join('\n');

/** fn(item, i) over items, n at a time, results in order. The first error stops new work and rejects. */
async function pool(items, n, fn) {
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { next = items.length; throw e; } }
  }));
  return out;
}

/** Who plans and who writes a job: { preset, planner, writer }, each role { provider, model, reasoning }. The preset (Balanced by
 *  default) picks a tier per role; PLANNER_MODEL / WRITER_MODEL in .env override it with a model id, which may belong to another
 *  provider (a known id, or provider:model); the studio's fields (plannerModel, model) override both, on the selected provider
 *  unless they say provider:model. A role on another provider takes its key and server from .env. */
export function roles(job) {
  const P = PROVIDERS[job.provider], id = job.preset in PRESETS ? job.preset : 'balanced', preset = { id, ...PRESETS[id] };
  const parse = (v, known) => { const m = /^([\w-]+):(.+)$/.exec(v), p = m && PROVIDERS[m[1]];
    return p && !p.agent ? { provider: m[1], model: m[2] } : { provider: (known && MODELS[v]?.provider) || job.provider, model: v }; };
  const role = (name, ui, env) => {
    const r = ui ? parse(ui, false) : env ? parse(env, true) : { provider: job.provider, model: (preset[name] === 'cheap' && CHEAP[job.provider]) || P.model };
    return { ...r, reasoning: reasoningFor(r.model, preset.reasoning[name]) };
  };
  return { preset, planner: role('planner', job.plannerModel, process.env.PLANNER_MODEL), writer: role('writer', job.model, process.env.WRITER_MODEL) };
}
const same = (a, b) => a.provider === b.provider && a.model === b.model;
/** A role as book.source records it (and roles() reads it back): the model, prefixed with its provider when that is not the job's. */
const roleName = (r, provider) => r.provider === provider ? r.model : `${r.provider}:${r.model}`;

/** The API-mode steps of one job: `outline()` and `spread(outline, i)`, with usage, cost, calls and repairs summed in `run`. */
function apiSteps(job, log, prompts, pdfBuf) {
  const { preset, planner, writer } = roles(job);
  const run = { preset, planner, writer, usage: emptyUsage(), cost: 0, priced: true, calls: 0, repairs: 0 };
  const inputs = { hasPdf: !!pdfBuf, fidelity: job.fidelity, sendImages: job.sendImages ?? preset.images };

  /** What a role's model sees of some pages besides their text: their PDF pages at high fidelity, else an image of each figure page. */
  const media = async (ps, r) => { const inp = inputsFor(r, inputs);
    return inp.pdf ? (ps.length ? [{ type: 'pdf', base64: await slicePdf(pdfBuf, ps.map(p => p.n)) }] : [])
      : inp.images ? ps.filter(p => p.image).flatMap(p => [{ type: 'text', text: `Image of page ${p.n}:` }, { type: 'image', dataUrl: p.image }]) : []; };
  const said = parts => parts.some(p => p.type === 'pdf') ? 'the PDF pages and their extracted text' : parts.some(p => p.type === 'image') ? 'extracted text, plus images of the pages with figures' : 'extracted text';

  async function call(what, r, system, parts, maxTokens) {
    const t0 = Date.now(); let lastLog = t0, truncated = false;
    log(`${what} → ${PROVIDERS[r.provider].label}, model ${r.model}, ≤ ${maxTokens.toLocaleString('en-US')} tokens out${r.reasoning ? `, reasoning ${r.reasoning.effort || r.reasoning.budget + ' tokens'}` : ''}…`);
    const onProgress = (n, note) => { if (note) truncated = true; if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`  ${what}: receiving (${n} chars)`); } };
    const own = r.provider === job.provider;
    const { text, usage } = await callModel(r.provider, { system, parts, model: r.model, maxTokens, reasoning: r.reasoning, apiKey: own ? job.apiKey : undefined, baseUrl: own ? job.baseUrl : undefined, signal: job.signal, onProgress });
    const c = costOf(r.model, usage);
    run.calls++; run.usage = addUsage(run.usage, usage); if (c == null) run.priced = false; else run.cost += c;
    log(`  ${what}: answer in ${((Date.now() - t0) / 1000).toFixed(0)} s (${text.length} chars) — ${usageLine(r.model, usage)}`);
    if (truncated) log(`  ${what}: the answer hit the output-token limit (raise SPREAD_MAX_TOKENS in .env if this keeps failing)`);
    return text;
  }

  /** The repair ladder of one answer: one try per role in `rs` (first try, repair, escalation). Each answer is fixed in code
   *  and checked; its errors and fixed form go into the next try. → { value }, or { last, errors } when every try failed.
   *  A valid answer is kept in .cache/; the same call again (fresh: false) is answered from there, re-checked, for no tokens. */
  async function ladder(what, system, parts, rs, cap, check, { fresh = false } = {}) {
    const file = job.cache !== false && path.join(CACHE, cacheKey([job.provider, rs, system, parts]) + '.json');
    if (file && !fresh) {
      const hit = await fs.readFile(file, 'utf8').then(JSON.parse, () => null), r = hit && check(hit);
      if (r?.ok) { log(`${what}: from the result cache, no tokens`); return { value: r.value }; }
    }
    let last = null, errors = [];
    for (const [k, role] of rs.entries()) {
      if (k) run.repairs++;
      const label = !k ? what : `${what} ${same(role, rs[0]) ? 'repair ' + k : 'escalated'}`;
      const text = await call(label, role, system, k ? [...parts, { type: 'text', text: repairNote(errors, last) }] : parts, cap(role));
      let raw; try { raw = JSON.parse(extractJson(text)); }
      catch (e) { errors = [e instanceof SyntaxError ? 'the answer is not valid JSON — ' + e.message : e.message]; last = null; log(`  ${what} invalid: ${errors[0]}`); continue; }
      const r = check(raw);
      if (r.ok) {
        r.warnings?.forEach(w => log(`  ${what} warning: ${w}`));
        if (file) await fs.mkdir(CACHE, { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(r.value))).catch(e => log(`  could not write the result cache: ${e.message}`));
        return { value: r.value };
      }
      errors = r.errors; last = r.value; log(`  ${what} invalid: ${errors.slice(0, 6).join(' | ')}`);
    }
    return { last, errors };
  }

  /** Step 1: every page's text (and the pages without text, as images) → { title, subtitle?, lang?, spreads: [{ kind?, pages, block, intent }] }. */
  async function outline() {
    const ns = job.pages.map(p => p.n), parts = [...await media(job.pages.filter(p => (p.text || '').trim().length < MIN_TEXT), planner), { type: 'text', text: pagesText(job.pages) }];
    parts.push({ type: 'text', text: ['Task: outline.', `The pages above are pages ${pageList(ns)}${job.totalPages ? ` of ${job.totalPages}` : ''} of ${job.fileName} (${said(parts)}).`,
      langLine(job), job.extra ? `Extra instructions from the author: ${job.extra}` : '', 'Return only the outline JSON (section 3).'].filter(Boolean).join('\n') });
    const r = await ladder('Outline', prompts.planner, parts, [planner, planner, planner], p => outlineCap(p, ns.length),
      raw => { const { outline, errors } = fixOutline(raw, ns); return { ok: !errors.length, value: outline, errors }; });
    if (!r.value) throw new Error(`The model could not produce a valid outline after 3 attempts (${r.errors.slice(0, 3).join(' | ')}). Try a stronger model or a smaller page range.`);
    log(outlineLine(r.value));
    return r.value;
  }

  /** Step 2: outline.spreads[i] from its own pages and its block's spec. Always returns a valid spread (the last rung is code).
   *  fresh: skip the result cache (regenerate); the new answer still replaces the cached one. */
  async function spread(outline, i, { fresh = false } = {}) {
    const plan = outline.spreads[i], ps = job.pages.filter(p => plan.pages.includes(p.n)), what = `Spread ${i + 1}/${outline.spreads.length}`;
    const parts = [{ type: 'text', text: outlineText(outline), cache: true }, { type: 'text', text: 'Scene block for this spread:\n\n' + prompts.blocks[plan.block] },
      ...await media(ps, writer), { type: 'text', text: pagesText(ps) }];
    parts.push({ type: 'text', text: [`Task: spread ${i + 1}/${outline.spreads.length}.`,
      `Write spread ${i + 1} of the outline${plan.kind === 'cover' ? ' (the cover)' : ''}: pages ${pageList(plan.pages)}, block "${plan.block}", intent: ${plan.intent}`,
      `The pages above are its source (${said(parts)}).`, langLine(job, outline.lang), job.extra ? `Extra instructions from the author: ${job.extra}` : '',
      `Return only this one spread object (section 5), with "scene": {"type":"${plan.block}",…}.`].filter(Boolean).join('\n') });
    const r = await ladder(what, prompts.writer, parts, [writer, writer, planner], spreadCap,
      raw => { const s = fixSpread(raw, plan), v = validateSpread(s); return { ok: v.ok, value: s, errors: v.errors, warnings: v.warnings }; }, { fresh });
    if (r.value) { log(`${what} ✓ "${r.value.title}"`); return r.value; }
    const s = fallbackSpread(outline, i, ps.map(p => p.text).join('\n'), r.last);
    log(`${what} ⚠ the model failed 3 times (${r.errors.slice(0, 3).join(' | ')}): PopBook wrote its ${s.fallback.join(', ')} from the page text — regenerate it in the studio`);
    return s;
  }

  return { run, outline, spread };
}

/** The book of an outline and its spreads, validated as a whole (each spread already passed on its own). */
function assembleBook(job, outline, spreads) {
  const { subtitle, coverColor, ui } = outline;
  const v = validateBook({ title: outline.title, ...(subtitle && { subtitle }), ...(coverColor && { coverColor }), ...(ui && { ui }),
    lang: job.lang && job.lang !== 'auto' ? job.lang : outline.lang, spreads }, { allowCustom: false });
  if (!v.ok) throw new Error('The assembled book is invalid:\n' + v.errors.join('\n'));
  return v.book;
}

const pageFile = (dir, n) => path.join(dir, 'pages', `page-${String(n).padStart(3, '0')}`); // + .txt, and .jpg for pages sent as images

export async function generate(job, log) {
  const dir = path.join(BOOKS, job.slug); await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  const pdfBuf = job.pdfBase64 ? Buffer.from(job.pdfBase64, 'base64') : null;
  if (pdfBuf) await fs.writeFile(path.join(dir, 'source.pdf'), pdfBuf);
  for (const p of job.pages) {
    const base = pageFile(dir, p.n);
    await fs.writeFile(base + '.txt', p.text || '');
    // photos of pages / rendered pages: saved so local agents can look at them too
    if (typeof p.image === 'string' && p.image.startsWith('data:image/')) await fs.writeFile(base + '.jpg', Buffer.from(p.image.slice(p.image.indexOf(',') + 1), 'base64'));
  }
  const [from, to] = job.range;
  log(`Saved ${job.pages.length} page(s) of text${pdfBuf ? ' and the PDF' : ''} to books/${job.slug}/`);
  const P = PROVIDERS[job.provider];

  /* ---------- agent mode ---------- */
  if (P.agent) {
    const prompt = [
      `Make a PopBook from the course in books/${job.slug}/. Follow CLAUDE.md (agent instructions) and prompts/core.md plus prompts/blocks/<name>.md for the blocks you use (book format) exactly.`,
      pdfBuf ? `The source PDF is books/${job.slug}/source.pdf — use pages ${from} to ${to}. Extracted text is in books/${job.slug}/pages/.` : `The lesson text is in books/${job.slug}/pages/.`,
      job.lang && job.lang !== 'auto' ? `Write the book in: ${job.lang}.` : 'Write the book in the language of the source.',
      job.extra ? `Extra instructions from the author: ${job.extra}` : '',
      job.pages.some(p => p.image) ? `Images of the pages are in books/${job.slug}/pages/*.jpg.` : '',
      `Write books/${job.slug}/book.json, then run: node tools/check.mjs books/${job.slug} — fix every error it reports and run it again until it says OK.`,
      'Do not edit anything outside that book folder. When it passes, stop.',
    ].filter(Boolean).join('\n');
    // the instructions go in a file: one short, quote-free command line works the same in every OS shell
    await fs.writeFile(path.join(dir, 'PROMPT.md'), prompt + '\n');
    await fs.rm(path.join(dir, 'book.json'), { force: true }); // a stale book must not pass for the agent's output
    log(`Starting ${P.label}…`);
    const { usage } = await runAgent(job.provider, { prompt: `Read books/${job.slug}/PROMPT.md and do exactly what it says.`, cwd: ROOT, model: job.model || AGENT_MODEL[P.agent]?.[job.preset || 'balanced'], onLine: l => log('  › ' + l), signal: job.signal });
    log(`Agent usage: ${usageLine(job.model, usage)}`);
    const file = path.join(dir, 'book.json');
    const txt = await fs.readFile(file, 'utf8').catch(() => { throw new Error(`The agent finished but books/${job.slug}/book.json does not exist`); });
    const v = validateBook(txt, { allowCustom: true });
    if (!v.ok) throw new Error('The agent wrote an invalid book.json:\n' + v.errors.join('\n'));
    v.warnings.forEach(w => log('warning: ' + w));
    if (usage) { const raw = JSON.parse(txt); raw.source = { ...raw.source, usage }; await fs.writeFile(file, JSON.stringify(raw, null, 2)); v.book.source = raw.source; }
    return v.book;
  }

  /* ---------- API mode: outline → spreads ---------- */
  const steps = apiSteps(job, log, await loadPrompts(), pdfBuf), { run } = steps;
  let book;
  try {
    let outline = await steps.outline();
    if (typeof job.review === 'function') { outline = await job.review(outline); log(outlineLine(outline, ' (reviewed)')); } // server.js: the studio's outline review
    log(`Writing ${outline.spreads.length} spreads, ${WRITERS} at a time…`);
    const spreads = await pool(outline.spreads, WRITERS, (_, i) => steps.spread(outline, i));
    book = assembleBook(job, outline, spreads);
    await fs.writeFile(path.join(dir, 'outline.json'), JSON.stringify(outline, null, 2));
  } catch (e) { e.stats = { usage: run.usage, cost: run.priced ? run.cost : null, calls: run.calls, repairs: run.repairs }; throw e; } // a failed run still cost tokens: the eval reports them
  const { planner, writer } = run; // recorded as roles() reads them back (regenerateSpread), like extra
  book.source = { file: job.fileName, pages: `${from}-${to}`, provider: job.provider, preset: run.preset.id, model: roleName(writer, job.provider), plannerModel: roleName(planner, job.provider),
    ...(job.extra && { extra: job.extra }), created: new Date().toISOString(), usage: run.usage, cost: run.priced ? +run.cost.toFixed(5) : null, calls: run.calls, repairs: run.repairs };
  const flagged = book.spreads.filter(s => s.fallback).length;
  log(`Total usage over ${run.calls} calls: ${fmtUsage(run.usage)}${run.priced ? ` · ≈ ${run.cost.toFixed(run.cost < 0.1 ? 4 : 2)}` : ''}${run.repairs ? ` · ${run.repairs} repair(s)` : ''}${flagged ? ` · ${flagged} spread(s) written by PopBook, flagged for regeneration` : ''}`);
  await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(book, null, 2));
  return book;
}

/** Writes spread `job.index` of an API-built book again, past the result cache, from its outline.json, its saved pages and
 *  source.pdf, and saves the book with the new spread and the usage added. Provider and models: the job's, else the book's own. */
export async function regenerateSpread(job, log) {
  const dir = path.join(BOOKS, job.slug), read = f => fs.readFile(path.join(dir, f), 'utf8').then(JSON.parse);
  const book = await read('book.json'), src = book.source || {};
  const outline = await read('outline.json').catch(() => { throw new Error('This book has no outline.json: only books written by an API model, one spread per call, can regenerate a spread'); });
  const i = job.index, plan = outline.spreads[i];
  if (!plan || book.spreads.length !== outline.spreads.length) throw new Error(`No spread ${i + 1} in this book's outline (${outline.spreads.length} spreads, the book has ${book.spreads.length})`);
  const j = { ...job, ...(!job.provider && { provider: src.provider, preset: src.preset, model: src.model, plannerModel: src.plannerModel || src.model }), lang: book.lang, extra: src.extra };
  if (!PROVIDERS[j.provider] || PROVIDERS[j.provider].agent) throw new Error('Regenerating a spread needs an API provider (an agent writes the whole book)');
  j.pages = await Promise.all(plan.pages.map(async n => {
    const img = await fs.readFile(pageFile(dir, n) + '.jpg', 'base64').catch(() => null);
    return { n, text: await fs.readFile(pageFile(dir, n) + '.txt', 'utf8').catch(() => ''), ...(img && { image: 'data:image/jpeg;base64,' + img }) };
  }));
  log(`Regenerating spread ${i + 1}/${book.spreads.length} of "${book.title}" (pages ${pageList(plan.pages)}, ${plan.block})…`);
  const steps = apiSteps(j, log, await loadPrompts(), await fs.readFile(path.join(dir, 'source.pdf')).catch(() => null)), { run } = steps;
  const s = await steps.spread(outline, i, { fresh: true });
  const v = validateBook({ ...book, spreads: book.spreads.map((x, k) => k === i ? s : x) }, { allowCustom: false });
  if (!v.ok) throw new Error('The book is invalid with the new spread:\n' + v.errors.join('\n'));
  v.book.source = { ...src, usage: addUsage(src.usage || emptyUsage(), run.usage), cost: src.cost != null && run.priced ? +(src.cost + run.cost).toFixed(5) : null,
    calls: (src.calls || 0) + run.calls, repairs: (src.repairs || 0) + run.repairs };
  log(`Usage: ${fmtUsage(run.usage)}${run.priced ? ` · ≈ ${run.cost.toFixed(4)}` : ''} over ${run.calls} call(s)`);
  await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(v.book, null, 2));
  return v.book;
}
