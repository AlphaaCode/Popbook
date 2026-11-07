// Page input: text cleaning, running header/footer removal and figure-page detection, on synthetic scans and on a real PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cleanText, cleanPages, readPdfPages, MIN_TEXT } from '../lib/pages.js';

const body = s => ({ str: s, eol: true, margin: false }), edge = s => ({ str: s, eol: true, margin: true });
const scan = (n, items, extra = {}) => ({ n, items, images: [], segments: 7, ...extra });
const BODY = 'Amdahl’s law bounds the speed-up of a program by its serial fraction, whatever the core count.';

test('cleanText collapses whitespace and joins words split at a line end', () => {
  assert.equal(cleanText('  Parallel   com-\nputing \t is\n\n\n\nfast  '), 'Parallel computing is\n\nfast');
  assert.equal(cleanText('Jean-\nPierre and well-known'), 'Jean-\nPierre and well-known'); // capitalised: a real hyphen
  assert.equal(cleanText(undefined), '');
});

test('running headers, footers and page numbers are dropped, their first occurrence kept', () => {
  const pages = cleanPages([1, 2, 3, 4].map(n => scan(n, [edge('Cours HPC · 2025'), body(BODY), edge(`${n} / 20`), edge(`Page ${n}`)])));
  assert.equal(pages[0].text, `Cours HPC · 2025\n${BODY}\nPage 1`); // "1 / 20" has no word: gone even from page 1
  for (const p of pages.slice(1)) assert.equal(p.text, BODY);
  // a margin line that is not on most pages is content (a slide title near the top, say)
  const once = cleanPages([scan(1, [edge('Introduction'), body(BODY)]), scan(2, [body(BODY)]), scan(3, [body(BODY)])]);
  assert.match(once[0].text, /^Introduction/);
  // with fewer than 3 pages nothing counts as repeated
  assert.match(cleanPages([1, 2].map(n => scan(n, [edge('Cours HPC'), body(BODY)])))[1].text, /^Cours HPC/);
});

test('figure pages: images that are not page furniture, drawings, or almost no text', () => {
  const logo = '400×120';
  const [plain, photo, drawing, scanned, logoOnly] = cleanPages([
    scan(1, [body(BODY)], { images: [logo] }),
    scan(2, [body(BODY)], { images: [logo, '1200×900'] }),
    scan(3, [body(BODY)], { images: [logo], segments: 7 + 150 }),
    scan(4, [body('x'.repeat(MIN_TEXT - 1))], { images: [logo] }),
    scan(5, [body(BODY)], { images: [logo] }),
  ]);
  assert.deepEqual([plain, photo, drawing, scanned, logoOnly].map(p => p.figure), [false, true, true, true, false]);
  assert.equal(cleanPages([scan(1, [body(BODY)], { images: [logo] })])[0].figure, true); // one page: no furniture to compare against
});

test('a real PDF: text read, footer removed, drawn and empty pages rendered as ≤1024 px JPEGs', async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i++) {
    const page = pdf.addPage([600, 800]);
    if (i !== 4) page.drawText(`Page ${i}: Gustafson's law scales the problem with the machine.`, { x: 40, y: 600, size: 12, font });
    page.drawText(`HPC course - page ${i}`, { x: 40, y: 30, size: 9, font });
    if (i === 2) for (let k = 0; k < 60; k++) page.drawLine({ start: { x: 40 + k * 8, y: 100 }, end: { x: 40 + k * 8, y: 500 } });
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const doc = await getDocument({ data: await pdf.save(), standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts') + path.sep, verbosity: 0 }).promise;
  const pages = await readPdfPages(doc, 1, 4, OPS);
  assert.deepEqual(pages.map(p => p.figure), [false, true, false, true]);
  assert.match(pages[0].text, /Gustafson.*\nHPC course - page 1$/s); // the footer, once
  assert.doesNotMatch(pages[2].text, /HPC course/);
  assert.equal(pages[0].image, undefined);
  for (const p of [pages[1], pages[3]]) {
    assert.match(p.image, /^data:image\/jpeg;base64,/);
    const jpg = Buffer.from(p.image.split(',')[1], 'base64'), sof = jpg.findIndex((b, i) => b === 0xff && (jpg[i + 1] & 0xf0) === 0xc0 && jpg[i + 1] !== 0xc4);
    assert.deepEqual([jpg.readUInt16BE(sof + 7), jpg.readUInt16BE(sof + 5)], [768, 1024]); // width × height: 600×800 pt, long side 1024
  }
  assert.equal((await readPdfPages(doc, 1, 4, OPS, { images: false }))[1].image, undefined);
});
