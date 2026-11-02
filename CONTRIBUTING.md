# Contributing to PopBook Studio

Thanks for wanting to help! PopBook turns course PDFs into interactive 3D pop-up books, and there's room for
contributions of every size: a typo fix, a better error message, a translation, a new scene block, or a new
AI provider.

New to the project? Read the [README](README.md) first. If you've never run it, the
[beginner's guide](docs/PopBook-Beginners-Guide.pdf) walks through installation step by step.

## Ways to help

- **Report a bug** — open an issue with the *Bug report* form. Include the red error line from the terminal or the
  build log, your OS, Node version, browser and AI provider. **Never paste an API key.**
- **Suggest a feature or a new scene block** — use the matching issue form. For a block, describe the idea it
  explains and how the reader would interact with it.
- **Share a book you made** — post it in [Discussions → Show and tell](../../discussions). Good books may become
  examples in `books/`.
- **Translate the interface** — add a language to [`viewer/i18n.js`](viewer/i18n.js).
- **Pick up an issue** — look for [`good first issue`](../../labels/good%20first%20issue) and
  [`help wanted`](../../labels/help%20wanted). Comment on the issue first so two people don't work on the same thing.

## Development setup

You need Node.js 18.17 or newer.

```bash
git clone https://github.com/AlphaaCode/Popbook.git
cd Popbook
npm install
POPBOOK_MOCK=1 npm start      # adds a "Mock" provider, so you can test without any AI key
```

On Windows (cmd): `set POPBOOK_MOCK=1 && npm start`. On PowerShell: `$env:POPBOOK_MOCK=1; npm start`.

Open http://localhost:5173. The example books open at `/viewer/?book=calcul-parallele` and
`/viewer/?book=blocks-demo` (every scene block in one book).

## Before you open a pull request

```bash
npm test          # unit tests (validator, expressions, JSON extraction, provider streams)
npm run check     # validates every book in books/
```

Both must pass; CI runs them on Linux and Windows. Then:

1. **Keep PRs focused.** One fix or feature per PR is much easier to review than a big mixed one.
2. **Open the viewer** if you touched anything visual (`viewer/`, `books/`, `prompts/`), and attach a screenshot
   or short recording to the PR.
3. **Update the docs** when behaviour changes: the README, and [`prompts/system.md`](prompts/system.md) if the book
   format or a block changed (the model only knows what that file says).
4. **Add a line to [CHANGELOG.md](CHANGELOG.md)** under *Unreleased*.

## Adding a scene block

The README section *Adding a new block* has the details. In short, every block touches four places:

1. `viewer/blocks.js` — the 3D model (use the helpers in `viewer/kit.js` so it matches the pen-and-ink look).
2. `lib/validate.js` — validation, normalisation and stamp targets.
3. `prompts/system.md` — documentation and a JSON example, so models can use it.
4. `books/blocks-demo/book.json` — a demo spread, plus a test in `test/` if it adds logic.

## Adding an AI provider

Providers live in [`lib/providers.js`](lib/providers.js). Stream the response (long generations exceed Node's
default fetch timeout otherwise), surface the provider's own error message, read the key from `.env` with a UI
override, and add a row to the *AI options* table in the README. Add a test against a fake local server, like the
existing ones in `test/providers.test.js`.

## Code style

- Plain modern JavaScript (ES modules), no build step and no framework. Keep it that way, so anyone can clone and run.
- No new runtime dependencies without discussing it in an issue first.
- Security matters: AI output is untrusted. Never `eval` it, keep expressions going through `lib/expr.js`, and keep
  the server bound to localhost.

## Commit messages

Short, imperative and specific: `Fix race block when b > a`, not `fixes`. Reference issues with `Fixes #12`.

## Code of conduct

Be kind and assume good intent. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
