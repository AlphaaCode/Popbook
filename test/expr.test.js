import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, evaluate } from '../lib/expr.js';

test('arithmetic and precedence', () => {
  assert.equal(evaluate('1 + 2 * 3', {}), 7);
  assert.equal(evaluate('(1 + 2) * 3', {}), 9);
  assert.equal(evaluate('2 ^ 3 ^ 2', {}), 512); // right-associative
  assert.equal(evaluate('2 ** 3', {}), 8);
  assert.equal(evaluate('-x^2', { x: 3 }), -9); // unary minus binds looser than ^
  assert.equal(evaluate('2^-1', {}), 0.5);
  assert.equal(evaluate('10 % 4', {}), 2);
  assert.equal(evaluate('1.5e2', {}), 150);
});

test('variables, functions, constants', () => {
  assert.equal(evaluate('n*(f/3.8)^3', { n: 1, f: 3.8 }), 1);
  assert.equal(evaluate('max(1, min(5, x))', { x: 9 }), 5);
  assert.equal(evaluate('round(pi * 100)', {}), 314);
  assert.equal(evaluate('1/((1-p)+p/x)', { p: 0.5, x: 1 }), 1);
});

test('logic and ternary', () => {
  assert.equal(evaluate('n==1 && f>=4', { n: 1, f: 4 }), 1);
  assert.equal(evaluate('n==1 && f>=4', { n: 2, f: 4 }), 0);
  assert.equal(evaluate('!a || b', { a: 1, b: 0 }), 0);
  assert.equal(evaluate('x > 2 ? 10 : 20', { x: 3 }), 10);
  assert.equal(evaluate('true', {}), 1);
});

test('typographic operators from models', () => {
  assert.equal(evaluate('4 − 1', {}), 3);
  assert.equal(evaluate('2 × 3 · 2', {}), 12);
});

test('rejects unknown names and prototype access', () => {
  assert.throws(() => evaluate('y + 1', { x: 1 }), /Unknown variable "y"/);
  assert.throws(() => evaluate('constructor', {}), /Unknown variable/);
  assert.throws(() => evaluate('toString(1)', {}), /Unknown function/);
  assert.throws(() => evaluate('constructor(1)', {}), /Unknown function/);
  assert.throws(() => evaluate('alert(1)', {}), /Unknown function/);
});

test('rejects malformed input', () => {
  assert.throws(() => compile('1 +'), /end/);
  assert.throws(() => compile('(1 + 2'), /Expected/);
  assert.throws(() => compile('1 2'), /Unexpected/);
  assert.throws(() => compile('a; b'), /Unexpected character/);
  assert.throws(() => compile('max(1,'), /end/);
  assert.throws(() => compile('"x"'), /Unexpected character/);
});
