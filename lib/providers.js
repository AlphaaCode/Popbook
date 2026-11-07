// Model providers. callModel() returns { text, usage }; runAgent() drives a local coding agent and returns { usage }.
// parts: [{ type:'text', text } | { type:'pdf', base64 } | { type:'image', dataUrl }]
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { countTokens } from './estimate.js';

export const PROVIDERS = {
  anthropic: { label: 'Claude API (Anthropic)', env: 'ANTHROPIC_API_KEY', model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5', pdf: true, images: true },
  openai: { label: 'OpenAI API', env: 'OPENAI_API_KEY', model: process.env.OPENAI_MODEL || 'gpt-6-astra', pdf: false, images: true },
  gemini: { label: 'Google Gemini API', env: 'GEMINI_API_KEY', model: process.env.GEMINI_MODEL || 'gemini-4-argon', pdf: true, images: true },
  compat: { label: 'OpenAI-compatible (Ollama, LM Studio, OpenRouter, Groq…)', env: 'COMPAT_API_KEY', model: process.env.COMPAT_MODEL || 'qwen2.5:14b', pdf: false, images: false, baseUrl: process.env.COMPAT_BASE_URL || 'http://localhost:11434/v1' },
  'agent-claude': { label: 'Claude Code (local agent, no API key)', agent: 'claude' },
  'agent-codex': { label: 'Codex CLI (local agent)', agent: 'codex' },
  'agent-gemini': { label: 'Gemini CLI (local agent)', agent: 'gemini' },
};
if (process.env.POPBOOK_MOCK === '1') PROVIDERS.mock = { label: 'Mock (returns the example book — for testing)', model: 'mock' };

const agentBin = which => (process.env['AGENT_CMD_' + which.toUpperCase()] || which).trim().split(/\s+/)[0];
export function hasBinary(bin) { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } }
export const agentAvailable = which => hasBinary(agentBin(which));

/* Token usage, the same shape for every API: input = all prompt tokens (cache hits included), cachedInput = the part
 * served from cache, output = all generated tokens (reasoning included), reasoning = the part spent thinking.
 * null means "the provider did not say". */
export const emptyUsage = () => ({ input: 0, cachedInput: 0, output: 0, reasoning: 0 });
export const addUsage = (a, b) => b ? { input: a.input + b.input, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output, reasoning: a.reasoning + b.reasoning } : a;
const num = v => Number(v || 0).toLocaleString('en-US');
export const fmtUsage = u => u ? `in ${num(u.input)}${u.cachedInput ? ` (cached ${num(u.cachedInput)})` : ''} · out ${num(u.output)}${u.reasoning ? ` (reasoning ${num(u.reasoning)})` : ''}` : 'usage not reported';

const b64 = dataUrl => dataUrl.slice(dataUrl.indexOf(',') + 1);
const mime = dataUrl => /^data:([^;]+);/.exec(dataUrl)?.[1] || 'image/jpeg';

/** POSTs JSON and reads a server-sent-event stream, calling onEvent(json) per `data:` line. Streaming keeps long
 *  generations alive (Node's fetch gives up after 5 minutes without response headers or body data). */
async function postStream(url, headers, body, signal, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const txt = await res.text(); let msg = txt;
    try { const j = JSON.parse(txt); msg = j.error?.message || j.message || (Array.isArray(j) && j[0]?.error?.message) || txt; } catch {}
    throw new Error(`${res.status} ${res.statusText}: ${String(msg).slice(0, 600)}`);
  }
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      onEvent(ev);
    }
  }
}

/** reasoning: { effort } (OpenAI reasoning_effort) or { budget } (Gemini thinking tokens), from lib/models.js REASONING; omitted = the model's default. */
export async function callModel(provider, { system, parts, model, apiKey, baseUrl, maxTokens = 32000, reasoning, signal, onProgress = () => {} }) {
  const P = PROVIDERS[provider]; if (!P || P.agent) throw new Error('Provider ' + provider + ' is not an API provider');
  const key = apiKey || process.env[P.env] || '';
  model = model || P.model;
  let out = '', stop = '', usage = null;
  const add = t => { if (t) { out += t; onProgress(out.length); } };

  if (provider === 'mock') { // the example book, so parsing, validation and usage accounting run offline
    const text = JSON.stringify(JSON.parse(readFileSync(new URL('../books/calcul-parallele/book.json', import.meta.url), 'utf8')));
    add(text);
    return { text, usage: { input: countTokens(system) + parts.reduce((s, p) => s + (p.type === 'text' ? countTokens(p.text) : 0), 0), cachedInput: 0, output: countTokens(text), reasoning: 0 } };
  }

  if (provider === 'anthropic') {
    if (!key) throw new Error('No Anthropic API key: paste one in the studio or set ANTHROPIC_API_KEY in .env');
    const content = parts.map(p => p.type === 'text' ? { type: 'text', text: p.text }
      : p.type === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mime(p.dataUrl), data: b64(p.dataUrl) } });
    await postStream((baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // the system prompt is the same on every call: cache it (a later read costs 0.1× the input price, this write 1.25×)
      { model, max_tokens: maxTokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content }], stream: true }, signal, ev => {
        if (ev.type === 'message_start' && ev.message?.usage) { const u = ev.message.usage, hit = u.cache_read_input_tokens || 0;
          usage = { input: (u.input_tokens || 0) + hit + (u.cache_creation_input_tokens || 0), cachedInput: hit, output: u.output_tokens || 0, reasoning: 0 }; }
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') add(ev.delta.text);
        else if (ev.type === 'message_delta') { if (ev.delta?.stop_reason) stop = ev.delta.stop_reason; if (usage && ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens; } // output_tokens is cumulative
        else if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
      });
    if (stop === 'max_tokens') onProgress(out.length, 'hit max_tokens');
    return { text: out, usage };
  }
  if (provider === 'openai' || provider === 'compat') {
    if (!key && provider === 'openai') throw new Error('No OpenAI API key: paste one in the studio or set OPENAI_API_KEY in .env');
    const url = (baseUrl || P.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
    const content = parts.filter(p => p.type !== 'pdf').map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } });
    const body = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, { role: 'user', content: content.every(c => c.type === 'text') ? content.map(c => c.text).join('\n\n') : content }] };
    if (provider === 'openai') { body.response_format = { type: 'json_object' }; body.max_completion_tokens = maxTokens; if (reasoning?.effort) body.reasoning_effort = reasoning.effort; } else body.max_tokens = Math.min(maxTokens, 16000);
    await postStream(url, key ? { authorization: 'Bearer ' + key } : {}, body, signal, ev => {
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      add(ev.choices?.[0]?.delta?.content); if (ev.choices?.[0]?.finish_reason) stop = ev.choices[0].finish_reason;
      if (ev.usage) { const u = ev.usage; // the last chunk, sent because of include_usage
        usage = { input: u.prompt_tokens || 0, cachedInput: u.prompt_tokens_details?.cached_tokens || 0, output: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0 }; }
    });
    if (stop === 'length') onProgress(out.length, 'hit max_tokens');
    return { text: out, usage };
  }
  if (provider === 'gemini') {
    if (!key) throw new Error('No Gemini API key: paste one in the studio or set GEMINI_API_KEY in .env');
    const gparts = parts.map(p => p.type === 'text' ? { text: p.text } : p.type === 'pdf' ? { inline_data: { mime_type: 'application/pdf', data: p.base64 } } : { inline_data: { mime_type: mime(p.dataUrl), data: b64(p.dataUrl) } });
    const url = `${(baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    await postStream(url, { 'x-goog-api-key': key }, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: gparts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens, ...(reasoning?.budget != null && { thinkingConfig: { thinkingBudget: reasoning.budget } }) } }, signal, ev => {
      (ev.candidates?.[0]?.content?.parts || []).forEach(p => { if (!p.thought) add(p.text); });
      if (ev.candidates?.[0]?.finishReason) stop = ev.candidates[0].finishReason;
      if (ev.usageMetadata) { const u = ev.usageMetadata, th = u.thoughtsTokenCount || 0; // cumulative: the last chunk wins; thoughts are billed as output
        usage = { input: u.promptTokenCount || 0, cachedInput: u.cachedContentTokenCount || 0, output: (u.candidatesTokenCount || 0) + th, reasoning: th }; }
    });
    if (stop === 'MAX_TOKENS') onProgress(out.length, 'hit max_tokens');
    return { text: out, usage };
  }
  throw new Error('Unknown provider ' + provider);
}

/* ---------- local agents ---------- */
// cmd.exe quoting for the few, controlled arguments we pass (no user text: the prompt lives in a file)
const winQuote = a => /^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;

/** One line of Claude Code's stream-json output → a short human log line (or null). */
export function describeClaudeEvent(ev) {
  if (ev.type === 'assistant') return (ev.message?.content || []).map(c => {
    if (c.type === 'text' && c.text.trim()) return c.text.trim().split('\n')[0].slice(0, 200);
    if (c.type === 'tool_use') { const i = c.input || {}; return `→ ${c.name} ${i.file_path || i.command || i.pattern || i.path || ''}`.trim().slice(0, 200); }
    return null;
  }).filter(Boolean).join('\n') || null;
  if (ev.type === 'result') return `agent finished (${ev.subtype}${ev.num_turns ? `, ${ev.num_turns} turns` : ''}${ev.total_cost_usd ? `, $${ev.total_cost_usd.toFixed(2)}` : ''})`;
  return null;
}

/** Claude Code's final `result` event → usage for the whole run (null when absent). Codex and Gemini CLI print no usage in text mode. */
export function claudeUsage(ev) {
  const u = ev?.type === 'result' && ev.usage; if (!u) return null;
  const hit = u.cache_read_input_tokens || 0;
  return { input: (u.input_tokens || 0) + hit + (u.cache_creation_input_tokens || 0), cachedInput: hit, output: u.output_tokens || 0, reasoning: 0 };
}

/** Runs a local coding agent (Claude Code, Codex, Gemini CLI) in the repo folder. Streams its output to onLine. Resolves { usage }. */
export function runAgent(provider, { prompt, cwd, onLine, model, signal }) {
  const which = PROVIDERS[provider].agent;
  if (model && !/^[\w.:/-]+$/.test(model)) { onLine(`ignoring model "${model}" (unexpected characters)`); model = ''; }
  const cmds = {
    claude: ['claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Write,Edit,MultiEdit,Glob,Grep,Bash(node tools/check.mjs:*),Bash(node tools/pdf2pages.mjs:*),PowerShell(node tools/check.mjs:*),PowerShell(node tools/pdf2pages.mjs:*)', ...(model ? ['--model', model] : [])]],
    codex: ['codex', ['exec', '--full-auto', ...(model ? ['-m', model] : []), prompt]],
    gemini: ['gemini', ['-p', prompt, '--yolo', ...(model ? ['-m', model] : [])]],
  };
  const custom = process.env['AGENT_CMD_' + which.toUpperCase()];
  const [bin, args] = custom ? [custom.trim().split(/\s+/)[0], [...custom.trim().split(/\s+/).slice(1), prompt]] : cmds[which];
  const win = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    // on Windows npm-installed CLIs are .cmd shims, which only start through the shell
    const ch = win ? spawn([bin, ...args].map(winQuote).join(' '), { cwd, env: process.env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', usage = null;
    const feed = buf => { pending += String(buf); const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; let msg = l;
        if (which === 'claude' && !custom && l.startsWith('{')) { try { const ev = JSON.parse(l); usage = claudeUsage(ev) || usage; msg = describeClaudeEvent(ev); } catch {} }
        if (msg) msg.split('\n').forEach(m => onLine(m)); } };
    ch.stdout.on('data', feed); ch.stderr.on('data', feed);
    ch.on('error', e => reject(new Error(`Could not start "${bin}": ${e.message}. Is it installed and logged in?`)));
    ch.on('close', code => { if (pending.trim()) onLine(pending.trim()); code === 0 ? resolve({ usage }) : reject(new Error(signal?.aborted ? 'Cancelled' : `${bin} exited with code ${code}`)); });
    signal?.addEventListener('abort', () => { if (win) spawn('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { windowsHide: true }); else ch.kill(); });
  });
}
