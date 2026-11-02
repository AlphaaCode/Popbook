// Generation pipeline: source pages -> model/agent -> validated book.json in books/<slug>/
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import { callModel, runAgent, PROVIDERS } from './providers.js';
import { validateBook } from './validate.js';

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

function userIntro(job, range, opts) {
  return [
    `Source file: ${job.fileName}. Pages ${range[0]}–${range[1]}${job.totalPages ? ` of ${job.totalPages}` : ''}.`,
    job.lang && job.lang !== 'auto' ? `Write the book in this language: ${job.lang}.` : 'Write the book in the language of the source.',
    opts.continuation ? `This is a continuation of a book that already has these spreads: ${opts.previous.map(s => '"' + s.title + '"').join(', ')}. Do NOT make a cover. Return a book object whose "spreads" contain only the NEW spreads for these pages.` : '',
    job.extra ? `Extra instructions from the author: ${job.extra}` : '',
    'The pages follow (as the original document and/or page images, plus extracted text). Return only the book.json object.',
  ].filter(Boolean).join('\n');
}

export async function generate(job, log) {
  const dir = path.join(BOOKS, job.slug); await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  const system = await fs.readFile(path.join(ROOT, 'prompts', 'system.md'), 'utf8');
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
      `Write books/${job.slug}/book.json, then run: node tools/check.mjs books/${job.slug} — fix every error it reports and run it again until it says OK.`,
    ].filter(Boolean).join('\n');
    log(`Starting ${P.label}…`);
    await runAgent(job.provider, { prompt, cwd: ROOT, model: job.model, onLine: l => log('  › ' + l), signal: job.signal });
    const txt = await fs.readFile(path.join(dir, 'book.json'), 'utf8').catch(() => { throw new Error(`The agent finished but books/${job.slug}/book.json does not exist`); });
    const v = validateBook(txt, { allowCustom: true });
    if (!v.ok) throw new Error('The agent wrote an invalid book.json:\n' + v.errors.join('\n'));
    v.warnings.forEach(w => log('warning: ' + w));
    return v.book;
  }

  /* ---------- API mode ---------- */
  if (job.provider === 'mock') { const ex = await fs.readFile(path.join(BOOKS, 'calcul-parallele', 'book.json'), 'utf8'); await fs.writeFile(path.join(dir, 'book.json'), ex); log('Mock provider: copied the example book'); return JSON.parse(ex); }
  const per = Math.max(3, Number(job.pagesPerCall) || 15);
  const batches = []; for (let a = from; a <= to; a += per) batches.push([a, Math.min(to, a + per - 1)]);
  let book = null;
  for (const [bi, range] of batches.entries()) {
    const pages = job.pages.filter(p => p.n >= range[0] && p.n <= range[1]);
    const parts = [{ type: 'text', text: userIntro(job, range, { continuation: bi > 0, previous: book?.spreads || [] }) }];
    if (pdfBuf && P.pdf && job.sendPdf !== false) parts.push({ type: 'pdf', base64: await slicePdf(pdfBuf, range[0], range[1]) });
    else if (P.images && job.sendImages !== false) pages.filter(p => p.image).forEach(p => parts.push({ type: 'text', text: `Image of page ${p.n}:` }, { type: 'image', dataUrl: p.image }));
    parts.push({ type: 'text', text: pages.map(p => `=== Page ${p.n} ===\n${(p.text || '').trim() || '(no extractable text — see the page image)'}`).join('\n\n') });
    let part = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !part; attempt++) {
      log(`Batch ${bi + 1}/${batches.length} (pages ${range[0]}–${range[1]}) → ${P.label}, model ${job.model || P.model}${attempt > 1 ? ` — repair attempt ${attempt}` : ''}…`);
      const t0 = Date.now();
      const extra = lastErr ? [{ type: 'text', text: `Your previous answer was rejected:\n${lastErr.errors.join('\n')}\n\nPrevious answer:\n${lastErr.json}\n\nReturn the complete corrected JSON only.` }] : [];
      const text = await callModel(job.provider, { system, parts: [...parts, ...extra], model: job.model, apiKey: job.apiKey, baseUrl: job.baseUrl, signal: job.signal });
      log(`  answer received in ${((Date.now() - t0) / 1000).toFixed(0)} s (${text.length} chars)`);
      let json; try { json = extractJson(text); } catch (e) { lastErr = { errors: [e.message], json: text.slice(0, 4000) }; log('  ' + e.message); continue; }
      const v = validateBook(json, { allowCustom: false });
      if (v.ok) { part = v.book; v.warnings.forEach(w => log('  warning: ' + w)); }
      else { lastErr = { errors: v.errors, json }; log('  invalid book: ' + v.errors.slice(0, 6).join(' | ')); }
    }
    if (!part) throw new Error('The model could not produce a valid book after 3 attempts. Try a stronger model or a smaller page range.');
    if (!book) book = part; else book.spreads.push(...part.spreads.filter(s => s.kind !== 'cover'));
  }
  book.source = { file: job.fileName, pages: `${from}-${to}`, provider: job.provider, model: job.model || P.model, created: new Date().toISOString() };
  await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(book, null, 2));
  return book;
}
