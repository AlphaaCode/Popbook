// Shared drawing kit for scene blocks: ink/paper materials, labels, glass, animation helpers.
import * as THREE from 'three';
export { THREE };

export const W = 1.0, H = 1.3, PY = 0.066;
export const INK = 0x1f1d1a;
export const pageY = x => PY - 0.032 * Math.exp(-Math.abs(x) / 0.04);
export const raw = hex => new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
export const PALETTE = [0xff8a3d, 0x7a5cff, 0x19a6ff, 0x2fb36b, 0xe0442f, 0xd4a335];
export const hexCss = h => '#' + h.toString(16).padStart(6, '0');

const env = { lightDir: new THREE.Vector3(0.5, 0.8, 0.2).normalize(), dpr: 1, billboards: [] };
export function initKit(o) { Object.assign(env, o); }
export const billboards = env.billboards;

/* ---------- ink / paper shading ---------- */
const inkVS = `varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const inkFS = `uniform vec3 uColor; uniform vec3 uGlow; uniform float uGlowAmt; uniform vec3 uL; uniform float uDpr; varying vec3 vN;
void main(){ vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n;
 float d = max(dot(n, normalize(uL)), 0.);
 vec3 col = uColor*(0.66 + 0.36*d);
 vec2 p = gl_FragCoord.xy/uDpr;
 float l1 = 1.-smoothstep(0.45,1.05, abs(fract((p.x+p.y)/5.5)-.5)*5.5);
 float l2 = 1.-smoothstep(0.45,1.05, abs(fract((p.x-p.y)/5.5)-.5)*5.5);
 float hatch = l1*(1.-smoothstep(0.12,0.3,d))*0.42 + l2*(1.-smoothstep(0.0,0.1,d))*0.38;
 col = mix(col, vec3(.13,.12,.11), hatch*(1.-uGlowAmt));
 col = mix(col, uGlow*(0.85+0.25*d), clamp(uGlowAmt,0.,1.)*0.9);
 gl_FragColor = vec4(col,1.); }`;
export function inkMat(hex = 0xf3eee2) {
  return new THREE.ShaderMaterial({ vertexShader: inkVS, fragmentShader: inkFS, side: THREE.DoubleSide,
    uniforms: { uColor: { value: raw(hex) }, uGlow: { value: raw(0xff9a3c) }, uGlowAmt: { value: 0 }, uL: { value: env.lightDir }, uDpr: { value: env.dpr } } });
}
const hullMat = t => new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms: { uT: { value: t } },
  vertexShader: `uniform float uT; void main(){ gl_Position = projectionMatrix*modelViewMatrix*vec4(position+normal*uT,1.); }`,
  fragmentShader: `void main(){ gl_FragColor = vec4(.12,.11,.1,1.); }` });
export const LINE = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: .92 });
export const LINE_SOFT = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: .35 });

/** A paper mesh with ink edges (and optionally an outline "hull" for round shapes). */
export function ink(geo, hex, o = {}) {
  const m = new THREE.Mesh(geo, inkMat(hex)); m.castShadow = true;
  if (o.edges !== false) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, o.thresh || 30), o.soft ? LINE_SOFT : LINE); e.raycast = () => {}; m.add(e); }
  if (o.hull) { const h = new THREE.Mesh(geo, hullMat(o.hull)); h.raycast = () => {}; m.add(h); }
  return m;
}
export function glow(mesh, amt, hex) { if (!mesh.material.uniforms) return; mesh.material.uniforms.uGlowAmt.value = amt; if (hex !== undefined) mesh.material.uniforms.uGlow.value = raw(hex); }
export function at(o, x, y, z) { o.position.set(x, y, z); return o; }
export function circlePts(r, n = 48, y = 0) { const p = []; for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2; p.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); } return p; }
export function lineLoop(r, y = 0, mat = LINE) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(r, 48, y)), mat); l.raycast = () => {}; return l; }
export function polyline(pts, mat = LINE) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat); l.raycast = () => {}; return l; }
export const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Invisible hit box so small/thin models are easy to click. */
export function hitBox(w, h, d, y = h / 2) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false })); m.position.y = y; return m; }

/** Glass cylinder whose side silhouettes always face the camera. */
export function glassCyl(r, h) {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide }));
  glass.position.y = h / 2; glass.raycast = () => {}; g.add(glass);
  g.add(lineLoop(r, 0), lineLoop(r, h));
  const sil = new THREE.Group(); sil.add(polyline([V(-r, 0, 0), V(-r, h, 0)]), polyline([V(r, 0, 0), V(r, h, 0)]));
  g.add(sil); env.billboards.push(sil);
  return g;
}

/* ---------- paper cards drawn on canvas ---------- */
export const FONTS = { mono: '"JetBrains Mono",monospace', serif: '"Instrument Serif",serif', news: '"Newsreader",Georgia,serif' };
export const F = (px, fam = 'mono', w = 400) => `${w} ${px}px ${FONTS[fam] || fam}`;
export function card(w, h, draw, o = {}) {
  const ppu = o.ppu || 1100;
  const cw = Math.min(2048, Math.round(w * ppu)), ch = Math.min(2048, Math.round(h * ppu));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: !o.flat });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  if (o.flat) { mesh.rotation.x = -Math.PI / 2; mesh.renderOrder = 1; }
  if (o.noHit) mesh.raycast = () => {};
  const redraw = fn => { g.clearRect(0, 0, cw, ch); g.direction = env.dir || 'ltr'; (fn || draw)(g, cw, ch); tex.needsUpdate = true; };
  redraw();
  mesh.redraw = redraw; // not in userData: blocks replace userData with {tip, click, target}
  return mesh;
}
export function boxed(g, cw, ch, fill = 'rgba(251,248,240,.96)') { g.fillStyle = fill; g.fillRect(3, 3, cw - 6, ch - 6); g.strokeStyle = '#1f1d1a'; g.lineWidth = 4; g.strokeRect(3, 3, cw - 6, ch - 6); }
export function txt(g, s, x, y, font, col = '#1f1d1a', align = 'left') { g.font = font; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); }
/** Draws text shrunk to fit maxW. */
export function fitTxt(g, s, x, y, px, fam, w, maxW, col, align) { let size = px; g.font = F(size, fam, w); while (size > 10 && g.measureText(s).width > maxW) { size -= 1; g.font = F(size, fam, w); } txt(g, s, x, y, F(size, fam, w), col, align); }
export function wrapTxt(g, s, x, y, maxW, lh, font, col = '#1f1d1a', maxLines = 9) {
  g.font = font; g.fillStyle = col; g.textAlign = 'left'; g.textBaseline = 'middle';
  const words = String(s).split(' '); let line = '', yy = y, n = 0;
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { if (++n >= maxLines) { g.fillText(line + '…', x, yy); return; } g.fillText(line, x, yy); line = w; yy += lh; } else line = t; }
  if (line) g.fillText(line, x, yy);
}
/** Flat label lying on the page: lines = [[text, px, family, color, weight]]. */
export function flatLabel(w, h, lines, o = {}) {
  return card(w, h, (g, cw, ch) => {
    if (o.box !== false) boxed(g, cw, ch, o.fill);
    const n = lines.length;
    lines.forEach((l, i) => { const yy = ch / 2 + (i - (n - 1) / 2) * (o.lh || l[1] * 1.25); fitTxt(g, String(l[0]), cw / 2, yy, l[1], l[2] || 'mono', l[4] || 400, cw - 24, l[3] || '#1f1d1a', 'center'); });
  }, { flat: true, ppu: o.ppu });
}
export function caption(text) { const m = card(0.86, 0.07, (g, cw, ch) => { wrapTxt(g, text, 6, ch * 0.32, cw - 12, 30, F(25, 'news'), '#2a2622', 2); }, { flat: true, ppu: 1300, noHit: true }); m.position.set(0.5, PY + 0.002, 0.58); return m; }

/* ---------- animation ---------- */
const tweens = [];
export const ease = { io: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, out: t => 1 - Math.pow(1 - t, 3), back: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }, lin: t => t };
export function tween(dur, fn, e = 'io', delay = 0) { return new Promise(res => tweens.push({ t: -delay, dur, fn, e: ease[e], res })); }
export function stepTweens(dt) { for (let i = tweens.length - 1; i >= 0; i--) { const tw = tweens[i]; tw.t += dt; if (tw.t < 0) continue; const u = Math.min(tw.t / tw.dur, 1); tw.fn(tw.e(u)); if (u >= 1) { tweens.splice(i, 1); tw.res(); } } }
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, t) => a + (b - a) * t;
export const fmtNum = (v, digits = 2, lang = 'en') => Number(v).toLocaleString(lang, { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, Math.abs(v) < 10 ? digits : 0) });
