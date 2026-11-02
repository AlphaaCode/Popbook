// Model providers. Each takes { system, parts, model, apiKey, baseUrl, maxTokens } and returns the model's text.
// parts: [{ type:'text', text } | { type:'pdf', base64 } | { type:'image', dataUrl }]
import { spawn, execFileSync } from 'node:child_process';

export const PROVIDERS = {
  anthropic: { label: 'Claude API (Anthropic)', env: 'ANTHROPIC_API_KEY', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', pdf: true, images: true },
  openai: { label: 'OpenAI API', env: 'OPENAI_API_KEY', model: process.env.OPENAI_MODEL || 'gpt-4.1', pdf: false, images: true },
  gemini: { label: 'Google Gemini API', env: 'GEMINI_API_KEY', model: process.env.GEMINI_MODEL || 'gemini-2.5-pro', pdf: true, images: true },
  compat: { label: 'OpenAI-compatible (Ollama, LM Studio, OpenRouter, Groq…)', env: 'COMPAT_API_KEY', model: process.env.COMPAT_MODEL || 'qwen2.5:14b', pdf: false, images: false, baseUrl: process.env.COMPAT_BASE_URL || 'http://localhost:11434/v1' },
  'agent-claude': { label: 'Claude Code (local agent, no API key)', agent: 'claude' },
  'agent-codex': { label: 'Codex CLI (local agent)', agent: 'codex' },
  'agent-gemini': { label: 'Gemini CLI (local agent)', agent: 'gemini' },
};
if (process.env.POPBOOK_MOCK === '1') PROVIDERS.mock = { label: 'Mock (returns the example book — for testing)', model: 'mock' };

export function hasBinary(bin) { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } }

const b64 = dataUrl => dataUrl.slice(dataUrl.indexOf(',') + 1);
const mime = dataUrl => /^data:([^;]+);/.exec(dataUrl)?.[1] || 'image/jpeg';

async function post(url, headers, body, signal) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const txt = await res.text();
  if (!res.ok) { let msg = txt; try { const j = JSON.parse(txt); msg = j.error?.message || j.message || txt; } catch {} throw new Error(`${res.status} ${res.statusText}: ${String(msg).slice(0, 600)}`); }
  return JSON.parse(txt);
}

export async function callModel(provider, { system, parts, model, apiKey, baseUrl, maxTokens = 32000, signal }) {
  const P = PROVIDERS[provider]; if (!P) throw new Error('Unknown provider ' + provider);
  const key = apiKey || process.env[P.env] || '';
  model = model || P.model;
  if (provider === 'anthropic') {
    if (!key) throw new Error('No Anthropic API key: paste one in the studio or set ANTHROPIC_API_KEY in .env');
    const content = parts.map(p => p.type === 'text' ? { type: 'text', text: p.text }
      : p.type === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mime(p.dataUrl), data: b64(p.dataUrl) } });
    const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], stream: false };
    const j = await post((baseUrl || 'https://api.anthropic.com') + '/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body, signal);
    return j.content.filter(c => c.type === 'text').map(c => c.text).join('');
  }
  if (provider === 'openai' || provider === 'compat') {
    if (!key && provider === 'openai') throw new Error('No OpenAI API key: paste one in the studio or set OPENAI_API_KEY in .env');
    const url = (baseUrl || P.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
    const content = parts.filter(p => p.type !== 'pdf').map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } });
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: content.every(c => c.type === 'text') ? content.map(c => c.text).join('\n\n') : content }] };
    if (provider === 'openai') { body.response_format = { type: 'json_object' }; body.max_completion_tokens = maxTokens; } else body.max_tokens = Math.min(maxTokens, 16000);
    const j = await post(url, key ? { authorization: 'Bearer ' + key } : {}, body, signal);
    return j.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    if (!key) throw new Error('No Gemini API key: paste one in the studio or set GEMINI_API_KEY in .env');
    const gparts = parts.map(p => p.type === 'text' ? { text: p.text } : p.type === 'pdf' ? { inline_data: { mime_type: 'application/pdf', data: p.base64 } } : { inline_data: { mime_type: mime(p.dataUrl), data: b64(p.dataUrl) } });
    const url = `${baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const j = await post(url, { 'x-goog-api-key': key }, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: gparts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens } }, signal);
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  }
  throw new Error('Provider ' + provider + ' is not an API provider');
}

/** Runs a local coding agent (Claude Code, Codex, Gemini CLI) in the repo folder. Streams output to onLine. */
export function runAgent(provider, { prompt, cwd, onLine, model, signal }) {
  const which = PROVIDERS[provider].agent;
  const cmds = {
    claude: ['claude', ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,MultiEdit,Glob,Grep,Bash(node tools/check.mjs:*),Bash(node tools/pdf2pages.mjs:*)', ...(model ? ['--model', model] : [])]],
    codex: ['codex', ['exec', '--full-auto', ...(model ? ['-m', model] : []), prompt]],
    gemini: ['gemini', ['-p', prompt, '--yolo', ...(model ? ['-m', model] : [])]],
  };
  const custom = process.env['AGENT_CMD_' + which.toUpperCase()];
  const [bin, args] = custom ? [custom.split(' ')[0], [...custom.split(' ').slice(1), prompt]] : cmds[which];
  return new Promise((resolve, reject) => {
    const ch = spawn(bin, args, { cwd, env: process.env, shell: process.platform === 'win32' });
    const feed = buf => String(buf).split(/\r?\n/).filter(Boolean).forEach(l => onLine(l));
    ch.stdout.on('data', feed); ch.stderr.on('data', feed);
    ch.on('error', e => reject(new Error(`Could not start "${bin}": ${e.message}. Is it installed and logged in?`)));
    ch.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)));
    signal?.addEventListener('abort', () => ch.kill());
  });
}
