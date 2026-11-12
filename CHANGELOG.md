# Changelog

All notable changes to PopBook Studio are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- New PopBook logo (an open book with a paper pop-up), favicon for the studio and viewer, and brand files in `docs/brand/`: logo SVGs, wordmarks, app icon, avatar and social preview.

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

[Unreleased]: https://github.com/AlphaaCode/Popbook/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/AlphaaCode/Popbook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AlphaaCode/Popbook/releases/tag/v0.1.0
