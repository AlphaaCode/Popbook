#!/usr/bin/env node
// Measures what a build costs: every PDF in eval/pdfs/ × every provider that has a key → eval/results.csv (one row per run).
// Usage: npm run eval -- [--pages 1-10] [--providers gemini,anthropic] [--model <id>] [--pdf <name part>] [--keep] [--baseline]
//   --providers mock   free dry run (the example book, no network)       --keep      also leave the books in books/
//   --baseline         also copy the results to eval/baseline.csv        --pages     range of each PDF (default 1-10, the studio's default)
// This runs the real pipeline on real pages and SPENDS REAL TOKENS. Pages are read like the studio reads them (lib/pages.js:
// clean text for every page, a rendered image for each figure page).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COLUMNS = ['date', 'pdf', 'pages', 'preset', 'model', 'validFirstTry', 'repairs', 'calls', 'spreads', 'warnings',
  'inputTokens', 'cachedInput', 'outputTokens', 'reasoning', 'cost', 'seconds', 'estInput', 'estOutput', 'error'];
export const csvLine = row => COLUMNS.map(c => { const v = String(row[c] ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');

export async function readPages(file, from, to) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { readPdfPages } = await import('../lib/pages.js');
  const buf = await fs.readFile(file);
  const doc = await getDocument({ data: new Uint8Array(buf), standardFontDataUrl: path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/') + path.sep, verbosity: 0 }).promise;
  to = Math.min(to, doc.numPages);
  return { buf, count: doc.numPages, to, pages: await readPdfPages(doc, from, to, OPS) }; // like the studio: clean text, images of figure pages
}

/** Runs the eval; returns the result rows. `providers` defaults to every API provider with a key in the environment. */
export async function runEval({ pdfDir = path.join(ROOT, 'eval', 'pdfs'), outDir = path.join(ROOT, 'eval'), providers, model, range = [1, 10], only, keep = false, log = console.log } = {}) {
  process.env.POPBOOK_MOCK = '1'; // the mock provider is only ever used when asked for
  const { PROVIDERS } = await import('../lib/providers.js');
  const { generate, loadPrompts, slugify, BOOKS } = await import('../lib/generate.js');
  const { estimate } = await import('../lib/estimate.js');
  const { costOf } = await import('../lib/models.js');

  const ids = providers?.length ? providers : Object.entries(PROVIDERS).filter(([id, P]) => P.env && id !== 'compat' && process.env[P.env]).map(([id]) => id);
  if (!ids.length) throw new Error('No provider to test: put an API key in .env or pass --providers mock');
  for (const id of ids) if (!PROVIDERS[id] || PROVIDERS[id].agent) throw new Error(`"${id}" is not an API provider (try: ${Object.keys(PROVIDERS).filter(k => !PROVIDERS[k].agent).join(', ')})`);
  const files = (await fs.readdir(pdfDir)).filter(f => /\.pdf$/i.test(f) && (!only || f.toLowerCase().includes(only.toLowerCase()))).sort();
  if (!files.length) throw new Error(`No PDF in ${path.relative(ROOT, pdfDir)} (add 2–3 course PDFs there)`);
  await fs.mkdir(path.join(outDir, 'out'), { recursive: true });
  const prompts = await loadPrompts(), rows = [];

  for (const f of files) {
    const { buf, count, to, pages } = await readPages(path.join(pdfDir, f), range[0], range[1]);
    for (const id of ids) {
      const P = PROVIDERS[id], mdl = model || P.model, slug = `eval-${slugify(f)}-${id}-${Date.now().toString(36)}`, lines = [];
      const job = { provider: id, model: mdl, fileName: f, totalPages: count, range: [range[0], to], pages, pdfBase64: buf.toString('base64'), slug, lang: 'auto', sendImages: true, extra: '', signal: AbortSignal.timeout(10 * 60 * 1000) };
      const est = estimate({ prompts, pages, range: job.range, provider: id, model: mdl, caps: P, hasPdf: true, sendImages: true });
      const figs = pages.filter(p => p.image).length;
      log(`▶ ${f} → ${id}:${mdl} (pages ${job.range.join('–')}, ${figs} as images)…`);
      const t0 = Date.now(); let book = null, err = null;
      try { book = await generate(job, m => lines.push(m)); } catch (e) { err = e; }
      const s = book?.source || err?.stats || {}, u = s.usage;
      const row = { date: new Date().toISOString(), pdf: f, pages: job.range.join('-'), preset: id, model: mdl, validFirstTry: book && s.repairs === 0 ? 1 : 0, repairs: s.repairs ?? '', calls: s.calls ?? '',
        spreads: book?.spreads.length ?? '', warnings: lines.filter(l => /warning:/.test(l)).length, inputTokens: u?.input ?? '', cachedInput: u?.cachedInput ?? '', outputTokens: u?.output ?? '', reasoning: u?.reasoning ?? '',
        cost: costOf(mdl, u) == null ? '' : +costOf(mdl, u).toFixed(5), seconds: +((Date.now() - t0) / 1000).toFixed(1), estInput: est.input, estOutput: est.output, error: err ? err.message.split('\n')[0].slice(0, 200) : '' };
      rows.push(row);
      if (book) await fs.copyFile(path.join(BOOKS, slug, 'book.json'), path.join(outDir, 'out', `${slugify(f)}__${id}.json`));
      if (!keep) await fs.rm(path.join(BOOKS, slug), { recursive: true, force: true });
      lines.filter(l => /invalid|did not return JSON|cut off|output-token limit|⚠/.test(l)).forEach(l => log('    ' + l.trim().slice(0, 300))); // why a try was rejected
      log(err ? `  ✗ ${row.error}` : `  ✓ ${row.spreads} spreads, ${row.validFirstTry ? 'valid first try' : row.repairs + ' repair(s)'}, in ${row.inputTokens} / out ${row.outputTokens} tokens${row.cost === '' ? '' : `, $${row.cost}`}, ${row.seconds} s`);
    }
  }
  await fs.writeFile(path.join(outDir, 'results.csv'), [COLUMNS.join(','), ...rows.map(csvLine)].join('\n') + '\n');
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  await import('../lib/env.js'); // keys from .env
  const range = (opt('--pages') || '1-10').split('-').map(Number);
  try {
    const rows = await runEval({ providers: opt('--providers')?.split(','), model: opt('--model'), range: [range[0], range[1] || range[0]], only: opt('--pdf'), keep: argv.includes('--keep') });
    if (argv.includes('--baseline')) await fs.copyFile(path.join(ROOT, 'eval', 'results.csv'), path.join(ROOT, 'eval', 'baseline.csv'));
    console.log(`\n${rows.length} run(s) → eval/results.csv${argv.includes('--baseline') ? ' (also saved as eval/baseline.csv)' : ''}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
