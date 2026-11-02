---
description: Turn a course PDF into a PopBook — /popup-book <file.pdf> <from-to> [slug]
argument-hint: <file.pdf> <from-to> [slug]
---

Make an interactive pop-up book from: $ARGUMENTS

The arguments are a PDF (or .md/.txt notes) path, a page range like `1-10` (default: the whole file) and an
optional book folder name. Follow CLAUDE.md step by step:

1. Choose a short slug (from the file name if none was given) and run
   `node tools/pdf2pages.mjs <file> --pages <range> --out books/<slug>`. Also read the PDF pages themselves for
   figures and tables.
2. Read prompts/system.md fully, then write books/<slug>/book.json.
3. Run `node tools/check.mjs books/<slug>` and fix everything until it prints OK.
4. Finish by telling me the link http://localhost:5173/viewer/?book=<slug> and summarising the spreads (title and
   scene block of each) in a short list.
