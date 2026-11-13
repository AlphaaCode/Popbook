// A stand-in for `claude -p --output-format stream-json` (test/providers.test.js): its answer is what it was given.
// Input "fail": an error result. Input "hang": one event, then silence until it is killed.
import { readFileSync } from 'node:fs';
if (!process.argv.includes('-p')) process.exit(0); // `node --test` runs every file under test/: nothing to do then
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const args = process.argv.slice(2), answer = { args, input, system: readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8') };
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  if (input === 'hang') return setInterval(() => {}, 1000);
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{' } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: input === 'fail', result: input === 'fail' ? 'API Error: overloaded' : JSON.stringify(answer),
    ...(args.includes('--json-schema') && { structured_output: answer }), usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } }));
});
