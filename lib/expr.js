// Tiny safe expression evaluator for scene formulas (no eval / Function).
// Supports numbers, identifiers, + - * / % ^, comparisons, && || !, ?:, and a few math functions.
const FUN = { min: Math.min, max: Math.max, abs: Math.abs, sqrt: Math.sqrt, log: Math.log, log10: Math.log10, log2: Math.log2,
  exp: Math.exp, pow: Math.pow, round: Math.round, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan };
const CONST = { pi: Math.PI, e: Math.E, true: 1, false: 0 };

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function tokenize(src) {
  // models often write typographic operators: − – × ·
  src = src.replace(/[−–]/g, '-').replace(/[×·]/g, '*');
  const t = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { t.push({ k: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
    if (id) { t.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(\*\*|&&|\|\||==|!=|<=|>=|[-+*/%^()<>!?:,])/.exec(src.slice(i));
    if (op) { t.push({ k: 'op', v: op[0] === '**' ? '^' : op[0] }); i += op[0].length; continue; }
    throw new Error(`Unexpected character "${c}" in expression "${src}"`);
  }
  return t;
}

export function compile(src) {
  if (typeof src === 'number') return () => src;
  const toks = tokenize(String(src)); let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const expect = v => { const t = next(); if (!t || t.v !== v) throw new Error(`Expected "${v}" in "${src}"`); };
  const BIN = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 8 };
  function primary() {
    const t = next(); if (!t) throw new Error(`Unexpected end of "${src}"`);
    if (t.k === 'n') return () => t.v;
    if (t.k === 'id') {
      if (peek() && peek().v === '(') {
        const f = own(FUN, t.v) && FUN[t.v]; if (!f) throw new Error(`Unknown function "${t.v}"`);
        next(); const args = [];
        if (peek() && peek().v !== ')') { do { args.push(ternary()); } while (peek() && peek().v === ',' && next()); }
        expect(')'); return s => f(...args.map(a => a(s)));
      }
      if (own(CONST, t.v)) return () => CONST[t.v];
      return s => { if (!own(s, t.v)) throw new Error(`Unknown variable "${t.v}"`); return s[t.v]; };
    }
    if (t.v === '(') { const e = ternary(); expect(')'); return e; }
    throw new Error(`Unexpected "${t.v}" in "${src}"`);
  }
  // prefix operators bind looser than ^ so that -x^2 = -(x^2) and 2^-1 works
  function unary() {
    const t = peek();
    if (t && t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) { next(); const e = binary(BIN['^']); return t.v === '-' ? s => -e(s) : t.v === '!' ? s => (e(s) ? 0 : 1) : e; }
    return primary();
  }
  function binary(minPrec) {
    let left = unary();
    for (;;) {
      const t = peek(); if (!t || t.k !== 'op' || !(t.v in BIN) || BIN[t.v] < minPrec) return left;
      next(); const prec = BIN[t.v]; const right = binary(t.v === '^' ? prec : prec + 1); const l = left, op = t.v;
      left = {
        '+': s => l(s) + right(s), '-': s => l(s) - right(s), '*': s => l(s) * right(s), '/': s => l(s) / right(s), '%': s => l(s) % right(s),
        '^': s => Math.pow(l(s), right(s)), '<': s => +(l(s) < right(s)), '>': s => +(l(s) > right(s)), '<=': s => +(l(s) <= right(s)),
        '>=': s => +(l(s) >= right(s)), '==': s => +(l(s) === right(s)), '!=': s => +(l(s) !== right(s)),
        '&&': s => +(l(s) && right(s)), '||': s => +(l(s) || right(s)) }[op];
    }
  }
  function ternary() {
    const c = binary(1);
    if (peek() && peek().v === '?') { next(); const a = ternary(); expect(':'); const b = ternary(); return s => (c(s) ? a(s) : b(s)); }
    return c;
  }
  const fn = ternary(); if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}" in "${src}"`);
  return fn;
}

export function evaluate(src, scope) { return compile(src)(scope); }
