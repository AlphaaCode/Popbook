import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateBook, sceneTargets, spreadSchema, writerSchema, outlineSchema, API_BLOCKS } from '../lib/validate.js';
import { extractJson } from '../lib/generate.js';

const lesson = scene => ({
  short: 'Short', title: 'A lesson', concept: 'Two sentences.', formula: { eq: 'E = mc<sup>2</sup>' },
  vocab: [['a', 'b'], ['c', 'd'], ['e', 'f']], quiz: { q: 'Q?', opts: ['x', 'y', 'z'], a: 1 }, why: 'Because.', fig: 'Touch it.', scene,
});
const book = (...scenes) => ({ title: 'T', lang: 'en', spreads: scenes.map(lesson) });

for (const dir of fs.readdirSync(new URL('../books', import.meta.url))) {
  const file = new URL(`../books/${dir}/book.json`, import.meta.url);
  if (!fs.existsSync(file)) continue;
  test(`books/${dir}/book.json is valid`, () => {
    const v = validateBook(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(v.errors, []);
  });
}

test('rejects broken JSON and missing fields', () => {
  assert.equal(validateBook('{oops').ok, false);
  const v = validateBook({ title: 'T', spreads: [{ scene: { type: 'nope' } }] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('.title')));
  assert.ok(v.errors.some(e => e.includes('scene.type')));
});

test('quiz answer index is checked', () => {
  const b = book({ type: 'network', nodes: [{ label: 'a' }, { label: 'b' }] });
  b.spreads[0].quiz.a = 3;
  assert.ok(validateBook(b).errors.some(e => e.includes('quiz.a')));
});

test('normalizes ids, dir and defaults', () => {
  const v = validateBook({ ...book({ type: 'showcase', items: [{ label: 'Météo', model: 'globe' }, { label: 'Météo', model: 'spaceship' }] }), lang: 'ar' });
  assert.equal(v.ok, true);
  assert.equal(v.book.dir, 'rtl');
  const [a, b] = v.book.spreads[0].scene.items;
  assert.equal(a.id, 'meteo');
  assert.equal(b.id, 'meteo-2'); // duplicates made unique
  assert.equal(b.model, 'cube'); // unknown model falls back
  assert.ok(v.warnings.some(w => w.includes('spaceship')));
  assert.deepEqual(v.book.spreads[0].targets, ['meteo', 'meteo-2']);
});

test('what prompts/core.md marks optional is filled in: short, kind, dir, ids, targets, block defaults', () => {
  const minimal = { title: 'T', lang: 'ar', spreads: [
    { title: 'Architecture et calcul parallèles', concept: 'C.', formula: { eq: 'S = 1/s' }, vocab: [['a', 'b']], quiz: { q: 'Q?', opts: ['x', 'y'], a: 0 }, why: 'W.',
      scene: { type: 'flow', steps: [{ label: 'Read data' }, { label: 'Compute' }] } },
    { title: 'Short one', concept: 'C.', formula: { eq: 'x' }, vocab: [['a', 'b']], quiz: { q: 'Q?', opts: ['x', 'y'], a: 1 }, why: 'W.',
      scene: { type: 'bars', items: [{ label: '4004', x: 1971, value: 2300 }, { label: 'P4', x: 2000, value: 4.2e7 }] } },
  ] };
  const v = validateBook(minimal);
  assert.deepEqual(v.errors, []);
  const [flow, bars] = v.book.spreads;
  assert.equal(v.book.dir, 'rtl');
  assert.deepEqual([flow.kind, flow.short, bars.short], ['lesson', 'Architecture et…', 'Short one']);
  assert.ok(flow.short.length <= 22);
  assert.deepEqual(flow.scene.steps.map(s => s.id), ['read-data', 'compute']);
  assert.deepEqual(flow.targets, ['play', 'read-data', 'compute']);
  assert.equal(bars.scene.log, true); assert.equal(bars.scene.items[0].valueText, '2300');
});

test('model expressions are compiled against param and toggle ids', () => {
  const ok = book({ type: 'model', param: { id: 'f', min: 1, max: 5 }, toggle: { id: 'n' }, outputs: [{ label: 'p', expr: 'n*f^3' }], threshold: { value: 4, when: 'n==1' } });
  const v = validateBook(ok);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.book.spreads[0].targets, ['param', 'threshold', 'toggle']);
  const bad = book({ type: 'model', param: { id: 'f', min: 1, max: 5 }, outputs: [{ label: 'p', expr: 'g*2' }] });
  assert.ok(validateBook(bad).errors.some(e => e.includes('Unknown variable "g"')));
});

test('plot checks ranges and reserved x', () => {
  const b = book({ type: 'plot', expr: 'x*p', x: { min: 0, max: 10, log: true }, y: { min: 5, max: 1 }, param: { id: 'x', min: 0, max: 1 } });
  const errs = validateBook(b).errors.join('\n');
  assert.match(errs, /reserved/);
  assert.match(errs, /x\.min: must be > 0/);
  assert.match(errs, /y: max must be greater/);
});

test('custom scenes only in agent mode', () => {
  const b = book({ type: 'custom', module: 'scenes/x.js', targets: ['a'] });
  assert.equal(validateBook(b, { allowCustom: true }).ok, true);
  assert.equal(validateBook(b, { allowCustom: false }).ok, false);
  b.spreads[0].scene.module = '../../etc/x.js';
  assert.equal(validateBook(b).ok, false);
});

test('sceneTargets covers every block', () => {
  assert.deepEqual(sceneTargets({ type: 'bars' }), ['play', 'bar', 'scale']);
  assert.deepEqual(sceneTargets({ type: 'flow', steps: [{ id: 'a' }] }), ['play', 'a']);
  assert.deepEqual(sceneTargets({ type: 'scheduler' }), ['core']);
  assert.deepEqual(sceneTargets({ type: 'nope' }), []);
});

test('extractJson handles fences, chatter and braces in strings', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson('Sure!\n```json\n{"a":"}"}\n```\nHope it helps {x}'), '{"a":"}"}');
  assert.equal(extractJson('Here: {"a":{"b":"\\"}"}} trailing } junk'), '{"a":{"b":"\\"}"}}');
  assert.throws(() => extractJson('no json here'), /did not return JSON/);
  assert.throws(() => extractJson('{"a": [1, 2'), /cut off/);
});

/** The errors of v against a toSchema() schema (its subset of JSON Schema). Keys the schema leaves unasked (ids, short…) pass. */
const fits = (v, s, at = '$') => {
  if (s.anyOf) return s.anyOf.some(x => !fits(v, x, at).length) ? [] : [at + ': fits no variant'];
  const t = Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  if (t !== s.type && !(s.type === 'number' && t === 'integer')) return [`${at}: ${t}, not ${s.type}`];
  if (s.enum && !s.enum.includes(v)) return [`${at}: "${v}" not allowed`];
  if (s.exclusiveMinimum != null && !(v > s.exclusiveMinimum)) return [`${at}: ${v} not > ${s.exclusiveMinimum}`];
  if (t === 'array') return [...(v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) ? [`${at}: ${v.length} items`] : []),
    ...v.flatMap((x, i) => fits(x, s.items, `${at}[${i}]`))];
  if (t !== 'object') return [];
  return [...s.required.filter(k => !(k in v)).map(k => `${at}.${k}: missing`), ...Object.entries(v).flatMap(([k, x]) =>
    s.properties[k] ? fits(x, s.properties[k], `${at}.${k}`) : ['id', 'short', 'kind', 'howto'].includes(k) ? [] : [`${at}.${k}: unknown`])];
};

test('schemas: every spread of the example books fits its block\'s schema and a writer answer of the book; mistakes do not', () => {
  for (const slug of ['calcul-parallele', 'blocks-demo']) {
    const ss = JSON.parse(fs.readFileSync(`books/${slug}/book.json`, 'utf8')).spreads.filter(s => s.scene.type !== 'custom');
    for (const s of ss) assert.deepEqual(fits(s, spreadSchema(s.scene.type, s.kind === 'cover')), [], `${slug}: ${s.title}`);
    const w = writerSchema(ss.map(s => ({ kind: s.kind, block: s.scene.type })));
    for (let i = 0; i < ss.length; i += 3) assert.deepEqual(fits({ spreads: ss.slice(i, i + 3) }, w), [], `${slug}: spreads ${i + 1}–`);
    assert.deepEqual(fits({ spreads: ss.slice(0, 4) }, w), ['$.spreads: 4 items']);
  }
  const s = lesson({ type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }), flow = spreadSchema('flow');
  assert.deepEqual(fits(s, flow), []);
  const { quiz, ...noQuiz } = s;
  assert.deepEqual(fits({ ...noQuiz, extra: 1 }, flow), ['$.quiz: missing', '$.extra: unknown']);
  assert.deepEqual(fits({ ...s, scene: { type: 'flow', steps: [{ label: 'a' }] } }, flow), ['$.scene.steps: 1 items']);
  assert.ok(fits({ ...s, scene: { type: 'bars', items: [] } }, flow).includes('$.scene.type: "bars" not allowed'));
  const race = lesson({ type: 'race', items: [{ label: 'x', a: 0, b: 2 }] });
  assert.deepEqual(fits(race, spreadSchema('race')), ['$.scene.items[0].a: 0 not > 0']); // a race time must be positive, as validateBook says
  assert.deepEqual(spreadSchema(API_BLOCKS).properties.scene.anyOf.map(x => x.properties.type.enum[0]), API_BLOCKS);
  assert.deepEqual(fits({ spreads: [{ ...s, quiz: undefined }] }, writerSchema([{ block: 'flow' }])).length, 1); // a lesson keeps its required parts
  assert.deepEqual(fits({ title: 'T', spreads: [{ kind: 'cover', pages: [1], block: 'network', intent: 'i' }] }, outlineSchema()), []);
  assert.deepEqual(fits({ title: 'T', spreads: [{ pages: [1], block: 'timeline', intent: 'i' }] }, outlineSchema()), ['$.spreads[0].block: "timeline" not allowed']);
});
