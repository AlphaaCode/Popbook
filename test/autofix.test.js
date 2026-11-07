import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { nearestBlock, fixSpread, fixOutline, fallbackSpread, API_BLOCKS } from '../lib/autofix.js';
import { validateSpread, validateBook } from '../lib/validate.js';

const demo = JSON.parse(await fs.readFile(new URL('../books/blocks-demo/book.json', import.meta.url), 'utf8'));
const byType = t => structuredClone(demo.spreads.find(s => s.scene.type === t));

test('nearestBlock snaps typos and case, and keeps the plan when the name is far from every block', () => {
  assert.equal(nearestBlock('Flow'), 'flow');
  assert.equal(nearestBlock('bar'), 'bars');
  assert.equal(nearestBlock('schedular'), 'scheduler');
  assert.equal(nearestBlock(' stacks '), 'stack');
  assert.equal(nearestBlock('timeline', 'race'), 'race');
  assert.equal(nearestBlock('custom', 'plot'), 'plot');
});

test('autofix drops nothing the engine uses: both example books come out identical', async () => {
  const fr = JSON.parse(await fs.readFile(new URL('../books/calcul-parallele/book.json', import.meta.url), 'utf8'));
  for (const s of [...demo.spreads, ...fr.spreads]) {
    if (s.scene.type === 'custom') continue;
    const v = validateSpread(fixSpread(structuredClone(s), { kind: s.kind, block: s.scene.type }));
    assert.ok(v.ok, `${s.title}: ${v.errors.join(' | ')}`);
    assert.deepEqual(v.spread, validateSpread(s).spread, s.title);
  }
});

test('fixSpread: unknown keys dropped, numbers coerced, ranges clamped, the outline decides kind and block', () => {
  const s = byType('model');
  Object.assign(s, { kind: 'cover', extra: 1, title: 'A '.repeat(60) + 'end', formula: 'P = C V² f' });
  s.quiz.a = String(s.quiz.a); s.vocab = { CPU: 'the processor', GPU: 'graphics' };
  s.scene = { ...s.scene, type: 'Modle', color: 'red', param: { ...s.scene.param, min: 5, max: 1, value: '9', step: -1 } };
  const f = fixSpread(s, { block: 'model' });
  assert.equal(f.kind, undefined); assert.equal(f.extra, undefined); assert.equal(f.scene.color, undefined);
  assert.equal(f.scene.type, 'model');
  assert.deepEqual([f.scene.param.min, f.scene.param.max, f.scene.param.value, f.scene.param.step], [1, 5, 5, undefined]);
  assert.equal(typeof f.quiz.a, 'number');
  assert.deepEqual(f.vocab, [['CPU', 'the processor'], ['GPU', 'graphics']]);
  assert.deepEqual(f.formula, { eq: 'P = C V² f' });
  assert.ok(f.title.length <= 70 && f.title.endsWith('…') && !f.title.includes('end'));
  assert.ok(validateSpread(f).ok);
});

test('fixSpread: weak-model shapes — a book around the spread, a letter answer, "term: def" strings, a log axis from 0', () => {
  const s = byType('plot'); s.quiz.a = 'B'; s.vocab = s.vocab.map(([a, b]) => `${a}: ${b}`); s.scene.x = { ...s.scene.x, min: 0, log: 'true' };
  const f = fixSpread({ title: 'Book', spreads: [s] }, { block: 'plot' });
  assert.equal(f.quiz.a, 1);
  assert.ok(f.vocab.every(p => p.length === 2 && !p[0].includes(':')));
  assert.equal(f.scene.x.log, undefined); // x.log needs x.min > 0
  assert.ok(validateSpread(f).ok);
  assert.equal(fixSpread({ title: 'no scene' }, { block: 'flow' }).scene.type, 'flow'); // the plan's block, left for the validator
  assert.equal(fixSpread({ title: 'x', scene: { type: 'custom', module: 'scenes/a.js' } }, { block: 'stack' }).scene.type, 'stack');
});

test('fixOutline: page lists cleaned, blocks snapped, only the first spread may be the cover', () => {
  const { outline, errors } = fixOutline({ title: 'T', lang: 'fr', spreads: [
    { kind: 'cover', pages: 1, block: 'Network', intent: 'cover' },
    { pages: '2-3', block: 'modle', intent: 'a knob' },
    { kind: 'cover', pages: ['4', 99], block: 'flow', intent: 'steps' },
    { pages: [42], block: 'race', intent: 'outside the range' },
  ] }, [1, 2, 3, 4]);
  assert.deepEqual(errors, []);
  assert.deepEqual(outline, { title: 'T', lang: 'fr', spreads: [
    { kind: 'cover', pages: [1], block: 'network', intent: 'cover' }, { pages: [2, 3], block: 'model', intent: 'a knob' }, { pages: [4], block: 'flow', intent: 'steps' }] });
  assert.match(fixOutline({ spreads: [{ pages: [1] }] }, [1]).errors.join(' '), /title: missing.*block: missing.*intent: missing/);
  assert.match(fixOutline([], [1, 2]).errors.join(' '), /title: missing.*at least one spread/);
});

const outline = { title: 'T', spreads: [{ kind: 'cover', pages: [1], block: 'network', intent: 'The course' }, { pages: [2, 3], block: 'model', intent: 'Power grows with frequency cubed' }, { pages: [4], block: 'flow', intent: 'The pipeline' }] };
const text = 'Power wall\n• Dynamic power: grows as C·V²·f\n• Leakage — current lost when idle\n12\n- Cooling has a limit';

test('fallbackSpread: always valid, from the page bullets, even with nothing to go on', () => {
  for (const [i, t] of [[1, text], [1, ''], [0, text], [0, ''], [2, '7']]) {
    const s = fallbackSpread(outline, i, t, null), v = validateSpread(s);
    assert.ok(v.ok, `${i} ${JSON.stringify(t)}: ${v.errors.join(' | ')}`);
    assert.equal(s.scene.type, 'stack'); assert.ok(s.fallback.includes('scene'));
  }
  const s = fallbackSpread(outline, 1, text, null);
  assert.equal(s.title, 'Power wall');
  assert.deepEqual(s.vocab[0], ['Dynamic power', 'grows as C·V²·f']); // "term: definition" bullets become vocabulary
  assert.deepEqual(s.scene.levels.map(l => l.tip), ['Power wall', 'Dynamic power: grows as C·V²·f', 'Leakage — current lost when idle', 'Cooling has a limit']); // "12" is a page number
  assert.equal(s.quiz.opts[s.quiz.a], outline.spreads[1].intent);
  assert.equal(fallbackSpread(outline, 0, text, null).plan.length, 2);
});

test('fallbackSpread keeps every valid part of the last attempt and flags only what code wrote', () => {
  const last = byType('model'); last.scene.outputs = [{ label: 'heat', expr: 'f^^3' }]; // a broken expression: the scene goes
  const s = fallbackSpread(outline, 1, text, last);
  assert.ok(validateSpread(s).ok);
  assert.deepEqual(s.fallback, ['scene']);
  assert.equal(s.title, last.title); assert.deepEqual(s.quiz, last.quiz);
  const noQuiz = byType('flow'); noQuiz.quiz.a = 7; // a valid scene is kept too
  const t = fallbackSpread(outline, 2, text, noQuiz);
  assert.deepEqual(t.fallback, ['quiz']); assert.equal(t.scene.type, 'flow');
});

test('no answer shape makes autofix or validation throw: odd values become errors, which go to the repair ladder', () => {
  const vals = [null, 1, 'x', true, [], [1], {}, ['a', 'b'], [[1, 2]], [null, null], [{}, {}, {}]];
  const keys = ['title', 'concept', 'formula', 'vocab', 'quiz', 'why', 'fig', 'scene', 'spreads', 'spread'];
  const sceneKeys = ['items', 'steps', 'levels', 'nodes', 'param', 'x', 'y', 'quantum', 'toggle', 'hub', 'tasks', 'outputs', 'messages', 'gauge', 'threshold', 'growth'];
  for (const block of API_BLOCKS) for (const v of vals) {
    const plan = { pages: [1], block, intent: 'i' }, param = { id: 'p', min: 0, max: 1 };
    const raws = [...keys.map(k => ({ title: 'T', [k]: v, scene: { type: block } })), ...sceneKeys.flatMap(k => [{ title: 'T', scene: { type: block, [k]: v } }, { title: 'T', scene: { type: block, param, [k]: v } }])];
    for (const raw of raws) assert.doesNotThrow(() => { validateSpread(fixSpread(structuredClone(raw), plan)); validateBook({ title: 'T', spreads: [raw] }); }, JSON.stringify(raw));
  }
  for (const v of vals) assert.doesNotThrow(() => fixOutline(v, [1]));
});
