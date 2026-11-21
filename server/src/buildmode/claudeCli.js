// @ts-check
// Build mode through the Claude Code CLI instead of the Messages API (SAS_BUILD_PROVIDER=cli): for running Build mode locally on
// the signed-in Claude subscription of the person at this computer, with no API key. Not for a hosted server: a personal
// subscription cannot power a product other people use, so a deployed server keeps the API (llm.js, agent.js).
//   - createCliLlm: the plan's structured calls, as `claude -p --json-schema …`, with every built-in tool switched off.
//   - spawnCli: the one way a CLI process is started (the build agent's loop is agentCli.js).
// The child never sees ANTHROPIC_API_KEY (the CLI would use it instead of the subscription), runs in a folder of its own outside
// the repository (so no project CLAUDE.md is read), and loads no MCP server but the ones it is given.
// Cost: the subscription is not billed per token, so nothing is counted toward the build or daily dollar limits (spend.js);
// the CLI's own list-price estimate is written to the server log.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LlmError } from './llm.js';

export const BUILD_PROVIDER = (process.env.SAS_BUILD_PROVIDER ?? '').trim().toLowerCase() === 'cli' ? 'cli' : 'api';

/** The CLI to run: SAS_CLAUDE_CLI, else the npm install's own binary on Windows (claude is a .ps1/.cmd shim there), else claude. */
export function cliCommand() {
  const set = (process.env.SAS_CLAUDE_CLI ?? '').trim();
  if (set) return set;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  return 'claude';
}

/** The child's environment: no API key (the subscription is used), and no marker that would make it think it runs inside Claude Code. */
export function cliEnv(/** @type {Record<string, string>} */ extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  return env;
}

/** A system prompt as text: a string, or the Messages API's system blocks. */
export const systemText = (/** @type {any} */ system) => (Array.isArray(system) ? system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n\n') : String(system ?? ''));

/** A folder of its own for one CLI run, outside the repository; removed by the caller. */
export const cliFolder = () => mkdtemp(path.join(os.tmpdir(), 'sas-claude-'));

/**
 * Starts the CLI. Its stdout is read line by line (onLine); stdin gets `input` and is closed.
 * @param {string[]} args
 * @param {{ input?: string, cwd: string, env?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number, onLine?: (line: string) => void }} o
 * @returns {{ done: Promise<{ code: number | null, stdout: string, stderr: string, killed: string | null }>, kill: (why: string) => void }}
 */
export function spawnCli(args, { input = '', cwd, env = {}, signal, timeoutMs, onLine }) {
  const child = spawn(cliCommand(), args, { cwd, env: cliEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  let pending = '';
  /** @type {string | null} */
  let killed = null;
  const kill = (/** @type {string} */ why) => {
    if (killed) return;
    killed = why;
    // On Windows the CLI's MCP children must go with it.
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    else child.kill('SIGTERM');
  };
  const timer = timeoutMs ? setTimeout(() => kill('timeout'), timeoutMs) : null;
  const onAbort = () => kill('stopped');
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
    if (!onLine) return;
    pending += d;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) onLine(l);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const notFound = /** @type {any} */ (err).code === 'ENOENT';
      reject(new LlmError(notFound
        ? `The Claude CLI was not found (${cliCommand()}). Install Claude Code, or set SAS_CLAUDE_CLI in server/.env to its path.`
        : `The Claude CLI could not start: ${err.message}`, 503, 'llm-unavailable'));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ code, stdout, stderr, killed });
    });
  });
  return { done, kill };
}

/** A CLI result line that failed, as an LlmError in the app's words. */
export function cliError(/** @type {any} */ result, /** @type {string} */ stderr) {
  const text = String(result?.result ?? result?.error ?? stderr ?? '').trim();
  if (result?.api_error_status === 401 || /log ?in|logged in|authenticat|\/login/i.test(text)) {
    return new LlmError('The Claude CLI is not signed in. Run "claude" in a terminal, sign in, then try again.', 503, 'llm-unavailable');
  }
  if (result?.api_error_status === 429 || /usage limit|rate limit/i.test(text)) {
    return new LlmError(`Claude's usage limit for this subscription was reached. ${text.slice(0, 200)}`, 429, 'llm-rate-limited');
  }
  return new LlmError(`The Claude CLI failed: ${text.slice(0, 300) || 'no answer'}`, 502, 'llm-error');
}

/** The last result line of a CLI run (stream-json or json output). */
export function lastResult(/** @type {string} */ stdout) {
  const lines = stdout.trim().split('\n').reverse();
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j?.type === 'result') return j;
    } catch { /* not JSON */ }
  }
  return null;
}

/**
 * The model that answered: the one asked for when it took part, else the one that wrote the most. The CLI also runs a small
 * model of its own for housekeeping, listed beside it in modelUsage.
 */
export function modelOf(/** @type {any} */ result, /** @type {string | undefined} */ asked) {
  const used = Object.entries(result?.modelUsage ?? {});
  if (asked && used.some(([id]) => id === asked || id.startsWith(`${asked}-`))) return asked;
  used.sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0));
  return used[0]?.[0] ?? asked ?? '';
}

/** Usage the subscription is not billed by: kept for the record, priced at nothing (see the header). */
export const FREE_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/**
 * The plan's structured calls through the CLI: the same contract as llm.js createLlm.
 * @param {{ model?: string }} [o]
 * @returns {import('./llm.js').Llm}
 */
export function createCliLlm({ model } = {}) {
  return {
    model: model ?? '',
    async structured({ system, user, schema, effort }) {
      const dir = await cliFolder();
      try {
        const sysFile = path.join(dir, 'system.txt');
        await writeFile(sysFile, systemText(system));
        const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt-file', sysFile,
          '--tools', '', '--strict-mcp-config', '--no-session-persistence', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
        const run = spawnCli(args, { input: user, cwd: dir, timeoutMs: 10 * 60000 });
        const { stdout, stderr, killed } = await run.done;
        if (killed === 'timeout') throw new LlmError('The Claude CLI did not answer within 10 minutes.', 504, 'llm-error');
        const result = lastResult(stdout);
        if (!result || result.is_error || result.subtype !== 'success') throw cliError(result, stderr);
        if (!result.structured_output || typeof result.structured_output !== 'object') throw new LlmError('Claude answered in an unexpected format.', 502, 'llm-bad-output');
        const used = modelOf(result, model);
        console.log(`[build cli] plan step: ${result.num_turns ?? 1} turn(s), ${Math.round((result.duration_ms ?? 0) / 1000)} s, list-price estimate $${(result.total_cost_usd ?? 0).toFixed(3)} (subscription, not billed per token)`);
        return { data: result.structured_output, model: used, usage: { ...FREE_USAGE } };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
