// Pre-flight estimate: how many tokens (and dollars) a build will use, before any model is called.
// gpt-tokenizer is OpenAI's tokenizer: other vendors count differently, so treat every figure as ±20 %.
// `npm run eval` records estimate and real usage side by side — recalibrate the constants below from that.
import { encode } from 'gpt-tokenizer';
import { costOf, inputsFor, BATCH } from './models.js';
import { GROUP } from './validate.js';

// allowedSpecial: a PDF about LLMs may contain "<|endoftext|>", which the tokenizer otherwise refuses
export const countTokens = text => encode(String(text ?? ''), { allowedSpecial: 'all' }).length;

const TASK = 120;             // the per-call task lines in generate.js
const MIN_TEXT = 40;          // lib/pages.js: a page with less text goes to the planner as an image
const SPREADS_PER_PAGE = 0.6; // prompts/core.md asks for 4–8 per 10 pages (phase 2 eval: 4 and 6)
const OUTLINE_PER_SPREAD = 45; // {"pages":[2,3],"block":"model","intent":"≤120 chars"}, plus the title once
const OUT_PER_SPREAD = 400;    // one minified spread (phase 2 eval on gemini-3.8-flash: 335 and 454 on average)
const IMAGE = { gemini: 580 }; // one figure-page image: Gemini at medium resolution (as a PDF page); others ≈ Claude's w×h/750 for 1024×768
const PDF_PAGE = { anthropic: 1600, gemini: 580 }; // a page inside a native PDF (high fidelity only). Gemini: 258 image tokens + the PDF's own text layer (measured: 2 PDFs on gemini-3.8-flash)
// Hidden thinking tokens per answer token, for models without a thinking budget (lib/models.js reasoningFor). Gemini thinks by default and
// bills it as output: measured 1.9× on gemini-3.8-flash before it got a budget (6 391 and 6 558 reasoning tokens for ~3 400 of answer).
const THINKING = { gemini: 1.9 };

/** Mirrors generate() on the preset's path. 'staged': one outline call by the planner reading every page's text, then one writer
 *  call per GROUP neighbouring spreads with only their own pages. 'single' (Budget): one call by the writer per BATCH pages, with all
 *  the rules and every block spec. prompts: loadPrompts(); pages: [{ n, text, image? }] where `image` marks a figure page; planner,
 *  writer: roles() of the job ({ provider, model, reasoning }); sendImages: the studio's switch, else the preset's choice. The number
 *  of spreads is a guess until the outline exists. Cached input is not counted: whether a prefix is long enough to cache depends on
 *  the model, so this is the uncached cost. */
export function estimate({ prompts, pages, range, planner, writer, path = 'staged', hasPdf = false, fidelity, sendImages }) {
  const sel = pages.filter(p => p.n >= range[0] && p.n <= range[1]), spreads = Math.max(1, Math.round(sel.length * SPREADS_PER_PAGE));
  const media = r => { const inp = inputsFor(r, { hasPdf, fidelity, sendImages });
    return p => inp.pdf ? (PDF_PAGE[r.provider] ?? 1000) : inp.images && p.image ? (IMAGE[r.provider] ?? 1050) : 0; };
  const sum = (ps, f) => ps.reduce((n, p) => n + f(p), 0), text = p => 6 + countTokens(p.text);
  // thinking: the most it may per call (gemini-3.8-flash used none of its 1 024), else the measured default ratio
  const think = (r, answer, calls) => r.reasoning?.budget != null ? calls * r.reasoning.budget : Math.round(answer * (THINKING[r.provider] || 0));
  if (path === 'single') {
    const calls = Math.ceil(sel.length / BATCH), answer = spreads * OUT_PER_SPREAD, u = { input: calls * (countTokens(prompts.single) + TASK) + sum(sel, p => text(p) + media(writer)(p)),
      cachedInput: 0, reasoning: think(writer, answer, calls) };
    u.output = answer + u.reasoning;
    return { path, calls, spreads, input: u.input, output: u.output, reasoning: u.reasoning, cost: costOf(writer.model, u) };
  }
  const specs = Object.values(prompts.blocks).map(countTokens), spec = Math.round(specs.reduce((a, b) => a + b, 0) / specs.length);
  const outlineOut = 60 + OUTLINE_PER_SPREAD * spreads;
  const outlineIn = countTokens(prompts.planner ?? prompts.core) + TASK + sum(sel, text) + sum(sel.filter(p => (p.text || '').trim().length < MIN_TEXT), media(planner));
  // every page goes to the writer of its spread, once; each writer call also gets the rules, the outline and the task, and each spread its block spec
  const calls = Math.ceil(spreads / GROUP);
  const writersIn = calls * (countTokens(prompts.writer ?? prompts.core) + outlineOut + TASK) + spreads * spec + sum(sel, p => text(p) + media(writer)(p));
  const p = { input: outlineIn, cachedInput: 0, reasoning: think(planner, outlineOut, 1) }, w = { input: writersIn, cachedInput: 0, reasoning: think(writer, spreads * OUT_PER_SPREAD, calls) };
  p.output = outlineOut + p.reasoning; w.output = spreads * OUT_PER_SPREAD + w.reasoning;
  const cp = costOf(planner.model, p), cw = costOf(writer.model, w);
  return { path, calls: 1 + calls, spreads, input: p.input + w.input, output: p.output + w.output, reasoning: p.reasoning + w.reasoning, cost: cp == null || cw == null ? null : cp + cw };
}
