// `npm run eval` end to end on a tiny generated PDF with the mock provider (no network, no keys, no files from eval/pdfs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { runEval, csvLine, COLUMNS } from '../tools/eval.mjs';

test('eval: one row per pdf × provider, results.csv written, books cleaned up', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'popbook-eval-'));
  try {
    const pdfs = path.join(tmp, 'pdfs'); await fs.mkdir(pdfs);
    const doc = await PDFDocument.create();
    for (let i = 1; i <= 3; i++) doc.addPage().drawText(`Amdahl's law, page ${i}: speedup = 1 / (s + p / n)`, { x: 40, y: 700, size: 14 });
    await fs.writeFile(path.join(pdfs, 'Tiny Course.pdf'), await doc.save());

    const rows = await runEval({ pdfDir: pdfs, outDir: tmp, providers: ['mock'], range: [1, 3], log: () => {} });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.pdf, 'Tiny Course.pdf'); assert.equal(r.preset, 'mock');
    assert.equal(r.validFirstTry, 1); assert.equal(r.repairs, 0); assert.equal(r.calls, 7); assert.equal(r.spreads, 6); // an outline, then one call per spread
    assert.ok(r.inputTokens > 0 && r.outputTokens > 0 && r.estInput > 0);
    assert.equal(r.error, '');

    const csv = (await fs.readFile(path.join(tmp, 'results.csv'), 'utf8')).trim().split('\n');
    assert.equal(csv.length, 2);
    assert.equal(csv[0], COLUMNS.join(','));
    assert.ok((await fs.readdir(path.join(tmp, 'out'))).includes('tiny-course__mock.json'));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('eval: refuses to run with nothing to test', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'popbook-eval-'));
  try {
    await assert.rejects(runEval({ pdfDir: tmp, outDir: tmp, providers: ['mock'], log: () => {} }), /No PDF/);
    await assert.rejects(runEval({ pdfDir: tmp, outDir: tmp, providers: ['agent-claude'], log: () => {} }), /not an API provider/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('csv cells with commas, quotes or newlines are quoted', () => {
  assert.match(csvLine({ pdf: 'a,b.pdf' }), /"a,b\.pdf"/);
  assert.match(csvLine({ error: 'say "no"' }), /"say ""no"""/);
});
