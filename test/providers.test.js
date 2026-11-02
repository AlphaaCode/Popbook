// Streaming parsers checked against a fake local server (no network, no keys).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callModel, describeClaudeEvent } from '../lib/providers.js';

const sse = events => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const STREAMS = {
  '/v1/messages': sse([{ type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"title":' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '"A"}' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]),
  '/chat/completions': sse([{ choices: [{ delta: { content: '{"title":' } }] }, { choices: [{ delta: { content: '"B"}' }, finish_reason: 'stop' }] }, '[DONE]']),
  '/v1beta/models/m:streamGenerateContent': sse([{ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"title":' }] } }] }, { candidates: [{ content: { parts: [{ text: '"C"}' }] }, finishReason: 'STOP' }] }]),
};
let server, base, seen = {};
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const path = req.url.split('?')[0]; seen[path] = { headers: req.headers, body: JSON.parse(body) };
      if (path === '/fail/chat/completions') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
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
  const out = await callModel('anthropic', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'x' });
  assert.equal(out, '{"title":"A"}');
  const b = seen['/v1/messages'];
  assert.equal(b.headers['x-api-key'], 'k');
  assert.equal(b.body.stream, true);
  assert.deepEqual(b.body.messages[0].content.map(c => c.type), ['text', 'document', 'image']);
});

test('openai-compatible stream drops the pdf part', async () => {
  const out = await callModel('compat', { system: 's', parts, baseUrl: base, model: 'x' });
  assert.equal(out, '{"title":"B"}');
  const b = seen['/chat/completions'].body;
  assert.deepEqual(b.messages[1].content.map(c => c.type), ['text', 'image_url']);
  assert.equal(seen['/chat/completions'].headers.authorization, undefined); // no key → no header
});

test('gemini stream skips thought parts', async () => {
  const out = await callModel('gemini', { system: 's', parts, apiKey: 'k', baseUrl: base, model: 'm' });
  assert.equal(out, '{"title":"C"}');
  assert.equal(seen['/v1beta/models/m:streamGenerateContent'].body.generationConfig.responseMimeType, 'application/json');
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
