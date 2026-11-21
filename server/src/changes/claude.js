// @ts-check
// The one place the changes module asks Claude something. It only ever gets text back (a JSON content entry): no tools, no files,
// no web, no shell. Two ways, chosen by SAS_CHANGES_AI:
//   api : the Anthropic API with ANTHROPIC_API_KEY (the SDK build mode already uses)
//   cli : the Claude Code program and its sign-in (a Max plan on a laptop), run from an empty temporary folder with its own short
//         system prompt, no MCP servers and no tools, so nothing of this computer is read and nothing is changed
//   off : never (the changes module then uses its plain mapping)
// Unset: api when a key is set, else cli when the program is found, else off.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AI_TIMEOUT_MS = 4 * 60_000;
export const aiModel = () => (process.env.SAS_CHANGES_AI_MODEL ?? '').trim() || 'sonnet';
const API_MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };

export class AiError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AiError';
  }
}

/** The Claude Code program: SAS_CLAUDE_BIN / CLAUDE_BIN, else on Windows the real claude.exe behind npm's claude.cmd (Node cannot start a .cmd by name), else "claude". */
export function claudeBin() {
  const set = (process.env.SAS_CLAUDE_BIN || process.env.CLAUDE_BIN || '').trim().replace(/^"|"$/g, '');
  if (set) return set;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  return 'claude';
}

/** Which way is on: 'api' | 'cli' | 'off'. */
export function aiMode() {
  const m = (process.env.SAS_CHANGES_AI ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'api' || m === 'cli') return m;
  if ((process.env.ANTHROPIC_API_KEY ?? '').trim()) return 'api';
  const bin = claudeBin();
  return bin !== 'claude' || process.platform !== 'win32' ? 'cli' : 'off';
}

/**
 * One question, one text answer. Rejects with AiError (a sentence to show) when it cannot be asked or answered.
 * @param {{ system: string, prompt: string, timeoutMs?: number }} q
 * @returns {Promise<{ text: string, model: string, costUsd: number | null, ms: number, way: 'api' | 'cli' }>}
 */
export async function askClaude({ system, prompt, timeoutMs = AI_TIMEOUT_MS }) {
  const mode = aiMode();
  if (mode === 'off') throw new AiError('The AI is off (SAS_CHANGES_AI=off, or no ANTHROPIC_API_KEY and no Claude Code program found).');
  const t0 = Date.now();
  if (mode === 'api') return { ...(await askApi({ system, prompt, timeoutMs })), ms: Date.now() - t0, way: 'api' };
  return { ...(await askCli({ system, prompt, timeoutMs })), ms: Date.now() - t0, way: 'cli' };
}

async function askApi({ system, prompt, timeoutMs }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 1 });
  const model = API_MODELS[aiModel()] ?? aiModel();
  try {
    const res = await client.messages.create({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: prompt }] });
    const text = res.content.filter((c) => c.type === 'text').map((c) => /** @type {any} */ (c).text).join('');
    return { text, model, costUsd: null };
  } catch (err) {
    throw new AiError(`Claude (API) did not answer: ${String(/** @type {Error} */ (err)?.message ?? err).slice(0, 200)}`);
  }
}

async function askCli({ system, prompt, timeoutMs }) {
  // An empty folder of its own: no project instructions are read from where Remastly runs, and nothing can be written there.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-claude-'));
  try {
    const mcp = path.join(dir, 'mcp.json');
    await writeFile(mcp, '{"mcpServers":{}}');
    const args = [
      '-p', prompt, '--output-format', 'json', '--model', aiModel(), '--max-turns', '1',
      '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--mcp-config', mcp, '--no-session-persistence',
      '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task',
    ];
    const out = await new Promise((resolve, reject) => {
      const child = spawn(claudeBin(), args, { cwd: dir, env: process.env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new AiError(`Claude did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new AiError(`Could not start Claude Code (${e.message}). Install it and sign in, or set SAS_CLAUDE_BIN / ANTHROPIC_API_KEY.`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) return reject(new AiError(`Claude Code stopped (${code}): ${stderr.trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 300)));
        resolve(stdout);
      });
    });
    let j;
    try {
      j = JSON.parse(/** @type {string} */ (out));
    } catch {
      throw new AiError('Claude Code answered something that is not its JSON output.');
    }
    if (j.is_error) throw new AiError(`Claude Code: ${String(j.result ?? j.subtype ?? 'error').slice(0, 300)}`);
    return { text: String(j.result ?? ''), model: aiModel(), costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
