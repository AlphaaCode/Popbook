# Changelog

All notable changes to PopBook Studio are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-11-13

Token-efficient generation. *Budget* (the default with Gemini and local models) writes a 10-page book in one request, about
3× cheaper than v0.1 on gemini-3.8-flash; *Balanced* and *Best* plan an outline, then write two or three spreads per call,
with repairs per spread, outline review and *regenerate this spread*. Measured costs: README, "Cost".

### Added
- **Token measurement** (v0.2 phase 1). Every provider now reports token usage (`input`, `cachedInput`, `output`,
  `reasoning`): Claude API, OpenAI, Gemini and OpenAI-compatible servers from their own usage fields, Claude Code from its
  result event (other CLIs report none). The job log shows it on every answer, with a cost when the model has a known price,
  and `book.source` keeps the totals (`usage`, `calls`, `repairs`).
- **Pre-flight estimate** in the studio: "~N calls, ~Xk in / ~Yk out tokens, ≈ $Z" under the Build button, from `POST /api/estimate`
  (`lib/estimate.js`, `gpt-tokenizer`) and a price table in `lib/models.js`.
- **`npm run eval`**: runs the PDFs in `eval/pdfs/` through the pipeline for each provider with a key and writes `eval/results.csv`
  (first-try validity, repairs, tokens, cost, seconds, estimate vs. real). `--providers mock` is a free dry run.
  `eval/baseline.csv` is the reference for the token-saving work that follows.
- The mock provider now goes through the real parse / validate / repair loop, so the pipeline is testable offline.
- **High fidelity** option in the studio (`fidelity: 'high'`): sends the PDF pages themselves, for scans and heavy maths.
- `SPREAD_MAX_TOKENS` in `.env`: the output cap per spread (default 1 500).
- **Outline review** in the studio: *let me review the outline* pauses the build to edit, reorder or delete spreads
  (`POST /api/jobs/:id/outline`).
- **Regenerate this spread**: *Your books* lists the spreads of API-built books, marks with ⚠ those PopBook wrote, and
  rewrites any one of them with the AI picked in the studio (`POST /api/books/:slug/spreads/:i/regenerate`).
- **Result cache** in `.cache/`: every valid outline and spread, keyed by a sha256 of what its call sends (pages, prompts,
  model). The same build again costs no tokens; regenerate skips it. Delete the folder to reset.

### Changed
Token diet (v0.2 phase 2). Same pipeline, less input and output per call:
- **Text first.** `lib/pages.js` cleans the page text (running headers, footers and page numbers removed, whitespace
  collapsed, hyphenated line breaks joined) and finds figure pages from the pdf.js operator list (images that are not
  page furniture, tables and diagrams drawn as paths, or under 40 characters of text). The model gets the text of every
  page plus a 1 024 px image of each figure page only; the PDF itself only at high fidelity. Gemini gets those images at
  medium resolution, its document setting. The studio, the eval and `tools/pdf2pages.mjs` share this code.
- **Cache-friendly prompts.** Every call is system prompt → pages → task, with nothing per job before the pages; a repair
  only appends. Claude caches the system prompt (`cache_control`); OpenAI and Gemini reuse the identical prefix.
- **Bounded output.** The cap per call is 1 500 tokens per spread it may write plus room to think (was 32 000).
  Reasoning is set explicitly: `low` effort for gpt-6-astra, a 1 024-token thinking budget for gemini-4-argon and
  gemini-3.8-flash (`REASONING` in `lib/models.js`).
- **Less to write.** The model is asked for minified JSON and leaves out what the engine fills in: `dir`, lesson `kind`,
  `short` (now cut from the title at a word), item `id`s, stamp targets and default values.
- **Narrow repairs.** A rejected batch is resent with its errors and only the spreads they point at, never the whole
  rejected answer.

Eval, pages 1–10, gemini-3.8-flash, phase 1 baseline → phase 2 (one run each):

| PDF | valid first try | input tokens | output tokens (reasoning) | cost | time |
|---|---|---|---|---|---|
| Claude-Call-Me-Guide (9 figure pages) | yes → yes | 14 310 → 13 807 | 9 644 (6 391) → 1 339 (0) | $0.047 → $0.015 | 196 s → 17 s |
| coursCalculParallel2025 (7 figure pages) | yes → yes | 10 127 → 8 591 | 10 173 (6 558) → 2 725 (0) | $0.046 → $0.017 | 110 s → 98 s |

Staged pipeline (v0.2 phase 3). API builds no longer write the whole book in one answer:
- **Outline, then one call per spread.** A planner call reads every page and returns an outline
  (`{title, spreads: [{pages, block, intent}]}`, saved as `outline.json`); then one writer call per spread, 3 at a time,
  gets only its pages, its block's spec and the outline (a shared, cached prefix). Replaces batches and *pages per call*.
- **Prompt split.** `prompts/system.md` is now `prompts/core.md` (the rules, sent with every call) and
  `prompts/blocks/<name>.md` (one per scene block, sent only to the spread that uses it).
- **Fix in code first.** `lib/autofix.js` clamps ranges, fills defaults, drops unknown keys, snaps a misspelt block name to
  the nearest one, trims long text and unwraps odd answer shapes before any repair call. Then: one repair with the errors,
  one try on the planner model (`plannerModel`), and finally a spread PopBook writes from the page text, flagged
  (`"fallback": [parts]`) instead of failing the build.
- The estimate counts one outline call plus ~0.6 spreads per page.

Routing and weak models (v0.2 phase 4):
- **Presets** *Budget* / *Balanced* / *Best* in the studio and the eval (`--preset`). A preset picks a model tier
  and a reasoning level for the planner (the outline call) and the writer (each spread), and whether figure pages go as
  images. Balanced plans with the provider's default model and writes with its cheaper sibling (gemini-3.8-flash,
  claude-haiku-5-5). `PLANNER_MODEL` / `WRITER_MODEL` in `.env` override a role, on another provider too
  (`claude-opus-5-5`, `compat:llama3:8b`); the studio's *planner* and *writer model* fields override both.
- **Capability table** in `lib/models.js`: per model its provider, price (input, output, cached input per 1M tokens),
  image and PDF input, JSON-schema support and caching. Cost is summed per call, so mixed roles are priced right
  (`book.source.cost`).
- **Each step its own rules.** The planner's system prompt is `core.md` sections 1, 2, 3, 6 (~1 100 tokens), the writer's
  1, 4, 5, 7 (~1 190), instead of all ~1 740 on every call.
- **Structured output.** `lib/validate.js` now holds the shape table of every spread and scene block and turns it into JSON
  schemas (`spreadSchema(block)`, `outlineSchema()`). Every call sends one: OpenAI `json_schema` strict, Gemini
  `responseJsonSchema`, Anthropic a forced tool, OpenAI-compatible servers `json_schema` (Ollama maps it to `format`,
  llama.cpp to a GBNF grammar). A server that refuses it is asked again without.
- **`claude-cli` provider**: the staged pipeline on a Claude login, no API key. Each call is `claude -p` with no tools,
  `--safe-mode`, our system prompt and `--json-schema`. Text only.
- **Two or three spreads per writer call.** Neighbouring spreads share one call (7 spreads → 3 calls), so the rules, the
  outline and the task go out 3 times instead of 7. Each spread of the answer (`{"spreads": […]}`) is fixed and validated on
  its own; one that fails is repaired alone, in a call with only its pages. The output cap grows with the spreads asked for.
- **One cached prefix for every writer.** Every API puts the JSON schema ahead of the system prompt, so a schema per block
  gave each writer its own prefix. Now every writer call of a book gets one schema (`writerSchema`: the book's blocks, cover
  or lesson), then the writer's rules and the outline; specs, pages and task follow. The first writer call runs alone, so
  the prefix is in the provider's cache before the others start.
- **Budget is phase 2's path again; the staged pipeline is Balanced and Best.** Budget writes the whole book in one call (one
  per 15 pages), from all the rules and every block spec, with autofix and phase 2's narrow repairs; no outline, review or
  regenerate. A new build starts on Budget with Gemini and OpenAI-compatible servers, on Balanced with Claude, OpenAI and
  `claude -p`. The job log and the studio's estimate name the path. Figure images are on for Budget too, as in phase 2.
- **Budget asks for full explanations**: `concept` 2–3 full sentences, `why` 2, formulas never shortened. Cours on
  gemini-3.6-flash: concept 134 → 212 characters, why 138 → 188 (baseline 221, 199), input +0.9 %, output +46 % (more thinking).
- **Gemini's free tier** (5 requests a minute, 20 a day per model). Requests to Gemini and OpenAI-compatible servers are spaced
  at least 13 s apart, and their staged writers run one at a time (3 for Claude and OpenAI). A per-minute 429 waits its
  `retryDelay` and tries again; the daily quota stops the build at once: "Gemini free tier: daily limit for <model> reached…".
  The estimate says how many requests a build uses ("uses 1 request", "uses ~7 requests"; on Gemini "free tier allows 20 a
  day"). The studio keeps the preset per provider, so Gemini stays on Budget unless Balanced or Best is picked for it.
- **Agent bundle.** A local agent gets `books/<slug>/input/` (`pages.md`, `fig-<n>.jpg`, and `outline.json` when a plain
  model of its family can plan: `claude -p`, or the Gemini / OpenAI API with a key) and a short `PROMPT.md` that names
  the files to read and forbids opening the PDF or exploring the repo. Claude Code and Gemini CLI get `--model` per preset.

### Fixed
- A model that refuses the reasoning setting (a 400 naming thinking or reasoning) is asked again without it, once, and
  called without it from then on, like a refused JSON schema. `gemini-3.6-flash` is in the model table (priced, no thinking budget).
- A model call that hangs no longer stalls a build for 5 minutes: after 90 s without a byte back (`REQUEST_TIMEOUT_MS` in `.env`)
  it is cut and tried again like a dropped connection. A long answer that keeps streaming is not cut; `claude -p` now streams too.
- One transient error no longer kills a build: a 429, a 5xx or a dropped connection is tried again up to 3 times, after 2 s,
  8 s and 20 s, or longer when the server's `Retry-After` (Gemini: `retryDelay`) asks for it, up to 60 s. The log says so.
- A race time of 0 or less cost a repair call: the schema now asks for `a`, `b` (and a bars `value`) greater than 0
  (`exclusiveMinimum`), and autofix turns one that slips through into a positive number, keeping the model's number as its label.
- Photos of pages never reached Claude or Gemini (the image switch was hidden and off for providers that read PDFs).
- The studio's estimate now refreshes when the model or image options change.
- A scene list of strings or a missing list (`"items": ["a", "b"]`) crashed validation instead of being reported as an
  error.

## [0.1.1] — 2026-11-04

### Added
- Beginner's guide (PDF) for non-technical users: `docs/PopBook-Beginners-Guide.pdf`.
- Contributing guide, security policy, issue forms, pull request template, Dependabot and code owners.
- CI now also runs on Windows and Node 24.

### Fixed
- Studio: the "Needs an API key" hint now turns green when you paste a key, instead of staying red until a key is in `.env` ([#11](https://github.com/AlphaaCode/Popbook/issues/11)).

## [0.1.0] — 2026-11-02

First public release.

### Added
- **Studio** at `localhost:5173`: drop a PDF (or `.md` / `.txt` notes or page photos), pick pages, connect an AI,
  follow a live build log, open or export the book.
- **AI options**: Claude API, OpenAI API, Gemini API, any OpenAI-compatible server (Ollama, LM Studio, OpenRouter,
  Groq…), and local agents (Claude Code, Codex CLI, Gemini CLI). Streaming responses, batching of long page ranges,
  automatic validation with up to two repair rounds.
- **3D viewer**: open hardback book on a desk, printed left page projected onto the 3D page, pen-and-ink pop-up
  models, page turns, predict-first quizzes, lift-the-flap answers, completion stamps, guided ▶ Demo, phone layout,
  right-to-left (Arabic) support, English / French / Arabic interface.
- **Scene blocks**: `race`, `bars`, `model`, `plot`, `flow`, `stack`, `scheduler`, `network`, `showcase`, and
  `custom` scenes in agent mode.
- **Agent mode**: `CLAUDE.md` / `AGENTS.md` and the `/popup-book` command for Claude Code.
- **Single-file HTML export**, CLI tools (`check`, `pages`, `export`) and unit tests.
- Example books: `calcul-parallele` and `blocks-demo`.

[Unreleased]: https://github.com/AlphaaCode/Popbook/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AlphaaCode/Popbook/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/AlphaaCode/Popbook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AlphaaCode/Popbook/releases/tag/v0.1.0
