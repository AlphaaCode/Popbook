# Changelog

All notable changes to PopBook Studio are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Beginner's guide (PDF) for non-technical users: `docs/PopBook-Beginners-Guide.pdf`.
- Contributing guide, security policy, issue forms, pull request template, Dependabot and code owners.
- CI now also runs on Windows and Node 24.

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

[Unreleased]: https://github.com/AlphaaCode/Popbook/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AlphaaCode/Popbook/releases/tag/v0.1.0
