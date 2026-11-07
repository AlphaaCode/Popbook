// PopBook Studio front-end: pick a lesson, connect an AI, follow the build, browse the library.
import * as pdfjs from '/vendor/pdfjs/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
import { scanPage, cleanPages, renderPage } from '/lib/pages.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('popbook:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('popbook:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('popbook:' + k); } catch {} },
};

/* ------------------------------------------------------------------ */
/* 1 · the lesson                                                      */
/* ------------------------------------------------------------------ */
// src = { kind: 'pdf', name, buf, doc, count } | { kind: 'pages', name, pages: [{ text, image }] }
let src = null;
const drop = $('#drop'), fileInput = $('#file'), thumbs = $('#thumbs'), fromEl = $('#from'), toEl = $('#to');

addEventListener('dragover', e => e.preventDefault()); // dropping next to the zone must not navigate away
addEventListener('drop', e => e.preventDefault());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); loadFiles([...e.dataTransfer.files]); });
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { loadFiles([...fileInput.files]); fileInput.value = ''; });
$('#clearFile').onclick = () => { src = null; $('#fileInfo').hidden = true; drop.hidden = false; thumbs.innerHTML = ''; refreshGo(); };

async function loadFiles(files) {
  if (!files.length) return;
  const pdf = files.find(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  try {
    if (pdf) {
      const buf = await pdf.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise; // pdf.js detaches the buffer it gets
      src = { kind: 'pdf', name: pdf.name, buf, doc, count: doc.numPages };
    } else {
      const pages = [];
      for (const f of files) {
        if (/^image\//.test(f.type)) pages.push({ text: '', image: await shrinkImage(f, 1600) });
        else if (/\.(md|markdown|txt)$/i.test(f.name) || f.type.startsWith('text/')) chunkText(await f.text()).forEach(text => pages.push({ text }));
      }
      if (!pages.length) throw new Error('Unsupported file type. Use a PDF, .md / .txt notes or photos of pages.');
      src = { kind: 'pages', name: files[0].name, pages, count: pages.length };
    }
  } catch (e) { alertBox(e.message); return; }
  $('#fname').textContent = src.name;
  $('#fmeta').textContent = `· ${src.count} page${src.count > 1 ? 's' : ''}${pdf && files.length > 1 ? ' (other files ignored: one PDF at a time)' : ''}`;
  fromEl.max = toEl.max = src.count; fromEl.value = 1; toEl.value = Math.min(src.count, 10);
  if (!$('#slug').value) $('#slug').placeholder = slugify(src.name);
  drop.hidden = true; $('#fileInfo').hidden = false;
  buildThumbs(); refreshGo();
}

/** Notes become ~2 500-character "pages", cut at paragraph boundaries. */
function chunkText(t) {
  const paras = t.replace(/\r/g, '').split(/\n\s*\n/), out = []; let cur = '';
  for (const p of paras) { if (cur && cur.length + p.length > 2500) { out.push(cur); cur = ''; } cur += (cur ? '\n\n' : '') + p; }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [t];
}
function shrinkImage(file, max) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); res(c.toDataURL('image/jpeg', 0.82)); };
    img.onerror = () => rej(new Error('Could not read image ' + file.name)); img.src = URL.createObjectURL(file); });
}
const slugify = s => String(s || 'book').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'book';

/* thumbnails: rendered lazily, one at a time */
let thumbQueue = Promise.resolve(), observer = null;
function buildThumbs() {
  observer?.disconnect(); thumbs.innerHTML = '';
  observer = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { observer.unobserve(en.target); const n = +en.target.dataset.n; thumbQueue = thumbQueue.then(() => drawThumb(en.target, n)); } }), { root: thumbs, rootMargin: '200px' });
  for (let n = 1; n <= src.count; n++) {
    const b = document.createElement('button'); b.className = 'thumb'; b.dataset.n = n; b.type = 'button';
    b.title = `Page ${n} — click: start here · shift-click: end here`; b.innerHTML = `<span class="n">${n}</span>`;
    b.onclick = e => { let a = +fromEl.value, z = +toEl.value; if (e.shiftKey) { z = n; if (z < a) a = z; } else { a = n; if (a > z) z = a; } fromEl.value = a; toEl.value = z; markRange(); };
    thumbs.append(b); observer.observe(b);
  }
  markRange();
}
async function drawThumb(el, n) {
  if (src.kind === 'pages') { const p = src.pages[n - 1]; el.insertAdjacentHTML('afterbegin', p.image ? `<img src="${p.image}" alt="">` : `<div class="txt">${esc(p.text.slice(0, 220))}</div>`); return; }
  try { const page = await src.doc.getPage(n); const vp = page.getViewport({ scale: 1 }); const scale = 140 / vp.width; const v = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = v.width; c.height = v.height; await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; el.prepend(c); } catch {}
}
function clampRange() { const max = src?.count || 1; let a = Math.max(1, Math.min(max, +fromEl.value || 1)), z = Math.max(1, Math.min(max, +toEl.value || a)); if (z < a) [a, z] = [z, a]; fromEl.value = a; toEl.value = z; return [a, z]; }
function markRange() { if (!src) return; const [a, z] = clampRange(); thumbs.querySelectorAll('.thumb').forEach(t => { const n = +t.dataset.n; t.classList.toggle('in', n >= a && n <= z); t.classList.toggle('edge', n === a || n === z); }); refreshGo(); }
fromEl.onchange = toEl.onchange = markRange;

/* ------------------------------------------------------------------ */
/* 2 · the AI                                                          */
/* ------------------------------------------------------------------ */
let providers = [], blocks = [], presets = [];
const preset = () => presets.find(p => p.id === S.preset) || {};
const S = store.get('studio', {}); S.models ||= {}; S.plannerModels ||= {}; S.baseUrls ||= {}; S.images ||= {}; S.hifi ||= {}; S.preset ||= 'balanced';
const provSel = $('#provider');
const prov = () => providers.find(p => p.id === provSel.value);
const saveSettings = () => store.set('studio', S);

async function loadConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  providers = cfg.providers; blocks = cfg.blocks || []; presets = cfg.presets || [];
  provSel.innerHTML = providers.map(p => `<option value="${p.id}">${esc(p.label)}${!p.available ? ' — not installed' : ''}</option>`).join('');
  provSel.value = providers.some(p => p.id === S.provider) ? S.provider : cfg.defaultProvider;
  for (const id of ['lang', 'extra']) if (S[id] !== undefined) $('#' + id).value = S[id];
  onProvider();
}
function onProvider() {
  const P = prov(); if (!P) return; S.provider = P.id; saveSettings();
  const isMock = P.id === 'mock', pm = P.presets?.[S.preset] || {};
  $('#modelField').hidden = isMock; $('#baseField').hidden = P.id !== 'compat';
  $('#keyField').hidden = P.agent || P.cli || isMock;
  $('#presetField').hidden = isMock; $('#preset').value = S.preset; $('#plannerField').hidden = P.agent || isMock;
  $('#modelLabel').textContent = P.agent ? 'Model' : 'Writer model';
  $('#model').value = S.models[P.id] || ''; $('#model').placeholder = pm.writer || P.model || (P.agent ? 'agent default' : 'default');
  $('#plannerModel').value = S.plannerModels[P.id] || ''; $('#plannerModel').placeholder = pm.planner || P.model || 'default';
  $('#presetHint').textContent = P.agent ? (pm.writer ? `Runs the agent with --model ${pm.writer}.` : 'This agent uses its own default model.')
    : `${pm.planner} plans the book, ${pm.writer} writes each spread${preset().images ? '' : ', from the page text only'}.`;
  $('#baseUrl').value = S.baseUrls[P.id] || P.baseUrl || '';
  $('#apiKey').value = store.get('key:' + P.id, ''); $('#rememberKey').checked = !!store.get('key:' + P.id, '');
  $('#apiKey').placeholder = P.id === 'compat' ? 'optional (Ollama / LM Studio need none)' : 'paste a key, or put it in .env';
  $('#sendImages').checked = S.images[P.id] ?? (P.images && !!preset().images); $('#sendImages').closest('.field').hidden = P.agent || isMock;
  $('#fidelity').checked = !!S.hifi[P.id]; $('#fidelityField').hidden = !P.pdf;
  $('#review').checked = !!S.review; $('#reviewField').hidden = P.agent; // agents write the whole book themselves
  const hint = $('#provHint'), keyState = $('#keyState');
  keyState.textContent = P.hasKey && P.needsKey ? '· key found in .env ✓' : '';
  hint.className = 'hint';
  if (P.agent) { hint.textContent = P.available ? `Found on your PATH ✓ Runs on this computer with your own login; no API key needed. It writes books/<name>/book.json and checks it.` : `Not installed (no "${P.id.replace('agent-', '')}" command on your PATH). Install it and log in once, or pick another option.`; hint.classList.add(P.available ? 'ok' : 'warn'); }
  else if (isMock) hint.textContent = 'Returns the example book instantly. For testing the pipeline.';
  else if (P.cli) { hint.textContent = P.available ? 'Found on your PATH ✓ The same staged pipeline, each call a "claude -p" with no tools, on your Claude login. Text only.' : `Not installed (no "${P.cli}" command on your PATH). Install Claude Code and log in once, or pick another option.`; hint.classList.add(P.available ? 'ok' : 'warn'); }
  else if (P.id === 'compat') hint.textContent = 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · OpenRouter: https://openrouter.ai/api/v1 · Groq: https://api.groq.com/openai/v1';
  else { hint.textContent = P.hasKey ? 'API key found in .env ✓' : 'Needs an API key: paste it below or add it to .env.'; hint.classList.add(P.hasKey ? 'ok' : 'warn'); }
  refreshGo();
}
provSel.onchange = onProvider;
$('#model').oninput = e => { S.models[provSel.value] = e.target.value.trim(); saveSettings(); refreshGo(); };
$('#plannerModel').oninput = e => { S.plannerModels[provSel.value] = e.target.value.trim(); saveSettings(); refreshGo(); };
$('#preset').onchange = e => { S.preset = e.target.value; S.images = {}; onProvider(); }; // the preset decides images again
$('#baseUrl').oninput = e => { S.baseUrls[provSel.value] = e.target.value.trim(); saveSettings(); };
$('#sendImages').onchange = e => { S.images[provSel.value] = e.target.checked; saveSettings(); refreshGo(); };
$('#fidelity').onchange = e => { S.hifi[provSel.value] = e.target.checked; saveSettings(); refreshGo(); };
$('#review').onchange = e => { S.review = e.target.checked; saveSettings(); };
for (const id of ['lang', 'extra']) $('#' + id).addEventListener('input', e => { S[id] = e.target.value; saveSettings(); });
const syncKey = () => { const k = 'key:' + provSel.value; if ($('#rememberKey').checked && $('#apiKey').value) store.set(k, $('#apiKey').value); else store.del(k); refreshGo(); };
$('#apiKey').oninput = syncKey; $('#rememberKey').onchange = syncKey;

/** The AI settings of the form, as the server reads them (roles() in lib/generate.js). */
const aiChoice = P => ({ provider: P.id, preset: S.preset, model: $('#model').value.trim() || undefined, plannerModel: P.agent ? undefined : $('#plannerModel').value.trim() || undefined });
/* what the model gets: clean text for every page, plus an image of each figure page — or, at high fidelity, the PDF itself */
const highFidelity = P => !P.agent && !!P.pdf && $('#fidelity').checked;
const wantsImages = P => P.id !== 'mock' && !highFidelity(P) && (P.agent || $('#sendImages').checked); // an agent gets its figures as input/fig-<n>.jpg
/** Pages a..z as [{ n, text, figure, image? }]. A PDF page is scanned once (cached on `src`); the cleaning needs the whole range. */
async function readRange(a, z) {
  if (src.kind !== 'pdf') return src.pages.slice(a - 1, z).map((p, i) => ({ n: a + i, text: p.text, figure: !!p.image, image: p.image }));
  const scans = (src.scans ||= new Map());
  for (let n = a; n <= z; n++) if (!scans.has(n)) scans.set(n, await scanPage(await src.doc.getPage(n), pdfjs.OPS));
  return cleanPages(Array.from({ length: z - a + 1 }, (_, i) => scans.get(a + i)));
}

/* pre-flight estimate of tokens and cost: the server counts them */
let estText = '', estTimer = 0, estSeq = 0;
const kTok = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
function scheduleEstimate() {
  clearTimeout(estTimer); estText = ''; const P = prov();
  if (!src || !P || P.agent || running) return;
  const seq = ++estSeq;
  estTimer = setTimeout(async () => {
    try {
      const [a, z] = clampRange(), pages = (await readRange(a, z)).map(p => ({ n: p.n, text: p.text, image: p.figure }));
      const body = { ...aiChoice(P), range: [a, z], pages, hasPdf: src.kind === 'pdf', sendImages: wantsImages(P), fidelity: highFidelity(P) ? 'high' : undefined };
      const e = await fetch('/api/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      if (seq !== estSeq || !e) return; // the settings changed meanwhile, or this is an agent
      estText = ` · estimate: ${e.calls} call${e.calls > 1 ? 's' : ''}, ~${kTok(e.input)} in / ~${kTok(e.output)} out tokens${e.cost == null ? '' : `, ≈ $${e.cost.toFixed(2)}`}`;
      refreshGo(true);
    } catch {} // an estimate is a courtesy: never block the build on it
  }, 400);
}

function refreshGo(keepEstimate) {
  if (!keepEstimate) scheduleEstimate();
  const P = prov(), go = $('#go'), hint = $('#goHint'); let why = '';
  if (!src) why = 'Drop a lesson first.';
  else if (!P) why = 'Pick a model.';
  else if (!P.available) why = `Not installed (no "${P.agent || P.cli}" command on your PATH).`;
  else if (P.needsKey && !P.hasKey && !$('#apiKey').value.trim()) why = 'Add an API key (or put it in .env).';
  else if (P.id === 'compat' && !$('#baseUrl').value.trim()) why = 'Set the base URL of your server.';
  go.disabled = !!why || running; hint.className = 'hint center';
  hint.textContent = running ? 'A book is being built…' : why || (() => { const [a, z] = clampRange(); return `Pages ${a}–${z} (${z - a + 1}) → ${P.label.split(' (')[0]}${estText}`; })();
}

/* ------------------------------------------------------------------ */
/* 3 · build                                                           */
/* ------------------------------------------------------------------ */
let running = false, jobId = null;
const logEl = $('#log');
function log(line) { const div = document.createElement('div'); div.textContent = line; if (/ERROR|invalid book/i.test(line)) div.className = 'err'; else if (/warning/i.test(line)) div.className = 'warn'; logEl.append(div); logEl.scrollTop = logEl.scrollHeight; }
function setBar(p) { const bar = $('.bar'); bar.classList.toggle('indet', p === null); if (p !== null) $('#barFill').style.width = Math.round(p * 100) + '%'; }

function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

function startProgress(title) {
  running = true; refreshGo();
  const card = $('#progress'); card.hidden = false; card.classList.remove('failed'); $('#doneRow').hidden = true; $('#cancel').hidden = false;
  logEl.innerHTML = ''; setBar(0.02); $('#jobTitle').textContent = '· ' + title; card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#go').onclick = async () => {
  const P = prov(); const [a, z] = clampRange();
  startProgress(src.name);
  try {
    const wantImages = wantsImages(P), hifi = highFidelity(P), pages = [];
    if (src.kind === 'pdf') {
      log(`Reading pages ${a}–${z}…`);
      const read = await readRange(a, z), figs = read.filter(p => p.figure).map(p => p.n);
      log(hifi ? '  high fidelity: the model gets the PDF pages themselves' : figs.length ? `  figures, tables or scans on page(s) ${figs.join(', ')}${wantImages ? ' — sent as images' : P.id === 'mock' ? '' : ' — images are off: the model gets their text only'}` : '  no figures found: text only');
      for (const [i, p] of read.entries()) { pages.push({ n: p.n, text: p.text, image: wantImages && p.figure ? await renderPage(await src.doc.getPage(p.n), src.doc.canvasFactory) : undefined }); setBar(0.02 + 0.08 * (i + 1) / read.length); }
      const empty = pages.filter(p => !p.text).length; if (empty && !hifi && !wantImages) log(`  ${empty} page(s) have no extractable text (scans?) and images are off: the model will not see them.`);
    } else for (const p of await readRange(a, z)) pages.push({ n: p.n, text: p.text, image: p.image });
    const body = { ...aiChoice(P), baseUrl: P.id === 'compat' ? $('#baseUrl').value.trim() : undefined, apiKey: $('#apiKey').value.trim() || undefined,
      fileName: src.name, totalPages: src.count, range: [a, z], pages, pdfBase64: src.kind === 'pdf' ? b64(src.buf) : undefined,
      slug: $('#slug').value.trim() || slugify(src.name), lang: $('#lang').value, sendImages: wantImages, fidelity: hifi ? 'high' : undefined, review: !P.agent && $('#review').checked, extra: $('#extra').value.trim() };
    log('Uploading to the local server…');
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json(); if (!res.ok) throw new Error(j.error || res.statusText);
    jobId = j.id; await follow(j.id, !P.agent);
  } catch (e) { log('ERROR: ' + e.message); fail(); }
};
/* outline review: the build waits on the server until the edited plan comes back */
const pagesLabel = ns => ns.length > 1 && ns.at(-1) - ns[0] === ns.length - 1 ? `${ns[0]}-${ns.at(-1)}` : ns.join(', ');
function reviewRow(s) {
  const li = document.createElement('li'); if (s.kind === 'cover') li.dataset.cover = '1';
  li.innerHTML = `<span class="cv">${s.kind === 'cover' ? 'cover' : ''}</span><input class="pg mono" value="${esc(pagesLabel(s.pages))}" aria-label="pages" title="pages, e.g. 2-3 or 4, 6">`
    + `<select aria-label="scene block">${blocks.map(b => `<option${b === s.block ? ' selected' : ''}>${b}</option>`).join('')}</select>`
    + `<input class="in" value="${esc(s.intent)}" aria-label="what the spread teaches">`
    + `<span class="ops"><button type="button" class="link" data-op="up" aria-label="move up">↑</button><button type="button" class="link" data-op="down" aria-label="move down">↓</button><button type="button" class="link" data-op="del" aria-label="delete this spread">✕</button></span>`;
  li.onclick = e => { const op = e.target.dataset.op; if (op === 'up') li.previousElementSibling?.before(li); else if (op === 'down') li.nextElementSibling?.after(li); else if (op === 'del') li.remove(); };
  return li;
}
function showReview(id, outline) {
  const box = $('#outlineReview'), list = $('#rvList'); box.hidden = false; $('#rvHint').textContent = '';
  $('#rvTitle').value = outline.title; list.replaceChildren(...outline.spreads.map(reviewRow));
  $('#rvGo').onclick = async () => {
    const spreads = [...list.children].map(li => ({ ...(li.dataset.cover && { kind: 'cover' }), pages: li.querySelector('.pg').value.split(/[,;\s]+/).filter(Boolean),
      block: li.querySelector('select').value, intent: li.querySelector('.in').value.trim() })); // a cover moved down becomes a lesson (server side)
    const res = await fetch(`/api/jobs/${id}/outline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outline: { ...outline, title: $('#rvTitle').value.trim(), spreads } }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) box.hidden = true; else $('#rvHint').textContent = j.error || res.statusText;
  };
}

/** Progress of an API build from its log: the outline is the first 15 %, then each finished spread (✓, or ⚠ when code wrote it). */
function apiProgress(text) {
  const m = [...text.matchAll(/Outline(?: \(reviewed\))?: ".*?", (\d+) spreads/g)].pop(); if (!m) return 0.1 + (/Outline → /.test(text) ? 0.05 : 0);
  return 0.25 + 0.73 * (text.match(/Spread \d+\/\d+ [✓⚠]/g) || []).length / +m[1]; // the log's lines, joined
}
/** staged: an API build, whose log tells its progress (an agent's or a single spread's does not) */
async function follow(id, staged) {
  let since = 0;
  setBar(staged ? 0.1 : null);
  for (;;) {
    const r = await fetch(`/api/jobs/${id}?since=${since}`).then(r => r.json());
    r.log.forEach(log); since = r.next;
    if (staged) setBar(apiProgress(logEl.textContent));
    if (r.status === 'done') { setBar(1); $('#cancel').hidden = true; $('#openBook').href = `/viewer/?book=${encodeURIComponent(r.slug)}`; $('#exportBook').href = `/api/books/${encodeURIComponent(r.slug)}/export`; $('#doneRow').hidden = false; running = false; refreshGo(); loadBooks(); return; }
    if (r.status === 'review' && $('#outlineReview').hidden) showReview(id, r.outline);
    if (r.status === 'error') { $('#outlineReview').hidden = true; fail(); return; }
    await new Promise(res => setTimeout(res, 900));
  }
}
function fail() { running = false; setBar(1); $('#progress').classList.add('failed'); $('#cancel').hidden = true; refreshGo(); }
$('#cancel').onclick = () => { if (jobId) fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }); };

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */
async function loadBooks() {
  const books = await fetch('/api/books').then(r => r.json()).catch(() => []);
  $('#books').innerHTML = books.length ? books.map(b => `<div class="book"><b>${esc(b.title)}</b>
    <span class="meta">${b.spreads} spreads · ${esc(b.lang || '')} · ${new Date(b.updated).toLocaleDateString()}${b.source?.file ? ' · ' + esc(b.source.file) : ''}</span>
    <div class="row"><a class="link" href="/viewer/?book=${encodeURIComponent(b.slug)}" target="_blank">open</a><a class="link" href="/api/books/${encodeURIComponent(b.slug)}/export">download HTML</a><span class="meta">books/${esc(b.slug)}</span></div>${spreadList(b)}</div>`).join('')
    : '<p class="empty">No books yet.</p>';
}
/** The spreads of a book written one per call, each with a regenerate button; ⚠ marks those PopBook wrote when the model failed. */
function spreadList(b) {
  if (!b.list) return '';
  const flagged = b.list.filter(s => s.fallback).length;
  return `<details class="spreads"${flagged ? ' open' : ''}><summary>spreads${flagged ? ` · ⚠ ${flagged} written by PopBook` : ''}</summary><ol>${b.list.map((s, i) => `<li>${esc(s.title)}`
    + `${s.fallback ? ` <span class="flag" title="the model failed 3 times: PopBook wrote its ${esc(s.fallback.join(', '))} from the page text">⚠ ${esc(s.fallback.join(', '))}</span>` : ''}`
    + ` <button class="link" data-slug="${esc(b.slug)}" data-i="${i}">regenerate</button></li>`).join('')}</ol></details>`;
}
/* one spread written again by the AI picked above (an agent picked: the book's own model), the rest of the book untouched */
$('#books').onclick = async e => {
  const { slug, i } = e.target.dataset; if (!slug || running) return;
  const P = prov(); startProgress(`${slug}, spread ${+i + 1}`);
  try {
    const body = P.agent ? {} : { ...aiChoice(P), baseUrl: P.id === 'compat' ? $('#baseUrl').value.trim() : undefined, apiKey: $('#apiKey').value.trim() || undefined,
      sendImages: wantsImages(P), fidelity: highFidelity(P) ? 'high' : undefined };
    const res = await fetch(`/api/books/${encodeURIComponent(slug)}/spreads/${i}/regenerate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json(); if (!res.ok) throw new Error(j.error || res.statusText);
    jobId = j.id; await follow(j.id, false);
  } catch (err) { log('ERROR: ' + err.message); fail(); }
};
$('#refresh').onclick = loadBooks;

function alertBox(msg) { $('#goHint').textContent = msg; $('#goHint').className = 'hint center warn'; }

loadConfig().catch(e => alertBox('Cannot reach the PopBook server: ' + e.message));
loadBooks();
