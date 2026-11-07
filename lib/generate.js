// Generation pipeline: source pages -> model/agent -> validated book.json in books/<slug>/
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import { callModel, runAgent, PROVIDERS, emptyUsage, addUsage, fmtUsage } from './providers.js';
import { validateBook } from './validate.js';
import { planBatches } from './estimate.js';
import { costOf, REASONING } from './models.js';

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
  throw new Error('The JSON in the answer is cut off (the model probably hit its output limit — try fewer pages per call)');
}

async function slicePdf(buf, from, to) {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const idx = []; for (let i = from - 1; i < Math.min(to, src.getPageCount()); i++) idx.push(i);
  (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
  return Buffer.from(await out.save()).toString('base64');
}

/* Prompt layout, the same for every call, so each provider can reuse a cached prefix: the system prompt (rules, then the block
 * catalogue: a fixed file, nothing per job in it) → this call's pages → this call's task, last because it changes most. */
function task(job, range, opts) {
  return [
    `The pages above are pages ${range[0]}–${range[1]}${job.totalPages ? ` of ${job.totalPages}` : ''} of ${job.fileName} (${opts.media}).`,
    job.lang && job.lang !== 'auto' ? `Write the book in this language: ${job.lang}.` : 'Write the book in the language of the source.',
    opts.continuation ? `This is a continuation of a book that already has these spreads: ${opts.previous.map(s => '"' + s.title + '"').join(', ')}. Do NOT make a cover. Return a book object whose "spreads" contain only the NEW spreads for these pages.` : '',
    job.extra ? `Extra instructions from the author: ${job.extra}` : '',
    'Return only the book.json object.',
  ].filter(Boolean).join('\n');
}

/** A repair resends the failing batch as it was (same prefix, so a cache hit) plus this note: the errors and only the spreads they
 *  point at, so the paths make sense. Never the whole rejected answer. */
function repairNote({ errors, json }) {
  let bad = [];
  try { const { spreads } = JSON.parse(json); bad = [...new Set(errors.map(e => Number(/^spreads\[(\d+)\]/.exec(e)?.[1])))].filter(i => spreads?.[i]).map(i => `spreads[${i}]: ${JSON.stringify(spreads[i])}`); } catch {}
  return ['Your previous answer was rejected:', ...errors.slice(0, 20).map(e => '- ' + e), ...(bad.length ? ['The spreads with errors, as you wrote them:', ...bad] : []),
    'Write the whole book JSON again with these errors fixed. Return only the minified JSON.'].join('\n');
}

/* Output cap of one call. A batch writes up to ~0.8 spreads per page plus the cover (prompts/system.md asks for 4–8 per 10 pages),
 * each capped at SPREAD_MAX_TOKENS (1 500), plus room to think: the model's budget, or THINK_ROOM when it thinks at its own default
 * level (OpenAI and Gemini count thinking against the cap; Claude does not think unless asked). The cap was 32 000. */
const THINK_ROOM = 8000;
export const outputCap = (provider, model, pages) => (Number(process.env.SPREAD_MAX_TOKENS) || 1500) * (Math.ceil(pages * 0.8) + 1)
  + (REASONING[model]?.budget ?? (provider === 'anthropic' ? 0 : THINK_ROOM));

export const systemPrompt = () => fs.readFile(path.join(ROOT, 'prompts', 'system.md'), 'utf8');

/** "in 12,345 · out 3,210 · ≈ $0.0421" for the job log (cost only when the model has a known price). */
function usageLine(model, u) {
  const c = costOf(model, u);
  return fmtUsage(u) + (c == null ? '' : ` · ≈ $${c.toFixed(c < 0.1 ? 4 : 2)}`);
}

export async function generate(job, log) {
  const dir = path.join(BOOKS, job.slug); await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  const system = await systemPrompt();
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
      `Make a PopBook from the course in books/${job.slug}/. Follow CLAUDE.md (agent instructions) and prompts/system.md (book format) exactly.`,
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

  /* ---------- API mode ---------- */
  const batches = planBatches(from, to, job.pagesPerCall);
  const native = pdfBuf && P.pdf && job.fidelity === 'high'; // the PDF pages themselves: opt-in, text + figure images cost far less
  const model = job.model || P.model, reasoning = REASONING[model];
  let book = null, total = emptyUsage(), calls = 0, repairs = 0;
  try {
  for (const [bi, range] of batches.entries()) {
    const pages = job.pages.filter(p => p.n >= range[0] && p.n <= range[1]);
    const parts = [];
    if (native) parts.push({ type: 'pdf', base64: await slicePdf(pdfBuf, range[0], range[1]) });
    else if (P.images && job.sendImages !== false) pages.filter(p => p.image).forEach(p => parts.push({ type: 'text', text: `Image of page ${p.n}:` }, { type: 'image', dataUrl: p.image }));
    parts.push({ type: 'text', text: pages.map(p => `=== Page ${p.n} ===\n${(p.text || '').trim() || '(no extractable text)'}`).join('\n\n') });
    const media = native ? 'the original PDF pages and their extracted text' : parts.some(p => p.type === 'image') ? 'extracted text, plus images of the pages with figures' : 'extracted text';
    parts.push({ type: 'text', text: task(job, range, { continuation: bi > 0, previous: book?.spreads || [], media }) });
    const maxTokens = outputCap(job.provider, model, pages.length);
    let part = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !part; attempt++) {
      log(`Batch ${bi + 1}/${batches.length} (pages ${range[0]}–${range[1]}) → ${P.label}, model ${model}, ≤ ${maxTokens.toLocaleString('en-US')} tokens out${reasoning ? `, reasoning ${reasoning.effort || reasoning.budget + ' tokens'}` : ''}${attempt > 1 ? ` — repair attempt ${attempt}` : ''}…`);
      if (attempt > 1) repairs++;
      const t0 = Date.now();
      const extra = lastErr ? [{ type: 'text', text: repairNote(lastErr) }] : [];
      let lastLog = Date.now(), truncated = false;
      const onProgress = (n, note) => { if (note) truncated = true; if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`  …receiving (${n} chars)`); } };
      const { text, usage } = await callModel(job.provider, { system, parts: [...parts, ...extra], model: job.model, maxTokens, reasoning, apiKey: job.apiKey, baseUrl: job.baseUrl, signal: job.signal, onProgress });
      calls++; total = addUsage(total, usage);
      if (truncated) log('  the answer hit the output-token limit; if it fails, lower "pages per call" (or raise SPREAD_MAX_TOKENS in .env)');
      log(`  answer received in ${((Date.now() - t0) / 1000).toFixed(0)} s (${text.length} chars) — ${usageLine(model, usage)}`);
      let json; try { json = extractJson(text); } catch (e) { lastErr = { errors: [e.message] }; log('  ' + e.message); continue; }
      const v = validateBook(json, { allowCustom: false });
      if (v.ok) { part = v.book; v.warnings.forEach(w => log('  warning: ' + w)); }
      else { lastErr = { errors: v.errors, json }; log('  invalid book: ' + v.errors.slice(0, 6).join(' | ')); }
    }
    if (!part) throw new Error('The model could not produce a valid book after 3 attempts. Try a stronger model or a smaller page range.');
    if (!book) book = part; else book.spreads.push(...part.spreads.filter(s => s.kind !== 'cover'));
  }
  } catch (e) { e.stats = { usage: total, calls, repairs }; throw e; } // a failed run still cost tokens: the eval reports them
  book.source = { file: job.fileName, pages: `${from}-${to}`, provider: job.provider, model, created: new Date().toISOString(), usage: total, calls, repairs };
  if (calls > 1) log(`Total usage over ${calls} calls: ${usageLine(model, total)}`);
  await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(book, null, 2));
  return book;
}
