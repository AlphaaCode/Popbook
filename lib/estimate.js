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
const PDF_PAGE = { anthropic: 1600, gemini: 258 }; // image part of a page inside a native PDF; its text is counted with the pages
const OUT_PER_PAGE = 340; // spread JSON per source page (the example book: 3 370 tokens for 10 pages)

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
    calls.push({ range: [a, z], input, output: batch.length * OUT_PER_PAGE });
  }
  const input = calls.reduce((n, c) => n + c.input, 0), output = calls.reduce((n, c) => n + c.output, 0);
  return { calls: calls.length, input, output, cost: costOf(model, { input, cachedInput: 0, output, reasoning: 0 }), perCall: calls };
}
