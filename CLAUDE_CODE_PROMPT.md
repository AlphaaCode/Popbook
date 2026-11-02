# Prompt for Claude Code — build "PopBook Studio"

> Paste everything below into Claude Code, opened in an empty folder (or in the unzipped `popbook-starter` folder — see "Starting point").

---

## Goal

Build **PopBook Studio**: an open-source tool people `git clone`, run with `npm install && npm start`, and use to turn any course PDF (slides, textbook chapter, lesson notes) into an **interactive 3D pop-up textbook** in the browser, inspired by "Every Joule" by Techartist.

The user drags a PDF into a local web page, picks a page range, connects **their own AI** (an API key, a local model, or a coding agent such as Claude Code), and gets back a book they can open, share and export as one HTML file.

## Core architecture (do not change this idea)

The AI **never writes 3D code** in normal use. It only writes **one JSON file, `book.json`**, following a strict format. A fixed, hand-written **3D engine** renders any `book.json`. That keeps results reliable with any model.

```
popbook/
  server.js                 Node http server (no framework), binds 127.0.0.1:5173
  app/                      Studio UI: drop zone, page picker, AI settings, progress log, library
  viewer/                   3D engine: engine.js, kit.js (ink materials, labels, tweens), blocks.js (scene blocks), i18n.js, viewer.css, index.html
  lib/
    validate.js             validates + normalizes book.json (shared by server, CLI and viewer)
    expr.js                 tiny SAFE math expression evaluator (no eval/Function)
    providers.js            Anthropic, OpenAI, Gemini, OpenAI-compatible, agent CLIs, mock
    generate.js             pipeline: pages → model → validate → repair → books/<slug>/book.json
    export.js               single-file HTML export
  prompts/system.md         THE instructions given to the model (book format + block catalogue)
  books/<slug>/             book.json, source.pdf, pages/*.txt, scenes/*.js (custom, agent mode only)
  tools/check.mjs           CLI validator: node tools/check.mjs books/<slug>
  tools/pdf2pages.mjs       CLI: extract text per page from a PDF into books/<slug>/pages/
  tools/export.mjs          CLI: export a book to one HTML file
  CLAUDE.md + AGENTS.md     agent-mode instructions
  .claude/commands/popup-book.md   slash command: /popup-book <pdf> <from-to>
  .env.example, README.md, LICENSE (MIT)
```

## The book (what the reader sees)

An open hardback book lying on a desk, seen from ~58° above, warm sunlight through window blinds (spotlight with a striped light "cookie" + soft shadows), yellow cloth cover, page stack edges, blue ribbon bookmark.

- **Left page = a printed lesson** rendered as real HTML, projected onto the 3D page with a CSS `matrix3d` homography computed every frame from the page's 4 projected corners, `mix-blend-mode: multiply` so it looks printed. It contains: kicker (lesson n · slides), title (Instrument Serif), 2-sentence concept, a boxed key formula (allow `<sub> <sup> <b> <i>` only), 3–4 vocabulary terms, block controls (sliders/buttons), a "Predict first" multiple-choice quiz, and a **lift-the-flap** answer that stays locked until the reader answers. A circular dashed **stamp** is inked when the reader has answered and touched every interactive part of the model.
- **Right page = a 3D pop-up model** in pen-and-ink paper-craft style: off-white materials with a custom shader (diffuse + screen-space cross-hatching in shadow), black ink edges (`EdgesGeometry`), inverted-hull outlines on round shapes (thickness ~0.002 world units — keep it thin), glass with camera-facing silhouette lines, glowing color fills when active, labels as paper cards drawn on canvas.
- **Page turn**: models fold flat, a paper sheet curls over the spine, the new models pop up with a back-ease.
- **Bottom toolbar**: ← title + progress dots → and a **▶ Demo** button that flies the camera to each model, triggers it, and comes back.
- Hover tooltips, click to interact, keyboard arrows, `#p3` deep links, progress saved in localStorage.
- **Phones / portrait**: 3D on top (52vh), lesson text in a scrolling panel underneath.
- RTL support (Arabic): `dir="rtl"`, Noto Naskh Arabic. UI strings in `viewer/i18n.js` (en, fr, ar), overridable per book.

## book.json format

```json
{ "title": "", "subtitle": "", "lang": "fr", "dir": "ltr",
  "spreads": [
    { "kind": "cover", "short": "", "slides": "Slides 1–2", "title": "", "concept": "", "plan": [""], "fig": "", "scene": {} },
    { "kind": "lesson", "short": "≤22 chars", "slides": "", "title": "≤60", "concept": "≤260",
      "formula": { "label": "", "eq": "", "note": "" },
      "vocab": [["term", "definition"]],
      "quiz": { "q": "", "opts": ["", "", ""], "a": 1 },
      "why": "≤330", "fig": "caption telling the reader what to touch",
      "scene": { "type": "…" } } ] }
```

## Scene block library (the engine implements each one)

Each block is `build(scene, ctx) → { G, pops, update(dt,t), controls:[…], demo:[{focus,d,act,wait}] }` and exposes **target ids** used for the stamp.

| type | idea it explains | interaction | targets |
|---|---|---|---|
| `race` | A vs B on up to 4 cases | two shelves of glass jars fill on a simulated clock (cubic time-lapse), readout card shows elapsed time and % per machine | item ids |
| `bars` | growth over ordered items | towers rise, log/linear toggle, optional dashed growth law `v0·factor^((x−x0)/every)` | play, bar, scale |
| `model` | a knob → outcome with a limit | slider drives formulas (`expr` via lib/expr.js), optional toggle (e.g. cores), threshold brick wall that glows/shakes, visuals `chip` (dies + heat particles + thermometer), `tank`, `dial` | param, threshold, toggle |
| `plot` | explore y = f(x, p) | standing paper panel with axes + 3D tube curve, param slider rebuilds it, click the curve to read a value | param, curve |
| `flow` | pipeline / algorithm | step blocks with arrows, a glowing token travels through them | play + step ids |
| `stack` | levels of abstraction | stepped floors with labels, click to read each | level ids |
| `scheduler` | sharing one resource | one core, task tokens, live Gantt chart, quantum slider, optional hyperthreading + levels | core + level ids |
| `network` | connected machines | racks around a switch, packets flow | network |
| `showcase` | 1–4 objects / domains | procedural models: globe (grid refines per step), head (scan slice), layers (geology + wells), server, chip, molecule, dna, gear, flask, cube, pyramid, sphere, cylinder; optional `steps` cycle with a readout | item ids |
| `custom` | anything (agent mode only) | `scenes/<name>.js` exports `default (kit, scene, ctx) => ({ G, pops, update, controls, demo, targets })` | declared |

`prompts/system.md` must document every block with a JSON example, the length limits, a table "the idea is about… → use block…", rules for cutting pages into spreads (4–8 spreads per 10 pages, cover if there is a title page), staying faithful to the source (flag added facts in the formula note), writing in the source language, and "return only JSON".

## AI connections (studio "Connect your AI" panel)

1. **Claude API** — `/v1/messages`, send the page range as a native PDF `document` block (slice with `pdf-lib`) + extracted text. Default model from `.env` (`ANTHROPIC_MODEL`), editable.
2. **OpenAI API** — chat completions with page images (rendered client-side by pdf.js) + text, `response_format: json_object`.
3. **Gemini API** — `generateContent` with inline PDF, `responseMimeType: application/json`.
4. **OpenAI-compatible** — Ollama, LM Studio, OpenRouter, Groq… (base URL + optional key; images optional for text-only models).
5. **Local agents, no API key**: **Claude Code** (`claude -p "<prompt>" --permission-mode acceptEdits --allowedTools "Read,Write,Edit,Glob,Grep,Bash(node tools/check.mjs:*)"`), **Codex CLI** (`codex exec --full-auto`), **Gemini CLI** (`gemini -p --yolo`). Detect them on PATH; stream their output into the progress log; afterwards validate `book.json`. Allow overriding commands via `AGENT_CMD_CLAUDE` etc.
6. **Mock** provider (when `POPBOOK_MOCK=1`) that returns the example book — for tests and demos.

Pipeline rules: batch long ranges (default 15 pages per call) and merge spreads (continuation batches: no cover); extract JSON from fenced/chatty answers; validate; on failure send the errors + previous answer back for **up to 2 repair attempts**; keys come from `.env` or the UI (never written to disk unless the user ticks "remember on this computer", which stores them in localStorage only); server listens on 127.0.0.1 only.

## Studio UI (app/)

Same paper/ink look as the book. Three cards: **1 Your lesson** (drop zone for PDF, also .md/.txt notes and photos of pages; page thumbnails with pdf.js, lazy-rendered; from/to inputs; click = start, shift-click = end), **2 Connect your AI** (provider select showing "key found in .env ✓" / "not installed" for agents, model, base URL, API key, options: language, folder name, pages per call, send images, extra instructions), **3 Building** (progress bar, live log by polling `/api/jobs/:id`, cancel, then "Open the book" + "Download as one HTML file"). Below: **Your books** library and a box explaining the `/popup-book` agent command. Remember settings in localStorage.

## Export

`GET /api/books/:slug/export` → one HTML file: CSS inlined, engine modules inlined as `data:` URLs in an import map (rewrite relative imports to `popbook/<file>.js`), three.js from jsdelivr (`three@0.160.0`), book JSON embedded, custom scene modules embedded too.

## Agent mode files

- `CLAUDE.md` (and `AGENTS.md` with the same content): how to make a book by hand — run `node tools/pdf2pages.mjs <pdf> --pages 1-10 --out books/<slug>` (or read the PDF directly), read `prompts/system.md`, write `books/<slug>/book.json`, run `node tools/check.mjs books/<slug>` until OK, then tell the user to open `http://localhost:5173/viewer/?book=<slug>`. When no block fits an idea, the agent may write a `custom` scene using only the kit API (document the kit: `ink, glow, card, flatLabel, glassCyl, tween, PY…`, right-page coordinates x∈[0.05,0.95], z∈[−0.62,0.62]).
- `.claude/commands/popup-book.md`: `/popup-book $ARGUMENTS` → runs that workflow.

## Starting point

If this folder already contains `popbook-starter` files (viewer/engine.js, viewer/kit.js, viewer/blocks.js, viewer/i18n.js, viewer/index.html, viewer/viewer.css, lib/*.js, server.js, prompts/system.md, app/index.html, books/calcul-parallele/book.json), **treat them as a first draft written without being run**: read them, keep the design, fix bugs. Still missing: `app/studio.js`, `app/studio.css`, `tools/*.mjs`, `CLAUDE.md`, `AGENTS.md`, the slash command, `.env.example`, `.gitignore`, `README.md`, `LICENSE`. `books/calcul-parallele/book.json` is a real example (French parallel-computing course, 6 spreads using network, showcase, race, bars, model, scheduler) — keep it as the demo book.

## How to work

1. Plan with a todo list. Build in this order: validator + expr (with unit tests via `node --test`), engine + blocks against the example book, server + mock provider, studio UI, real providers, agent mode, export, README.
2. **Test in a real browser with Playwright** after each stage: open `/viewer/?book=calcul-parallele#p1`…`#p5`, screenshot each spread, check console errors, click a quiz option, open the flap, drag sliders, run Demo. Look at the screenshots and fix layout problems (text overflowing cards, models overlapping labels, outlines too thick, stamps colliding with text).
3. Make a second test book (`books/blocks-demo/book.json`) that uses **every** block type at least once (including plot, flow, stack, and a `tank` and `dial` model) and screenshot every spread.
4. Run the full pipeline with `POPBOOK_MOCK=1`: drop a PDF in the studio through Playwright, generate, open, export, then open the exported HTML file.
5. If an API key or `claude` is available, run one real generation on a 5-page PDF and fix what breaks.
6. Write a README with a GIF/screenshot section, quick start (clone → `npm install` → `npm start` → open localhost:5173), every AI option, agent mode, the block catalogue, how to add a new block, and troubleshooting (CORS-free because the server proxies, Ollama base URL, Windows notes).
7. Commit with clear messages. Don't push anywhere unless I ask.

Done = `npm install && npm start` works on a clean clone, the example book and the all-blocks book render with no console errors, mock generation works end to end, `npm run check` passes, export opens standalone.
