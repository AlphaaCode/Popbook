// Scene blocks: each turns a `scene` object from book.json into a 3D pop-up model on the right page.
// Signature: build(scene, ctx) -> { G, pops, update(dt,t), demo:[{focus:[x,y,z], d, act, wait}], controls:[...] }
// ctx = { touch(id), setControl(id, patch), lang, ui, fmt(v,d) }
import { THREE, PY, INK, PALETTE, hexCss, ink, glow, at, lineLoop, polyline, V, hitBox, glassCyl, card, boxed, txt, fitTxt, wrapTxt,
  flatLabel, F, inkMat, LINE, LINE_SOFT, tween, wait, clamp, lerp, ease } from './kit.js';
import { compile } from '../lib/expr.js';

const tipOf = (title, body) => [title || '', body || ''];
const readoutCard = (w = 0.8, h = 0.1, z = 0.42) => { const c = card(w, h, () => {}, { flat: true, noHit: true }); c.position.set(0.5, PY + 0.002, z); return c; };

/* ===================================================================== */
/* network                                                               */
/* ===================================================================== */
function network(sc, ctx) {
  const G = new THREE.Group(), pops = [], racks = [], packets = [];
  const hub = ink(new THREE.BoxGeometry(0.16, 0.035, 0.08), 0xe9e2d2); at(hub, 0.5, PY + 0.0175, -0.02); G.add(hub); pops.push(hub);
  hub.userData = { target: 'network', tip: tipOf(sc.hub.label, sc.hub.tip), click: () => toggle() };
  const hl = flatLabel(0.15, 0.05, [[String(sc.hub.label).toUpperCase(), 30, 'mono', '#1f1d1a', 600]], { box: false }); hl.position.set(0, 0.0178, 0); hub.add(hl); hl.userData = hub.userData;
  const n = sc.nodes.length;
  sc.nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (i + 0.5) / n * Math.PI * 2 - Math.PI / n * (n % 2 ? 0 : 0);
    const x = 0.5 + Math.cos(a) * 0.31, z = -0.02 + Math.sin(a) * 0.34;
    const r = ink(new THREE.BoxGeometry(0.12, 0.22, 0.1), 0xf1ebdd); at(r, x, PY + 0.11, z); G.add(r); pops.push(r); racks.push(r);
    r.userData.leds = [];
    for (let k = 0; k < 6; k++) { r.add(polyline([V(-0.05, -0.09 + k * 0.03, 0.051), V(0.05, -0.09 + k * 0.03, 0.051)], LINE_SOFT));
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.002), new THREE.MeshBasicMaterial({ color: 0x8a857c })); led.position.set(0.035, -0.078 + k * 0.03, 0.052); r.add(led); r.userData.leds.push(led); }
    r.userData.target = 'network'; r.userData.tip = tipOf(nd.label, nd.tip); r.userData.click = () => toggle();
    const lab = flatLabel(0.15, 0.04, [[String(nd.label).toUpperCase(), 28, 'mono', '#1f1d1a', 600]]); lab.position.set(x, PY + 0.002, z + 0.09); G.add(lab);
    // cable leaves the rack side facing the hub (labels sit in front of the racks, cables never cross them)
    const sx = Math.abs(x - 0.5) < 0.05 ? 0 : Math.sign(0.5 - x), A = sx ? V(x + sx * 0.062, PY + 0.006, z) : V(x, PY + 0.006, z + (z < -0.02 ? 0.052 : -0.052));
    const B = sx ? V(0.5 - sx * 0.082, PY + 0.006, -0.02 + (z < -0.02 ? -0.022 : 0.022)) : V(0.5, PY + 0.006, -0.02 + (z < -0.02 ? -0.042 : 0.042));
    const c = new THREE.CatmullRomCurve3([A, V((A.x + B.x) / 2, PY + 0.006, (A.z + B.z) / 2 + (z < -0.02 ? -0.02 : 0.02)), B]);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(c, 40, 0.006, 8), inkMat(0x3b3833)); tube.castShadow = true; tube.raycast = () => {}; G.add(tube);
    for (let k = 0; k < 3; k++) { const pk = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), new THREE.MeshBasicMaterial({ color: 0x2fa8ff })); pk.visible = false; G.add(pk); packets.push({ m: pk, c, o: k / 3, dir: i % 2 ? 1 : -1 }); }
  });
  let on = false;
  function toggle() { on = !on; packets.forEach(p => p.m.visible = on); racks.forEach(r => glow(r, on ? 0.18 : 0, 0x7cc8ff)); ctx.touch('network'); }
  return { G, pops,
    update(dt, t) { if (!on) return; packets.forEach(p => { const u = ((t * 0.45 * p.dir + p.o) % 1 + 1) % 1; p.m.position.copy(p.c.getPoint(u)); p.m.position.y += 0.008; });
      racks.forEach((r, i) => r.userData.leds.forEach((l, k) => l.material.color.setHex(Math.sin(t * 9 + k * 1.7 + i) > 0.2 ? 0x39d36b : 0x5e5a52))); },
    demo: [{ focus: [0.5, PY, 0], d: 1.15, act: () => { if (!on) toggle(); }, wait: 2600 }] };
}

/* ===================================================================== */
/* showcase models                                                        */
/* ===================================================================== */
const MODELS = {
  globe(item) {
    const g = new THREE.Group();
    const base = ink(new THREE.CylinderGeometry(0.05, 0.06, 0.02, 32), 0xece5d5, { thresh: 40 }); base.position.y = 0.01; g.add(base);
    const rod = ink(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 8), 0x6a645b, { edges: false }); rod.position.y = 0.055; g.add(rod);
    const globe = ink(new THREE.SphereGeometry(0.09, 48, 32), 0xf3efe6, { edges: false, hull: 0.0025 }); globe.position.y = 0.165; g.add(globe);
    for (let la = -60; la <= 60; la += 30) globe.add(lineLoop(0.0905 * Math.cos(la * Math.PI / 180), 0.0905 * Math.sin(la * Math.PI / 180), LINE_SOFT));
    for (let lo = 0; lo < 180; lo += 30) { const pts = []; for (let a = 0; a <= 64; a++) { const th = a / 64 * Math.PI * 2; pts.push(V(Math.cos(th) * 0.0905 * Math.cos(lo * Math.PI / 180), Math.sin(th) * 0.0905, Math.cos(th) * 0.0905 * Math.sin(lo * Math.PI / 180))); } globe.add(polyline(pts, LINE_SOFT)); }
    let lines = null;
    const mesh = lvl => { if (lines) globe.remove(lines); const n = 4 * Math.pow(2, lvl); const pts = [], R = 0.0918;
      const sph = (la, lo) => V(R * Math.cos(la) * Math.sin(lo), R * Math.sin(la), R * Math.cos(la) * Math.cos(lo));
      for (let i = 0; i <= n; i++) { const la = lerp(0.05, 0.85, i / n); for (let k = 0; k < 24; k++) pts.push(sph(la, lerp(-0.6, 0.5, k / 24)), sph(la, lerp(-0.6, 0.5, (k + 1) / 24))); }
      for (let i = 0; i <= n; i++) { const lo = lerp(-0.6, 0.5, i / n); for (let k = 0; k < 24; k++) pts.push(sph(lerp(0.05, 0.85, k / 24), lo), sph(lerp(0.05, 0.85, (k + 1) / 24), lo)); }
      lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: lvl ? 0x0b78d0 : INK })); lines.raycast = () => {}; globe.add(lines); };
    mesh(0);
    return { g, hit: globe, onStep: i => { mesh(Math.min(i, 3)); glow(globe, i ? 0.12 : 0, 0x9fd8ff); }, update: (dt, t, on) => { globe.rotation.y += dt * (on ? 0.5 : 0.12); } };
  },
  head() {
    const g = new THREE.Group();
    const ped = ink(new THREE.CylinderGeometry(0.06, 0.07, 0.03, 32), 0xece5d5, { thresh: 40 }); ped.position.y = 0.015; g.add(ped);
    const neck = ink(new THREE.CylinderGeometry(0.03, 0.035, 0.06, 24), 0xf4efe3, { edges: false, hull: 0.002 }); neck.position.y = 0.06; g.add(neck);
    const head = ink(new THREE.SphereGeometry(0.085, 40, 24), 0xf6f1e6, { edges: false, hull: 0.0025 }); head.scale.set(0.9, 1.08, 1); head.position.y = 0.17; g.add(head);
    const wf = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.0865, 2)), LINE_SOFT); wf.scale.copy(head.scale); wf.position.copy(head.position); wf.raycast = () => {}; g.add(wf);
    const slice = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), new THREE.MeshBasicMaterial({ color: 0x22b8ff, transparent: true, opacity: .22, side: THREE.DoubleSide, depthWrite: false }));
    slice.rotation.x = -Math.PI / 2; slice.visible = false; slice.raycast = () => {}; g.add(slice);
    const ring = lineLoop(1, 0, new THREE.LineBasicMaterial({ color: 0x0b78d0 })); ring.visible = false; g.add(ring);
    return { g, hit: head, update: (dt, t, on) => { slice.visible = ring.visible = on; glow(head, on ? 0.25 : 0, 0x7fd6ff); if (!on) return;
      const yy = 0.17 + Math.sin(t * 1.6) * 0.08; slice.position.y = ring.position.y = yy; const dy = (yy - 0.17) / 1.08, r = Math.sqrt(Math.max(0.0865 ** 2 - dy * dy, 0)); ring.scale.set(r * 0.9, 1, r); } };
  },
  layers() {
    const g = new THREE.Group(), bw = 0.28, bh = 0.15, bd = 0.2;
    const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .12, depthWrite: false })); box.position.y = bh / 2; box.raycast = () => {}; g.add(box);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), LINE); e.position.y = bh / 2; g.add(e);
    [[0.03, 0xe7d6ae], [0.065, 0xd2b88c], [0.1, 0xbfa47d]].forEach(([y0, c], i) => { const geo = new THREE.PlaneGeometry(bw * 0.98, bd * 0.98, 24, 16); geo.rotateX(-Math.PI / 2); const p = geo.attributes.position;
      for (let k = 0; k < p.count; k++) p.setY(k, y0 + 0.012 * Math.sin(p.getX(k) * 18 + i) + 0.008 * Math.cos(p.getZ(k) * 20)); geo.computeVertexNormals(); const m = ink(geo, c, { edges: false }); m.raycast = () => {}; g.add(m); });
    const pocket = ink(new THREE.SphereGeometry(1, 24, 12), 0x5b544b, { edges: false }); pocket.scale.set(0.08, 0.02, 0.055); pocket.position.set(0.02, 0.118, 0); g.add(pocket);
    const wells = [-0.07, 0.02, 0.1].map((x, i) => { const w = ink(new THREE.CylinderGeometry(0.0045, 0.0045, 0.11, 8), 0xeee8da, { edges: false, hull: 0.0015 }); w.position.set(x, 0.13, -0.03 + i * 0.03); g.add(w);
      const der = ink(new THREE.ConeGeometry(0.018, 0.05, 4), 0xf4efe3); der.position.set(x, bh + 0.025, -0.03 + i * 0.03); g.add(der); return w; });
    const hit = hitBox(bw, bh + 0.05, bd); g.add(hit);
    return { g, hit, update: (dt, t, on) => { wells.forEach((w, i) => glow(w, on ? 0.6 + 0.3 * Math.sin(t * 6 + i) : 0, 0xff9a3c)); glow(pocket, on ? 0.75 : 0, 0xffa53a); } };
  },
  server() {
    const g = new THREE.Group(); const r = ink(new THREE.BoxGeometry(0.13, 0.24, 0.11), 0xf1ebdd); r.position.y = 0.12; g.add(r); const leds = [];
    for (let k = 0; k < 7; k++) { r.add(polyline([V(-0.055, -0.1 + k * 0.03, 0.056), V(0.055, -0.1 + k * 0.03, 0.056)], LINE_SOFT)); const l = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.002), new THREE.MeshBasicMaterial({ color: 0x8a857c })); l.position.set(0.04, -0.088 + k * 0.03, 0.057); r.add(l); leds.push(l); }
    return { g, hit: r, update: (dt, t, on) => { leds.forEach((l, k) => l.material.color.setHex(on && Math.sin(t * 9 + k * 1.7) > 0.2 ? 0x39d36b : 0x8a857c)); glow(r, on ? 0.12 : 0, 0x7cc8ff); } };
  },
  chip() {
    const g = new THREE.Group(); const sub = ink(new THREE.BoxGeometry(0.22, 0.016, 0.22), 0xdfe4d2); sub.position.y = 0.008; g.add(sub);
    for (let k = -4; k <= 4; k++) { g.add(polyline([V(k * 0.022, 0.0165, 0.09), V(k * 0.022, 0.0165, 0.11)], LINE_SOFT)); g.add(polyline([V(k * 0.022, 0.0165, -0.11), V(k * 0.022, 0.0165, -0.09)], LINE_SOFT)); }
    const die = ink(new THREE.BoxGeometry(0.09, 0.02, 0.09), 0xf2ede2); die.position.y = 0.026; g.add(die);
    return { g, hit: die, update: (dt, t, on) => glow(die, on ? 0.55 + 0.2 * Math.sin(t * 5) : 0, 0xff9a3c) };
  },
  molecule() {
    const g = new THREE.Group(); const c = new THREE.Group(); c.position.y = 0.15; g.add(c);
    const pts = [V(0, 0, 0), V(0.08, 0.04, 0), V(-0.07, 0.05, 0.03), V(0.01, -0.07, 0.05), V(0.02, 0.02, -0.08)], atoms = [];
    pts.forEach((p, i) => { const s = ink(new THREE.SphereGeometry(i ? 0.024 : 0.034, 24, 16), i ? 0xf4efe3 : 0xe9d9c9, { edges: false, hull: 0.002 }); s.position.copy(p); c.add(s); atoms.push(s);
      if (i) { const d = p.length(); const b = ink(new THREE.CylinderGeometry(0.006, 0.006, d, 8), 0xd9d1c0, { edges: false }); b.position.copy(p.clone().multiplyScalar(0.5)); b.quaternion.setFromUnitVectors(V(0, 1, 0), p.clone().normalize()); c.add(b); } });
    const stand = ink(new THREE.CylinderGeometry(0.004, 0.004, 0.08, 6), 0x6a645b, { edges: false }); stand.position.y = 0.04; g.add(stand);
    const hit = hitBox(0.2, 0.22, 0.2, 0.15); g.add(hit);
    return { g, hit, update: (dt, t, on) => { c.rotation.y += dt * (on ? 1.4 : 0.2); atoms.forEach((a, i) => glow(a, on ? 0.4 : 0, PALETTE[i % PALETTE.length])); } };
  },
  dna() {
    const g = new THREE.Group(), c = new THREE.Group(); c.position.y = 0.02; g.add(c); const balls = [];
    for (let i = 0; i < 14; i++) { const y = i * 0.019, a = i * 0.55; const p1 = V(Math.cos(a) * 0.05, y, Math.sin(a) * 0.05), p2 = V(-Math.cos(a) * 0.05, y, -Math.sin(a) * 0.05);
      [p1, p2].forEach((p, k) => { const s = ink(new THREE.SphereGeometry(0.012, 14, 10), 0xf4efe3, { edges: false, hull: 0.0015 }); s.position.copy(p); c.add(s); balls.push(s); });
      c.add(polyline([p1, p2], LINE_SOFT)); }
    const hit = hitBox(0.14, 0.3, 0.14, 0.15); g.add(hit);
    return { g, hit, update: (dt, t, on) => { c.rotation.y += dt * (on ? 1.2 : 0.25); balls.forEach((b, i) => glow(b, on ? 0.6 : 0, PALETTE[(i >> 1) % 4])); } };
  },
  gear() {
    const mk = (r, teeth) => { const s = new THREE.Shape(); for (let i = 0; i < teeth * 2; i++) { const a0 = i / (teeth * 2) * Math.PI * 2, a1 = (i + 1) / (teeth * 2) * Math.PI * 2, rr = i % 2 ? r : r * 1.18; s.lineTo(Math.cos(a0) * rr, Math.sin(a0) * rr); s.lineTo(Math.cos(a1) * rr, Math.sin(a1) * rr); }
      const h = new THREE.Path(); h.absarc(0, 0, r * 0.3, 0, Math.PI * 2, true); s.holes.push(h); const geo = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false }); geo.rotateX(-Math.PI / 2); return ink(geo, 0xefe8d8, { thresh: 50 }); };
    const g = new THREE.Group(); const a = mk(0.08, 12), b = mk(0.05, 8); a.position.set(-0.04, 0.0, 0); b.position.set(0.098, 0.0, 0.0); g.add(a, b);
    const hit = hitBox(0.28, 0.06, 0.2, 0.02); g.add(hit);
    return { g, hit, update: (dt, t, on) => { const s = on ? 1.2 : 0.15; a.rotation.y += dt * s; b.rotation.y -= dt * s * 12 / 8; glow(a, on ? 0.25 : 0, 0xffc46b); glow(b, on ? 0.25 : 0, 0xffc46b); } };
  },
  flask() {
    const g = new THREE.Group(); const prof = [V(0.001, 0, 0), V(0.085, 0, 0), V(0.09, 0.01, 0), V(0.03, 0.15, 0), V(0.025, 0.24, 0)].map(v => new THREE.Vector2(v.x, v.y));
    const glass = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .18, depthWrite: false, side: THREE.DoubleSide })); g.add(glass);
    g.add(lineLoop(0.088, 0.005), lineLoop(0.025, 0.24)); const sil = new THREE.Group(); sil.add(polyline(prof.map(p => V(p.x, p.y, 0))), polyline(prof.map(p => V(-p.x, p.y, 0)))); g.add(sil); env_bill(sil);
    const liq = new THREE.Mesh(new THREE.LatheGeometry([V(0.001, 0.002), V(0.084, 0.002), V(0.088, 0.012), V(0.055, 0.08), V(0.001, 0.08)].map(v => new THREE.Vector2(v.x, v.y)), 32), new THREE.MeshBasicMaterial({ color: 0x2fb36b, transparent: true, opacity: .8 })); g.add(liq);
    const bubbles = []; for (let i = 0; i < 10; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0xc9ffe0 })); b.visible = false; g.add(b); bubbles.push({ b, o: Math.random() }); }
    const hit = hitBox(0.18, 0.25, 0.18); g.add(hit);
    return { g, hit, update: (dt, t, on) => { liq.material.color.setHex(on ? 0x3fe08a : 0x2fb36b); bubbles.forEach((B, i) => { B.b.visible = on; const u = (t * 0.5 + B.o) % 1; B.b.position.set(Math.sin(i * 7) * 0.03 * (1 - u), 0.02 + u * 0.22, Math.cos(i * 5) * 0.03 * (1 - u)); }); } };
  },
  cube: () => simpleShape(new THREE.BoxGeometry(0.14, 0.14, 0.14), 0.12),
  pyramid: () => simpleShape(new THREE.ConeGeometry(0.11, 0.18, 4), 0.12),
  sphere: () => simpleShape(new THREE.SphereGeometry(0.09, 32, 20), 0.13, true),
  cylinder: () => simpleShape(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 32), 0.12, true),
};
let env_bill = () => {};
import { billboards } from './kit.js';
env_bill = o => billboards.push(o);
function simpleShape(geo, y, round) {
  const g = new THREE.Group(); const ped = ink(new THREE.CylinderGeometry(0.07, 0.08, 0.025, 32), 0xece5d5, { thresh: 40 }); ped.position.y = 0.0125; g.add(ped);
  const m = ink(geo, 0xf3eee2, round ? { edges: false, hull: 0.0025 } : {}); m.position.y = y; g.add(m);
  return { g, hit: m, update: (dt, t, on) => { m.rotation.y += dt * (on ? 1.2 : 0.15); glow(m, on ? 0.35 : 0, 0x9fd0ff); } };
}

function showcase(sc, ctx) {
  const G = new THREE.Group(), pops = [], n = sc.items.length;
  // models are up to ~0.3 tall; seen from 58° they cover ~0.2 of page depth behind them, so nothing sits right behind a model
  const POS = { 1: [[0.5, -0.14]], 2: [[0.28, -0.16], [0.72, -0.16]], 3: [[0.19, -0.16], [0.5, -0.16], [0.81, -0.16]], 4: [[0.28, -0.4], [0.72, -0.4], [0.28, 0.02], [0.72, 0.02]] }[n];
  const SCALE = n === 3 ? 0.9 : n === 4 ? 0.78 : 1, LABZ = n === 4 ? 0.16 : 0.2;
  const anySteps = sc.items.some(i => i.steps && i.steps.length);
  const ro = anySteps ? readoutCard(0.8, 0.09, 0.45) : null; if (ro) G.add(ro);
  const drawRo = it => ro && ro.redraw((g, cw, ch) => { boxed(g, cw, ch); if (!it) { txt(g, ctx.ui.touch, 24, ch / 2, F(26, 'news'), '#3d3830'); return; }
    const st = it.steps[it.step]; fitTxt(g, String(it.label).toUpperCase(), 24, ch * 0.32, 24, 'mono', 600, cw * 0.4, '#1f1d1a', 'left');
    fitTxt(g, st.label, 24, ch * 0.7, 40, 'serif', 400, cw * 0.45, '#1f1d1a', 'left'); fitTxt(g, st.value || '', cw - 24, ch / 2, 30, 'mono', 600, cw * 0.45, '#0b78d0', 'right'); });
  drawRo(null);
  const objs = sc.items.map((it, i) => {
    const M = (MODELS[it.model] || MODELS.cube)(it); const [x, z] = POS[i]; M.g.position.set(x, PY, z); M.g.scale.setScalar(SCALE); G.add(M.g); pops.push(M.g);
    const st = { on: false, step: 0, M };
    const click = () => { ctx.touch(it.id); if (it.steps && it.steps.length) { st.step = (st.step + 1) % it.steps.length; it.step = st.step; M.onStep ? M.onStep(st.step) : null; st.on = st.step > 0 || !M.onStep; drawRo(it); } else st.on = !st.on; };
    it.step = 0; M.hit.userData = { target: it.id, tip: tipOf(it.label, it.tip), click };
    const lab = flatLabel(n === 3 ? 0.28 : 0.3, it.sub ? 0.078 : 0.05, [[String(it.label).toUpperCase(), 27, 'mono', '#1f1d1a', 600], ...(it.sub ? [[it.sub, 25, 'news', '#4a443b']] : [])]); lab.position.set(x, PY + 0.002, z + LABZ); G.add(lab);
    lab.userData = M.hit.userData;
    return { it, st, click, M };
  });
  return { G, pops, update: (dt, t) => objs.forEach(o => o.M.update && o.M.update(dt, t, o.st.on)),
    demo: objs.map(o => ({ focus: [o.M.g.position.x, PY + 0.12, o.M.g.position.z], d: 0.75, act: () => { o.click(); if (o.it.steps && o.it.steps.length > 2) setTimeout(o.click, 1300); }, wait: 2600 })) };
}

/* ===================================================================== */
/* race (glass jars)                                                      */
/* ===================================================================== */
function race(sc, ctx) {
  const G = new THREE.Group(), pops = [], n = sc.items.length;
  const shelf = new THREE.Group(); G.add(shelf); pops.push(shelf);
  // shelves on the right, one machine tag per shelf on the left
  const X = sc.items.map((_, i) => n === 1 ? 0.58 : lerp(0.34, 0.82, i / (n - 1))), zTop = -0.24, zBot = -0.06, yTop = 0.13;
  const colA = 0x6b4cff, colB = 0x19a6ff, x0 = 0.25, x1 = 0.91;
  const b1 = ink(new THREE.BoxGeometry(x1 - x0, 0.014, 0.13), 0xece4d2); at(b1, (x0 + x1) / 2, PY + 0.007, zBot); shelf.add(b1);
  const b2 = ink(new THREE.BoxGeometry(x1 - x0, 0.014, 0.13), 0xece4d2); at(b2, (x0 + x1) / 2, PY + yTop, zTop); shelf.add(b2);
  for (const x of [x0 + 0.012, x1 - 0.012]) { for (const z of [zTop - 0.055, zTop + 0.055]) { const p = ink(new THREE.BoxGeometry(0.012, yTop, 0.012), 0xe6dece); at(p, x, PY + yTop / 2, z); shelf.add(p); } }
  // a flat tag at page level reads at the same screen height as the raised shelf when shifted back by height·cot(58°)
  const tag = (lab, col, z) => { const t = flatLabel(0.18, 0.05, [[String(lab), 26, 'mono', hexCss(col), 600]], { fill: 'rgba(251,248,240,.96)' }); t.position.set(0.12, PY + 0.002, z); shelf.add(t); return t; };
  tag(sc.a.label, colA, zTop - yTop * 0.62); tag(sc.b.label, colB, zBot);
  const days = sc.unit === 'days';
  const fmtT = d => !days ? ctx.fmt(d, 1) + ' ' + sc.unit : d < 1 ? '0 ' + ctx.ui.d : d < 60 ? Math.round(d) + ' ' + ctx.ui.d : d < 730 ? ctx.fmt(d / 30.4, 1) + ' ' + ctx.ui.mo : ctx.fmt(d / 365, 1) + ' ' + ctx.ui.yr;
  const jars = sc.items.map((T, i) => {
    const mk = (z, y, col) => { const j = glassCyl(0.055, 0.15); at(j, X[i], PY + y, z); shelf.add(j);
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 32).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .85 }));
      liq.scale.y = 0.0001; liq.visible = false; liq.position.y = 0.003; liq.raycast = () => {}; j.add(liq); const cap = lineLoop(0.05, 0, new THREE.LineBasicMaterial({ color: col })); cap.position.y = 0.003; j.add(cap);
      const hit = hitBox(0.12, 0.16, 0.12, 0.08); j.add(hit); hit.userData = { target: T.id, tip: tipOf(T.label, `${T.tip ? T.tip + ' — ' : ''}${sc.a.label} : ${T.aText} · ${sc.b.label} : ${T.bText}`), click: () => run(i) };
      return { liq, cap }; };
    const lab = flatLabel(Math.min(0.185, 0.6 / n), 0.08, [[String(T.label).toUpperCase(), 25, 'mono', '#1f1d1a', 600], [T.short, 24, 'news', '#3d3830']]); lab.position.set(X[i], PY + 0.002, 0.085); G.add(lab);
    lab.userData = { target: T.id, tip: tipOf(T.label, ctx.ui.run), click: () => run(i) };
    return { top: mk(zTop, yTop + 0.007, colA), bot: mk(zBot, 0.014, colB), T, run: 0, t: 0 };
  });
  const clock = readoutCard(0.8, 0.16, 0.3); G.add(clock);
  let active = -1, day = 0;
  function drawClock() { clock.redraw((g, cw, ch) => { boxed(g, cw, ch);
    if (active < 0) { txt(g, ctx.ui.clock, 24, 36, F(24, 'mono', 600)); wrapTxt(g, ctx.ui.raceHelp, 24, 88, cw - 48, 32, F(27, 'news'), '#3d3830', 2); return; }
    const T = jars[active].T; fitTxt(g, T.label.toUpperCase() + ' · ' + ctx.ui.elapsed, 24, 34, 24, 'mono', 600, cw * 0.62, '#1f1d1a', 'left'); txt(g, fmtT(day), cw - 24, 40, F(50, 'serif'), '#1f1d1a', 'right');
    const pa = Math.min(day / T.a, 1), pb = Math.min(day / T.b, 1);
    const bar = (y, p, col, lab) => { g.fillStyle = 'rgba(31,29,26,.08)'; g.fillRect(230, y - 13, cw - 470, 26); g.fillStyle = col; g.fillRect(230, y - 13, (cw - 470) * p, 26); g.strokeStyle = '#1f1d1a'; g.lineWidth = 2; g.strokeRect(230, y - 13, cw - 470, 26);
      fitTxt(g, lab, 24, y, 24, 'mono', 600, 190, col, 'left'); txt(g, p >= 1 ? '✓ ' + ctx.ui.done : Math.floor(p * 100) + ' %', cw - 24, y, F(24, 'mono', 600), p >= 1 ? '#2d7a3e' : '#1f1d1a', 'right'); };
    const fast = T.b <= T.a; bar(88, fast ? pb : pa, hexCss(fast ? colB : colA), fast ? sc.b.label : sc.a.label); bar(130, fast ? pa : pb, hexCss(fast ? colA : colB), fast ? sc.a.label : sc.b.label); }); }
  drawClock();
  function run(i) { active = i; day = 0; jars.forEach(J => { [J.top, J.bot].forEach(x => { x.liq.scale.y = 0.0001; x.liq.visible = false; x.cap.position.y = 0.003; }); J.run = 0; }); jars[i].t = 0; jars[i].run = 1; ctx.touch(sc.items[i].id); }
  return { G, pops,
    update(dt) { if (active < 0) return; const J = jars[active]; if (!J.run) return; J.t += dt; const T = J.T, long = Math.max(T.a, T.b), dur = 5.5;
      const u = Math.min(J.t / dur, 1); day = long * Math.pow(u, 3); if (u >= 1) { J.run = 0; day = long; }
      const pa = Math.min(day / T.a, 1), pb = Math.min(day / T.b, 1);
      [[J.top, pa], [J.bot, pb]].forEach(([x, p]) => { x.liq.visible = p > 0.002; x.liq.scale.y = Math.max(0.0001, 0.14 * p); x.cap.position.y = 0.003 + 0.14 * p; }); drawClock(); },
    demo: [{ focus: [0.5, PY + 0.1, -0.05], d: 1.0, act: () => run(0), wait: 6200 }, ...(n > 2 ? [{ focus: [0.6, PY + 0.1, -0.05], d: 1.0, act: () => run(n - 2), wait: 6200 }] : [])] };
}

/* ===================================================================== */
/* bars (towers)                                                          */
/* ===================================================================== */
function bars(sc, ctx) {
  const G = new THREE.Group(), pops = [], n = sc.items.length;
  const vals = sc.items.map(i => i.value), vmin = Math.min(...vals), vmax = Math.max(...vals);
  const lmin = Math.log10(vmin) - 0.25, lmax = Math.log10(vmax);
  const HMAX = 0.3; // taller towers lean off the page in perspective
  const hLog = v => 0.04 + (Math.log10(v) - lmin) / Math.max(lmax - lmin, 0.01) * (HMAX - 0.04), hLin = v => Math.max(0.003, v / vmax * HMAX);
  let logScale = sc.log, grown = 1;
  const xs = sc.items.map((_, i) => n === 1 ? 0.5 : lerp(0.14, 0.84, i / (n - 1))), Z = -0.12, bw = Math.min(0.07, 0.6 / n);
  const towers = sc.items.map((it, i) => {
    const g = new THREE.Group(); at(g, xs[i], PY, Z); G.add(g); pops.push(g);
    const col = ink(new THREE.BoxGeometry(bw, 1, bw).translate(0, 0.5, 0), i === n - 1 ? 0xe9e0f6 : 0xf2ece0); g.add(col);
    for (let k = 1; k < 12; k++) col.add(polyline([V(-bw / 2, k / 12, bw / 2 + 0.0001), V(bw / 2, k / 12, bw / 2 + 0.0001), V(bw / 2, k / 12, -bw / 2 - 0.0001)], LINE_SOFT));
    const cap = ink(new THREE.BoxGeometry(bw * 1.3, 0.012, bw * 1.3), 0x8f877a); g.add(cap);
    const die = ink(new THREE.BoxGeometry(bw * 0.65, 0.004, bw * 0.65), 0xd9cfb8); die.position.y = 0.008; cap.add(die);
    col.userData = { target: 'bar', tip: tipOf(`${it.label} · ${it.x}`, `${it.valueText} ${sc.unitLabel || ''}${it.tip ? ' — ' + it.tip : ''}`), click: () => { ctx.touch('bar'); towers.forEach(t => glow(t.col, 0)); glow(col, 0.5, i === n - 1 ? 0x8f6bff : 0x2fa8ff); } };
    cap.userData = col.userData;
    const lab = flatLabel(Math.min(0.14, 0.82 / n), 0.085, [[String(it.label).toUpperCase(), 23, 'mono', '#1f1d1a', 600], ...(String(it.label) === String(it.x) ? [] : [[String(it.x), 30, 'serif']]), [it.valueText, 21, 'mono', '#4a443b']]); lab.position.set(xs[i], PY + 0.002, 0.06); G.add(lab);
    return { g, col, cap, v: it.value };
  });
  const dashMat = new THREE.LineDashedMaterial({ color: 0xb8342a, dashSize: 0.015, gapSize: 0.01 }); let curve = null;
  const x0 = sc.items[0].x, x1 = sc.items[n - 1].x;
  function drawCurve() { if (curve) { G.remove(curve); curve = null; } if (!sc.growth) return; const pts = [];
    for (let k = 0; k <= 60; k++) { const x = lerp(x0, x1, k / 60); const v = sc.items[0].value * Math.pow(sc.growth.factor || 2, (x - x0) / (sc.growth.every || 1)); const h = logScale ? hLog(v) : hLin(v);
      if (h > HMAX * 1.25) break; pts.push(V(lerp(xs[0], xs[n - 1], (x - x0) / (x1 - x0 || 1)), PY + h * grown + 0.014, Z - 0.05)); }
    curve = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dashMat); curve.computeLineDistances(); curve.raycast = () => {}; G.add(curve); }
  const setH = (t, h) => { t.col.scale.y = Math.max(h, 0.0005); t.cap.position.y = h + 0.006; };
  function apply() { towers.forEach(t => setH(t, (logScale ? hLog(t.v) : hLin(t.v)) * grown)); drawCurve(); }
  const info = readoutCard(0.8, 0.13, 0.27); G.add(info);
  const drawInfo = () => info.redraw((g, cw, ch) => { boxed(g, cw, ch); txt(g, logScale ? ctx.ui.logScale : ctx.ui.linScale, 24, 34, F(25, 'mono', 600));
    wrapTxt(g, (logScale ? ctx.ui.logHelp : ctx.ui.linHelp) + (sc.growth && logScale ? ' ' + ctx.ui.growth + ' ' + (sc.growth.label || '') + '.' : ''), 24, 80, cw - 48, 30, F(26, 'news'), '#3d3830', 2); });
  drawInfo(); apply();
  async function play() { ctx.touch('play'); grown = 0; apply(); await tween(3.2, u => { towers.forEach((t, i) => setH(t, (logScale ? hLog(t.v) : hLin(t.v)) * ease.back(clamp(u * n - i, 0, 1)))); }, 'lin'); grown = 1; apply(); }
  function toggleScale() { ctx.touch('scale'); const from = logScale; logScale = !logScale; drawInfo(); ctx.setControl('scale', { label: ctx.ui.scale + ' : ' + (logScale ? 'log' : 'lin') });
    tween(0.9, u => towers.forEach(t => setH(t, lerp(from ? hLog(t.v) : hLin(t.v), logScale ? hLog(t.v) : hLin(t.v), u))), 'io').then(apply); }
  return { G, pops, update() {},
    controls: [{ id: 'play', kind: 'button', label: '▶ ' + ctx.ui.grow, onClick: play }, { id: 'scale', kind: 'button', label: ctx.ui.scale + ' : ' + (logScale ? 'log' : 'lin'), onClick: toggleScale }],
    demo: [{ focus: [0.5, PY + 0.12, -0.05], d: 1.05, act: play, wait: 3600 }, { focus: [0.72, PY + 0.2, -0.05], d: 0.85, act: toggleScale, wait: 2600 }, { focus: [0.5, PY + 0.12, -0.05], d: 1.05, act: toggleScale, wait: 1800 }] };
}

/* ===================================================================== */
/* model (slider → formulas, threshold wall, toggle)                      */
/* ===================================================================== */
function model(sc, ctx) {
  const G = new THREE.Group(), pops = [];
  const P = sc.param, T = sc.toggle; const scope = { [P.id]: P.value }; if (T) scope[T.id] = T.off;
  const outs = sc.outputs.slice(0, 3).map(o => ({ ...o, f: compile(o.expr) }));
  const gaugeF = sc.gauge ? compile(sc.gauge.expr) : outs[0].f, gMax = sc.gauge && sc.gauge.max ? sc.gauge.max : null;
  const thrWhen = sc.threshold && sc.threshold.when ? compile(sc.threshold.when) : () => 1;
  const msgs = (sc.messages || []).map(m => ({ text: m.text, f: compile(m.when || 'true') }));
  const safe = (f) => { try { const v = f(scope); return Number.isFinite(v) ? v : 0; } catch { return 0; } };
  let gaugeRef = gMax || Math.max(1e-6, ...[P.min, P.max].map(v => { const s = { ...scope, [P.id]: v }; try { return Math.abs(gaugeF(s)); } catch { return 1; } }));
  const thrOn = () => sc.threshold && scope[P.id] >= sc.threshold.value && !!safe(thrWhen);
  // units (chip dies / tank / dial)
  const unitsN = () => T ? clamp(Math.round(scope[T.id]) || 1, 1, 4) : 1;
  const main = new THREE.Group(); at(main, 0.3, PY, -0.26); G.add(main); pops.push(main);
  let dies = [], pts = null, pp = null, life = null, pm = null, tankLiq = null, needle = null;
  if (sc.visual === 'chip') {
    const sub = ink(new THREE.BoxGeometry(0.26, 0.016, 0.26), 0xdfe4d2); sub.position.y = 0.008; main.add(sub);
    for (let k = -5; k <= 5; k++) { main.add(polyline([V(k * 0.022, 0.0165, 0.11), V(k * 0.022, 0.0165, 0.13)], LINE_SOFT)); main.add(polyline([V(k * 0.022, 0.0165, -0.13), V(k * 0.022, 0.0165, -0.11)], LINE_SOFT)); }
    const ihs = ink(new THREE.BoxGeometry(0.17, 0.012, 0.17), 0xe9e5dc); ihs.position.y = 0.022; main.add(ihs);
    const layouts = { 1: [[0, 0, 0.1, 0.1]], 2: [[-0.038, 0, 0.06, 0.1], [0.038, 0, 0.06, 0.1]], 3: [[-0.038, -0.03, 0.06, 0.045], [0.038, -0.03, 0.06, 0.045], [0, 0.03, 0.136, 0.045]], 4: [[-0.038, -0.03, 0.06, 0.045], [0.038, -0.03, 0.06, 0.045], [-0.038, 0.03, 0.06, 0.045], [0.038, 0.03, 0.06, 0.045]] };
    const dieSets = {}; for (const k of [1, 2, 3, 4]) { dieSets[k] = layouts[k].map(([x, z, w, d]) => { const m = ink(new THREE.BoxGeometry(w, 0.018, d), 0xf2ede2); m.position.set(x, 0.037, z); m.visible = false; main.add(m);
      m.userData = { target: 'param', tip: tipOf(sc.gauge ? sc.gauge.label : P.label, ctx.ui.useSlider) }; return m; }); }
    dies = () => dieSets[unitsN()]; Object.values(dieSets).flat().forEach(m => m.visible = false);
    const NP = 90; pp = new Float32Array(NP * 3); life = new Float32Array(NP).map(() => Math.random());
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3)); pm = new THREE.PointsMaterial({ color: 0xff7a2a, size: 0.014, transparent: true, opacity: 0, depthWrite: false });
    pts = new THREE.Points(pg, pm); pts.raycast = () => {}; main.add(pts);
  } else if (sc.visual === 'tank') {
    const j = glassCyl(0.08, 0.22); main.add(j); tankLiq = new THREE.Mesh(new THREE.CylinderGeometry(0.076, 0.076, 1, 40).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0x19a6ff, transparent: true, opacity: .8 })); tankLiq.position.y = 0.003; j.add(tankLiq);
    for (let k = 1; k < 6; k++) j.add(polyline([V(0.08, k * 0.037, 0), V(0.1, k * 0.037, 0)])); const h = hitBox(0.18, 0.22, 0.18); h.userData = { target: 'param', tip: tipOf(sc.gauge ? sc.gauge.label : P.label, ctx.ui.useSlider) }; main.add(h);
  } else {
    const face = ink(new THREE.CylinderGeometry(0.13, 0.13, 0.025, 48, 1, false, Math.PI / 2, Math.PI), 0xf3eee2, { thresh: 50 }); face.position.y = 0.0125; main.add(face);
    for (let k = 0; k <= 10; k++) { const a = Math.PI * (k / 10); main.add(polyline([V(Math.cos(a) * 0.1, 0.026, -Math.sin(a) * 0.1), V(Math.cos(a) * 0.125, 0.026, -Math.sin(a) * 0.125)])); }
    needle = ink(new THREE.BoxGeometry(0.11, 0.008, 0.008).translate(0.055, 0, 0), 0xb8342a); needle.position.y = 0.03; main.add(needle);
    face.userData = { target: 'param', tip: tipOf(sc.gauge ? sc.gauge.label : P.label, ctx.ui.useSlider) };
  }
  // thermometer gauge (chip only)
  let merc = null;
  if (sc.visual === 'chip') {
    const th = new THREE.Group(); at(th, 0.78, PY, -0.34); G.add(th); pops.push(th);
    const tb = ink(new THREE.BoxGeometry(0.07, 0.012, 0.07), 0xece5d5); tb.position.y = 0.006; th.add(tb);
    const bulb = ink(new THREE.SphereGeometry(0.028, 24, 16), 0xf3d9cf, { edges: false, hull: 0.002 }); bulb.position.y = 0.04; th.add(bulb); glow(bulb, 0.7, 0xd8342a);
    const tube = glassCyl(0.013, 0.2); tube.position.y = 0.06; th.add(tube);
    merc = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 1, 12).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xd8342a })); merc.position.y = 0.05; th.add(merc);
    for (let k = 0; k <= 6; k++) th.add(polyline([V(0.016, 0.08 + k * 0.028, 0), V(0.028, 0.08 + k * 0.028, 0)]));
    bulb.userData = { target: 'param', tip: tipOf(sc.gauge ? sc.gauge.label : '', ctx.ui.useSlider) };
    if (sc.gauge) { const gl = flatLabel(0.2, 0.035, [[String(sc.gauge.label).toUpperCase(), 22, 'mono', '#4a443b', 600]], { box: false }); gl.position.set(0.78, PY + 0.002, -0.24); G.add(gl); }
  }
  // ruler (z=0.15) with the threshold wall standing just behind it (z=0.02); readout card in front (z=0.33)
  const fx = v => 0.12 + (v - P.min) / (P.max - P.min) * 0.76, RZ = 0.15;
  const ticks = (() => { const span = P.max - P.min, mag = Math.pow(10, Math.floor(Math.log10(span / 5))); return [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => span / st <= 5); })();
  const ruler = card(0.9, 0.09, (g, cw, ch) => {
    const X = v => cw * (fx(v) - 0.05) / 0.9;
    if (sc.threshold) { const x = X(sc.threshold.value); g.fillStyle = 'rgba(184,52,42,.13)'; g.fillRect(x, 0, X(P.max) + 30 - x, ch); fitTxt(g, sc.threshold.label, x + 10, ch * 0.15, 22, 'mono', 600, X(P.max) + 20 - x, '#b8342a', 'left'); }
    g.strokeStyle = '#1f1d1a'; g.lineWidth = 3; g.beginPath(); g.moveTo(X(P.min), ch * 0.4); g.lineTo(X(P.max), ch * 0.4); g.stroke();
    let td = 0; while (td < 6 && Math.abs(ticks * 10 ** td - Math.round(ticks * 10 ** td)) > 1e-6) td++; // decimals of the tick step
    for (let v = Math.ceil(P.min / ticks - 1e-9) * ticks + 0; v <= P.max + 1e-9; v += ticks) { const x = X(v); g.beginPath(); g.moveTo(x, ch * 0.4); g.lineTo(x, ch * 0.58); g.stroke(); txt(g, ctx.fmt(Math.abs(v) < 1e-9 ? 0 : v, td), x, ch * 0.8, F(23, 'mono', 600), '#1f1d1a', 'center'); }
    if (P.unit) txt(g, P.unit, cw - 8, ch * 0.8, F(21, 'mono', 400), '#4a443b', 'right');
  }, { flat: true, noHit: true, ltr: true });
  ruler.position.set(0.5, PY + 0.002, RZ); G.add(ruler);
  const marker = ink(new THREE.ConeGeometry(0.016, 0.04, 4), INK); marker.rotation.x = Math.PI; G.add(marker);
  // threshold wall
  const bricks = [];
  if (sc.threshold) { const wall = new THREE.Group(); at(wall, fx(sc.threshold.value), PY, 0.02); G.add(wall); pops.push(wall);
    for (let r = 0; r < 4; r++) for (let c = -2; c <= 2; c++) { const b = ink(new THREE.BoxGeometry(0.03, 0.026, 0.044), 0xe8d2c4); b.position.set(0, 0.013 + r * 0.027, c * 0.045 + (r % 2 ? 0.0225 : 0));
      if (Math.abs(b.position.z) < 0.08) { wall.add(b); bricks.push(b); b.userData = { target: 'threshold', tip: tipOf(sc.threshold.label, sc.threshold.tip || ''), click: () => ctx.touch('threshold') }; } } }
  // readout
  const ro = readoutCard(0.9, 0.1, 0.33); G.add(ro); let last = '';
  function drawRo() { const key = JSON.stringify(scope); if (key === last) return; last = key;
    ro.redraw((g, cw, ch) => { boxed(g, cw, ch); const hot = outs.some(o => o.warnAbove !== undefined && safe(o.f) > o.warnAbove) || thrOn();
      fitTxt(g, `${P.label} = ${ctx.fmt(scope[P.id], 2)} ${P.unit || ''}${T && scope[T.id] === T.on ? ' · ' + T.label : ''}`, 24, 34, 26, 'mono', 600, cw * 0.42, '#1f1d1a', 'left');
      let x = cw - 24; [...outs].reverse().forEach((o, k) => { const s = `${o.label} ${ctx.fmt(safe(o.f), o.digits ?? 2)}`; const col = o.warnAbove !== undefined && safe(o.f) > o.warnAbove ? '#b8342a' : k === 0 && outs.length > 1 ? '#2f5fd0' : '#1f1d1a';
        g.font = F(25, 'mono', 600); const w = g.measureText(s).width; txt(g, s, x, 34, F(25, 'mono', 600), col, 'right'); x -= w + 26; });
      const m = msgs.find(m => safe(m.f)); if (m) fitTxt(g, m.text, 24, 78, 26, 'news', 400, cw - 48, hot ? '#b8342a' : '#3d3830', 'left'); }); }
  function setP(v) { scope[P.id] = v; ctx.touch('param'); if (thrOn()) ctx.touch('threshold'); ctx.setControl('param', { value: v }); }
  function setT(on) { if (!T) return; scope[T.id] = on ? T.on : T.off; ctx.touch('toggle'); ctx.setControl('toggle', { on, label: T.label + (on ? ' ✓' : '') }); }
  const controls = [{ id: 'param', kind: 'range', label: P.label, min: P.min, max: P.max, step: P.step, value: P.value, fmt: v => ctx.fmt(v, 2) + ' ' + (P.unit || ''), onInput: v => setP(v) }];
  if (T) controls.push({ id: 'toggle', kind: 'toggle', label: T.label, on: false, onClick: on => setT(on) });
  let pDies = null;
  return { G, pops, controls,
    update(dt, t) { const gv = safe(gaugeF), heat = clamp(gv / gaugeRef, 0, 1.3), hot = thrOn() || outs.some(o => o.warnAbove !== undefined && safe(o.f) > o.warnAbove);
      if (typeof dies === 'function') { const ds = dies(); if (ds !== pDies) { (pDies || []).forEach(d => d.visible = false); ds.forEach(d => d.visible = true); pDies = ds; } ds.forEach(d => glow(d, clamp(heat, 0, 1) * 0.85, hot ? 0xff3b22 : 0xff9a3c)); }
      if (merc) merc.scale.y = 0.03 + 0.18 * clamp(heat, 0, 1);
      if (tankLiq) { tankLiq.scale.y = Math.max(0.001, 0.214 * clamp(heat, 0, 1)); tankLiq.material.color.setHex(hot ? 0xe0442f : 0x19a6ff); }
      if (needle) needle.rotation.y = Math.PI - Math.PI * clamp(heat, 0, 1);
      marker.position.set(fx(scope[P.id]), PY + 0.04 + Math.sin(t * 4) * 0.005, RZ - 0.006);
      const wh = thrOn(); bricks.forEach((b, i) => { glow(b, wh ? 0.75 : 0, 0xe0442f); b.position.x = wh ? Math.sin(t * 40 + i) * 0.002 : 0; });
      if (pts) { pm.opacity = clamp(heat - 0.15, 0, 1) * 0.9; pm.color.setHex(hot ? 0xff3b22 : 0xff8a3d); const spread = 0.05 + unitsN() * 0.03;
        for (let i = 0; i < life.length; i++) { life[i] += dt * (0.4 + heat * 0.9); if (life[i] > 1) { life[i] = 0; pp[i * 3] = (Math.random() - .5) * spread; pp[i * 3 + 2] = (Math.random() - .5) * 0.1; } pp[i * 3 + 1] = 0.05 + life[i] * 0.22; }
        pts.geometry.attributes.position.needsUpdate = true; }
      drawRo(); },
    demo: [
      { focus: [0.42, PY + 0.08, -0.05], d: 1.0, act: async () => { setT(false); const a = scope[P.id], b = sc.threshold ? Math.min(P.max, sc.threshold.value + (P.max - P.min) * 0.06) : P.max; await tween(2.4, u => setP(+lerp(a, b, u).toFixed(4)), 'io'); }, wait: 3000 },
      ...(sc.threshold ? [{ focus: [fx(sc.threshold.value), PY + 0.05, 0.08], d: 0.65, act: () => {}, wait: 1800 }] : []),
      ...(T ? [{ focus: [0.42, PY + 0.08, -0.05], d: 1.0, act: async () => { setT(true); const a = scope[P.id], b = lerp(P.min, P.max, 0.4); await tween(1.6, u => setP(+lerp(a, b, u).toFixed(4)), 'io'); }, wait: 2800 }] : [])] };
}

/* ===================================================================== */
/* plot (standing panel, 3D ribbon curve)                                 */
/* ===================================================================== */
function plot(sc, ctx) {
  const G = new THREE.Group(), pops = [];
  const f = compile(sc.expr), P = sc.param; const scope = { x: 0, [P.id]: P.value };
  const xl = !!sc.x.log && sc.x.min > 0;
  const PWd = 0.84, PHt = 0.36, tilt = -0.38;
  const board = new THREE.Group(); at(board, 0.5, PY, -0.06); board.rotation.x = tilt; G.add(board); pops.push(board);
  const easel = ink(new THREE.BoxGeometry(PWd + 0.03, PHt + 0.03, 0.012).translate(0, (PHt + 0.03) / 2, -0.008), 0xe9e2d2); board.add(easel);
  const u2x = u => xl ? Math.pow(10, lerp(Math.log10(sc.x.min), Math.log10(sc.x.max), u)) : lerp(sc.x.min, sc.x.max, u);
  const x2u = x => xl ? (Math.log10(x) - Math.log10(sc.x.min)) / (Math.log10(sc.x.max) - Math.log10(sc.x.min)) : (x - sc.x.min) / (sc.x.max - sc.x.min);
  const PAD = { l: 0.1, r: 0.03, b: 0.075, t: 0.04 }; const iw = PWd - PAD.l - PAD.r, ih = PHt - PAD.b - PAD.t;
  const toLocal = (u, yv) => V(-PWd / 2 + PAD.l + u * iw, PAD.b + clamp((yv - sc.y.min) / (sc.y.max - sc.y.min), -0.02, 1.02) * ih, 0.004);
  const face = card(PWd, PHt, (g, cw, ch) => {
    g.fillStyle = '#fbf8f0'; g.fillRect(0, 0, cw, ch); g.strokeStyle = '#1f1d1a'; g.lineWidth = 4; g.strokeRect(2, 2, cw - 4, ch - 4);
    const X = u => (PAD.l + u * iw) / PWd * cw, Y = v => ch - (PAD.b + v * ih) / PHt * ch;
    g.strokeStyle = 'rgba(31,29,26,.15)'; g.lineWidth = 1.5;
    for (let k = 0; k <= 5; k++) { g.beginPath(); g.moveTo(X(0), Y(k / 5)); g.lineTo(X(1), Y(k / 5)); g.stroke(); txt(g, ctx.fmt(lerp(sc.y.min, sc.y.max, k / 5), 2), X(0) - 10, Y(k / 5), F(24, 'mono'), '#4a443b', 'right'); }
    for (let k = 0; k <= 6; k++) { g.beginPath(); g.moveTo(X(k / 6), Y(0)); g.lineTo(X(k / 6), Y(1)); g.stroke(); txt(g, ctx.fmt(u2x(k / 6), 1), X(k / 6), Y(0) + 26, F(24, 'mono'), '#4a443b', 'center'); }
    g.strokeStyle = '#1f1d1a'; g.lineWidth = 3; g.beginPath(); g.moveTo(X(0), Y(1)); g.lineTo(X(0), Y(0)); g.lineTo(X(1), Y(0)); g.stroke();
    txt(g, sc.x.label || 'x', X(1), Y(0) - 20, F(26, 'mono', 600), '#1f1d1a', 'right'); txt(g, sc.y.label || 'y', X(0) + 14, Y(1) + 10, F(26, 'mono', 600), '#1f1d1a', 'left');
    (sc.marks || []).forEach(m => { const u = x2u(m.x); if (u < 0 || u > 1) return; g.setLineDash([8, 6]); g.strokeStyle = '#b8342a'; g.beginPath(); g.moveTo(X(u), Y(0)); g.lineTo(X(u), Y(1)); g.stroke(); g.setLineDash([]); txt(g, m.label || '', X(u) + 8, Y(0.92), F(24, 'mono', 600), '#b8342a', 'left'); });
  }, { ppu: 1700, ltr: true });
  face.position.set(0, PHt / 2, 0.0005); board.add(face); face.userData = { target: 'curve', tip: tipOf(sc.y.label || 'y', ctx.ui.touchCurve), click: e => pick(e) };
  let tube = null;
  function build() { const pts = []; for (let k = 0; k <= 120; k++) { const u = k / 120; scope.x = u2x(u); let yv; try { yv = f(scope); } catch { yv = NaN; } if (Number.isFinite(yv)) pts.push(toLocal(u, yv)); }
    if (tube) { board.remove(tube); tube.geometry.dispose(); } if (pts.length < 2) return;
    tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.0055, 8), inkMat(0xf3eee2)); glow(tube, 0.85, 0x2f7bff); tube.castShadow = true; board.add(tube);
    tube.userData = { target: 'curve', tip: tipOf(sc.y.label || 'y', ctx.ui.touchCurve), click: e => pick(e) }; }
  build();
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xb8342a })); dot.visible = false; board.add(dot);
  const ro = readoutCard(0.82, 0.1, 0.3); G.add(ro);
  let picked = null;
  const drawRo = () => ro.redraw((g, cw, ch) => { boxed(g, cw, ch); fitTxt(g, `${P.label} = ${ctx.fmt(scope[P.id], 3)}`, 24, 34, 26, 'mono', 600, cw * 0.5, '#1f1d1a', 'left');
    if (picked !== null) { const s = { ...scope, x: picked }; let yv = NaN; try { yv = f(s); } catch {} fitTxt(g, `${sc.x.label || 'x'} = ${ctx.fmt(picked, 2)}  →  ${sc.y.label || 'y'} = ${ctx.fmt(yv, 3)}`, 24, 76, 28, 'serif', 400, cw - 48, '#2f5fd0', 'left'); }
    else fitTxt(g, ctx.ui.touchCurve, 24, 76, 25, 'news', 400, cw - 48, '#3d3830', 'left'); });
  function placeDot() { if (picked === null) return; const s = { ...scope, x: picked }; let yv = NaN; try { yv = f(s); } catch {} if (!Number.isFinite(yv)) { dot.visible = false; return; } dot.position.copy(toLocal(x2u(picked), yv)); dot.position.z = 0.01; dot.visible = true; }
  function pick(hit) { ctx.touch('curve'); if (hit && hit.point) { const p = board.worldToLocal(hit.point.clone()); const u = clamp((p.x + PWd / 2 - PAD.l) / iw, 0, 1); picked = u2x(u); } else picked = u2x(0.5); placeDot(); drawRo(); }
  drawRo();
  function setP(v) { scope[P.id] = v; build(); placeDot(); drawRo(); ctx.touch('param'); ctx.setControl('param', { value: v }); }
  return { G, pops, update() {},
    controls: [{ id: 'param', kind: 'range', label: P.label, min: P.min, max: P.max, step: P.step, value: P.value, fmt: v => ctx.fmt(v, 3), onInput: setP }],
    demo: [{ focus: [0.5, PY + 0.15, -0.1], d: 1.0, act: async () => { const a = scope[P.id]; await tween(1.6, u => setP(lerp(a, P.max, u)), 'io'); await tween(1.6, u => setP(lerp(P.max, P.min, u)), 'io'); }, wait: 3600 },
           { focus: [0.5, PY + 0.15, -0.1], d: 1.0, act: async () => { await tween(1.0, u => setP(lerp(P.min, P.value, u)), 'io'); pick(null); }, wait: 2000 }] };
}

/* ===================================================================== */
/* flow (pipeline)                                                        */
/* ===================================================================== */
function flow(sc, ctx) {
  const G = new THREE.Group(), pops = [], n = sc.steps.length;
  const two = n > 4, perRow = two ? Math.ceil(n / 2) : n;
  const pos = sc.steps.map((_, i) => { const row = two && i >= perRow ? 1 : 0, k = row ? n - 1 - i : i, m = row ? n - perRow : perRow;
    const kk = row ? (perRow - 1) - (i - perRow) - (perRow - m) / 1 : k; const col = row ? (perRow - 1) - (i - perRow) : i;
    return [lerp(0.16, 0.84, perRow === 1 ? 0.5 : col / (perRow - 1)), two ? (row ? 0.0 : -0.3) : -0.18]; });
  const blocks = sc.steps.map((s, i) => {
    const b = ink(new THREE.BoxGeometry(0.15, 0.07, 0.11), 0xf1ebdd); at(b, pos[i][0], PY + 0.035, pos[i][1]); G.add(b); pops.push(b);
    const top = card(0.14, 0.1, (g, cw, ch) => { txt(g, String(i + 1), cw / 2, ch * 0.25, F(30, 'serif'), '#7a7266', 'center'); fitTxt(g, String(s.label).toUpperCase(), cw / 2, ch * 0.66, 30, 'mono', 600, cw - 16, '#1f1d1a', 'center'); }, { flat: true });
    top.position.set(0, 0.0355, 0); b.add(top);
    b.userData = { target: s.id, tip: tipOf(s.label, s.tip), click: () => focus(i) }; top.userData = b.userData; return b; });
  const path = [];
  for (let i = 0; i < n - 1; i++) { const a = V(pos[i][0], PY + 0.012, pos[i][1]), b = V(pos[i + 1][0], PY + 0.012, pos[i + 1][1]); const dir = b.clone().sub(a).normalize();
    const s = a.clone().add(dir.clone().multiplyScalar(dir.z ? 0.06 : 0.08)), e = b.clone().sub(dir.clone().multiplyScalar(dir.z ? 0.07 : 0.09));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(s, e), 4, 0.005, 8), inkMat(0x3b3833)); tube.raycast = () => {}; G.add(tube);
    const cone = ink(new THREE.ConeGeometry(0.013, 0.03, 12), 0x3b3833, { edges: false }); cone.position.copy(e); cone.quaternion.setFromUnitVectors(V(0, 1, 0), dir); G.add(cone); }
  sc.steps.forEach((_, i) => path.push(V(pos[i][0], PY + 0.1, pos[i][1])));
  if (sc.loop && n > 2) path.push(path[0].clone());
  const token = new THREE.Mesh(new THREE.SphereGeometry(0.02, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffb23c })); token.visible = false; G.add(token);
  const ro = readoutCard(0.82, 0.12, 0.3); G.add(ro);
  const drawRo = i => ro.redraw((g, cw, ch) => { boxed(g, cw, ch); if (i < 0) { txt(g, (sc.token ? String(sc.token).toUpperCase() + ' · ' : '') + ctx.ui.pipeline, 24, 36, F(24, 'mono', 600)); wrapTxt(g, ctx.ui.flowHelp, 24, 82, cw - 48, 30, F(26, 'news'), '#3d3830', 2); return; }
    const s = sc.steps[i]; fitTxt(g, `${i + 1}/${n} · ${String(s.label).toUpperCase()}`, 24, 34, 26, 'mono', 600, cw - 48, '#1f1d1a', 'left'); wrapTxt(g, s.tip || '', 24, 80, cw - 48, 30, F(26, 'news'), '#3d3830', 2); });
  drawRo(-1);
  function focus(i) { blocks.forEach((b, k) => glow(b, k === i ? 0.45 : 0, 0xffc46b)); drawRo(i); ctx.touch(sc.steps[i].id); }
  let playing = false;
  async function play() { if (playing) return; playing = true; ctx.touch('play'); token.visible = true;
    for (let i = 0; i < path.length; i++) { const target = path[i].clone(), from = token.position.clone(); if (i === 0) token.position.copy(target);
      else await tween(0.7, u => { token.position.lerpVectors(from, target, u); token.position.y = target.y + Math.sin(u * Math.PI) * 0.06; }, 'io');
      focus(i % n); await wait(650); }
    token.visible = false; playing = false; }
  return { G, pops, update(dt, t) { if (token.visible) token.scale.setScalar(1 + 0.15 * Math.sin(t * 10)); },
    controls: [{ id: 'play', kind: 'button', label: '▶ ' + ctx.ui.runFlow, onClick: play }],
    demo: [{ focus: [0.5, PY + 0.05, two ? -0.15 : -0.18], d: 1.1, act: play, wait: n * 1400 + 400 }] };
}

/* ===================================================================== */
/* stack (levels)                                                          */
/* ===================================================================== */
function levelsModel(levels, ctx, opt) {
  const grp = new THREE.Group(), slabs = {}, n = levels.length; const { x = 0.5, w = 0.6, zFront = 0.02, zBack = -0.4, dy = 0.08 } = opt;
  levels.forEach((L, i) => { const z = n === 1 ? zFront : lerp(zFront, zBack, i / (n - 1)), y = 0.03 + i * dy, d = Math.min(0.17, (zFront - zBack) / n + 0.02);
    const s = ink(new THREE.BoxGeometry(w, 0.012, d), 0xefe8d8); at(s, x, PY + y, z); grp.add(s); slabs[L.id] = s;
    for (const dx of [-w / 2 + 0.02, w / 2 - 0.02]) for (const dz of [-d / 2 + 0.015, d / 2 - 0.015]) { const p = ink(new THREE.CylinderGeometry(0.005, 0.005, y, 8), 0xe1d9c7, { edges: false, hull: 0.0015 }); at(p, x + dx, PY + y / 2, z + dz); grp.add(p); }
    const lab = card(w - 0.02, d - 0.02, (g, cw, ch) => { fitTxt(g, String(L.title).toUpperCase(), cw / 2, ch * 0.36, 34, 'mono', 600, cw - 20, '#1f1d1a', 'center'); if (L.sub) fitTxt(g, L.sub, cw / 2, ch * 0.72, 40, 'serif', 400, cw - 20, '#4a443b', 'center'); }, { flat: true });
    lab.position.set(0, 0.0065, 0); s.add(lab);
    s.userData = { target: L.id, tip: tipOf(L.title + (L.sub ? ' · ' + L.sub : ''), L.tip), click: () => opt.onClick(L, s) }; lab.userData = s.userData; });
  return { grp, slabs };
}
function stack(sc, ctx) {
  const G = new THREE.Group(), pops = [];
  const ro = readoutCard(0.82, 0.12, 0.36); G.add(ro);
  const drawRo = L => ro.redraw((g, cw, ch) => { boxed(g, cw, ch); if (!L) { txt(g, ctx.ui.levels, 24, 36, F(24, 'mono', 600)); wrapTxt(g, ctx.ui.touch, 24, 82, cw - 48, 30, F(26, 'news'), '#3d3830', 2); return; }
    fitTxt(g, String(L.title).toUpperCase() + (L.sub ? ' · ' + L.sub : ''), 24, 34, 26, 'mono', 600, cw - 48, '#1f1d1a', 'left'); wrapTxt(g, L.tip || '', 24, 80, cw - 48, 30, F(26, 'news'), '#3d3830', 2); });
  drawRo(null);
  const M = levelsModel(sc.levels, ctx, { x: 0.5, w: 0.6, zFront: 0.1, zBack: -0.26, dy: 0.06, onClick: (L, s) => { Object.values(M.slabs).forEach(x => glow(x, 0)); glow(s, 0.35, 0xffd27a); drawRo(L); ctx.touch(L.id); } });
  G.add(M.grp); pops.push(M.grp);
  return { G, pops, update() {}, demo: sc.levels.map(L => ({ focus: [0.5, PY + 0.1, M.slabs[L.id].position.z], d: 0.8, act: () => M.slabs[L.id].userData.click(), wait: 1800 })) };
}

/* ===================================================================== */
/* scheduler                                                               */
/* ===================================================================== */
function scheduler(sc, ctx) {
  const G = new THREE.Group(), pops = [], NT = sc.tasks.length;
  const hasLv = sc.levels && sc.levels.length; const cx = hasLv ? 0.27 : 0.45;
  let M = null;
  if (hasLv) { M = levelsModel(sc.levels, ctx, { x: 0.76, w: 0.32, zFront: 0.02, zBack: -0.3, dy: 0.06, onClick: (L, s) => { Object.values(M.slabs).forEach(x => glow(x, 0)); glow(s, 0.35, 0xffd27a); ctx.touch(L.id); if (sc.ht && /hw|hard|mat|ht/i.test(L.id)) setHT(!ht); } }); G.add(M.grp); pops.push(M.grp); }
  const coreG = new THREE.Group(); at(coreG, cx, PY, -0.18); G.add(coreG); pops.push(coreG);
  const core = ink(new THREE.BoxGeometry(0.13, 0.07, 0.13), 0xf1ebde); core.position.y = 0.035; coreG.add(core);
  const coreLab = card(0.12, 0.05, () => {}, { flat: true }); coreLab.position.set(0, 0.0705, 0.035); coreG.add(coreLab);
  const drawCore = () => coreLab.redraw((g, cw, ch) => fitTxt(g, ht ? ctx.ui.core2 : ctx.ui.core1, cw / 2, ch / 2, 34, 'mono', 600, cw - 8, '#1f1d1a', 'center'));
  core.userData = { target: 'core', tip: tipOf(ctx.ui.core1, ctx.ui.coreTip), click: () => { ctx.touch('core'); running = !running; } }; coreLab.userData = core.userData;
  const cols = PALETTE.slice(0, NT);
  const tokens = sc.tasks.map((name, i) => { const m = ink(new THREE.CylinderGeometry(0.026, 0.026, 0.035, 28), 0xf4efe3, { thresh: 40 }); glow(m, 0.8, cols[i]);
    const a = Math.PI * 0.7 + i / Math.max(NT - 1, 1) * Math.PI * 0.6; const home = V(cx + Math.cos(a) * 0.2, PY + 0.0175, -0.18 - Math.sin(a) * 0.2 + 0.06); m.position.copy(home); G.add(m); pops.push(m);
    m.userData = { tip: tipOf(name, ctx.ui.waiting) }; return { m, home, i }; });
  const gantt = card(0.86, 0.085 + NT * 0.045, () => {}, { flat: true, noHit: true, ltr: true }); gantt.position.set(0.5, PY + 0.002, 0.3 + NT * 0.01); G.add(gantt);
  let running = false, ht = false, q = sc.quantum.value, simT = 0, sliceEnd = 0, rr = 0, slots = [null, null]; const segs = [];
  drawCore();
  function setHT(v) { ht = v; ctx.setControl('ht', { on: v, label: (sc.ht ? sc.ht.label : 'HT') + (v ? ' ✓' : '') }); drawCore(); sliceEnd = simT; }
  function setQ(v) { q = v; ctx.setControl('q', { value: v }); }
  function schedule() { const k = ht ? 2 : 1, next = []; for (let j = 0; j < k; j++) { next.push(rr % NT); rr++; } slots = [next[0], k > 1 ? next[1] : null];
    segs.forEach(s => { if (s.end === null) s.end = simT; }); slots.forEach(id => { if (id !== null) segs.push({ id, start: simT, end: null }); }); sliceEnd = simT + q; }
  const WIN = 8;
  function drawGantt() { gantt.redraw((g, cw, ch) => { boxed(g, cw, ch); const x0 = 170, x1 = cw - 24, t0 = simT - WIN, row = 48;
    txt(g, `${ctx.ui.gantt} · ${sc.quantum.label} ${ctx.fmt(q, 2)} s${ht ? ' · ' + (sc.ht ? sc.ht.label : '') : ''}`, 24, 30, F(23, 'mono', 600));
    sc.tasks.forEach((nm, i) => { const y = 60 + i * row; fitTxt(g, nm, 24, y + 17, 25, 'mono', 600, 140, hexCss(cols[i]), 'left'); g.strokeStyle = 'rgba(31,29,26,.25)'; g.lineWidth = 1.5; g.strokeRect(x0, y, x1 - x0, 34); });
    segs.forEach(s => { const a = Math.max(s.start, t0), b = s.end === null ? simT : s.end; if (b < t0) return; g.fillStyle = hexCss(cols[s.id]); g.fillRect(x0 + (a - t0) / WIN * (x1 - x0), 60 + s.id * row + 3, Math.max(1, (b - a) / WIN * (x1 - x0)), 28); });
    fitTxt(g, running ? (q < 0.2 ? ctx.ui.simul : ctx.ui.oneAtTime) : ctx.ui.startCore, 24, ch - 26, 25, 'news', 400, cw - 48, '#3d3830', 'left'); }); }
  drawGantt();
  const controls = [{ id: 'q', kind: 'range', label: sc.quantum.label, min: sc.quantum.min, max: sc.quantum.max, step: 0.05, value: q, fmt: v => ctx.fmt(v, 2) + ' s', onInput: setQ }];
  if (sc.ht) controls.push({ id: 'ht', kind: 'toggle', label: sc.ht.label, on: false, onClick: on => { setHT(on); const hw = (sc.levels || []).find(l => /hw|hard|mat|ht/i.test(l.id)); if (hw) ctx.touch(hw.id); } });
  return { G, pops, controls,
    update(dt, t) { if (running) { simT += dt; if (simT >= sliceEnd) schedule(); while (segs.length > 400) segs.shift(); drawGantt(); }
      tokens.forEach(T => { const k = running ? slots.indexOf(T.i) : -1; const target = k >= 0 ? V(cx + (ht ? (k ? 0.035 : -0.035) : 0), PY + 0.088, -0.18) : T.home; T.m.position.lerp(target, 1 - Math.exp(-dt * 18)); });
      glow(core, running ? 0.12 + 0.08 * Math.sin(t * 8) : 0, 0xffe1a8); },
    demo: [{ focus: [0.42, PY + 0.05, 0.0], d: 1.05, act: () => { running = true; ctx.touch('core'); }, wait: 3200 },
           { focus: [0.42, PY + 0.05, 0.1], d: 1.05, act: () => tween(1.5, u => setQ(+lerp(sc.quantum.value, Math.max(sc.quantum.min, 0.08), u).toFixed(2)), 'io'), wait: 2600 },
           ...(hasLv ? sc.levels.map(L => ({ focus: [0.75, PY + 0.1, M.slabs[L.id].position.z], d: 0.75, act: () => M.slabs[L.id].userData.click(), wait: 1500 })) : [])] };
}

export const BLOCKS = { network, showcase, race, bars, model, plot, flow, stack, scheduler };
