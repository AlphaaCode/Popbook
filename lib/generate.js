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
import { costOf, REASONING } from './models.js';
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

/** The prompt parts: prompts/core.md (the rules, the system prompt of every call) and prompts/blocks/<name>.md (one scene block
 *  each, sent only to the writer of a spread that uses it; `custom` is agent-only). */
export async function loadPrompts() {
  const dir = path.join(ROOT, 'prompts'), blocks = {};
  for (const b of BLOCKS) if (b !== 'custom') blocks[b] = (await fs.readFile(path.join(dir, 'blocks', b + '.md'), 'utf8')).trim();
  return { core: (await fs.readFile(path.join(dir, 'core.md'), 'utf8')).trim(), blocks };
}

/* Output caps (the single call of v0.1 had 32 000). An outline is ~50 tokens per spread: 1 000 + 100 per page is room for two
 * spreads a page. A spread is capped at SPREAD_MAX_TOKENS (1 500). Both plus room to think: the model's budget, or THINK_ROOM when
 * it thinks at its own default level (OpenAI and Gemini count thinking against the cap; Claude does not think unless asked). */
const THINK_ROOM = 8000;
const thinkRoom = (provider, model) => REASONING[model]?.budget ?? (provider === 'anthropic' ? 0 : THINK_ROOM);
export const outlineCap = (provider, model, pages) => 1000 + 100 * pages + thinkRoom(provider, model);
export const spreadCap = (provider, model) => (Number(process.env.SPREAD_MAX_TOKENS) || 1500) + thinkRoom(provider, model);
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

/* ---------- prompt pieces. Layout of every call, most stable first so providers reuse a cached prefix: core rules (system) →
 * the outline (writers) → the block spec (writers) → the pages → the task. Nothing per job comes before the pages. ---------- */
const pagesText = ps => ps.map(p => `=== Page ${p.n} ===\n${(p.text || '').trim() || '(no extractable text)'}`).join('\n\n');
const pageList = ns => ns.length > 1 && ns.at(-1) - ns[0] === ns.length - 1 ? `${ns[0]}–${ns.at(-1)}` : ns.join(', ');
const langLine = (job, lang) => job.lang && job.lang !== 'auto' ? `Write in this language: ${job.lang}.` : lang ? `Write in the book's language: ${lang}.` : 'Write in the language of the source.';
/** The outline as every writer of a job sees it: identical bytes for each spread, so it caches along with the system prompt. */
export const outlineText = o => [`Book outline: "${o.title}"${o.subtitle ? ` — ${o.subtitle}` : ''}${o.lang ? ` (lang: ${o.lang})` : ''}`,
  ...o.spreads.map((s, i) => `${i + 1}. ${s.kind === 'cover' ? 'cover · ' : ''}pages ${pageList(s.pages)} · ${s.block} — ${s.intent}`)].join('\n');
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

/** The API-mode steps of one job: `outline()` and `spread(outline, i)`, with usage, calls and repairs summed in `run`. */
function apiSteps(job, log, prompts, pdfBuf) {
  const P = PROVIDERS[job.provider], system = prompts.core;
  const model = job.model || P.model, planner = job.plannerModel || model; // phase 4 routes the planner to a stronger model
  const native = !!pdfBuf && P.pdf && job.fidelity === 'high'; // the PDF pages themselves: opt-in, text + figure images cost far less
  const images = !native && P.images && job.sendImages !== false;
  const run = { model, planner, usage: emptyUsage(), calls: 0, repairs: 0 };

  /** What a model sees of some pages besides their text: their PDF pages at high fidelity, else an image of each figure page. */
  const media = async ps => native ? (ps.length ? [{ type: 'pdf', base64: await slicePdf(pdfBuf, ps.map(p => p.n)) }] : [])
    : images ? ps.filter(p => p.image).flatMap(p => [{ type: 'text', text: `Image of page ${p.n}:` }, { type: 'image', dataUrl: p.image }]) : [];
  const said = parts => native ? 'the PDF pages and their extracted text' : parts.some(p => p.type === 'image') ? 'extracted text, plus images of the pages with figures' : 'extracted text';

  async function call(what, m, parts, maxTokens) {
    const reasoning = REASONING[m], t0 = Date.now(); let lastLog = t0, truncated = false;
    log(`${what} → ${P.label}, model ${m}, ≤ ${maxTokens.toLocaleString('en-US')} tokens out${reasoning ? `, reasoning ${reasoning.effort || reasoning.budget + ' tokens'}` : ''}…`);
    const onProgress = (n, note) => { if (note) truncated = true; if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`  ${what}: receiving (${n} chars)`); } };
    const { text, usage } = await callModel(job.provider, { system, parts, model: m, maxTokens, reasoning, apiKey: job.apiKey, baseUrl: job.baseUrl, signal: job.signal, onProgress });
    run.calls++; run.usage = addUsage(run.usage, usage);
    log(`  ${what}: answer in ${((Date.now() - t0) / 1000).toFixed(0)} s (${text.length} chars) — ${usageLine(m, usage)}`);
    if (truncated) log(`  ${what}: the answer hit the output-token limit (raise SPREAD_MAX_TOKENS in .env if this keeps failing)`);
    return text;
  }

  /** The repair ladder of one answer: one try per entry of `models` (first try, repair, escalation). Each answer is fixed in code
   *  and checked; its errors and fixed form go into the next try. → { value }, or { last, errors } when every try failed.
   *  A valid answer is kept in .cache/; the same call again (fresh: false) is answered from there, re-checked, for no tokens. */
  async function ladder(what, parts, models, cap, check, { fresh = false } = {}) {
    const file = job.cache !== false && path.join(CACHE, cacheKey([job.provider, models, system, parts]) + '.json');
    if (file && !fresh) {
      const hit = await fs.readFile(file, 'utf8').then(JSON.parse, () => null), r = hit && check(hit);
      if (r?.ok) { log(`${what}: from the result cache, no tokens`); return { value: r.value }; }
    }
    let last = null, errors = [];
    for (const [k, m] of models.entries()) {
      if (k) run.repairs++;
      const label = !k ? what : `${what} ${m !== models[0] ? 'escalated' : 'repair ' + k}`;
      const text = await call(label, m, k ? [...parts, { type: 'text', text: repairNote(errors, last) }] : parts, cap(m));
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
    const ns = job.pages.map(p => p.n), parts = [...await media(job.pages.filter(p => (p.text || '').trim().length < MIN_TEXT)), { type: 'text', text: pagesText(job.pages) }];
    parts.push({ type: 'text', text: ['Task: outline.', `The pages above are pages ${pageList(ns)}${job.totalPages ? ` of ${job.totalPages}` : ''} of ${job.fileName} (${said(parts)}).`,
      langLine(job), job.extra ? `Extra instructions from the author: ${job.extra}` : '', 'Return only the outline JSON (section 3).'].filter(Boolean).join('\n') });
    const r = await ladder('Outline', parts, [planner, planner, planner], m => outlineCap(job.provider, m, ns.length),
      raw => { const { outline, errors } = fixOutline(raw, ns); return { ok: !errors.length, value: outline, errors }; });
    if (!r.value) throw new Error(`The model could not produce a valid outline after 3 attempts (${r.errors.slice(0, 3).join(' | ')}). Try a stronger model or a smaller page range.`);
    log(`Outline: "${r.value.title}", ${r.value.spreads.length} spreads — ${r.value.spreads.map(s => `p. ${pageList(s.pages)} ${s.kind === 'cover' ? 'cover/' : ''}${s.block}`).join(' · ')}`);
    return r.value;
  }

  /** Step 2: outline.spreads[i] from its own pages and its block's spec. Always returns a valid spread (the last rung is code). */
  async function spread(outline, i) {
    const plan = outline.spreads[i], ps = job.pages.filter(p => plan.pages.includes(p.n)), what = `Spread ${i + 1}/${outline.spreads.length}`;
    const parts = [{ type: 'text', text: outlineText(outline), cache: true }, { type: 'text', text: 'Scene block for this spread:\n\n' + prompts.blocks[plan.block] },
      ...await media(ps), { type: 'text', text: pagesText(ps) }];
    parts.push({ type: 'text', text: [`Task: spread ${i + 1}/${outline.spreads.length}.`,
      `Write spread ${i + 1} of the outline${plan.kind === 'cover' ? ' (the cover)' : ''}: pages ${pageList(plan.pages)}, block "${plan.block}", intent: ${plan.intent}`,
      `The pages above are its source (${said(parts)}).`, langLine(job, outline.lang), job.extra ? `Extra instructions from the author: ${job.extra}` : '',
      `Return only this one spread object (section 5), with "scene": {"type":"${plan.block}",…}.`].filter(Boolean).join('\n') });
    const r = await ladder(what, parts, [model, model, planner], m => spreadCap(job.provider, m),
      raw => { const s = fixSpread(raw, plan), v = validateSpread(s); return { ok: v.ok, value: s, errors: v.errors, warnings: v.warnings }; });
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

export async function generate(job, log) {
  const dir = path.join(BOOKS, job.slug); await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  const pdfBuf = job.pdfBase64 ? Buffer.from(job.pdfBase64, 'base64') : null;
  if (pdfBuf) await fs.writeFile(path.join(dir, 'source.pdf'), pdfBuf);
  for (const p of job.pages) {
    const base = path.join(dir, 'pages', `page-${String(p.n).padStart(3, '0')}`);
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
    const { usage } = await runAgent(job.provider, { prompt: `Read books/${job.slug}/PROMPT.md and do exactly what it says.`, cwd: ROOT, model: job.model, onLine: l => log('  › ' + l), signal: job.signal });
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
    const outline = await steps.outline();
    log(`Writing ${outline.spreads.length} spreads, ${WRITERS} at a time…`);
    const spreads = await pool(outline.spreads, WRITERS, (_, i) => steps.spread(outline, i));
    book = assembleBook(job, outline, spreads);
    await fs.writeFile(path.join(dir, 'outline.json'), JSON.stringify(outline, null, 2));
  } catch (e) { e.stats = { usage: run.usage, calls: run.calls, repairs: run.repairs }; throw e; } // a failed run still cost tokens: the eval reports them
  // ponytail: one model's prices for the total; when phase 4 routes the planner elsewhere, sum the cost per call instead
  book.source = { file: job.fileName, pages: `${from}-${to}`, provider: job.provider, model: run.model, ...(run.planner !== run.model && { plannerModel: run.planner }),
    created: new Date().toISOString(), usage: run.usage, calls: run.calls, repairs: run.repairs };
  const flagged = book.spreads.filter(s => s.fallback).length;
  log(`Total usage over ${run.calls} calls: ${usageLine(run.model, run.usage)}${run.repairs ? ` · ${run.repairs} repair(s)` : ''}${flagged ? ` · ${flagged} spread(s) written by PopBook, flagged for regeneration` : ''}`);
  await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(book, null, 2));
  return book;
}
