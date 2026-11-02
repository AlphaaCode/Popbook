# Security policy

PopBook Studio runs on your own computer, talks to AI providers with your API keys, and renders content written by
an AI. Security reports are welcome and taken seriously.

## Supported versions

Only the latest release on `main` receives fixes.

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Instead, use GitHub's private reporting:
[**Report a vulnerability**](../../security/advisories/new) (Security tab → *Report a vulnerability*).

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a first answer
within a week. Once a fix is released, you'll be credited in the advisory unless you prefer not to be.

## What's in scope

- Ways for a web page, a crafted PDF or a crafted `book.json` to run code, read files outside `books/`, or reach
  the local server from another origin.
- Ways for API keys to leak (to disk, to logs, to other sites, into exported HTML).
- Escapes from the safe expression evaluator in `lib/expr.js`.
- Agent mode doing more than its allowed tools (`--allowedTools`) permit.

## Good to know

- The server listens on `127.0.0.1` and rejects requests not addressed to localhost. Setting `HOST=0.0.0.0` exposes
  the studio — and builds with your keys — to your whole network; only do it on a network you trust.
- Keys pasted in the studio are not written to disk unless you tick *remember on this computer* (browser
  localStorage). Keys in `.env` stay on your machine; `.env` is git-ignored.
- Exported books are static HTML. They load three.js and fonts from public CDNs.
