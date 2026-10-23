// @ts-check
// `npm run local`: the whole product on this computer, at one address — http://localhost:8080
//   /        the marketing site (Next.js dev server, ../remastly-website, port 3000)
//   /app/    the tool (Vite dev server, port 5173), only for a signed-in, verified account (scripts/local-proxy.mjs)
//   /api/    the API (port 4000) with accounts on (SAS_ACCOUNTS=1)
// Email verification is stubbed: the API runs with SAS_DEV_NO_VERIFY=1, so a new account is verified on sign-up (the API prints
// its warning line at start). `npm run local -- --verify` runs the real behaviour instead: a new account is unverified and the
// gate keeps it out (the code is printed in the API's log; no mail module yet).
// Everything else comes from server/.env as usual (SAS_DATA_DIR, SAS_ALLOW_LOCALHOST…); the settings above win over it.
//
// Options: --verify   SAS_LOCAL_PORT (8080)   SAS_MARKETING_DIR (../remastly-website, next to this repo)
// Ctrl+C stops all four.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalProxy } from './local-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SAS_LOCAL_PORT) || 8080;
const MARKETING = path.resolve(process.env.SAS_MARKETING_DIR || path.join(ROOT, '..', 'remastly-website'));
const VERIFY = process.argv.includes('--verify');
const PUBLIC = `http://localhost:${PORT}`;
const PORTS = { api: 4000, app: 5173, site: 3000 };

const busy = (port) => new Promise((resolve) => {
  const s = net.connect({ host: 'localhost', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
});

if (!existsSync(path.join(MARKETING, 'package.json'))) {
  console.error(`The marketing site is not at ${MARKETING}. Set SAS_MARKETING_DIR to its folder.`);
  process.exit(1);
}
if (!existsSync(path.join(MARKETING, 'node_modules'))) {
  console.error(`The marketing site has no node_modules: run "npm install" in ${MARKETING} first.`);
  process.exit(1);
}
const taken = [];
for (const [name, port] of [['the API', PORTS.api], ['the tool (Vite)', PORTS.app], ['the marketing site (Next.js)', PORTS.site], ['this proxy', PORT]]) {
  if (await busy(port)) taken.push(`  port ${port} (${name})`);
}
if (taken.length) {
  console.error(`Not starting: these ports are already in use:\n${taken.join('\n')}\nStop what runs there first (an "npm run dev" here, or "next dev" in the marketing site), then run npm run local again.`);
  process.exit(1);
}

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
const COLORS = { api: 35, app: 36, site: 33, proxy: 32 };
const prefix = (name) => `\x1b[${COLORS[name]}m[${name}]\x1b[0m `;
const out = (name, chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) process.stdout.write(`${prefix(name)}${line}\n`);
};

function run(name, cwd, args, env) {
  const child = spawn('npm', args, { cwd, env: { ...process.env, ...env, FORCE_COLOR: '1' }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => out(name, d));
  child.stderr?.on('data', (d) => out(name, d));
  child.on('exit', (code) => {
    out(name, `stopped (exit ${code})`);
    if (!stopping) stopAll(1);
  });
  children.push(child);
}

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    // npm runs through a shell: on Windows only the whole tree stops the dev server under it.
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => {});
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

run('api', ROOT, ['run', 'dev', '-w', 'server'], {
  SAS_ACCOUNTS: '1',
  SAS_DEV_NO_VERIFY: VERIFY ? '0' : '1',
  SAS_BIND_HOST: '127.0.0.1',
  SAS_PUBLIC_ORIGIN: PUBLIC,
  APP_ORIGIN: PUBLIC, // previews may be framed by the tool at this address
  PORT: String(PORTS.api),
});
run('app', ROOT, ['run', 'dev', '-w', 'client'], {});
run('site', MARKETING, ['run', 'dev', '--', '-p', String(PORTS.site)], {
  NEXT_PUBLIC_APP_URL: '/app', // where the sign-in form sends a signed-in visitor
  NEXT_PUBLIC_API_BASE: '/api', // where it posts
});

const proxy = createLocalProxy({
  api: { host: '127.0.0.1', port: PORTS.api },
  app: { host: 'localhost', port: PORTS.app },
  site: { host: 'localhost', port: PORTS.site },
  log: (line) => out('proxy', line),
});
proxy.listen(PORT, '127.0.0.1', () => {
  out('proxy', `Open ${PUBLIC}  —  marketing at /, the tool at /app/, the API at /api/ (all four start in a few seconds).`);
  out('proxy', VERIFY
    ? 'Email verification is REQUIRED (--verify): a new account is kept out until verified; codes appear in the [api] log.'
    : 'Email verification is STUBBED (SAS_DEV_NO_VERIFY=1): a new account is verified on sign-up. Use --verify for the real behaviour.');
});
// localhost may resolve to ::1 first: answer there too (this computer only).
const proxy6 = createLocalProxy({
  api: { host: '127.0.0.1', port: PORTS.api },
  app: { host: 'localhost', port: PORTS.app },
  site: { host: 'localhost', port: PORTS.site },
  log: (line) => out('proxy', line),
});
proxy6.on('error', () => {}); // no IPv6 loopback: 127.0.0.1 is enough
proxy6.listen(PORT, '::1');
