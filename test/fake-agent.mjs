// A stand-in for a local coding agent (test/generate.test.js): reads nothing, writes the example book where PROMPT.md says.
import fs from 'node:fs';
const slug = /books\/([\w-]+)\/PROMPT\.md/.exec(process.argv.slice(2).join(' '))?.[1];
if (slug) fs.copyFileSync('books/calcul-parallele/book.json', `books/${slug}/book.json`); // `node --test` runs it bare: nothing then
