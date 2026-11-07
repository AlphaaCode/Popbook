#!/usr/bin/env node
// Extracts the clean text of each PDF page (lib/pages.js: no running headers/footers) into books/<slug>/pages/page-NNN.txt,
// copies the PDF to books/<slug>/source.pdf and lists the pages with figures, tables or scans.
// Usage: node tools/pdf2pages.mjs <file.pdf> [--pages 1-10] [--out books/<slug>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfPages } from '../lib/pages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const range = opt('--pages'), outOpt = opt('--out');
const file = args[0];
if (!file || !fs.existsSync(file)) { console.error('Usage: node tools/pdf2pages.mjs <file.pdf> [--pages 1-10] [--out books/<slug>]'); process.exit(1); }

const slug = path.basename(file).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.pdf$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'book';
const out = path.resolve(outOpt || path.join(ROOT, 'books', slug));
const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data: data.slice(), standardFontDataUrl: path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/') + path.sep, verbosity: 0 }).promise;
let [from, to] = (range || `1-${doc.numPages}`).split('-').map(Number);
to = Math.min(to || from, doc.numPages); from = Math.max(1, from || 1);
if (!(from <= to)) { console.error(`Bad page range "${range}" (the PDF has ${doc.numPages} pages)`); process.exit(1); }

fs.mkdirSync(path.join(out, 'pages'), { recursive: true });
if (path.resolve(file) !== path.join(out, 'source.pdf')) fs.writeFileSync(path.join(out, 'source.pdf'), data);
const pages = await readPdfPages(doc, from, to, OPS, { images: false });
for (const p of pages) fs.writeFileSync(path.join(out, 'pages', `page-${String(p.n).padStart(3, '0')}.txt`), p.text + '\n');
const empty = pages.filter(p => !p.text).length, figures = pages.filter(p => p.figure).map(p => p.n);
console.log(`✓ ${to - from + 1} page(s) of ${doc.numPages} → ${path.relative(ROOT, out) || out}${path.sep}pages${path.sep}`);
if (empty) console.log(`  ${empty} page(s) had no text layer (scanned?) — read source.pdf directly for those.`);
if (figures.length) console.log(`  Figures, tables or scans on page(s) ${figures.join(', ')} — look at source.pdf for those.`);
