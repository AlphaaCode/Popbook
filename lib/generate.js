// Generation pipeline: source pages -> model/agent -> validated book.json in books/<slug>/
// API mode takes the preset's path. Single (Budget): one call writes the whole book, per BATCH pages, from all the rules and every
// block spec. Staged (Balanced, Best): an outline call plans the book from all the page text, then writer calls (WRITERS at a time)
// write it, each up to GROUP neighbouring spreads from their own pages and their blocks' specs only. Every answer is fixed in code
// (lib/autofix.js) and validated; a staged spread that still fails gets a repair, then the planner model once, then a spread
// written by code from its pages, flagged in the book.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { callModel, runAgent, PROVIDERS, PACE, emptyUsage, addUsage, fmtUsage } from './providers.js';
import { validateBook, validateSpread, BLOCKS, writerSchema, outlineSchema, GROUP } from './validate.js';
import { fixSpread, fixOutline, fallbackSpread } from './autofix.js';
import { costOf, reasoningFor, inputsFor, capsOf, PRESETS, CHEAP, MODELS, AGENT_MODEL, BATCH, defaultPreset } from './models.js';
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
 *  writer of a spread that uses it; `custom` is agent-only). Section numbers stay, so the rules' cross-references still hold.
 *  single: the system prompt of a call that writes the whole book (Budget): all the rules, LENGTH, then every block's spec. */
// A whole book in one answer came out short (eval, Cours on gemini-3.6-flash: concept 134 and why 138 chars against the baseline's
// 221 and 199). With this: 212 and 188, for 0.9 % more input.
const LENGTH = `## Length (when you write the whole book)

The left page needs explanations, not captions. Within the limits of section 5: write every \`concept\` as 2–3 full sentences
and every \`why\` as 2 full sentences. Never shorten, simplify or drop a formula: write \`formula.eq\` as complete as the source gives it.`;
export async function loadPrompts() {
  const dir = path.join(ROOT, 'prompts'), blocks = {};
  for (const b of BLOCKS) if (b !== 'custom') blocks[b] = (await fs.readFile(path.join(dir, 'blocks', b + '.md'), 'utf8')).trim();
  const core = (await fs.readFile(path.join(dir, 'core.md'), 'utf8')).trim(), [intro, ...secs] = core.split(/\r?\n(?=## \d+\.)/);
  const pick = ns => [intro, ...secs.filter(s => ns.includes(+/^## (\d+)/.exec(s)[1]))].join('\n').trim();
  return { core, blocks, planner: pick([1, 2, 3, 6]), writer: pick([1, 4, 5, 7]), single: [core, LENGTH, '## Scene blocks', ...Object.values(blocks)].join('\n\n') };
}

/* Output caps (the single call of v0.1 had 32 000). An outline is ~50 tokens per spread: 1 000 + 100 per page is room for two
 * spreads a page. A spread is capped at SPREAD_MAX_TOKENS (1 500). Both plus room to think: the model's budget, or THINK_ROOM when
 * it thinks at its own default level (OpenAI and Gemini count thinking against the cap; Claude does not think unless asked). */
const THINK_ROOM = 8000;
const thinkRoom = r => r.reasoning?.budget ?? (r.provider === 'anthropic' ? 0 : THINK_ROOM); // r: a role, see roles()
export const outlineCap = (r, pages) => 1000 + 100 * pages + thinkRoom(r);
export const spreadCap = (r, n = 1) => n * (Number(process.env.SPREAD_MAX_TOKENS) || 1500) + thinkRoom(r); // n spreads in one answer
export const WRITERS = 3; // writer calls in flight at once; one on a provider with a request pace (Gemini, OpenAI-compatible)
const writersOf = r => PACE[r.provider] ? 1 : WRITERS;
/** The writer calls of n spreads: neighbouring spreads, GROUP at most per call, as even as possible (7 → 3, 2, 2). */
export const groupsOf = n => { const g = Math.ceil(n / GROUP), out = [];
  for (let k = 0, i = 0; k < g; k++) { const len = Math.floor(n / g) + (k < n % g ? 1 : 0); out.push(Array.from({ length: len }, (_, j) => i + j)); i += len; }
  return out; };

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

/** Who plans and who writes a job: { preset, planner, writer }, each role { provider, model, reasoning }. The preset (the provider's
 *  defaultPreset when none is given) picks a path and a tier per role; PLANNER_MODEL / WRITER_MODEL in .env override it with a model id, which may belong to another
 *  provider (a known id, or provider:model); the studio's fields (plannerModel, model) override both, on the selected provider
 *  unless they say provider:model. A role on another provider takes its key and server from .env. */
export function roles(job) {
  const P = PROVIDERS[job.provider], id = job.preset in PRESETS ? job.preset : defaultPreset(job.provider), preset = { id, ...PRESETS[id] };
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

const OUTLINE_SCHEMA = outlineSchema();

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

  /** schema: the answer's JSON schema, for a model that takes one. Every API puts it ahead of the system prompt in its cached prefix
   *  (Anthropic's tools, OpenAI's response_format, claude -p's --json-schema), so every writer of a book gets the same one. */
  async function call(what, r, system, parts, maxTokens, schema) {
    if (!capsOf(r.provider, r.model).schema) schema = undefined;
    const t0 = Date.now(); let lastLog = t0, truncated = false;
    log(`${what} → ${PROVIDERS[r.provider].label}, model ${r.model}, ≤ ${maxTokens.toLocaleString('en-US')} tokens out${r.reasoning ? `, reasoning ${r.reasoning.effort || r.reasoning.budget + ' tokens'}` : ''}…`);
    const onProgress = (n, note) => { if (note) truncated = true; if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`  ${what}: receiving (${n} chars)`); } };
    const own = r.provider === job.provider;
    const { text, usage } = await callModel(r.provider, { system, parts, model: r.model, maxTokens, reasoning: r.reasoning, schema,
      apiKey: own ? job.apiKey : undefined, baseUrl: own ? job.baseUrl : undefined, signal: job.signal, onProgress, onNote: m => log(`  ${what}: ${m}`) });
    const c = costOf(r.model, usage);
    run.calls++; run.usage = addUsage(run.usage, usage); if (c == null) run.priced = false; else run.cost += c;
    log(`  ${what}: answer in ${((Date.now() - t0) / 1000).toFixed(0)} s (${text.length} chars) — ${usageLine(r.model, usage)}`);
    if (truncated) log(`  ${what}: the answer hit the output-token limit (raise SPREAD_MAX_TOKENS in .env if this keeps failing)`);
    return text;
  }

  /** The repair ladder of one answer: one try per role in `rs` (first try, repair, escalation). Each answer is fixed in code
   *  and checked; its errors and fixed form go into the next try. → { value }, or { last, errors } when every try failed.
   *  A valid answer is kept in .cache/; the same call again (fresh: false) is answered from there, re-checked, for no tokens.
   *  prior: { errors, last } of a first try made elsewhere (a writer call of several spreads): the ladder starts at the repair. */
  async function ladder(what, system, parts, rs, cap, check, { fresh = false, schema, prior } = {}) {
    const file = job.cache !== false && path.join(CACHE, cacheKey([job.provider, rs, system, parts]) + '.json');
    if (file && !fresh) {
      const hit = await fs.readFile(file, 'utf8').then(JSON.parse, () => null), r = hit && check(hit);
      if (r?.ok) { log(`${what}: from the result cache, no tokens`); return { value: r.value }; }
    }
    let last = prior?.last ?? null, errors = prior?.errors ?? [];
    for (const [k, role] of rs.entries()) {
      if (!k && prior) continue;
      if (k) run.repairs++;
      const label = !k ? what : `${what} ${same(role, rs[0]) ? 'repair ' + k : 'escalated'}`;
      const text = await call(label, role, system, k ? [...parts, { type: 'text', text: repairNote(errors, last) }] : parts, cap(role), schema);
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
      raw => { const { outline, errors } = fixOutline(raw, ns); return { ok: !errors.length, value: outline, errors }; }, { schema: OUTLINE_SCHEMA });
    if (!r.value) throw new Error(`The model could not produce a valid outline after 3 attempts (${r.errors.slice(0, 3).join(' | ')}). Try a stronger model or a smaller page range.`);
    log(outlineLine(r.value));
    return r.value;
  }

  /** A writer call's parts for spreads `idxs` of the outline: the outline (shared by every writer), their blocks' specs, their pages,
   *  the task. One spread or several, the answer is {"spreads": […]}, of the book's one writer schema: any of its blocks, as cover or
   *  lesson. The shared prefix is that schema, the writer's rules and the outline; what differs per call (specs, pages) comes after. */
  async function writerParts(outline, idxs) {
    const plans = idxs.map(i => outline.spreads[i]), ns = new Set(plans.flatMap(p => p.pages)), ps = job.pages.filter(p => ns.has(p.n));
    const blocks = [...new Set(plans.map(p => p.block))], one = idxs.length === 1, n = outline.spreads.length;
    const parts = [{ type: 'text', text: outlineText(outline), cache: true },
      { type: 'text', text: `Scene block${blocks.length > 1 ? 's' : ''} for ${one ? 'this spread' : 'these spreads'}:\n\n` + blocks.map(b => prompts.blocks[b]).join('\n\n') },
      ...await media(ps, writer), { type: 'text', text: pagesText(ps) }];
    parts.push({ type: 'text', text: [`Task: ${one ? `spread ${idxs[0] + 1}/${n}` : `spreads ${idxs.map(i => i + 1).join(', ')} of ${n}`}.`,
      `Write ${one ? 'this spread' : 'these spreads'} of the outline${one ? '' : ', in this order'}:`,
      ...plans.map((p, k) => `- spread ${idxs[k] + 1}${p.kind === 'cover' ? ' (the cover)' : ''}: pages ${pageList(p.pages)}, block "${p.block}", intent: ${p.intent}`),
      `The pages above are ${one ? 'its' : 'their'} source (${said(parts)}).`, langLine(job, outline.lang), job.extra ? `Extra instructions from the author: ${job.extra}` : '',
      `Return only {"spreads":[…]} with ${one ? 'this one spread object' : `these ${idxs.length} spread objects, in order`} (section 5), each with "scene": {"type":"<its block>",…}.`].filter(Boolean).join('\n') });
    return { parts, ps };
  }
  const checkSpread = plan => raw => { const s = fixSpread(raw, plan), v = validateSpread(s); return { ok: v.ok, value: s, errors: v.errors, warnings: v.warnings }; };

  /** Step 2: outline.spreads[i] on its own: its pages, its block's spec. Always returns a valid spread (the last rung is code).
   *  fresh: skip the result cache (regenerate); the new answer still replaces the cached one. prior: see ladder(). */
  async function spread(outline, i, { fresh = false, prior } = {}) {
    const plan = outline.spreads[i], what = `Spread ${i + 1}/${outline.spreads.length}`, { parts, ps } = await writerParts(outline, [i]);
    const r = await ladder(what, prompts.writer, parts, [writer, writer, planner], p => spreadCap(p), checkSpread(plan),
      { fresh, prior, schema: writerSchema(outline.spreads) });
    if (r.value) { log(`${what} ✓ "${r.value.title}"`); return r.value; }
    const s = fallbackSpread(outline, i, ps.map(p => p.text).join('\n'), r.last);
    log(`${what} ⚠ the model failed 3 times (${r.errors.slice(0, 3).join(' | ')}): PopBook wrote its ${s.fallback.join(', ')} from the page text — regenerate it in the studio`);
    return s;
  }

  /** Step 2 for neighbouring spreads `idxs` (groupsOf) in one writer call. Each spread of the answer is fixed and checked on its own;
   *  one that fails (or is missing) climbs its own ladder from the repair, in a call of its own. */
  async function spreads(outline, idxs) {
    if (idxs.length === 1) return [await spread(outline, idxs[0])];
    const n = outline.spreads.length, what = `Spreads ${idxs[0] + 1}–${idxs.at(-1) + 1}/${n}`, { parts } = await writerParts(outline, idxs);
    const r = await ladder(what, prompts.writer, parts, [writer], p => spreadCap(p, idxs.length), raw => { // the list, each item fixed: cached as is
      const a = Array.isArray(raw?.spreads) ? raw.spreads : Array.isArray(raw) ? raw : null;
      return a ? { ok: true, value: idxs.map((i, k) => fixSpread(a[k], outline.spreads[i]) ?? null) } : { ok: false, errors: ['the answer has no "spreads" list'] };
    }, { schema: writerSchema(outline.spreads) });
    return Promise.all(idxs.map((i, k) => {
      const s = r.value?.[k], c = s ? checkSpread(outline.spreads[i])(s) : { errors: r.errors ?? [`spread ${i + 1} is missing from the answer`], value: null };
      if (!c.ok) { log(`  Spread ${i + 1}/${n} invalid: ${c.errors.slice(0, 6).join(' | ')}`); return spread(outline, i, { prior: { errors: c.errors, last: c.value } }); }
      c.warnings?.forEach(w => log(`  Spread ${i + 1}/${n} warning: ${w}`));
      log(`Spread ${i + 1}/${n} ✓ "${c.value.title}"`); return c.value;
    }));
  }

  /** A whole-book answer (Budget), each spread fixed in code, then validated. On failure `value` holds only the spreads the errors
   *  point at: what the repair echoes back, as phase 2 did, instead of the whole rejected book. */
  const checkBook = raw => {
    const b = raw && Array.isArray(raw.spreads) ? { ...raw, spreads: raw.spreads.map(s => fixSpread(s, { kind: s?.kind, block: s?.scene?.type })) } : raw;
    const v = validateBook(b, { allowCustom: false });
    if (v.ok) return { ok: true, value: v.book, warnings: v.warnings };
    const bad = [...new Set(v.errors.map(e => +/^spreads\[(\d+)\]/.exec(e)?.[1]))].filter(i => b?.spreads?.[i]);
    return { ok: false, errors: v.errors, value: bad.length ? Object.fromEntries(bad.map(i => [`spreads[${i}]`, b.spreads[i]])) : null };
  };

  /** Budget, phase 2's path: the whole book in one call per BATCH pages, by the writer, from all the rules and every block's spec.
   *  No outline, so no review and no regenerate; a rejected answer is resent with its errors, twice at most. */
  async function book() {
    const batches = []; for (let i = 0; i < job.pages.length; i += BATCH) batches.push(job.pages.slice(i, i + BATCH));
    let out = null;
    for (const ps of batches) {
      const ns = ps.map(p => p.n), what = batches.length > 1 ? `Book, pages ${pageList(ns)}` : 'Book', parts = [...await media(ps, writer), { type: 'text', text: pagesText(ps) }];
      parts.push({ type: 'text', text: [`Task: the whole book${out ? ', continued' : ''}: plan it (sections 1–3), then write every spread (sections 4–5).`,
        `The pages above are pages ${pageList(ns)}${job.totalPages ? ` of ${job.totalPages}` : ''} of ${job.fileName} (${said(parts)}).`, langLine(job, out?.lang),
        out ? `This continues a book that already has these spreads: ${out.spreads.map(s => `"${s.title}"`).join(', ')}. No cover: return a book whose "spreads" are only the new ones, for these pages.` : '',
        job.extra ? `Extra instructions from the author: ${job.extra}` : '', 'Return only the book.json object (section 5).'].filter(Boolean).join('\n') });
      const r = await ladder(what, prompts.single, parts, [writer, writer, writer], p => spreadCap(p, Math.ceil(ps.length * 0.8) + 1), checkBook);
      if (!r.value) throw new Error(`The model could not produce a valid book after 3 attempts (${r.errors.slice(0, 3).join(' | ')}). Try the Balanced preset, a stronger model or fewer pages.`);
      log(`${what} ✓ ${r.value.spreads.length} spreads: ${r.value.spreads.map(s => `"${s.title}"`).join(', ')}`);
      if (!out) out = r.value; else out.spreads.push(...r.value.spreads.filter(s => s.kind !== 'cover'));
    }
    return out;
  }

  return { run, outline, spread, spreads, book };
}

/** The book of an outline and its spreads, validated as a whole (each spread already passed on its own). */
function assembleBook(job, outline, spreads) {
  const { subtitle, coverColor, ui } = outline;
  const v = validateBook({ title: outline.title, ...(subtitle && { subtitle }), ...(coverColor && { coverColor }), ...(ui && { ui }),
    lang: job.lang && job.lang !== 'auto' ? job.lang : outline.lang, spreads }, { allowCustom: false });
  if (!v.ok) throw new Error('The assembled book is invalid:\n' + v.errors.join('\n'));
  return v.book;
}

/** Who plans for a local agent before it starts: the plain path of its family, used when installed or keyed (lib/providers.js). */
const AGENT_PLANNER = { claude: 'claude-cli', gemini: 'gemini', codex: 'openai' };
const pageFile = (dir, n) => path.join(dir, 'pages', `page-${String(n).padStart(3, '0')}`); // + .txt, and .jpg for pages sent as images

export async function generate(job, log) {
  const dir = path.join(BOOKS, job.slug); await fs.mkdir(dir, { recursive: true });
  const pdfBuf = job.pdfBase64 ? Buffer.from(job.pdfBase64, 'base64') : null;
  if (pdfBuf) await fs.writeFile(path.join(dir, 'source.pdf'), pdfBuf);
  const [from, to] = job.range, P = PROVIDERS[job.provider];
  const isImg = p => typeof p.image === 'string' && p.image.startsWith('data:image/'), jpg = p => Buffer.from(p.image.slice(p.image.indexOf(',') + 1), 'base64');

  /* ---------- agent mode: a bundle in input/ (the pages as one Markdown file, the figure images, a plan when a plain model of the
   * same family is at hand), and a PROMPT.md naming the files to read, so the agent neither opens the PDF nor explores the repo ---------- */
  if (P.agent) {
    const inDir = path.join(dir, 'input'), rel = `books/${job.slug}/input`, figs = job.pages.filter(isImg);
    await fs.rm(inDir, { recursive: true, force: true }); await fs.mkdir(inDir, { recursive: true });
    for (const p of figs) await fs.writeFile(path.join(inDir, `fig-${p.n}.jpg`), jpg(p));
    await fs.writeFile(path.join(inDir, 'pages.md'), [`# ${job.fileName || 'Course'}, pages ${pageList(job.pages.map(p => p.n))}`,
      ...job.pages.map(p => `## Page ${p.n}\n\n${(p.text || '').trim() || '(no extractable text)'}${isImg(p) ? `\n\n![page ${p.n}](fig-${p.n}.jpg)` : ''}`)].join('\n\n') + '\n');
    log(`Saved ${job.pages.length} page(s) of text${figs.length ? ` and ${figs.length} figure image(s)` : ''} to ${rel}/`);
    let outline = null, plan = null;
    const pp = AGENT_PLANNER[P.agent];
    if (pp && (PROVIDERS[pp].cli || process.env[PROVIDERS[pp].env])) {
      plan = apiSteps({ ...job, provider: pp, model: undefined, plannerModel: undefined, apiKey: undefined, baseUrl: undefined }, log, await loadPrompts(), pdfBuf);
      try { outline = await plan.outline(); await fs.writeFile(path.join(inDir, 'outline.json'), JSON.stringify(outline, null, 2)); }
      catch (e) { log(`No outline from ${PROVIDERS[pp].label} (${e.message.split('\n')[0]}): the agent plans the book itself`); }
    }
    const blocks = outline && [...new Set(outline.spreads.map(s => s.block))];
    const prompt = [
      `Make a PopBook from the course pages in ${rel}/: write books/${job.slug}/book.json.`,
      `Read only: ${rel}/pages.md (the pages' text)${figs.length ? ', the figure images it links when a figure matters' : ''}${outline ? `, ${rel}/outline.json (the plan: write its spreads in its order, each with its pages and block)` : ''}, prompts/core.md (the format and rules), and ${blocks ? `the specs of the plan's blocks: ${blocks.map(b => `prompts/blocks/${b}.md`).join(', ')}` : 'prompts/blocks/<name>.md for each block you use'}.`,
      'Do not open source.pdf or any other file of the repository: everything you need is listed above.',
      langLine(job, outline?.lang), job.extra ? `Extra instructions from the author: ${job.extra}` : '',
      `Then run: node tools/check.mjs books/${job.slug} — fix every error it reports and run it again until it says OK. Write nothing outside books/${job.slug}/. When it passes, stop.`,
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
    const raw = JSON.parse(txt); // the run's usage: the agent's (when it reports it) plus the plan's
    raw.source = { ...raw.source, ...(usage && { usage: addUsage(usage, plan?.run.usage) }), ...(outline && { plannerModel: roleName(plan.run.planner, job.provider) }) };
    await fs.writeFile(file, JSON.stringify(raw, null, 2)); v.book.source = raw.source;
    return v.book;
  }

  await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  for (const p of job.pages) { // API mode: what regenerateSpread reads back
    await fs.writeFile(pageFile(dir, p.n) + '.txt', p.text || '');
    if (isImg(p)) await fs.writeFile(pageFile(dir, p.n) + '.jpg', jpg(p));
  }
  log(`Saved ${job.pages.length} page(s) of text${pdfBuf ? ' and the PDF' : ''} to books/${job.slug}/`);

  /* ---------- API mode: the whole book in one call (Budget), or outline → spreads ---------- */
  const steps = apiSteps(job, log, await loadPrompts(), pdfBuf), { run } = steps, single = run.preset.path === 'single';
  log(single ? `${run.preset.label} path: one call writes the whole book${job.pages.length > BATCH ? ` (${BATCH} pages per call)` : ''}, model ${run.writer.model}`
    : `${run.preset.label} path: ${run.planner.model} plans the book, then ${run.writer.model} writes up to ${GROUP} spreads per call`);
  let book;
  try {
    if (single) {
      if (typeof job.review === 'function') log('No outline to review: Budget writes the book in one call (pick Balanced or Best to review it)');
      const b = await steps.book(); book = assembleBook(job, b, b.spreads);
      await fs.rm(path.join(dir, 'outline.json'), { force: true }); // a stale plan would offer "regenerate" for spreads it did not plan
    } else {
      let outline = await steps.outline();
      if (typeof job.review === 'function') { outline = await job.review(outline); log(outlineLine(outline, ' (reviewed)')); } // server.js: the studio's outline review
      const [first, ...rest] = groupsOf(outline.spreads.length);
      const n = writersOf(run.writer);
      log(`Writing ${outline.spreads.length} spreads in ${rest.length + 1} call(s) of up to ${GROUP}: ${n > 1 ? `the first alone (it writes the shared prefix to the provider's cache), then ${n} at a time` : `one at a time, at least ${PACE[run.writer.provider] / 1000} s apart (the provider's request limit)`}…`);
      const spreads = [await steps.spreads(outline, first), ...await pool(rest, n, g => steps.spreads(outline, g))].flat();
      book = assembleBook(job, outline, spreads);
      await fs.writeFile(path.join(dir, 'outline.json'), JSON.stringify(outline, null, 2));
    }
  } catch (e) { e.stats = { usage: run.usage, cost: run.priced ? run.cost : null, calls: run.calls, repairs: run.repairs }; throw e; } // a failed run still cost tokens: the eval reports them
  const { planner, writer } = run; // recorded as roles() reads them back (regenerateSpread), like extra
  book.source = { file: job.fileName, pages: `${from}-${to}`, provider: job.provider, preset: run.preset.id, model: roleName(writer, job.provider), ...(!single && { plannerModel: roleName(planner, job.provider) }),
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
