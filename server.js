// PopBook Studio — local server. Run: npm start  (then open http://localhost:5173)
import './lib/env.js'; // must stay first: loads .env before the other modules read process.env
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, BOOKS, generate, slugify, loadPrompts } from './lib/generate.js';
import { PROVIDERS, agentAvailable } from './lib/providers.js';
import { estimate } from './lib/estimate.js';
import { exportBook } from './lib/export.js';
import { validateBook } from './lib/validate.js';
import { fixOutline, API_BLOCKS } from './lib/autofix.js';


const PORT = Number(process.env.PORT || 5173), HOST = process.env.HOST || '127.0.0.1';
const STATIC = { '/': 'app', '/viewer': 'viewer', '/lib': 'lib', '/books': 'books', '/prompts': 'prompts',
  '/vendor/three': 'node_modules/three/build', '/vendor/pdfjs': 'node_modules/pdfjs-dist/build' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
const jobs = new Map();

const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
async function readBody(req, limit = 120 * 1024 * 1024) { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > limit) throw new Error('Upload too large'); chunks.push(c); } return Buffer.concat(chunks).toString('utf8'); }

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/config' && req.method === 'GET') {
    const providers = Object.entries(PROVIDERS).map(([id, P]) => ({ id, label: P.label, model: P.model || '', agent: !!P.agent, available: P.agent ? agentAvailable(P.agent) : true,
      hasKey: P.env ? !!process.env[P.env] : true, needsKey: !!P.env && id !== 'compat', baseUrl: P.baseUrl || '', images: !!P.images, pdf: !!P.pdf }));
    return send(res, 200, { providers, blocks: API_BLOCKS, defaultProvider: process.env.DEFAULT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : agentAvailable('claude') ? 'agent-claude' : 'anthropic') });
  }
  if (p === '/api/books' && req.method === 'GET') {
    await fsp.mkdir(BOOKS, { recursive: true });
    const out = [];
    for (const d of await fsp.readdir(BOOKS, { withFileTypes: true })) { if (!d.isDirectory()) continue;
      try { const b = JSON.parse(await fsp.readFile(path.join(BOOKS, d.name, 'book.json'), 'utf8')); const st = await fsp.stat(path.join(BOOKS, d.name, 'book.json'));
        out.push({ slug: d.name, title: b.title, spreads: b.spreads?.length || 0, lang: b.lang, source: b.source || null, updated: st.mtimeMs }); } catch {} }
    return send(res, 200, out.sort((a, b) => b.updated - a.updated));
  }
  if (p === '/api/estimate' && req.method === 'POST') { // tokens and cost of a build, before spending any (text only: images are counted, not sent)
    const b = JSON.parse(await readBody(req)); const P = PROVIDERS[b.provider];
    if (!P || P.agent || !Array.isArray(b.pages) || !Array.isArray(b.range)) return send(res, 200, null); // agents report their usage after the run
    const pages = b.pages.filter(p => p && Number.isInteger(p.n)).map(p => ({ n: p.n, text: String(p.text || ''), image: !!p.image }));
    return send(res, 200, estimate({ prompts: await loadPrompts(), pages, range: b.range, provider: b.provider, model: b.model || P.model, caps: P, hasPdf: !!b.hasPdf, fidelity: b.fidelity, sendImages: b.sendImages }));
  }
  if (p === '/api/generate' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!PROVIDERS[body.provider]) return send(res, 400, { error: 'Unknown provider' });
    if (!Array.isArray(body.pages) || !body.pages.length) return send(res, 400, { error: 'No pages' });
    // page numbers become file names: integers only
    body.pages = body.pages.filter(p => p && Number.isInteger(p.n) && p.n > 0 && p.n < 100000).map(p => ({ n: p.n, text: String(p.text || ''), image: typeof p.image === 'string' ? p.image : undefined }));
    const ns = body.pages.map(p => p.n);
    if (!ns.length) return send(res, 400, { error: 'No valid pages' });
    if (!Array.isArray(body.range) || !body.range.every(Number.isInteger)) body.range = [Math.min(...ns), Math.max(...ns)];
    // never overwrite an existing book: thermo, thermo-2, thermo-3…
    const base = slugify(body.slug || body.fileName); let slug = base;
    for (let n = 2; fs.existsSync(path.join(BOOKS, slug, 'book.json')) || [...jobs.values()].some(j => j.slug === slug && (j.status === 'running' || j.status === 'review')); n++) slug = `${base}-${n}`;
    const id = randomUUID(); const ac = new AbortController();
    const job = { ...body, review: undefined, id, status: 'running', log: [], slug, started: Date.now(), signal: ac.signal, abort: () => ac.abort() };
    const log = m => { job.log.push(`[${new Date().toLocaleTimeString()}] ${m}`); if (job.log.length > 2000) job.log.splice(0, 500); console.log('[job ' + id.slice(0, 6) + '] ' + m); };
    // outline review: the build waits here while the author edits the plan in the studio (POST …/outline); an hour without an answer cancels it
    if (body.review === true && !PROVIDERS[body.provider].agent) job.review = outline => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { job.error = 'The outline was not reviewed within an hour'; ac.abort(); }, 60 * 60 * 1000);
      ac.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(job.error || 'Cancelled')); }, { once: true });
      Object.assign(job, { status: 'review', outline, resume: o => { clearTimeout(timer); Object.assign(job, { status: 'running', outline: undefined, resume: undefined }); resolve(o); } });
      log('Outline ready: review it below (edit, reorder or delete spreads), then write the book.');
    });
    jobs.set(id, job);
    generate(job, log).then(book => { job.status = 'done'; job.title = book.title; log(`Done: "${book.title}" — ${book.spreads.length} spreads. Open /viewer/?book=${slug}`); })
      .catch(e => { job.status = 'error'; if (job.error !== 'Cancelled') job.error = e.message; log('ERROR: ' + job.error); })
      .finally(() => { delete job.pdfBase64; delete job.pages; delete job.apiKey; });
    return send(res, 200, { id, slug });
  }
  let m;
  if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(p)) && req.method === 'GET') { const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: 'No such job' }); const since = Number(url.searchParams.get('since') || 0);
    return send(res, 200, { status: j.status, slug: j.slug, error: j.error, title: j.title, outline: j.status === 'review' ? j.outline : undefined, log: j.log.slice(since), next: j.log.length }); }
  if ((m = /^\/api\/jobs\/([\w-]+)\/outline$/.exec(p)) && req.method === 'POST') { const j = jobs.get(m[1]);
    if (!j || j.status !== 'review') return send(res, 409, { error: 'This build is not waiting for its outline' });
    const { outline, errors } = fixOutline(JSON.parse(await readBody(req)).outline, j.pages.map(pg => pg.n)); // the same cleaning as the model's outline
    if (errors.length) return send(res, 400, { error: errors.join(' · ') });
    j.resume(outline); return send(res, 200, { ok: true }); }
  if ((m = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p)) && req.method === 'POST') { const j = jobs.get(m[1]); if (j && (j.status === 'running' || j.status === 'review')) { j.abort(); j.status = 'error'; j.error = 'Cancelled'; } return send(res, 200, { ok: true }); }
  if ((m = /^\/api\/books\/([\w-]+)\/export$/.exec(p)) && req.method === 'GET') {
    const html = await exportBook(m[1]); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${m[1]}.html"` }); return res.end(html); }
  if ((m = /^\/api\/books\/([\w-]+)\/check$/.exec(p)) && req.method === 'GET') { const v = validateBook(await fsp.readFile(path.join(BOOKS, m[1], 'book.json'), 'utf8')); return send(res, 200, { ok: v.ok, errors: v.errors, warnings: v.warnings }); }
  return send(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad path', 'text/plain'); }
  const prefix = Object.keys(STATIC).filter(k => k !== '/' && (pathname === k || pathname.startsWith(k + '/'))).sort((a, b) => b.length - a.length)[0] || '/';
  const rel = prefix === '/' ? pathname : pathname.slice(prefix.length);
  const baseDir = path.join(ROOT, STATIC[prefix]);
  let file = path.join(baseDir, rel);
  if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try { if ((await fsp.stat(file)).isDirectory()) { if (!pathname.endsWith('/')) { res.writeHead(301, { location: pathname + '/' + url.search }); return res.end(); } file = path.join(file, 'index.html'); }
    const data = await fsp.readFile(file); send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'); }
  catch { send(res, 404, 'Not found', 'text/plain'); }
}

// The studio can run local agents and spend API credit, so only accept requests addressed to this machine
// (blocks DNS rebinding) and, for writes, only from our own pages (blocks cross-site POSTs).
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function allowed(req) {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') return true; // user opted into network access
  if (!LOCAL.test(req.headers.host || '')) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  return !origin || (() => { try { return LOCAL.test(new URL(origin).host); } catch { return false; } })();
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: 'Forbidden: PopBook Studio only accepts requests from localhost' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else await serveStatic(req, res, url); }
  catch (e) { console.error(e); send(res, 500, { error: e.message }); }
});
server.listen(PORT, HOST, () => {
  console.log(`\n  📖  PopBook Studio is running →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  const avail = Object.entries(PROVIDERS).filter(([, P]) => P.agent ? agentAvailable(P.agent) : !P.env || process.env[P.env]).map(([, P]) => P.label);
  console.log('  Ready providers: ' + (avail.join(', ') || 'none yet — add an API key in .env or paste it in the studio') + '\n');
});
