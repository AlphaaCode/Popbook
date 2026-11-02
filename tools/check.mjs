#!/usr/bin/env node
// Validates book folders.  Usage: node tools/check.mjs [books/<slug> ...]   (no argument = every book)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBook } from '../lib/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dirs = process.argv.slice(2);
if (!dirs.length) dirs = fs.readdirSync(path.join(ROOT, 'books'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join('books', d.name));

let failed = 0;
for (const d of dirs) {
  const dir = path.resolve(d), file = fs.statSync(dir, { throwIfNoEntry: false })?.isFile() ? dir : path.join(dir, 'book.json');
  const name = path.relative(ROOT, file);
  if (!fs.existsSync(file)) { console.log(`✗ ${name}: file not found`); failed++; continue; }
  const v = validateBook(fs.readFileSync(file, 'utf8'), { allowCustom: true });
  if (v.book?.spreads) for (const [i, s] of v.book.spreads.entries())
    if (s?.scene?.type === 'custom' && s.scene.module && !fs.existsSync(path.join(path.dirname(file), s.scene.module))) v.errors.push(`spreads[${i}].scene.module: ${s.scene.module} does not exist`);
  v.warnings.forEach(w => console.log(`  warning  ${w}`));
  if (v.errors.length) { failed++; console.log(`✗ ${name}: ${v.errors.length} error(s)`); v.errors.forEach(e => console.log(`  error    ${e}`)); }
  else console.log(`✓ ${name} OK — "${v.book.title}", ${v.book.spreads.length} spreads${v.warnings.length ? `, ${v.warnings.length} warning(s)` : ''}`);
}
process.exit(failed ? 1 : 0);
