// Validates and normalizes a book.json. Used by the server, the CLI checker and the viewer.
import { compile } from './expr.js';

export const BLOCKS = ['race', 'bars', 'model', 'plot', 'flow', 'stack', 'scheduler', 'network', 'showcase', 'custom'];
export const MODELS = ['globe', 'head', 'layers', 'server', 'chip', 'molecule', 'dna', 'gear', 'flask', 'cube', 'pyramid', 'sphere', 'cylinder'];
export const API_BLOCKS = BLOCKS.filter(b => b !== 'custom');

/* What a spread and each scene block may hold, from prompts/blocks/*.md and what viewer/ reads. lib/autofix.js drops anything else,
 * validateBook() takes its list sizes from here, toSchema() turns it into the JSON schema structured output enforces.
 *   'str' 'num' 'int' 'bool' · 'a|b' one of these strings · 'pairs' [[term, definition]] · [shape, min, max] a list ·
 *   { key: shape, 'key?': shape } an object and its optional keys.
 * Item ids, `short` and `howto` are derived or rare: kept when written, never asked for (left out of the schema). */
const S = 'str', N = 'num', B = 'bool';
const LEVEL = { 'id?': S, title: S, 'sub?': S, 'tip?': S };
export const SCENES = {
  race: { 'a?': { label: S }, 'b?': { label: S }, 'unit?': S, items: [{ 'id?': S, label: S, 'tip?': S, a: N, b: N, 'aText?': S, 'bText?': S, 'short?': S }, 1, 4] },
  bars: { items: [{ label: S, x: N, value: N, 'valueText?': S, 'tip?': S }, 2, 7], 'growth?': { label: S, factor: N, every: N }, 'unitLabel?': S, 'log?': B },
  model: { 'visual?': 'chip|tank|dial', param: { id: S, label: S, min: N, max: N, 'step?': N, 'value?': N, 'unit?': S }, 'toggle?': { id: S, label: S, 'off?': N, 'on?': N },
    outputs: [{ label: S, expr: S, 'digits?': 'int', 'warnAbove?': N }, 1, 3], 'gauge?': { label: S, expr: S, max: N },
    'threshold?': { value: N, label: S, 'when?': S, 'tip?': S }, 'messages?': [{ 'when?': S, text: S }, 0] },
  plot: { expr: S, x: { label: S, min: N, max: N, 'log?': B }, y: { label: S, min: N, max: N }, param: { id: S, label: S, min: N, max: N, 'step?': N, 'value?': N },
    'marks?': [{ x: N, label: S }, 0] },
  flow: { 'token?': S, 'loop?': B, steps: [{ 'id?': S, label: S, 'tip?': S }, 2, 6] },
  stack: { levels: [LEVEL, 2, 4] },
  scheduler: { tasks: [S, 2, 4], 'quantum?': { label: S, min: N, max: N, value: N }, 'ht?': { label: S }, 'levels?': [LEVEL, 0, 3] },
  network: { 'hub?': { label: S, 'tip?': S }, nodes: [{ label: S, 'tip?': S }, 2, 6] },
  showcase: { items: [{ 'id?': S, model: MODELS.join('|'), label: S, 'sub?': S, 'tip?': S, 'steps?': [{ label: S, value: S }, 1, 6] }, 1, 4] },
};
const SPREAD = { 'slides?': S, title: S, 'short?': S, concept: S, fig: S }; // `kind` and `scene` come from the outline's plan
export const SPREADS = {
  cover: { ...SPREAD, 'plan?': [S, 0, 9], 'howto?': S },
  lesson: { ...SPREAD, formula: { 'label?': S, eq: S, 'note?': S }, vocab: 'pairs', quiz: { q: S, opts: [S, 2, 4], a: 'int' }, why: S },
};
const UNASKED = new Set(['id?', 'short?', 'howto?']);

/** A shape of the table above as JSON Schema (the common subset: type, properties, required, items, min/maxItems, enum). */
export function toSchema(sh) {
  if (sh === 'pairs') return { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, minItems: 3, maxItems: 4 };
  if (typeof sh === 'string') return { str: { type: 'string' }, num: { type: 'number' }, int: { type: 'integer' }, bool: { type: 'boolean' } }[sh] ?? { type: 'string', enum: sh.split('|') };
  if (Array.isArray(sh)) return { type: 'array', items: toSchema(sh[0]), ...(sh[1] && { minItems: sh[1] }), ...(sh[2] && { maxItems: sh[2] }) };
  const keys = Object.keys(sh).filter(k => !UNASKED.has(k));
  return { type: 'object', properties: Object.fromEntries(keys.map(k => [k.replace(/\?$/, ''), toSchema(sh[k])])), required: keys.filter(k => !k.endsWith('?')), additionalProperties: false };
}
const sceneSchema = b => { const o = toSchema(SCENES[b]); return { ...o, properties: { type: { type: 'string', enum: [b] }, ...o.properties }, required: ['type', ...o.required] }; };
/** The schema of one writer answer: a spread of `block` (the cover when `cover`). Without a block, one loose schema for every writer
 *  of a book (any block; only what cover and lesson share required), for a provider that caches the schema ahead of the prompt. */
export function spreadSchema(block, cover = false) {
  const s = toSchema(block ? SPREADS[cover ? 'cover' : 'lesson'] : { ...SPREADS.cover, ...SPREADS.lesson });
  if (!block) s.required = s.required.filter(k => toSchema(SPREADS.cover).required.includes(k));
  s.properties.scene = block ? sceneSchema(block) : { anyOf: API_BLOCKS.map(sceneSchema) };
  s.required.push('scene');
  return s;
}
/** The schema of the planner's answer (prompts/core.md section 3; `ui` is left to the prompt: its keys are free). */
export const outlineSchema = () => toSchema({ title: S, 'subtitle?': S, 'lang?': S, 'coverColor?': S,
  spreads: [{ 'kind?': 'cover', pages: ['int', 1], block: API_BLOCKS.join('|'), intent: S }, 1] });

const slug = (s, i) => (String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)) || 'item' + i;
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** A title cut to whole words for the toolbar ("Architecture et calcul parallèles" → "Architecture et…"). */
export const shorten = (t, max) => { t = String(t).trim(); if (t.length <= max) return t; const cut = t.slice(0, max - 1).replace(/[\s,;:–—-]+\S*$/, ''); return (cut || t.slice(0, max - 1)) + '…'; };

/** Lengths past which a text overflows the printed page: validateBook() warns, lib/autofix.js trims. */
export const LIMITS = { title: 70, concept: 300, fig: 130, eq: 90, why: 380 };

/** Returns the interactive target ids a scene exposes (what the reader must touch to earn the stamp). Safe on a scene that
 *  failed validation (its lists missing or not lists): validateBook still calls it. */
const idsOf = a => Array.isArray(a) ? a.map(x => x?.id) : [];
export function sceneTargets(sc) {
  switch (sc && sc.type) {
    case 'race': return idsOf(sc.items);
    case 'bars': return ['play', 'bar', 'scale'];
    case 'model': return ['param', ...(sc.threshold ? ['threshold'] : []), ...(sc.toggle ? ['toggle'] : [])];
    case 'plot': return ['param', 'curve'];
    case 'flow': return ['play', ...idsOf(sc.steps)];
    case 'stack': return idsOf(sc.levels);
    case 'scheduler': return ['core', ...idsOf(sc.levels)];
    case 'network': return ['network'];
    case 'showcase': return idsOf(sc.items);
    case 'custom': return Array.isArray(sc.targets) ? sc.targets : [];
    default: return [];
  }
}

export function validateBook(input, { allowCustom = true } = {}) {
  const errors = [], warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`), warn = (p, m) => warnings.push(`${p}: ${m}`);
  let book;
  try { book = typeof input === 'string' ? JSON.parse(input) : structuredClone(input); }
  catch (e) { return { ok: false, errors: ['book: not valid JSON — ' + e.message], warnings, book: null }; }
  if (!book || typeof book !== 'object') return { ok: false, errors: ['book: must be an object'], warnings, book: null };
  if (!isStr(book.title)) err('title', 'missing');
  book.lang = book.lang || 'en';
  book.dir = book.dir === 'rtl' || ['ar', 'he', 'fa', 'ur'].includes(book.lang) ? 'rtl' : 'ltr';
  if (book.ui !== undefined && (typeof book.ui !== 'object' || Array.isArray(book.ui))) { warn('ui', 'must be an object of strings, ignored'); delete book.ui; }
  if (!Array.isArray(book.spreads) || !book.spreads.length) { err('spreads', 'must be a non-empty array'); return { ok: false, errors, warnings, book }; }

  const len = (p, v, max) => { if (isStr(v) && v.length > max) warn(p, `is ${v.length} chars (max ~${max}), may overflow`); };
  const checkExpr = (p, src, vars) => {
    try { const f = compile(src); const scope = {}; vars.forEach(v => scope[v] = 1); const r = f(scope); if (typeof r !== 'number') warn(p, 'did not evaluate to a number'); }
    catch (e) { err(p, e.message); }
  };

  book.spreads.forEach((s, i) => {
    const P = `spreads[${i}]`;
    if (!s || typeof s !== 'object') { err(P, 'must be an object'); return; }
    s.kind = s.kind === 'cover' ? 'cover' : 'lesson';
    if (!isStr(s.title)) err(P + '.title', 'missing');
    s.short = isStr(s.short) ? s.short : shorten(s.title || 'Spread ' + i, 22); // optional in prompts/core.md: the model saves the tokens
    s.slides = s.slides || '';
    if (!isStr(s.concept)) err(P + '.concept', 'missing');
    len(P + '.title', s.title, LIMITS.title); len(P + '.concept', s.concept, LIMITS.concept); len(P + '.fig', s.fig, LIMITS.fig);
    if (s.kind === 'cover') {
      if (s.plan && !Array.isArray(s.plan)) err(P + '.plan', 'must be an array of strings');
      if (Array.isArray(s.plan) && s.plan.length > 10) warn(P + '.plan', 'more than 10 items');
    } else {
      if (!s.formula || !isStr(s.formula.eq)) err(P + '.formula.eq', 'missing');
      else { s.formula.label = s.formula.label || 'KEY'; s.formula.note = s.formula.note || ''; len(P + '.formula.eq', s.formula.eq, LIMITS.eq); }
      if (!Array.isArray(s.vocab) || !s.vocab.length) err(P + '.vocab', 'needs 3–4 [term, definition] pairs');
      else s.vocab = s.vocab.filter(v => Array.isArray(v) && v.length >= 2).slice(0, 5).map(([a, b]) => [String(a), String(b)]);
      const q = s.quiz;
      if (!q || !isStr(q.q) || !Array.isArray(q.opts) || q.opts.length < 2) err(P + '.quiz', 'needs q and at least 2 opts');
      else if (!Number.isInteger(q.a) || q.a < 0 || q.a >= q.opts.length) err(P + '.quiz.a', 'must be the 0-based index of the right option');
      else { q.opts = q.opts.slice(0, 4).map(String); if (q.a >= q.opts.length) err(P + '.quiz.a', 'at most 4 options'); }
      if (!isStr(s.why)) err(P + '.why', 'missing'); len(P + '.why', s.why, LIMITS.why);
    }
    const sc = s.scene;
    if (!sc || !BLOCKS.includes(sc.type)) { err(P + '.scene.type', `must be one of ${BLOCKS.join(', ')}`); return; }
    const S = P + '.scene';
    const seen = new Set();
    /** sc[key] must be a list of min–max objects (SCENES' sizes; kept to max). An error and false otherwise: the scene is not checked further. */
    const list = key => { const a = sc[key], [, min = 0, max = Infinity] = SCENES[sc.type][key] ?? SCENES[sc.type][key + '?'];
      if (!Array.isArray(a) || a.length < min) { err(`${S}.${key}`, max < Infinity ? `needs ${min}–${max} ${key}` : 'must be a list'); return false; }
      if (!a.every(isObj)) { err(`${S}.${key}`, 'each entry must be an object'); return false; }
      sc[key] = a.slice(0, max); return true; };
    const ids = arr => arr.forEach((it, k) => { let id = slug(it.id || it.label || it.title, k), base = id, n = 2; while (seen.has(id)) id = base + '-' + n++; seen.add(id); it.id = id; });
    switch (sc.type) {
      case 'race':
        if (!list('items')) break; ids(sc.items);
        sc.items.forEach((it, k) => { if (!isNum(it.a) || !isNum(it.b) || it.a <= 0 || it.b <= 0) err(`${S}.items[${k}]`, 'a and b must be positive numbers'); it.aText = it.aText || String(it.a); it.bText = it.bText || String(it.b); it.short = it.short || `${it.aText} → ${it.bText}`; });
        sc.a = sc.a || { label: 'A' }; sc.b = sc.b || { label: 'B' }; sc.unit = sc.unit || 'days'; break;
      case 'bars':
        if (!list('items')) break;
        sc.items.forEach((it, k) => { if (!isNum(it.value) || it.value <= 0) err(`${S}.items[${k}].value`, 'must be a positive number'); if (!isNum(Number(it.x))) it.x = k; else it.x = Number(it.x); it.valueText = it.valueText || String(it.value); });
        if (sc.items.some((it, k) => k && it.x <= sc.items[k - 1].x)) warn(S + '.items', 'x should be increasing');
        if (sc.growth && (!isNum(sc.growth.factor) || sc.growth.factor <= 0)) { warn(S + '.growth.factor', 'must be a positive number, growth line removed'); delete sc.growth; }
        sc.log = sc.log !== false; break;
      case 'model': {
        const pm = sc.param;
        if (!pm || !isNum(pm.min) || !isNum(pm.max) || pm.max <= pm.min) { err(S + '.param', 'needs id, min < max'); break; }
        pm.id = /^[a-z_][a-z0-9_]*$/i.test(pm.id || '') ? pm.id : 'x'; pm.step = pm.step || (pm.max - pm.min) / 100; pm.value = isNum(pm.value) ? pm.value : pm.min; pm.unit = pm.unit || '';
        const vars = [pm.id];
        if (sc.toggle && !isObj(sc.toggle)) { err(S + '.toggle', 'must be an object'); break; }
        if (sc.toggle) { sc.toggle.id = /^[a-z_][a-z0-9_]*$/i.test(sc.toggle.id || '') ? sc.toggle.id : 'k'; sc.toggle.off = isNum(sc.toggle.off) ? sc.toggle.off : 0; sc.toggle.on = isNum(sc.toggle.on) ? sc.toggle.on : 1; vars.push(sc.toggle.id); }
        if (list('outputs')) sc.outputs.forEach((o, k) => checkExpr(`${S}.outputs[${k}].expr`, o.expr, vars));
        if (sc.gauge) checkExpr(S + '.gauge.expr', sc.gauge.expr, vars);
        if (sc.threshold && sc.threshold.when) checkExpr(S + '.threshold.when', sc.threshold.when, vars);
        if (sc.messages !== undefined && list('messages')) sc.messages.forEach((m, k) => checkExpr(`${S}.messages[${k}].when`, m.when || 'true', vars));
        sc.visual = ['chip', 'tank', 'dial'].includes(sc.visual) ? sc.visual : 'chip'; break; }
      case 'plot':
        if (!sc.param || !isNum(sc.param.min) || !isNum(sc.param.max)) { err(S + '.param', 'needs min/max'); break; }
        sc.param.id = /^[a-z_][a-z0-9_]*$/i.test(sc.param.id || '') ? sc.param.id : 'p';
        if (sc.param.id === 'x') err(S + '.param.id', '"x" is reserved for the horizontal axis');
        sc.param.value = isNum(sc.param.value) ? sc.param.value : sc.param.min; sc.param.step = sc.param.step || (sc.param.max - sc.param.min) / 100;
        checkExpr(S + '.expr', sc.expr, ['x', sc.param.id]);
        if (!sc.x || !isNum(sc.x.min) || !isNum(sc.x.max)) err(S + '.x', 'needs min/max');
        if (!sc.y || !isNum(sc.y.min) || !isNum(sc.y.max)) err(S + '.y', 'needs min/max');
        for (const k of ['x', 'y']) if (sc[k] && isNum(sc[k].min) && isNum(sc[k].max) && sc[k].max <= sc[k].min) err(`${S}.${k}`, 'max must be greater than min');
        if (sc.x && sc.x.log && !(sc.x.min > 0)) err(S + '.x.min', 'must be > 0 when x.log is true');
        if (sc.param.max <= sc.param.min) err(S + '.param', 'max must be greater than min'); break;
      case 'flow':
        if (list('steps')) ids(sc.steps); break;
      case 'stack':
        if (list('levels')) ids(sc.levels); break;
      case 'scheduler':
        sc.tasks = (Array.isArray(sc.tasks) && sc.tasks.length >= 2 ? sc.tasks : ['A', 'B', 'C']).slice(0, 4);
        sc.quantum = Object.assign({ label: 'Quantum', min: 0.05, max: 1.5, value: 0.6 }, sc.quantum || {});
        if (sc.levels && list('levels')) ids(sc.levels); break;
      case 'network':
        if (!list('nodes')) break;
        sc.hub = sc.hub || { label: 'Hub' }; break;
      case 'showcase':
        if (!list('items')) break; ids(sc.items);
        sc.items.forEach((it, k) => { if (!MODELS.includes(it.model)) { warn(`${S}.items[${k}].model`, `"${it.model}" unknown, using cube`); it.model = 'cube'; }
          if (it.steps !== undefined) it.steps = Array.isArray(it.steps) && it.steps.length ? it.steps.slice(0, 6).map(st => ({ label: String(st?.label ?? st), value: st?.value != null ? String(st.value) : '' })) : undefined; }); break;
      case 'custom':
        if (!allowCustom) err(S, 'custom scenes are only allowed in agent mode');
        else if (!isStr(sc.module) || !/^scenes\/[\w.-]+\.js$/.test(sc.module)) err(S + '.module', 'must look like "scenes/name.js"'); break;
    }
    s.targets = sceneTargets(sc);
  });
  return { ok: errors.length === 0, errors, warnings, book };
}

/** One spread on its own (the staged pipeline writes them one by one): the paths read "spread.quiz.a" instead of "spreads[0]…". */
export function validateSpread(spread, opts = { allowCustom: false }) {
  const v = validateBook({ title: '-', spreads: [spread] }, opts), at = s => s.replace(/^spreads\[0\]/, 'spread');
  return { ok: v.ok, errors: v.errors.map(at), warnings: v.warnings.map(at), spread: v.book?.spreads?.[0] ?? null };
}
