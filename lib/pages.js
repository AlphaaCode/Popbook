// Page input with pdf.js, shared by the studio (browser), the eval and tools/pdf2pages.mjs (Node).
// The input diet: every page goes to the model as clean text; only pages with figures also go as an image.
//   scanPage(page, OPS)       → raw text items + image/path draw counts of one page (cache it: it does not depend on the range)
//   cleanPages(scans)         → [{ n, text, figure }] for the selected pages (running headers/footers need the whole range)
//   renderPage(page, factory) → JPEG data URL, long side ≤ 1024 px
//   readPdfPages(doc, ...)    → the three together, for Node callers

const MARGIN = 0.1;          // top / bottom 10 % of the page: where running headers, footers and page numbers sit
export const MIN_TEXT = 40;  // fewer characters than this (a scan, a photo, a full-page diagram): the page is a figure
const MIN_IMAGE = 64 * 64;   // smaller images are icons and bullets, not figures
// Vector path segments beyond the plainest page of the range that make a figure. Measured on the eval PDFs: plain slides 7–14,
// a slide table or diagram 110–1 040. HTML-printed documents draw their boxes and tables as paths too (150–1 800), so most of
// their pages pass: that costs an image, not a lost table. ponytail: a count, not a layout analysis; raise it if text pages get images.
const FIG_SEGMENTS = 100;
export const MAX_SIDE = 1024; // figure image size: a 1024×768 page ≈ 1 050 Claude tokens, under half a native PDF page

/** One pdf.js page → { n, items: [{ str, eol, margin }], images: ['w×h'], segments }. */
export async function scanPage(page, OPS) {
  const [, y0, , y1] = page.view, h = (y1 - y0) || 1;
  const items = (await page.getTextContent()).items.filter(i => typeof i.str === 'string').map(i => {
    const y = (i.transform[5] - y0) / h; return { str: i.str, eol: !!i.hasEOL, margin: y < MARGIN || y > 1 - MARGIN };
  });
  const { fnArray, argsArray } = await page.getOperatorList();
  const IMG = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup];
  const images = []; let segments = 0;
  fnArray.forEach((f, k) => {
    const a = argsArray[k];
    if (f === OPS.constructPath) segments += a[0]?.length || 0; // pdf.js packs a whole path into one op: count its moveTo/lineTo/curveTo/rect
    else if (IMG.includes(f)) { const [w, ht] = f === OPS.paintImageXObject ? [a[1], a[2]] : [a[0]?.width, a[0]?.height]; images.push(w * ht >= MIN_IMAGE ? `${w}×${ht}` : ''); }
  });
  return { n: page.pageNumber, items, images: images.filter(Boolean), segments };
}

/** Whitespace collapsed, words split by a hyphen at a line end joined again. */
export const cleanText = t => String(t || '')
  .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, '$1$2')
  .replace(/[ \t  -​]+/g, ' ').replace(/ ?\r?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Scans of the selected pages → [{ n, text, figure }]. A margin line or an image size found on most pages is page furniture
 *  (course title, teacher, page number, logo): the text is kept on its first page only, the image never counts as a figure. */
export function cleanPages(scans) {
  const key = s => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const many = scans.length >= 3, most = Math.max(3, Math.ceil(scans.length / 2));
  const pagesWith = list => { const m = new Map(); for (const l of list) for (const k of new Set(l)) m.set(k, (m.get(k) || 0) + 1); return m; };
  const lines = pagesWith(scans.map(s => s.items.filter(i => i.margin && i.str.trim()).map(i => key(i.str))));
  const pics = pagesWith(scans.map(s => s.images));
  const plainest = many ? Math.min(...scans.map(s => s.segments)) : 0, seen = new Set();
  return scans.map(s => {
    let raw = '';
    for (const i of s.items) {
      const k = i.margin && key(i.str);
      if (many && k && lines.get(k) >= most) {
        if (seen.has(k) || !/\p{L}/u.test(k)) { if (i.eol && raw && !raw.endsWith('\n')) raw += '\n'; continue; } // a bare page number is never worth keeping
        seen.add(k);
      }
      raw += i.str + (i.eol ? '\n' : '');
    }
    const text = cleanText(raw);
    const figure = text.length < MIN_TEXT || s.images.some(d => !(many && pics.get(d) >= most)) || s.segments - plainest >= FIG_SEGMENTS;
    return { n: s.n, text, figure };
  });
}

/** A page as a JPEG data URL, long side ≤ maxSide. `factory` is the document's own canvas factory (doc.canvasFactory):
 *  a <canvas> in the browser, @napi-rs/canvas in Node. */
export async function renderPage(page, factory, maxSide = MAX_SIDE) {
  const one = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: maxSide / Math.max(one.width, one.height) });
  const c = factory.create(Math.round(viewport.width), Math.round(viewport.height));
  try { await page.render({ canvasContext: c.context, viewport }).promise; return c.canvas.toDataURL('image/jpeg', 0.8); }
  finally { factory.destroy(c); }
}

/** Pages from..to of a pdf.js document → [{ n, text, figure, image? }]; figure pages get an image when `images` is set. */
export async function readPdfPages(doc, from, to, OPS, { images = true } = {}) {
  const scans = [];
  for (let n = from; n <= to; n++) scans.push(await scanPage(await doc.getPage(n), OPS));
  const pages = cleanPages(scans);
  if (images) for (const p of pages) if (p.figure) p.image = await renderPage(await doc.getPage(p.n), doc.canvasFactory);
  return pages;
}
