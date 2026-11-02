// Example custom scene (agent mode). Uses only the kit API passed in as `kit`.
export default function pendulum(kit, scene, ctx) {
  const { THREE, PY, ink, glow, at, polyline, V, card, boxed, fitTxt, hitBox, lerp } = kit;
  const G = new THREE.Group(), pops = [];
  let L = 0.25, on = false, t0 = 0, theta = 0.35;

  // gallows: base, post, arm
  const frame = new THREE.Group(); at(frame, 0.5, PY, -0.2); G.add(frame); pops.push(frame);
  frame.add(at(ink(new THREE.BoxGeometry(0.34, 0.016, 0.14), 0xece4d2), 0, 0.008, 0));
  frame.add(at(ink(new THREE.BoxGeometry(0.016, 0.36, 0.016), 0xe6dece), -0.15, 0.18, 0));
  frame.add(at(ink(new THREE.BoxGeometry(0.2, 0.016, 0.016), 0xe6dece), -0.06, 0.36, 0));

  // the swinging part hangs from the pivot
  const pivot = new THREE.Group(); pivot.position.set(0.02, 0.352, 0); frame.add(pivot);
  let string = null;
  const bob = ink(new THREE.SphereGeometry(0.028, 28, 18), 0xf3eee2, { edges: false, hull: 0.002 });
  pivot.add(bob);
  const hit = hitBox(0.08, 0.08, 0.08, 0); bob.add(hit);
  hit.userData = bob.userData = { target: 'bob', tip: ['Weight', 'Touch to start or stop the swing.'], click: () => { on = !on; t0 = performance.now() / 1000; ctx.touch('bob'); } };
  function setLength(v) {
    L = v; if (string) pivot.remove(string);
    string = polyline([V(0, 0, 0), V(0, -L, 0)]); pivot.add(string); bob.position.y = -L; draw();
  }

  const period = () => 2 * Math.PI * Math.sqrt((L * 4) / 9.81); // 0.25 model units ≈ 1 m
  const ro = card(0.8, 0.1, () => {}, { flat: true, noHit: true }); ro.position.set(0.5, PY + 0.002, 0.3); G.add(ro);
  function draw() { ro.redraw((g, cw, ch) => { boxed(g, cw, ch);
    fitTxt(g, `L = ${ctx.fmt(L * 4, 2)} m`, 24, ch / 2, 34, 'mono', 600, cw * 0.4, '#1f1d1a', 'left');
    fitTxt(g, `T = ${ctx.fmt(period(), 2)} s`, cw - 24, ch / 2, 40, 'serif', 400, cw * 0.45, '#2f5fd0', 'right'); }); }
  setLength(L);

  return {
    G, pops, targets: ['bob', 'length'],
    controls: [{ id: 'length', kind: 'range', label: 'Length', min: 0.1, max: 0.3, step: 0.005, value: L, fmt: v => ctx.fmt(v * 4, 2) + ' m',
      onInput: v => { setLength(v); ctx.touch('length'); } }],
    update(dt) {
      const t = performance.now() / 1000 - t0;
      theta = on ? 0.35 * Math.cos(2 * Math.PI * t / period()) : lerp(theta, 0, 1 - Math.exp(-dt * 3));
      pivot.rotation.z = theta; glow(bob, on ? 0.5 : 0, 0xffb23c);
    },
    demo: [
      { focus: [0.5, PY + 0.15, -0.2], d: 0.9, act: () => { if (!on) hit.userData.click(); }, wait: 3000 },
      { focus: [0.5, PY + 0.15, -0.2], d: 0.9, act: () => kit.tween(1.5, u => { setLength(lerp(0.12, 0.3, u)); ctx.setControl('length', { value: L }); }), wait: 3500 },
    ],
  };
}
