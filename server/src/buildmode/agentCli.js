// @ts-check
// The build agent driven by the Claude Code CLI (SAS_BUILD_PROVIDER=cli; see claudeCli.js for when this is allowed). The CLI is
// given no built-in tool at all (--tools "") and one MCP server, cliTools.js, whose four tools forward to the same toolbox the
// API loop uses (agent.js createToolbox): the confined editor, preview_site, check_site and finish with its rules. So what the
// agent may touch is decided by this code, not by the CLI's permissions.
// Limits: turns (counted per answer in the stream) and minutes are enforced by stopping the CLI; dollars are not, because the
// subscription is not billed per token (the CLI's list-price estimate goes to the server log). An agent that stops without
// finishing is reminded once (the same session, resumed), as in the API loop.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_EFFORT, createToolbox, toolsFor, workspaceNote } from './agent.js';
import { FREE_USAGE, cliError, cliFolder, lastResult, spawnCli, systemText } from './claudeCli.js';
import { listFiles } from './workspace.js';
import { LlmError } from './llm.js';

const TOOLS_SCRIPT = fileURLToPath(new URL('./cliTools.js', import.meta.url));
const SERVER = 'site';
const MAX_BODY = 5 * 1024 * 1024;

/** The editor's input as a plain JSON schema (the API knows it as a built-in tool type; MCP needs it spelled out). */
const EDITOR_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
    path: { type: 'string', description: 'Relative to the project root, e.g. index.html or css/site.css. "." lists the project.' },
    file_text: { type: 'string', description: 'create: the whole file.' },
    old_str: { type: 'string', description: 'str_replace: the exact text to replace; it must appear once.' },
    new_str: { type: 'string', description: 'str_replace: the text to put in its place.' },
    insert_line: { type: 'integer', description: 'insert: the line after which to insert (0 = the top).' },
    insert_text: { type: 'string', description: 'insert: the text to insert.' },
    view_range: { type: 'array', items: { type: 'integer' }, description: 'view: [first line, last line], -1 = to the end.' },
  },
  required: ['command', 'path'],
  additionalProperties: false,
};

/** The stack's tools as MCP tool definitions. */
export function mcpTools(/** @type {import('./stacks.js').BuildStack} */ stack, { audit = false } = {}) {
  return toolsFor(stack, { audit }).map((/** @type {any} */ t) => (t.type
    ? { name: t.name, description: 'View, create and edit the files of the project folder: view (a file, or a folder\'s file list), create (a whole file), str_replace (one exact, unique piece of text), insert (after a line).', inputSchema: EDITOR_SCHEMA }
    : { name: t.name, description: t.description, inputSchema: t.input_schema }));
}

/** A toolbox answer (text, or the Messages API's blocks) as MCP content. */
export function toMcp(/** @type {string | any[]} */ content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((b) => (b.type === 'image' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : { type: 'text', text: b.text ?? '' }));
}

/** The first message's text, as the CLI takes it (stdin), with the workspace note and what the tools are called here. */
function userText(/** @type {any[]} */ messages, /** @type {string} */ note, /** @type {string[]} */ names) {
  const text = messages.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text)));
  return [...text, note, `Here the tools are named ${names.map((n) => `mcp__${SERVER}__${n}`).join(', ')}; they are the ones described above, and the only tools you have.`].join('\n\n');
}

/**
 * Runs the agent through the CLI. The same contract as agent.js runAgent.
 * @param {{ prompt: { system: any, messages: any[] }, siteDir: string, fonts?: any, images?: any[], model?: string, onEvent?: (e: any) => void,
 *   signal?: AbortSignal, lim: any, preview?: any, stack: import('./stacks.js').BuildStack,
 *   tmp?: string, build?: any }} o
 */
export async function runAgentCli({ prompt, siteDir, fonts, images = [], model, onEvent = () => {}, signal, lim, preview, stack, tmp, build, existing = null, polish = null, assess = null }) {
  const toolbox = createToolbox({ siteDir, stack, lim, onEvent, signal, preview, tmp, build, existing, polish, assess });
  const token = randomBytes(24).toString('hex');
  /** @type {{ report: any, checks: any } | null} */
  let finished = null;

  // The tools' end of the line: loopback only, this run's token only.
  const server = http.createServer((req, res) => {
    const answer = (/** @type {number} */ status, /** @type {any} */ body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.headers['x-sas-token'] !== token) return answer(403, { content: [{ type: 'text', text: 'Refused.' }], isError: true });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      body += d;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { name, input } = JSON.parse(body);
        const out = await toolbox.call(String(name ?? '').replace(`mcp__${SERVER}__`, ''), input);
        if (out.finished) finished = out.finished;
        answer(200, { content: toMcp(out.content), isError: Boolean(out.isError) });
      } catch (err) {
        answer(200, { content: [{ type: 'text', text: `The tool failed: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 300)}` }], isError: true });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const port = /** @type {any} */ (server.address()).port;

  const dir = await cliFolder();
  const tools = mcpTools(stack, { audit: Boolean(assess) });
  const names = tools.map((t) => t.name);
  const deadline = Date.now() + lim.minutes * 60000;
  const usage = { ...FREE_USAGE };
  /** @type {Map<string, any>} */
  const answers = new Map();
  let usedModel = model ?? '';
  let estimate = 0;
  try {
    const sysFile = path.join(dir, 'system.txt');
    const toolsFile = path.join(dir, 'tools.json');
    const mcpFile = path.join(dir, 'mcp.json');
    await writeFile(sysFile, systemText(prompt.system));
    await writeFile(toolsFile, JSON.stringify(tools));
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [TOOLS_SCRIPT], env: { SAS_TOOLS_URL: `http://127.0.0.1:${port}/call`, SAS_TOOLS_TOKEN: token, SAS_TOOLS_FILE: toolsFile } } } }));
    const base = ['-p', '--output-format', 'stream-json', '--verbose', '--system-prompt-file', sysFile, '--mcp-config', mcpFile, '--strict-mcp-config',
      '--tools', '', '--allowedTools', names.map((n) => `mcp__${SERVER}__${n}`).join(','), ...(model ? ['--model', model] : []), '--effort', AGENT_EFFORT];
    // A look at an app stack builds it first: the CLI waits for a tool as long as the build may take.
    const env = { MCP_TOOL_TIMEOUT: String(15 * 60000), MCP_TIMEOUT: '60000', MAX_MCP_OUTPUT_TOKENS: '200000' };

    /** One CLI run (the first, or the reminder that resumes it). */
    const runOnce = async (/** @type {string[]} */ args, /** @type {string} */ input) => {
      const left = deadline - Date.now();
      if (left <= 0) throw new LlmError('The build reached its limit before the agent finished. Nothing was lost: the files written so far are kept.', 504, 'agent-limit');
      /** @type {ReturnType<typeof spawnCli>} */
      let run;
      const onLine = (/** @type {string} */ line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev?.type !== 'assistant' || !ev.message) return;
        const m = ev.message;
        answers.set(m.id ?? `${answers.size}`, m.usage ?? {});
        if (m.model) usedModel = m.model;
        for (const b of m.content ?? []) if (b.type === 'text' && b.text?.trim()) onEvent({ type: 'note', text: b.text.trim().slice(0, 300) });
        for (const k of Object.keys(usage)) usage[/** @type {keyof typeof usage} */ (k)] = [...answers.values()].reduce((s, u) => s + (u?.[k] ?? 0), 0);
        onEvent({ type: 'usage', usage: { ...usage }, costUsd: 0, turns: answers.size });
        if (answers.size > lim.turns) run.kill('turns');
      };
      run = spawnCli(args, { input, cwd: dir, env, signal, timeoutMs: left, onLine });
      const out = await run.done;
      const result = lastResult(out.stdout);
      estimate += result?.total_cost_usd ?? 0;
      if (out.killed === 'stopped' || signal?.aborted) throw new LlmError('The build was stopped.', 499, 'stopped');
      if (finished) return result;
      if (out.killed) throw new LlmError('The build reached its limit before the agent finished. Nothing was lost: the files written so far are kept.', 504, 'agent-limit');
      if (!result || result.is_error) throw cliError(result, out.stderr);
      return result;
    };

    const first = await runOnce(base, userText(prompt.messages, workspaceNote({ fonts, stack, images, existing, audit: Boolean(assess) }), names));
    if (!finished && first?.session_id) {
      // Stopped without finishing: remind it once, in the same session, then end with what is there.
      await runOnce([...base, '--resume', first.session_id], 'Continue until the site is complete, run check_site, then call finish.');
    }
    console.log(`[build cli] agent: ${answers.size} answer(s), list-price estimate $${estimate.toFixed(2)} (subscription, not billed per token)`);
    if (finished) {
      const files = await listFiles(siteDir);
      onEvent({ type: 'done', text: `Site complete: ${files.length} files` });
      return { ...finished, turns: answers.size, usage, costUsd: 0, model: usedModel };
    }
    return { report: null, checks: await toolbox.siteChecks(), turns: answers.size, usage, costUsd: 0, model: usedModel };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
