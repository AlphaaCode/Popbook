// Model providers. callModel() returns the model's text; runAgent() drives a local coding agent.
// parts: [{ type:'text', text } | { type:'pdf', base64 } | { type:'image', dataUrl }]
import { spawn, execFileSync } from 'node:child_process';

export const PROVIDERS = {
  anthropic: { label: 'Claude API (Anthropic)', env: 'ANTHROPIC_API_KEY', model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5', pdf: true, images: true },
  openai: { label: 'OpenAI API', env: 'OPENAI_API_KEY', model: process.env.OPENAI_MODEL || 'gpt-4.1', pdf: false, images: true },
  gemini: { label: 'Google Gemini API', env: 'GEMINI_API_KEY', model: process.env.GEMINI_MODEL || 'gemini-2.5-pro', pdf: true, images: true },
  compat: { label: 'OpenAI-compatible (Ollama, LM Studio, OpenRouter, Groq…)', env: 'COMPAT_API_KEY', model: process.env.COMPAT_MODEL || 'qwen2.5:14b', pdf: false, images: false, baseUrl: process.env.COMPAT_BASE_URL || 'http://localhost:11434/v1' },
  'agent-claude': { label: 'Claude Code (local agent, no API key)', agent: 'claude' },
  'agent-codex': { label: 'Codex CLI (local agent)', agent: 'codex' },
  'agent-gemini': { label: 'Gemini CLI (local agent)', agent: 'gemini' },
};
if (process.env.POPBOOK_MOCK === '1') PROVIDERS.mock = { label: 'Mock (returns the example book — for testing)', model: 'mock' };

const agentBin = which => (process.env['AGENT_CMD_' + which.toUpperCase()] || which).trim().split(/\s+/)[0];
export function hasBinary(bin) { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } }
export const agentAvailable = which => hasBinary(agentBin(which));

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

export async function callModel(provider, { system, parts, model, apiKey, baseUrl, maxTokens = 32000, signal, onProgress = () => {} }) {
  const P = PROVIDERS[provider]; if (!P || P.agent) throw new Error('Provider ' + provider + ' is not an API provider');
  const key = apiKey || process.env[P.env] || '';
  model = model || P.model;
  let out = '', stop = '';
  const add = t => { if (t) { out += t; onProgress(out.length); } };

  if (provider === 'anthropic') {
    if (!key) throw new Error('No Anthropic API key: paste one in the studio or set ANTHROPIC_API_KEY in .env');
    const content = parts.map(p => p.type === 'text' ? { type: 'text', text: p.text }
      : p.type === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mime(p.dataUrl), data: b64(p.dataUrl) } });
    await postStream((baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], stream: true }, signal, ev => {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') add(ev.delta.text);
        else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        else if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
      });
    if (stop === 'max_tokens') onProgress(out.length, 'hit max_tokens');
    return out;
  }
  if (provider === 'openai' || provider === 'compat') {
    if (!key && provider === 'openai') throw new Error('No OpenAI API key: paste one in the studio or set OPENAI_API_KEY in .env');
    const url = (baseUrl || P.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
    const content = parts.filter(p => p.type !== 'pdf').map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } });
    const body = { model, stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: content.every(c => c.type === 'text') ? content.map(c => c.text).join('\n\n') : content }] };
    if (provider === 'openai') { body.response_format = { type: 'json_object' }; body.max_completion_tokens = maxTokens; } else body.max_tokens = Math.min(maxTokens, 16000);
    await postStream(url, key ? { authorization: 'Bearer ' + key } : {}, body, signal, ev => {
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      add(ev.choices?.[0]?.delta?.content); if (ev.choices?.[0]?.finish_reason) stop = ev.choices[0].finish_reason;
    });
    if (stop === 'length') onProgress(out.length, 'hit max_tokens');
    return out;
  }
  if (provider === 'gemini') {
    if (!key) throw new Error('No Gemini API key: paste one in the studio or set GEMINI_API_KEY in .env');
    const gparts = parts.map(p => p.type === 'text' ? { text: p.text } : p.type === 'pdf' ? { inline_data: { mime_type: 'application/pdf', data: p.base64 } } : { inline_data: { mime_type: mime(p.dataUrl), data: b64(p.dataUrl) } });
    const url = `${(baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    await postStream(url, { 'x-goog-api-key': key }, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: gparts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens } }, signal, ev => {
      (ev.candidates?.[0]?.content?.parts || []).forEach(p => { if (!p.thought) add(p.text); });
      if (ev.candidates?.[0]?.finishReason) stop = ev.candidates[0].finishReason;
    });
    if (stop === 'MAX_TOKENS') onProgress(out.length, 'hit max_tokens');
    return out;
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

/** Runs a local coding agent (Claude Code, Codex, Gemini CLI) in the repo folder. Streams its output to onLine. */
export function runAgent(provider, { prompt, cwd, onLine, model, signal }) {
  const which = PROVIDERS[provider].agent;
  if (model && !/^[\w.:/-]+$/.test(model)) { onLine(`ignoring model "${model}" (unexpected characters)`); model = ''; }
  const cmds = {
    claude: ['claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Write,Edit,MultiEdit,Glob,Grep,Bash(node tools/check.mjs:*),Bash(node tools/pdf2pages.mjs:*)', ...(model ? ['--model', model] : [])]],
    codex: ['codex', ['exec', '--full-auto', ...(model ? ['-m', model] : []), prompt]],
    gemini: ['gemini', ['-p', prompt, '--yolo', ...(model ? ['-m', model] : [])]],
  };
  const custom = process.env['AGENT_CMD_' + which.toUpperCase()];
  const [bin, args] = custom ? [custom.trim().split(/\s+/)[0], [...custom.trim().split(/\s+/).slice(1), prompt]] : cmds[which];
  const win = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    // on Windows npm-installed CLIs are .cmd shims, which only start through the shell
    const ch = win ? spawn([bin, ...args].map(winQuote).join(' '), { cwd, env: process.env, shell: true, windowsHide: true })
      : spawn(bin, args, { cwd, env: process.env });
    let pending = '';
    const feed = buf => { pending += String(buf); const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; let msg = l;
        if (which === 'claude' && !custom && l.startsWith('{')) { try { msg = describeClaudeEvent(JSON.parse(l)); } catch {} }
        if (msg) msg.split('\n').forEach(m => onLine(m)); } };
    ch.stdout.on('data', feed); ch.stderr.on('data', feed);
    ch.on('error', e => reject(new Error(`Could not start "${bin}": ${e.message}. Is it installed and logged in?`)));
    ch.on('close', code => { if (pending.trim()) onLine(pending.trim()); code === 0 ? resolve() : reject(new Error(signal?.aborted ? 'Cancelled' : `${bin} exited with code ${code}`)); });
    signal?.addEventListener('abort', () => { if (win) spawn('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { windowsHide: true }); else ch.kill(); });
  });
}
