// @ts-check
// The build agent's tools as an MCP server (stdio, newline-delimited JSON-RPC), for the Claude Code CLI path (agentCli.js).
// This process runs nothing itself: each tools/call is forwarded over loopback HTTP, with the run's token, to the build that
// started the CLI, where the same toolbox as the API path runs it (agent.js createToolbox). So the CLI agent reaches the
// project only through the confined editor, the look, the checks and the finish, exactly like the API agent.
// Started by the CLI with SAS_TOOLS_URL, SAS_TOOLS_TOKEN and SAS_TOOLS_FILE (the tool list) in its environment.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const { SAS_TOOLS_URL: url = '', SAS_TOOLS_TOKEN: token = '', SAS_TOOLS_FILE: file = '' } = process.env;
const tools = JSON.parse(readFileSync(file, 'utf8'));

const send = (/** @type {any} */ msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** Forwards one call; no client timeout, because a look at an app stack builds it first and can take minutes. */
function forward(/** @type {string} */ name, /** @type {any} */ input) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, input });
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-sas-token': token } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`bad answer (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function handle(/** @type {string} */ line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return; // a notification
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'site', version: '1' } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') {
      const out = /** @type {any} */ (await forward(params?.name, params?.arguments ?? {}));
      return send({ jsonrpc: '2.0', id, result: { content: out.content, isError: Boolean(out.isError) } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (err) {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `The tool could not run: ${/** @type {any} */ (err)?.message ?? err}` }], isError: true } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
