// Loads .env into process.env (no dependency). Import this FIRST: other modules read process.env at load time.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

try {
  for (const line of fs.readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
