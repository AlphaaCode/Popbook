// PopBook Studio front-end: pick a lesson, connect an AI, follow the build, browse the library.
import * as pdfjs from '/vendor/pdfjs/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

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
let providers = [];
const S = store.get('studio', {}); S.models ||= {}; S.baseUrls ||= {}; S.images ||= {};
const provSel = $('#provider');
const prov = () => providers.find(p => p.id === provSel.value);
const saveSettings = () => store.set('studio', S);

async function loadConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  providers = cfg.providers;
  provSel.innerHTML = providers.map(p => `<option value="${p.id}">${esc(p.label)}${p.agent && !p.available ? ' — not installed' : ''}</option>`).join('');
  provSel.value = providers.some(p => p.id === S.provider) ? S.provider : cfg.defaultProvider;
  for (const id of ['lang', 'per', 'extra']) if (S[id] !== undefined) $('#' + id).value = S[id];
  onProvider();
}
function onProvider() {
  const P = prov(); if (!P) return; S.provider = P.id; saveSettings();
  const isMock = P.id === 'mock';
  $('#modelField').hidden = isMock; $('#baseField').hidden = P.id !== 'compat';
  $('#keyField').hidden = P.agent || isMock;
  $('#model').value = S.models[P.id] || ''; $('#model').placeholder = P.model || (P.agent ? 'agent default' : 'default');
  $('#baseUrl').value = S.baseUrls[P.id] || P.baseUrl || '';
  $('#apiKey').value = store.get('key:' + P.id, ''); $('#rememberKey').checked = !!store.get('key:' + P.id, '');
  $('#apiKey').placeholder = P.id === 'compat' ? 'optional (Ollama / LM Studio need none)' : 'paste a key, or put it in .env';
  $('#sendImages').checked = S.images[P.id] ?? P.images; $('#sendImages').closest('.field').hidden = P.agent || isMock || P.pdf;
  const hint = $('#provHint'), keyState = $('#keyState');
  keyState.textContent = P.hasKey && P.needsKey ? '· key found in .env ✓' : '';
  hint.className = 'hint';
  if (P.agent) { hint.textContent = P.available ? `Found on your PATH ✓ Runs on this computer with your own login; no API key needed. It writes books/<name>/book.json and checks it.` : `Not installed (no "${P.id.replace('agent-', '')}" command on your PATH). Install it and log in once, or pick another option.`; hint.classList.add(P.available ? 'ok' : 'warn'); }
  else if (isMock) hint.textContent = 'Returns the example book instantly. For testing the pipeline.';
  else if (P.id === 'compat') hint.textContent = 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · OpenRouter: https://openrouter.ai/api/v1 · Groq: https://api.groq.com/openai/v1';
  else { hint.textContent = P.hasKey ? 'API key found in .env ✓' : 'Needs an API key: paste it below or add it to .env.'; hint.classList.add(P.hasKey ? 'ok' : 'warn'); }
  refreshGo();
}
provSel.onchange = onProvider;
$('#model').oninput = e => { S.models[provSel.value] = e.target.value.trim(); saveSettings(); };
$('#baseUrl').oninput = e => { S.baseUrls[provSel.value] = e.target.value.trim(); saveSettings(); };
$('#sendImages').onchange = e => { S.images[provSel.value] = e.target.checked; saveSettings(); };
for (const id of ['lang', 'per', 'extra']) $('#' + id).addEventListener('input', e => { S[id] = e.target.value; saveSettings(); });
const syncKey = () => { const k = 'key:' + provSel.value; if ($('#rememberKey').checked && $('#apiKey').value) store.set(k, $('#apiKey').value); else store.del(k); refreshGo(); };
$('#apiKey').oninput = syncKey; $('#rememberKey').onchange = syncKey;

function refreshGo() {
  const P = prov(), go = $('#go'), hint = $('#goHint'); let why = '';
  if (!src) why = 'Drop a lesson first.';
  else if (!P) why = 'Pick a model.';
  else if (P.agent && !P.available) why = 'This agent is not installed.';
  else if (P.needsKey && !P.hasKey && !$('#apiKey').value.trim()) why = 'Add an API key (or put it in .env).';
  else if (P.id === 'compat' && !$('#baseUrl').value.trim()) why = 'Set the base URL of your server.';
  go.disabled = !!why || running; hint.className = 'hint center';
  hint.textContent = running ? 'A book is being built…' : why || (() => { const [a, z] = clampRange(); return `Pages ${a}–${z} (${z - a + 1}) → ${P.label.split(' (')[0]}`; })();
}

/* ------------------------------------------------------------------ */
/* 3 · build                                                           */
/* ------------------------------------------------------------------ */
let running = false, jobId = null;
const logEl = $('#log');
function log(line) { const div = document.createElement('div'); div.textContent = line; if (/ERROR|invalid book/i.test(line)) div.className = 'err'; else if (/warning/i.test(line)) div.className = 'warn'; logEl.append(div); logEl.scrollTop = logEl.scrollHeight; }
function setBar(p) { const bar = $('.bar'); bar.classList.toggle('indet', p === null); if (p !== null) $('#barFill').style.width = Math.round(p * 100) + '%'; }

async function pageText(page) { const tc = await page.getTextContent(); return tc.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim(); }
async function pageImage(page) { const vp = page.getViewport({ scale: 1 }); const v = page.getViewport({ scale: Math.min(2.5, 1200 / vp.width) }); const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; return c.toDataURL('image/jpeg', 0.78); }
function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

$('#go').onclick = async () => {
  const P = prov(); const [a, z] = clampRange();
  running = true; refreshGo();
  const card = $('#progress'); card.hidden = false; card.classList.remove('failed'); $('#doneRow').hidden = true; $('#cancel').hidden = false;
  logEl.innerHTML = ''; setBar(0.02); $('#jobTitle').textContent = '· ' + src.name; card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const wantImages = !P.agent && P.id !== 'mock' && !P.pdf && $('#sendImages').checked;
    const pages = [];
    if (src.kind === 'pdf') {
      log(`Reading pages ${a}–${z}${wantImages ? ' and rendering page images' : ''}…`);
      for (let n = a; n <= z; n++) { const page = await src.doc.getPage(n); pages.push({ n, text: await pageText(page), image: wantImages ? await pageImage(page) : undefined }); setBar(0.02 + 0.08 * (n - a + 1) / (z - a + 1)); }
      const empty = pages.filter(p => !p.text).length; if (empty) log(`  ${empty} page(s) have no extractable text (scans?) — the model will rely on the PDF or images.`);
    } else for (let n = a; n <= z; n++) { const p = src.pages[n - 1]; pages.push({ n, text: p.text, image: p.image }); }
    const body = { provider: P.id, model: $('#model').value.trim() || undefined, baseUrl: P.id === 'compat' ? $('#baseUrl').value.trim() : undefined, apiKey: $('#apiKey').value.trim() || undefined,
      fileName: src.name, totalPages: src.count, range: [a, z], pages, pdfBase64: src.kind === 'pdf' ? b64(src.buf) : undefined,
      slug: $('#slug').value.trim() || slugify(src.name), lang: $('#lang').value, pagesPerCall: +$('#per').value || 15, sendImages: wantImages, extra: $('#extra').value.trim() };
    log('Uploading to the local server…');
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json(); if (!res.ok) throw new Error(j.error || res.statusText);
    jobId = j.id; await follow(j.id, P);
  } catch (e) { log('ERROR: ' + e.message); fail(); }
};
async function follow(id, P) {
  let since = 0;
  setBar(P.agent ? null : 0.1);
  for (;;) {
    const r = await fetch(`/api/jobs/${id}?since=${since}`).then(r => r.json());
    r.log.forEach(log); since = r.next;
    if (!P.agent) { const m = [...logEl.textContent.matchAll(/Batch (\d+)\/(\d+)/g)].pop(); if (m) { const [i, n] = [+m[1], +m[2]]; const got = /answer received[^\n]*$/.test(logEl.lastChild?.textContent || ''); setBar(0.1 + 0.85 * ((i - 1) + (got ? 0.9 : 0.3)) / n); } }
    if (r.status === 'done') { setBar(1); $('#cancel').hidden = true; $('#openBook').href = `/viewer/?book=${encodeURIComponent(r.slug)}`; $('#exportBook').href = `/api/books/${encodeURIComponent(r.slug)}/export`; $('#doneRow').hidden = false; running = false; refreshGo(); loadBooks(); return; }
    if (r.status === 'error') { fail(); return; }
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
    <div class="row"><a class="link" href="/viewer/?book=${encodeURIComponent(b.slug)}" target="_blank">open</a><a class="link" href="/api/books/${encodeURIComponent(b.slug)}/export">download HTML</a><span class="meta">books/${esc(b.slug)}</span></div></div>`).join('')
    : '<p class="empty">No books yet.</p>';
}
$('#refresh').onclick = loadBooks;

function alertBox(msg) { $('#goHint').textContent = msg; $('#goHint').className = 'hint center warn'; }

loadConfig().catch(e => alertBox('Cannot reach the PopBook server: ' + e.message));
loadBooks();
