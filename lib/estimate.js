// Pre-flight estimate: how many tokens (and dollars) a build will use, before any model is called.
// gpt-tokenizer is OpenAI's tokenizer: other vendors count differently, so treat every figure as ±20 %.
// `npm run eval` records estimate and real usage side by side — recalibrate the constants below from that.
import { encode } from 'gpt-tokenizer';
import { costOf } from './models.js';

// allowedSpecial: a PDF about LLMs may contain "<|endoftext|>", which the tokenizer otherwise refuses
export const countTokens = text => encode(String(text ?? ''), { allowedSpecial: 'all' }).length;

/** The page ranges generate() sends as separate model calls. */
export function planBatches(from, to, perCall) {
  const per = Math.max(3, Number(perCall) || 15), out = [];
  for (let a = from; a <= to; a += per) out.push([a, Math.min(to, a + per - 1)]);
  return out;
}

const INTRO = 150;       // the per-call instructions in generate.js's userIntro()
const IMAGE = 1100;      // one page image (≈1 100 tokens at the studio's 1 200 px)
const PDF_PAGE = { anthropic: 1600, gemini: 580 }; // a page inside a native PDF. Gemini: 258 image tokens + the PDF's own text layer (measured: 2 PDFs on gemini-3.8-flash)
const OUT_PER_PAGE = 340; // spread JSON per source page (the example book: 3 370 tokens for 10 pages; measured 325–362 on gemini-3.8-flash)
// Hidden thinking tokens per answer token. Gemini thinks by default and bills it as output: measured 1.9× on gemini-3.8-flash (2 runs,
// 6 391 and 6 558 reasoning tokens for ~3 400 of answer). Remove once generate() sets an explicit thinking budget.
const THINKING = { gemini: 1.9 };

/** job: { provider, model, pages:[{n, text, image?}], range, pagesPerCall, hasPdf, sendPdf, sendImages }.
 *  caps: the PROVIDERS entry ({pdf, images}).  Mirrors how generate() builds its calls. */
export function estimate({ system, pages, range, pagesPerCall, provider, model, caps = {}, hasPdf = false, sendPdf, sendImages }) {
  const sys = countTokens(system), calls = [];
  const nativePdf = hasPdf && caps.pdf && sendPdf !== false;
  for (const [a, z] of planBatches(range[0], range[1], pagesPerCall)) {
    const batch = pages.filter(p => p.n >= a && p.n <= z);
    let input = sys + INTRO + batch.reduce((n, p) => n + 6 + countTokens(p.text), 0);
    if (nativePdf) input += batch.length * (PDF_PAGE[provider] ?? 1000);
    else if (caps.images && sendImages !== false) input += batch.filter(p => p.image).length * IMAGE;
    const answer = batch.length * OUT_PER_PAGE, reasoning = Math.round(answer * (THINKING[provider] || 0));
    calls.push({ range: [a, z], input, output: answer + reasoning, reasoning });
  }
  const sum = k => calls.reduce((n, c) => n + c[k], 0), input = sum('input'), output = sum('output'), reasoning = sum('reasoning');
  return { calls: calls.length, input, output, reasoning, cost: costOf(model, { input, cachedInput: 0, output, reasoning }), perCall: calls };
}
