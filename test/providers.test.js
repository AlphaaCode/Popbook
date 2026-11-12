// Streaming parsers checked against a fake local server (no network, no keys).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { callModel, describeClaudeEvent, claudeUsage, addUsage, emptyUsage, fmtUsage, RETRY } from '../lib/providers.js';
RETRY.delays = [1, 1, 1]; // retries in milliseconds, not seconds

const sse = events => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const STREAMS = {
  '/v1/messages': sse([{ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 1 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"title":' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '"A"}' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 250 } }]),
  '/chat/completions': sse([{ choices: [{ delta: { content: '{"title":' } }] }, { choices: [{ delta: { content: '"B"}' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 128 }, completion_tokens_details: { reasoning_tokens: 100 } } }, '[DONE]']),
  '/nousage/chat/completions': sse([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }, '[DONE]']),
  '/tool/v1/messages': sse([{ type: 'content_block_start', content_block: { type: 'tool_use', name: 'answer', input: {} } }, { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"T"}' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }]),
  '/v1beta/models/m:streamGenerateContent': sse([{ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"title":' }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 5, thoughtsTokenCount: 20 } }, { candidates: [{ content: { parts: [{ text: '"C"}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 200, candidatesTokenCount: 120, thoughtsTokenCount: 80 } }]),
};
STREAMS['/noschema/chat/completions'] = STREAMS['/chat/completions'];
let server, base, seen = {}, requests = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      let path = req.url.split('?')[0]; seen[path] = { headers: req.headers, body: JSON.parse(body) };
      requests.push({ path, schema: !!seen[path].body.response_format });
      if (path === '/noschema/chat/completions' && seen[path].body.response_format) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"response_format json_schema is not supported"}}'); }
      if (path === '/fail/chat/completions') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
      if (path === '/flaky/chat/completions' && requests.filter(q => q.path === path).length <= 2) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0.2' }); return res.end('{"error":{"message":"high demand"}}'); }
      if (path === '/busy/chat/completions') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down","details":[{"retryDelay":"0.1s"}]}}'); }
      if (path === '/flaky/chat/completions') path = '/chat/completions';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // split the stream at an awkward place to test buffering across chunks
      const s = STREAMS[path] || ''; res.write(s.slice(0, 17)); setTimeout(() => res.end(s.slice(17)), 5);
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const parts = [{ type: 'text', text: 'hi' }, { type: 'pdf', base64: 'UERG' }, { type: 'image', dataUrl: 'data:image/png;base64,iVBO' }];

test('anthropic stream', async () => {
  const { text, usage } = await callModel('anthropic', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'x' });
  assert.equal(text, '{"title":"A"}');
  assert.deepEqual(usage, { input: 150, cachedInput: 40, output: 250, reasoning: 0 }); // input = fresh + cache read + cache write; output is the final cumulative count
  const b = seen['/v1/messages'];
  assert.equal(b.headers['x-api-key'], 'k');
  assert.equal(b.body.stream, true);
  assert.deepEqual(b.body.messages[0].content.map(c => c.type), ['text', 'document', 'image']);
  assert.deepEqual(b.body.system, [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]); // the cached prefix
});

test('openai-compatible stream drops the pdf part', async () => {
  const { text, usage } = await callModel('compat', { system: 's', parts, baseUrl: base, model: 'x' });
  assert.equal(text, '{"title":"B"}');
  assert.deepEqual(usage, { input: 200, cachedInput: 128, output: 300, reasoning: 100 });
  assert.equal(seen['/chat/completions'].body.stream_options.include_usage, true);
  const b = seen['/chat/completions'].body;
  assert.deepEqual(b.messages[1].content.map(c => c.type), ['text', 'image_url']);
  assert.equal(seen['/chat/completions'].headers.authorization, undefined); // no key → no header
});

test('gemini stream skips thought parts', async () => {
  const { text, usage } = await callModel('gemini', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'm' });
  assert.equal(text, '{"title":"C"}');
  assert.deepEqual(usage, { input: 500, cachedInput: 200, output: 200, reasoning: 80 }); // the last chunk wins; thoughts are billed as output
  assert.equal(seen['/v1beta/models/m:streamGenerateContent'].body.generationConfig.responseMimeType, 'application/json');
});

test('output cap and reasoning go to each API in its own words; unknown models get no reasoning setting', async () => {
  await callModel('openai', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'x', maxTokens: 9000, reasoning: { effort: 'low' } });
  let b = seen['/chat/completions'].body;
  assert.equal(b.max_completion_tokens, 9000); assert.equal(b.reasoning_effort, 'low');
  await callModel('compat', { system: 's', parts, baseUrl: base, model: 'x', maxTokens: 9000, reasoning: { effort: 'low' } });
  b = seen['/chat/completions'].body;
  assert.equal(b.max_tokens, 9000); assert.equal(b.reasoning_effort, undefined); // a local server may not know it
  await callModel('gemini', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'm', maxTokens: 5000, reasoning: { budget: 1024 } });
  const cfg = () => seen['/v1beta/models/m:streamGenerateContent'].body.generationConfig;
  assert.equal(cfg().maxOutputTokens, 5000); assert.deepEqual(cfg().thinkingConfig, { thinkingBudget: 1024 });
  assert.equal(cfg().mediaResolution, 'MEDIA_RESOLUTION_MEDIUM'); // an image at Gemini's default level costs two PDF pages
  await callModel('gemini', { system: 's', parts: parts.slice(0, 1), apiKey: 'k', baseUrl: base, model: 'm' });
  assert.equal(cfg().thinkingConfig, undefined); assert.equal(cfg().mediaResolution, undefined);
});

test('a JSON schema goes to each API its own way; a server that refuses it is asked again without, once', async () => {
  const schema = { type: 'object', properties: { title: { type: 'string' }, log: { type: 'boolean' }, kind: { type: 'string', enum: ['cover'] } }, required: ['title'], additionalProperties: false };
  const { text } = await callModel('anthropic', { system: 's', parts, apiKey: 'k', baseUrl: base + '/tool', model: 'x', schema });
  assert.equal(text, '{"title":"T"}'); // the forced tool's input, streamed as input_json_delta
  let b = seen['/tool/v1/messages'].body;
  assert.deepEqual([b.tools[0].input_schema, b.tool_choice], [schema, { type: 'tool', name: 'answer' }]);
  await callModel('openai', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'x', schema });
  const rf = seen['/chat/completions'].body.response_format;
  assert.deepEqual([rf.type, rf.json_schema.strict, rf.json_schema.schema.required], ['json_schema', true, ['title', 'log', 'kind']]); // strict: every key listed…
  assert.deepEqual([rf.json_schema.schema.properties.log.type, rf.json_schema.schema.properties.kind.enum], [['boolean', 'null'], ['cover', null]]); // …optional ones nullable
  await callModel('compat', { system: 's', parts, baseUrl: base, model: 'x', schema });
  assert.deepEqual(seen['/chat/completions'].body.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema } }); // Ollama, llama.cpp: as is
  await callModel('gemini', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'm', schema });
  assert.deepEqual(seen['/v1beta/models/m:streamGenerateContent'].body.generationConfig.responseJsonSchema, schema);
  await callModel('compat', { system: 's', parts, baseUrl: base, model: 'x' });
  assert.equal(seen['/chat/completions'].body.response_format, undefined); // no schema: nothing asked of a local server
  requests = []; const notes = [];
  const r = await callModel('compat', { system: 's', parts, baseUrl: base + '/noschema', model: 'x', schema, onNote: n => notes.push(n) });
  assert.equal(r.text, '{"title":"B"}');
  await callModel('compat', { system: 's', parts, baseUrl: base + '/noschema', model: 'x', schema });
  assert.deepEqual(requests.map(q => q.schema), [true, false, false]); // refused once, then not sent again
  assert.match(notes[0], /refused the JSON schema/);
});

test('claude-cli: claude -p without tools, our system prompt from a file, the schema as --json-schema, the answer and usage from its JSON', async () => {
  process.env.CLAUDE_CLI_CMD = 'node ' + fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
  try {
    const { text, usage } = await callModel('claude-cli', { system: 'rules', parts, model: 'haiku', schema: { type: 'object' } });
    const a = JSON.parse(text), arg = f => a.args[a.args.indexOf(f) + 1];
    assert.deepEqual([a.input, a.system], ['hi', 'rules']); // text only: the pdf and image parts stay behind
    assert.deepEqual([arg('--output-format'), arg('--tools'), arg('--model'), JSON.parse(arg('--json-schema'))], ['json', '', 'haiku', { type: 'object' }]);
    for (const f of ['-p', '--safe-mode', '--no-session-persistence']) assert.ok(a.args.includes(f), f);
    assert.deepEqual(usage, { input: 15, cachedInput: 5, output: 7, reasoning: 0 });
    await assert.rejects(callModel('claude-cli', { system: 's', parts: [{ type: 'text', text: 'fail' }] }), /-p failed.*overloaded/);
  } finally { delete process.env.CLAUDE_CLI_CMD; }
});

test('a transient failure is tried again: Retry-After respected, 3 retries at most, a 4xx about the request never', async () => {
  requests = []; const notes = [], t0 = Date.now();
  const r = await callModel('compat', { system: 's', parts, baseUrl: base + '/flaky', model: 'x', onNote: n => notes.push(n) });
  assert.equal(r.text, '{"title":"B"}'); // two 503s, then the answer
  assert.ok(Date.now() - t0 >= 380, 'waited Retry-After (0.2 s) twice'); // longer than RETRY.delays
  assert.equal(notes.length, 2); assert.match(notes[0], /^503 .*high demand — trying again in 0 s \(1\/3\)/);
  requests = []; const t1 = Date.now();
  await assert.rejects(callModel('compat', { system: 's', parts, baseUrl: base + '/busy', model: 'x' }), /^Error: 429 .*slow down/);
  assert.equal(requests.length, 4); assert.ok(Date.now() - t1 >= 280); // Gemini's retryDelay in the body counts as Retry-After
  requests = [];
  await assert.rejects(callModel('compat', { system: 's', parts, baseUrl: base + '/fail', model: 'x' }), /401/);
  assert.equal(requests.length, 1);
  const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const port = closed.address().port; closed.close();
  const n = []; await assert.rejects(callModel('compat', { system: 's', parts, baseUrl: `http://127.0.0.1:${port}`, model: 'x', onNote: m => n.push(m) }), /fetch failed/);
  assert.equal(n.length, 3); // a refused connection: 3 retries
  const ac = new AbortController(); RETRY.delays = [5000]; setTimeout(() => ac.abort(), 50);
  try { await assert.rejects(callModel('compat', { system: 's', parts, baseUrl: base + '/busy', model: 'x', signal: ac.signal }), /abort/i); } finally { RETRY.delays = [1, 1, 1]; } // cancel stops the wait
});

test('HTTP errors surface the provider message', async () => {
  await assert.rejects(callModel('compat', { system: 's', parts, baseUrl: base + '/fail', model: 'x' }), /401.*bad key/);
  await assert.rejects(callModel('anthropic', { system: 's', parts, apiKey: '', model: 'x' }), /No Anthropic API key/);
});

test('Claude Code stream-json events become log lines', () => {
  assert.equal(describeClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'books/x/book.json' } }] } }), '→ Write books/x/book.json');
  assert.equal(describeClaudeEvent({ type: 'result', subtype: 'success', num_turns: 4 }), 'agent finished (success, 4 turns)');
  assert.equal(describeClaudeEvent({ type: 'system' }), null);
});

test('usage is null when the server reports none', async () => {
  const { text, usage } = await callModel('compat', { system: 's', parts, baseUrl: base + '/nousage', model: 'x' });
  assert.equal(text, '{}');
  assert.equal(usage, null);
});

test('usage helpers: sum, skip null, format', () => {
  const total = addUsage(addUsage(emptyUsage(), { input: 1000, cachedInput: 400, output: 50, reasoning: 20 }), null);
  assert.deepEqual(addUsage(total, { input: 1, cachedInput: 0, output: 2, reasoning: 0 }), { input: 1001, cachedInput: 400, output: 52, reasoning: 20 });
  assert.equal(fmtUsage(total), 'in 1,000 (cached 400) · out 50 (reasoning 20)');
  assert.equal(fmtUsage({ input: 5, cachedInput: 0, output: 6, reasoning: 0 }), 'in 5 · out 6');
  assert.equal(fmtUsage(null), 'usage not reported');
});

test('Claude Code result event carries the run usage', () => {
  assert.deepEqual(claudeUsage({ type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 } }), { input: 17, cachedInput: 5, output: 7, reasoning: 0 });
  assert.equal(claudeUsage({ type: 'result' }), null);
  assert.equal(claudeUsage({ type: 'assistant', usage: { input_tokens: 1 } }), null);
});
