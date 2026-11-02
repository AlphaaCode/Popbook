// PopBook viewer engine: renders a book.json as an open 3D pop-up book.
import * as K from './kit.js';
import { THREE, W, H, PY, pageY, initKit, tween, wait, stepTweens, billboards } from './kit.js';
import { BLOCKS } from './blocks.js';
import { validateBook, sceneTargets } from '../lib/validate.js';
import { UI } from './i18n.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// formula/eq may contain a few inline tags; everything else is escaped
const rich = s => esc(s).replace(/&lt;(\/?)(sub|sup|b|i|em|strong)&gt;/g, '<$1$2>');

export async function startViewer({ book: input, base = '.', allowCustom = true }) {
  const { ok, errors, warnings, book } = validateBook(input, { allowCustom });
  if (warnings.length) console.warn('[popbook] warnings:\n' + warnings.join('\n'));
  if (!ok) { $('#loading').innerHTML = `<div class="err"><b>book.json has errors</b><pre>${esc(errors.join('\n'))}</pre></div>`; throw new Error(errors.join('\n')); }
  const ui = Object.assign({}, UI.en, UI[book.lang] || {}, book.ui || {});
  const lang = book.lang;
  const fmt = (v, d = 2) => K.fmtNum(v, d, lang);
  document.documentElement.lang = lang;
  document.title = book.title + ' — PopBook';
  $('#head').innerHTML = `${esc(ui.brand)}<b>${esc(book.title)}</b>`;
  const SP = book.spreads;

  /* ---------- renderer ---------- */
  const canvas = $('#c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xcfc8bb);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  scene.add(new THREE.HemisphereLight(0xfff6e8, 0x8a8174, 1.05));
  const spot = new THREE.SpotLight(0xffe2b8, 26, 0, 0.62, 0.55, 2);
  spot.position.set(-2.3, 3.4, 0.5); spot.target.position.set(0.15, 0, 0.1);
  spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -0.0004; spot.shadow.radius = 4; spot.shadow.camera.near = 1; spot.shadow.camera.far = 8;
  { const cv = document.createElement('canvas'); cv.width = cv.height = 512; const g = cv.getContext('2d'); g.fillStyle = '#b9b2a6'; g.fillRect(0, 0, 512, 512); g.filter = 'blur(6px)';
    for (let i = -6; i < 16; i++) { g.fillStyle = '#fff'; g.save(); g.translate(256, 256); g.rotate(-0.5); g.fillRect(-500, i * 44 - 300, 1000, 27); g.restore(); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; spot.map = t; }
  scene.add(spot, spot.target);
  initKit({ lightDir: spot.position.clone().sub(spot.target.position).normalize(), dpr: renderer.getPixelRatio(), dir: book.dir });

  /* ---------- desk & book ---------- */
  const noise = (g, w, h, a) => { const img = g.getImageData(0, 0, w, h), d = img.data; for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - .5) * a; d[i] += n; d[i + 1] += n; d[i + 2] += n; } g.putImageData(img, 0, 0); };
  const paperTex = side => { const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 1332; const g = cv.getContext('2d'); g.fillStyle = '#f4efe3'; g.fillRect(0, 0, 1024, 1332); noise(g, 1024, 1332, 10);
    const gr = side === 'L' ? g.createLinearGradient(1024, 0, 820, 0) : g.createLinearGradient(0, 0, 204, 0); gr.addColorStop(0, 'rgba(90,70,40,.30)'); gr.addColorStop(1, 'rgba(90,70,40,0)'); g.fillStyle = gr; g.fillRect(0, 0, 1024, 1332);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  { const cv = document.createElement('canvas'); cv.width = cv.height = 1024; const g = cv.getContext('2d'); g.fillStyle = '#d8cdb9'; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 260; i++) { g.strokeStyle = `rgba(120,95,60,${Math.random() * .10})`; g.lineWidth = Math.random() * 3 + 0.5; const y = Math.random() * 1024; g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= 1024; x += 64) g.lineTo(x, y + Math.sin(x * 0.01 + i) * 6); g.stroke(); }
    g.fillStyle = '#8ea3ad'; g.fillRect(130, 250, 770, 640); noise(g, 1024, 1024, 8);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 6.5), new THREE.MeshStandardMaterial({ map: t, roughness: .95 })); desk.rotation.x = -Math.PI / 2; desk.position.y = -0.035; desk.receiveShadow = true; scene.add(desk); }
  const bookG = new THREE.Group(); scene.add(bookG);
  const cover = new THREE.Mesh(new THREE.BoxGeometry(2 * W + 0.07, 0.03, H + 0.07), new THREE.MeshStandardMaterial({ color: book.coverColor ? new THREE.Color(book.coverColor) : 0xd4a335, roughness: .85 }));
  cover.position.y = -0.02; cover.castShadow = cover.receiveShadow = true; bookG.add(cover);
  const edgeMat = (() => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const g = cv.getContext('2d'); g.fillStyle = '#efe8d8'; g.fillRect(0, 0, 64, 64); g.strokeStyle = 'rgba(120,100,70,.35)'; for (let y = 2; y < 64; y += 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke(); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(20, 1); return new THREE.MeshStandardMaterial({ map: t, roughness: .95 }); })();
  for (const s of [-1, 1]) {
    const blk = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.05, H), edgeMat); blk.position.set(s * (0.1 + (W - 0.1) / 2), 0.015, 0); blk.receiveShadow = true; bookG.add(blk);
    const geo = new THREE.PlaneGeometry(W, H, 60, 1); geo.rotateX(-Math.PI / 2); const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i) + s * W / 2; p.setX(i, x); p.setY(i, pageY(x)); } geo.computeVertexNormals();
    const pg = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: paperTex(s < 0 ? 'L' : 'R'), roughness: .92 })); pg.receiveShadow = true; bookG.add(pg);
  }
  { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.004, 0.12), new THREE.MeshStandardMaterial({ color: 0x2f5fa8, roughness: .8 })); rib.position.set(0.03, 0.025, H / 2 + 0.035); rib.rotation.x = 0.5; rib.castShadow = true; bookG.add(rib); }
  const sheetGeo = new THREE.PlaneGeometry(W, H, 40, 1); sheetGeo.rotateX(-Math.PI / 2);
  const sheet = new THREE.Mesh(sheetGeo, new THREE.MeshStandardMaterial({ map: paperTex('R'), roughness: .9, side: THREE.DoubleSide })); sheet.castShadow = true; sheet.visible = false; bookG.add(sheet);
  const sheetU = []; { const p = sheetGeo.attributes.position; for (let i = 0; i < p.count; i++) sheetU.push(p.getX(i) + W / 2); }
  function setSheet(theta, dir) { const p = sheetGeo.attributes.position, seg = 40, step = W / seg; const xs = [0], ys = [0]; let x = 0, y = 0;
    for (let k = 1; k <= seg; k++) { const u = (k - 0.5) * step / W; const a = theta - dir * 0.75 * Math.sin(theta) * Math.pow(u, 1.3); x += Math.cos(a) * step; y += Math.sin(a) * step; xs.push(x); ys.push(y); }
    for (let i = 0; i < p.count; i++) { const k = Math.round(sheetU[i] / step); p.setX(i, xs[k]); p.setY(i, PY + 0.003 + ys[k]); } p.needsUpdate = true; sheetGeo.computeVertexNormals(); }

  /* ---------- state ---------- */
  const KEY = 'popbook:' + book.title;
  let stamps = {}; try { stamps = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  const state = SP.map((s, i) => ({ answered: -1, flap: false, touched: new Set(), stamped: !!stamps[i] }));
  let cur = 0, busy = false, current = null, demoRunning = false, controlEls = {};

  /* ---------- build a spread's scene ---------- */
  async function buildScene(i) {
    billboards.length = 0;
    const sc = SP[i].scene;
    const ctx = { touch: id => touch(i, id), setControl, ui, lang, fmt };
    let out;
    if (sc.type === 'custom') {
      const mapped = (window.__POPBOOK_MODULES__ || {})[sc.module];
      const mod = await import(mapped || new URL(sc.module, new URL(base + '/', location.href)).href);
      out = await mod.default(K, sc, ctx);
      SP[i].targets = out.targets || sc.targets || [];
    } else out = BLOCKS[sc.type](sc, ctx);
    if (SP[i].fig) out.G.add(K.caption(SP[i].fig));
    out.update = out.update || (() => {}); out.demo = out.demo || []; out.pops = out.pops || [out.G];
    return out;
  }

  /* ---------- left page ---------- */
  const pageEl = $('#leftPage');
  pageEl.dir = book.dir;
  function renderPage(i, scn) {
    const S = SP[i], st = state[i]; controlEls = {};
    let h = `<div class="inner"><div class="hd"><div><div class="kicker"><span>${esc(i === 0 && S.kind === 'cover' ? ui.popup : ui.lesson + ' ' + i)}${S.slides ? ' · ' + esc(S.slides) : ''}</span></div><h1>${esc(S.title)}</h1></div>${S.kind !== 'cover' && S.targets.length ? '<div class="stamp"></div>' : ''}</div>`;
    h += `<p class="concept">${esc(S.concept)}</p>`;
    if (S.kind === 'cover') {
      if (S.plan && S.plan.length) h += `<h4>${esc(ui.plan)}</h4><ol class="plan">${S.plan.map(p => `<li>${esc(p)}</li>`).join('')}</ol>`;
      h += `<div class="formula"><b class="lab">${esc(ui.howtoLab)}</b>${esc(S.howto || ui.howto)}</div>`;
    } else {
      h += `<div class="formula"><b class="lab">${esc(S.formula.label)}</b><div class="eq">${rich(S.formula.eq)}</div>${S.formula.note ? `<small>${esc(S.formula.note)}</small>` : ''}</div>`;
      h += `<h4>${esc(ui.vocab)}</h4><dl>${S.vocab.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>`;
    }
    if (scn.controls && scn.controls.length) h += `<div class="controls"></div>`;
    if (S.kind !== 'cover') {
      h += `<div class="quiz"><h4>${esc(ui.predict)}</h4><p>${esc(S.quiz.q)}</p><div class="opts">${S.quiz.opts.map((o, k) => `<button class="opt" data-k="${'ABCD'[k]}" data-i="${k}">${esc(o)}</button>`).join('')}</div></div>`;
      h += `<div class="flapZone"><div class="under"><b>${esc(ui.why)}</b>${esc(S.why)}</div><div class="flap locked"><span>🔒</span><div>${esc(ui.lift)}<small>${esc(ui.answerFirst)}</small></div></div></div>`;
    }
    h += `</div><div class="folio">${i === 0 && S.kind === 'cover' ? 'i' : '— ' + (i * 2) + ' —'}</div>`;
    pageEl.innerHTML = h;
    // controls
    const cbox = pageEl.querySelector('.controls');
    (scn.controls || []).forEach(c => {
      if (c.kind === 'range') { const l = document.createElement('label'); l.className = 'rng'; l.innerHTML = `<span class="readout">${esc(c.label)}</span><input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}"><b class="readout val"></b>`;
        const inp = l.querySelector('input'), val = l.querySelector('.val'); val.textContent = c.fmt ? c.fmt(c.value) : c.value; inp.oninput = () => { val.textContent = c.fmt ? c.fmt(+inp.value) : inp.value; c.onInput(+inp.value); };
        controlEls[c.id] = { set: p => { if (p.value !== undefined && +inp.value !== p.value) inp.value = p.value; if (p.value !== undefined) val.textContent = c.fmt ? c.fmt(p.value) : p.value; } }; cbox.append(l); }
      else { const b = document.createElement('button'); b.className = 'btn'; b.textContent = c.label; let on = !!c.on; if (on) b.classList.add('on');
        b.onclick = () => { if (c.kind === 'toggle') { on = !on; b.classList.toggle('on', on); c.onClick(on); } else c.onClick(); };
        controlEls[c.id] = { set: p => { if (p.label) b.textContent = p.label; if (p.on !== undefined) { on = p.on; b.classList.toggle('on', on); } } }; cbox.append(b); }
    });
    // quiz + flap
    const showQuiz = () => { if (st.answered < 0) return; pageEl.querySelectorAll('.opt').forEach((b, k) => { b.disabled = true; if (k === S.quiz.a) b.classList.add('right'); else if (k === st.answered) b.classList.add('wrong'); });
      const f = pageEl.querySelector('.flap'); if (f) { f.classList.remove('locked'); f.innerHTML = `<span>↗</span><div>${esc(ui.lift)}<small>${esc(ui.toSee)}</small></div>`; if (st.flap) f.classList.add('open'); } };
    pageEl.querySelectorAll('.opt').forEach(b => b.onclick = () => { st.answered = +b.dataset.i; showQuiz(); checkStamp(i); });
    const flap = pageEl.querySelector('.flap');
    if (flap) flap.onclick = () => { if (st.answered < 0) { flap.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 260 }); return; } st.flap = true; flap.classList.add('open'); };
    showQuiz(); updateStamp(); fitPage();
  }
  // shrink the printed page until it fits (long titles / concepts); the phone layout scrolls instead
  function fitPage() { const inner = pageEl.querySelector('.inner'); if (!inner) return; inner.style.transform = ''; inner.style.width = '';
    if (narrow) return; const avail = PH - 34 - 28 - 30, w = PW - 44 - 40;
    for (let s = 1; s >= 0.7; s -= 0.03) { inner.style.width = w / s + 'px'; inner.style.transform = `scale(${s})`; if (inner.offsetHeight * s <= avail) break; } }
  function setControl(id, patch) { const c = controlEls[id]; if (c) c.set(patch); }
  function updateStamp() { const S = SP[cur], st = state[cur], el = pageEl.querySelector('.stamp'); if (!el) return;
    if (st.stamped) { el.classList.add('inked'); el.innerHTML = `${esc(ui.stamped)}<span>${esc(ui.lesson)} ${cur}</span>`; }
    else el.innerHTML = `<span>${esc(ui.models)} ${[...st.touched].filter(t => S.targets.includes(t)).length}/${S.targets.length}<br>${esc(ui.prediction)} ${st.answered >= 0 ? '✓' : '—'}</span>`; }
  function touch(i, id) { if (i !== cur) return; state[i].touched.add(id); checkStamp(i); }
  function checkStamp(i) { const S = SP[i], st = state[i]; if (S.kind === 'cover') return;
    if (!st.stamped && st.answered >= 0 && S.targets.every(t => st.touched.has(t))) { st.stamped = true; stamps[i] = 1; try { localStorage.setItem(KEY, JSON.stringify(stamps)); } catch (e) {} }
    updateStamp(); updateBar(); }

  /* ---------- homography: HTML page onto the 3D page ---------- */
  function solve(A, b) { const n = b.length; for (let i = 0; i < n; i++) { let m = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r; [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
      for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; } }
    const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; } return x; }
  const PW = 600, PH = 860;
  const CORN = [new THREE.Vector3(-0.965, PY + 0.001, -0.625), new THREE.Vector3(-0.1, PY + 0.001, -0.625), new THREE.Vector3(-0.1, PY + 0.001, 0.615), new THREE.Vector3(-0.965, PY + 0.001, 0.615)];
  function placePage() { if (narrow) return; const r = canvas.getBoundingClientRect(); const d = CORN.map(v => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * r.width, (1 - p.y) / 2 * r.height]; });
    const s = [[0, 0], [PW, 0], [PW, PH], [0, PH]]; const A = [], b = [];
    for (let i = 0; i < 4; i++) { const [x, y] = s[i], [u, v] = d[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
    const h = solve(A, b); pageEl.style.transform = `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`; }

  /* ---------- camera ---------- */
  let narrow = false, camMode = 'home'; const camHome = { pos: new THREE.Vector3(), look: new THREE.Vector3() }, camLook = new THREE.Vector3(); const PITCH = 58 * Math.PI / 180;
  function frame() { narrow = innerWidth < 760 || innerHeight > innerWidth * 1.1; document.body.classList.toggle('narrow', narrow);
    const w = innerWidth, h = narrow ? innerHeight * 0.52 : innerHeight; renderer.setSize(w, h, false); canvas.style.height = h + 'px'; camera.aspect = w / h; camera.updateProjectionMatrix();
    const tan = Math.tan(camera.fov * Math.PI / 360); const target = narrow ? new THREE.Vector3(0.5, 0, 0.02) : new THREE.Vector3(0, 0, 0.05);
    const d = Math.max((narrow ? 0.58 : 1.12) / (tan * camera.aspect), (narrow ? 0.72 : 0.78) / tan);
    camHome.look.copy(target); camHome.pos.set(target.x, target.y + Math.sin(PITCH) * d, target.z + Math.cos(PITCH) * d);
    if (camMode === 'home') { camera.position.copy(camHome.pos); camLook.copy(camHome.look); camera.lookAt(camLook); }
    if (narrow) pageEl.style.transform = 'none'; fitPage(); }
  addEventListener('resize', frame);
  async function flyTo(pos, look, dur = 1.2) { const p0 = camera.position.clone(), l0 = camLook.clone(); await tween(dur, u => { camera.position.lerpVectors(p0, pos, u); camLook.lerpVectors(l0, look, u); camera.lookAt(camLook); }, 'io'); }
  const closeUp = (f, d) => { const look = new THREE.Vector3(...f); return { pos: look.clone().add(new THREE.Vector3(0, Math.sin(PITCH) * d, Math.cos(PITCH) * d)), look }; };

  /* ---------- navigation ---------- */
  const ttl = $('#ttl'), dots = $('#dots');
  function updateBar() { ttl.textContent = (SP[cur].kind === 'cover' ? '' : cur + '. ') + SP[cur].short;
    dots.innerHTML = SP.map((S, i) => `<i class="${i === cur ? 'cur' : ''} ${state[i].stamped ? 'done' : ''}" data-i="${i}" title="${esc(S.short)}"></i>`).join('');
    dots.querySelectorAll('i').forEach(d => d.onclick = () => go(+d.dataset.i)); $('#prev').disabled = cur === 0; $('#next').disabled = cur === SP.length - 1; }
  const baseSY = new WeakMap(); // blocks may pre-scale a part; pop animations scale relative to it
  async function mount(i, popped = true) { const scn = await buildScene(i); current = scn; bookG.add(scn.G); scn.pops.forEach(p => baseSY.set(p, p.scale.y)); if (!popped) scn.pops.forEach(p => p.scale.y = 0.001); renderPage(i, scn); updateBar(); return scn; }
  const popUp = scn => Promise.all(scn.pops.map((p, k) => tween(0.7, u => p.scale.y = Math.max(0.001, u) * (baseSY.get(p) ?? 1), 'back', k * 0.07)));
  const foldDown = scn => Promise.all(scn.pops.map((p, k) => tween(0.35, u => p.scale.y = Math.max(0.001, 1 - u) * (baseSY.get(p) ?? 1), 'io', k * 0.03)));
  async function go(n) {
    if (busy || n === cur || n < 0 || n >= SP.length) return; busy = true; hideTip();
    try {
      if (camMode !== 'home') { camMode = 'home'; await flyTo(camHome.pos, camHome.look, 0.8); }
      const dir = n > cur ? 1 : -1; pageEl.classList.add('hidden'); await foldDown(current);
      sheet.visible = true; setSheet(dir > 0 ? 0 : Math.PI, dir); const old = current;
      await tween(0.9, u => setSheet(dir > 0 ? u * Math.PI : (1 - u) * Math.PI, dir), 'io');
      sheet.visible = false; bookG.remove(old.G);
      cur = n; try { history.replaceState(null, '', location.pathname + location.search + (n ? '#p' + n : '')); } catch (e) {}
      const scn = await mount(n, false); pageEl.classList.remove('hidden'); await popUp(scn);
    } finally { busy = false; }
  }
  $('#prev').onclick = () => go(cur - 1); $('#next').onclick = () => go(cur + 1);
  addEventListener('keydown', e => { if (e.target.tagName === 'INPUT') return; if (e.key === 'ArrowRight') go(cur + (book.dir === 'rtl' ? -1 : 1)); if (e.key === 'ArrowLeft') go(cur + (book.dir === 'rtl' ? 1 : -1)); });
  addEventListener('hashchange', () => { const m = /^#p(\d+)$/.exec(location.hash); const n = m ? +m[1] : 0; if (n !== cur) go(n); });
  const demoBtn = $('#demo'); demoBtn.textContent = '▶ ' + ui.demo;
  demoBtn.onclick = async () => { if (busy || demoRunning || !current.demo.length) return; demoRunning = true; demoBtn.disabled = true; camMode = 'demo'; const lesson = cur;
    try { for (const st of current.demo) { if (cur !== lesson) break; const { pos, look } = closeUp(st.focus, st.d || 0.9); await flyTo(pos, look, 1.1); await Promise.all([st.act && st.act(), wait(st.wait || 2000)]); }
      await flyTo(camHome.pos, camHome.look, 1.1); } finally { camMode = 'home'; demoRunning = false; demoBtn.disabled = false; } };

  /* ---------- picking ---------- */
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), tipEl = $('#tip');
  function pick(e) { const r = canvas.getBoundingClientRect(); mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mouse, camera);
    if (!current) return null; for (const h of ray.intersectObject(current.G, true)) { let o = h.object; while (o && !o.userData.tip && !o.userData.click) o = o.parent; if (o) return { o, h }; } return null; }
  function hideTip() { tipEl.style.opacity = 0; }
  canvas.addEventListener('pointermove', e => { const p = pick(e); canvas.style.cursor = p && p.o.userData.click ? 'pointer' : 'default';
    if (p && p.o.userData.tip && (p.o.userData.tip[0] || p.o.userData.tip[1])) { tipEl.innerHTML = `<b>${esc(p.o.userData.tip[0])}</b>${esc(p.o.userData.tip[1])}`; tipEl.style.opacity = 1; tipEl.style.left = Math.min(e.clientX + 16, innerWidth - 280) + 'px'; tipEl.style.top = (e.clientY + 16) + 'px'; } else hideTip(); });
  let downAt = null; canvas.addEventListener('pointerdown', e => downAt = [e.clientX, e.clientY]);
  canvas.addEventListener('pointerup', e => { if (!downAt || busy) return; if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return; const p = pick(e); if (!p) return; if (p.o.userData.click) p.o.userData.click(p.h); if (p.o.userData.target) touch(cur, p.o.userData.target); });
  canvas.addEventListener('pointerleave', hideTip);

  /* ---------- loop ---------- */
  const clock = new THREE.Clock(), tmp = new THREE.Vector3();
  function loop() { const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime; stepTweens(dt); if (current) current.update(dt, t);
    billboards.forEach(b => { b.getWorldPosition(tmp); b.rotation.y = Math.atan2(camera.position.x - tmp.x, camera.position.z - tmp.z); });
    renderer.render(scene, camera); placePage(); requestAnimationFrame(loop); }

  try { await Promise.race([Promise.all(['600 20px "JetBrains Mono"', '400 20px "JetBrains Mono"', '20px "Instrument Serif"', '20px "Newsreader"'].map(f => document.fonts.load(f))), wait(2500)]); } catch (e) {}
  frame(); { const m = /^#p(\d+)$/.exec(location.hash); if (m && +m[1] < SP.length) cur = +m[1]; }
  const scn = await mount(cur, false); loop();
  const ld = $('#loading'); ld.style.opacity = 0; setTimeout(() => ld.remove(), 600);
  pageEl.classList.remove('hidden'); await wait(250); await popUp(scn);
  return { go, book };
}
