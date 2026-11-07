// Fixes in code what a model got slightly wrong, before any repair call: free, deterministic, and it only ever makes an answer
// more valid. Also the last rung of the repair ladder: a deterministic spread built from the page text, so a book always completes.
//   fixSpread(answer, plan)  → one spread: unknown keys dropped, numbers coerced and clamped, block name snapped, long text trimmed
//   fixOutline(answer, ns)   → { outline, errors }: the plan of the book, pages limited to the ones sent (ns)
//   fallbackSpread(...)      → a valid spread that keeps every valid part of the model's last attempt and replaces the rest
import { API_BLOCKS, SCENES, SPREADS, LIMITS, shorten, validateSpread } from './validate.js';

export { API_BLOCKS };

const dist = (a, b) => { // Levenshtein
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length];
};
/** "Flow", "bar", "schedular" → the closest API block. A name far from all of them ("timeline") → `fallback` when given. */
export function nearestBlock(name, fallback) {
  const n = String(name ?? '').trim().toLowerCase(), best = API_BLOCKS.reduce((a, b) => dist(n, b) < dist(n, a) ? b : a);
  return API_BLOCKS.includes(n) || !fallback || dist(n, best) <= Math.max(2, Math.floor(n.length / 3)) ? best : fallback;
}

const S = 'str', N = 'num', B = 'bool';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const toNum = v => { if (typeof v !== 'string' || !v.trim()) return v; const n = Number(v.replace(/\s/g, '')); return Number.isFinite(n) ? n : v; }; // "2 300" → 2300; "0,5" stays (comma is ambiguous)
/** v reshaped to `sh` (validate.js SCENES / SPREADS): unknown keys and nulls (strict structured output's "not given") dropped,
 *  numbers and booleans written as strings coerced. A value of the wrong kind is kept as it is, so the validator still names the problem. */
function shape(v, sh) {
  if (sh === S) return typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
  if (sh === N || sh === 'int') return toNum(v);
  if (sh === B) return v === 'true' ? true : v === 'false' ? false : v;
  if (sh === 'pairs') { // [[term, definition]]; also accepts {term: def}, [{term, def}] and ["term: def"]
    const list = isObj(v) ? Object.entries(v) : v;
    const split = p => { const m = /^(.*?)\s*[:–—]\s*(.*)$/s.exec(p); return m ? [m[1], m[2]] : p; };
    return Array.isArray(list) ? list.map(p => isObj(p) ? Object.values(p).slice(0, 2) : typeof p === 'string' ? split(p) : p) : v;
  }
  if (typeof sh === 'string') return v; // one of 'a|b'
  if (Array.isArray(sh)) return Array.isArray(v) ? v.map(x => shape(x, sh[0])) : v;
  if (!isObj(v)) return v;
  const out = {}; for (const k of Object.keys(v)) { const t = Object.hasOwn(sh, k) ? sh[k] : sh[k + '?']; if (t !== undefined && v[k] !== null) out[k] = shape(v[k], t); }
  return out;
}
/** {min, max, value, step}: bounds in order, value inside them, a step that fits. */
function range(r, withValue = true) {
  if (!isObj(r) || typeof r.min !== 'number' || typeof r.max !== 'number') return;
  if (r.min > r.max) [r.min, r.max] = [r.max, r.min];
  if (withValue && typeof r.value === 'number') r.value = Math.min(r.max, Math.max(r.min, r.value));
  if ('step' in r && !(r.step > 0 && r.step <= r.max - r.min)) delete r.step;
}
const trim = (o, k, max) => { if (typeof o[k] === 'string' && o[k].length > max) o[k] = shorten(o[k], max); };

/** One writer answer → the spread it meant. `plan` is its outline entry ({ kind?, block }): the outline decides the block and
 *  whether this is the cover. Never throws; what it cannot fix is left for the validator to report. */
export function fixSpread(answer, plan = {}) {
  let s = answer;
  if (isObj(s) && !s.scene && Array.isArray(s.spreads) && s.spreads.length === 1) s = s.spreads[0]; // a whole book with one spread
  else if (isObj(s) && isObj(s.spread)) s = s.spread;
  if (!isObj(s)) return s;
  const scene = s.scene;
  if (typeof s.formula === 'string') s = { ...s, formula: { eq: s.formula } };
  s = shape(s, SPREADS[plan.kind === 'cover' ? 'cover' : 'lesson']);
  if (plan.kind === 'cover') s.kind = 'cover'; else delete s.kind;
  const t = isObj(scene) && typeof scene.type === 'string' && scene.type !== 'custom' ? nearestBlock(scene.type, plan.block) : plan.block;
  s.scene = t && SCENES[t] ? { type: t, ...shape(isObj(scene) ? scene : {}, SCENES[t]) } : scene;
  const sc = s.scene, q = s.quiz;
  if (isObj(q) && typeof q.a === 'string' && Array.isArray(q.opts)) { // "B", or the answer itself
    const i = q.opts.indexOf(q.a); q.a = i >= 0 ? i : /^[A-D]$/i.test(q.a.trim()) ? q.a.trim().toUpperCase().charCodeAt(0) - 65 : q.a;
  }
  if (isObj(q) && typeof q.a === 'number' && !Number.isInteger(q.a)) q.a = Math.round(q.a);
  for (const k of ['title', 'concept', 'fig', 'why']) trim(s, k, LIMITS[k]);
  if (isObj(s.formula) && !/</.test(s.formula.eq || '')) trim(s.formula, 'eq', LIMITS.eq); // never cut inside a <sub> tag
  if (isObj(sc)) {
    if (sc.type === 'model' || sc.type === 'plot') range(sc.param);
    if (sc.type === 'plot') { range(sc.x, false); range(sc.y, false); if (isObj(sc.x) && sc.x.log && !(sc.x.min > 0)) delete sc.x.log; }
    if (sc.type === 'scheduler') range(sc.quantum);
  }
  return s;
}

/** The planner's answer → { outline: { title, subtitle?, lang?, coverColor?, ui?, spreads: [{ kind?, pages, block, intent }] }, errors }.
 *  `ns`: the page numbers that were sent; pages outside them are dropped, and so is a spread left with none. */
export function fixOutline(answer, ns) {
  const o = Array.isArray(answer) ? { spreads: answer } : isObj(answer) ? answer : {}, errors = [], have = new Set(ns);
  const out = { title: typeof o.title === 'string' ? shorten(o.title.trim(), LIMITS.title) : '' };
  for (const k of ['subtitle', 'lang', 'coverColor']) if (typeof o[k] === 'string' && o[k].trim()) out[k] = o[k].trim();
  if (isObj(o.ui)) out.ui = o.ui;
  if (!out.title) errors.push('title: missing');
  const pagesOf = p => (Array.isArray(p) ? p : [p]).flatMap(x => { const m = /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(String(x));
    if (m) { const r = []; for (let n = +m[1]; n <= +m[2] && r.length < 100; n++) r.push(n); return r; } return [Math.round(toNum(x))]; });
  out.spreads = (Array.isArray(o.spreads) ? o.spreads : []).filter(isObj).map((s, i) => {
    const pages = [...new Set(pagesOf(s.pages ?? s.page ?? []))].filter(n => have.has(n)).sort((a, b) => a - b);
    const intent = String(s.intent ?? s.title ?? '').trim(), block = typeof s.block === 'string' ? nearestBlock(s.block) : typeof s.scene === 'string' ? nearestBlock(s.scene) : '';
    return { ...(i === 0 && s.kind === 'cover' ? { kind: 'cover' } : {}), pages, block, intent };
  }).filter(s => s.pages.length);
  if (!out.spreads.length) errors.push(`spreads: needs at least one spread whose "pages" are among ${ns[0]}–${ns.at(-1)}`);
  out.spreads.forEach((s, i) => { if (!s.block) errors.push(`spreads[${i}].block: missing (one of ${API_BLOCKS.join(', ')})`); if (!s.intent) errors.push(`spreads[${i}].intent: missing`); });
  return { outline: out, errors };
}

/** Lines of the page text worth showing: bullet markers stripped, scraps (page numbers, stray symbols) skipped. */
const bullets = text => String(text || '').split(/\n+/).map(l => l.replace(/^\s*(?:[•▪◦‣·*]\s*|[-–—]\s+|\d+[.)]\s+)/, '').trim()).filter(l => l.length >= 3 && /\p{L}/u.test(l));

/** The last rung of the repair ladder: outline.spreads[i] written by code from its pages' text. Every part of the model's
 *  `last` attempt that validates on its own is kept; `fallback` lists the parts code wrote, for the studio to flag. Always valid.
 *  ponytail: the canned texts are English whatever the book's language; the studio flags the spread for regeneration anyway. */
export function fallbackSpread(outline, i, text, last) {
  const plan = outline.spreads[i], lines = bullets(text), cut = (t, n) => shorten(String(t || '').replace(/\s+/g, ' '), n);
  const pages = plan.pages.length > 1 ? `${plan.pages[0]}–${plan.pages.at(-1)}` : `${plan.pages[0]}`;
  const levels = (lines.length >= 2 ? lines : [...lines, plan.intent, `p. ${pages}`]).slice(0, 4).map(l => ({ title: cut(l, 18), tip: cut(l, 140) }));
  const base = { slides: `p. ${pages}`, title: cut(lines[0] || plan.intent, 60), concept: cut(lines.slice(1, 4).join(' ') || plan.intent, 260),
    fig: 'Touch each level to read it.', scene: { type: 'stack', levels } };
  let code;
  if (plan.kind === 'cover') code = { kind: 'cover', ...base, plan: outline.spreads.slice(1).map(s => cut(s.intent, 90)).slice(0, 9) };
  else {
    const defs = lines.map(l => /^(.{2,24}?)\s*[:–—]\s+(.{3,})$/.exec(l)).filter(Boolean).map(m => [cut(m[1], 16), cut(m[2], 70)]);
    const others = outline.spreads.filter((s, k) => k !== i && s.kind !== 'cover').slice(0, 2).map(s => cut(s.intent, 55));
    code = { ...base, formula: { label: 'KEY', eq: cut(plan.intent, 70) },
      vocab: (defs.length ? defs : lines.slice(0, 3).map(l => [cut(l.split(/\s+/).slice(0, 2).join(' '), 16), cut(l, 70)])).slice(0, 4),
      quiz: { q: 'Which idea is this spread about?', opts: [cut(plan.intent, 55), ...(others.length ? others : ['Something else'])], a: 0 }, why: cut(plan.intent, 330) };
    if (!code.vocab.length) code.vocab = [[cut(plan.block, 16), cut(plan.intent, 70)]];
  }
  const fixed = isObj(last) ? fixSpread(last, plan) : null, parts = Object.keys(code).filter(k => k !== 'kind'), s = { ...code };
  if (isObj(fixed)) for (const k of parts) if (fixed[k] !== undefined) s[k] = fixed[k];
  for (let round = 0; round < 3; round++) { // put back code's version of every part the validator names
    const v = validateSpread(s); if (v.ok) return { ...s, fallback: parts.filter(k => s[k] === code[k]) };
    for (const e of v.errors) { const k = /^spread\.(\w+)/.exec(e)?.[1]; if (k in code) s[k] = code[k]; }
  }
  return { ...code, fallback: parts };
}
