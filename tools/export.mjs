#!/usr/bin/env node
// Exports a book as one self-contained HTML file.  Usage: node tools/export.mjs books/<slug> [out.html]
import fs from 'node:fs';
import path from 'node:path';
import { exportBook } from '../lib/export.js';

const [dir, outArg] = process.argv.slice(2);
if (!dir) { console.error('Usage: node tools/export.mjs books/<slug> [out.html]'); process.exit(1); }
const slug = path.basename(path.resolve(dir));
const out = outArg || `${slug}.html`;
try {
  fs.writeFileSync(out, await exportBook(slug));
  console.log(`✓ ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB) — open it in any browser; three.js and fonts load from a CDN.`);
} catch (e) { console.error('✗ ' + e.message); process.exit(1); }
