// Builds a single self-contained HTML file for a book (three.js loads from a CDN; everything else is inlined).
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, BOOKS } from './generate.js';
import { validateBook } from './validate.js';

const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const MODS = { 'popbook/engine.js': 'viewer/engine.js', 'popbook/kit.js': 'viewer/kit.js', 'popbook/blocks.js': 'viewer/blocks.js', 'popbook/i18n.js': 'viewer/i18n.js', 'popbook/validate.js': 'lib/validate.js', 'popbook/expr.js': 'lib/expr.js' };
const rewrite = src => src.replace(/from\s+['"](\.\.?\/[^'"]+)['"]/g, (m, p) => `from 'popbook/${path.basename(p)}'`).replace(/import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g, (m, p) => `import('popbook/${path.basename(p)}')`);
const dataUrl = src => 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
const escScript = s => s.replace(/<\/script/gi, '<\\/script');

export async function exportBook(slug) {
  const dir = path.join(BOOKS, slug);
  const raw = await fs.readFile(path.join(dir, 'book.json'), 'utf8');
  const v = validateBook(raw); if (!v.ok) throw new Error('book.json has errors:\n' + v.errors.join('\n'));
  let html = await fs.readFile(path.join(ROOT, 'viewer', 'index.html'), 'utf8');
  const css = await fs.readFile(path.join(ROOT, 'viewer', 'viewer.css'), 'utf8');
  const imports = { three: THREE_CDN }, custom = {};
  for (const [spec, file] of Object.entries(MODS)) imports[spec] = dataUrl(rewrite(await fs.readFile(path.join(ROOT, file), 'utf8')));
  for (const s of v.book.spreads) if (s.scene.type === 'custom') { const spec = 'popbook-custom/' + s.scene.module; imports[spec] = dataUrl(await fs.readFile(path.join(dir, s.scene.module), 'utf8')); custom[s.scene.module] = spec; }
  const replaceBlock = (name, content) => { html = html.replace(new RegExp(`<!--POPBOOK:${name}-->[\\s\\S]*?<!--/POPBOOK:${name}-->`), () => content); };
  replaceBlock('STYLE', `<style>\n${css}\n</style>`);
  replaceBlock('IMPORTMAP', `<script type="importmap">${JSON.stringify({ imports })}</script>`);
  replaceBlock('BOOT', `<script>window.__POPBOOK_MODULES__ = ${JSON.stringify(custom)};</script>\n<script type="module">\nimport { startViewer } from 'popbook/engine.js';\nconst book = ${escScript(JSON.stringify(JSON.parse(raw)))};\nstartViewer({ book, base: '.' }).catch(e => { console.error(e); });\n</script>`);
  html = html.replace('<title>PopBook</title>', `<title>${v.book.title.replace(/[<&]/g, '')} — PopBook</title>`);
  return html;
}
