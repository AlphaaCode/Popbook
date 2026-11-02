#!/usr/bin/env node
// Extracts the text of each PDF page into books/<slug>/pages/page-NNN.txt and copies the PDF to books/<slug>/source.pdf.
// Usage: node tools/pdf2pages.mjs <file.pdf> [--pages 1-10] [--out books/<slug>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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
let empty = 0;
for (let n = from; n <= to; n++) {
  const tc = await (await doc.getPage(n)).getTextContent();
  const text = tc.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim();
  if (!text) empty++;
  fs.writeFileSync(path.join(out, 'pages', `page-${String(n).padStart(3, '0')}.txt`), text + '\n');
}
console.log(`✓ ${to - from + 1} page(s) of ${doc.numPages} → ${path.relative(ROOT, out) || out}${path.sep}pages${path.sep}`);
if (empty) console.log(`  ${empty} page(s) had no text layer (scanned?) — read source.pdf directly for those.`);
