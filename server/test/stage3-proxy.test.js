// Stage 3 of accounts: the one local address (scripts/local-proxy.mjs) — marketing at /, the tool at /app/ behind the gate, the API
// at /api. A real API process (accounts on) behind the proxy; the tool's and the marketing site's dev servers are stand-ins that say
// who answered, so the routing and the gate are what is tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { createLocalProxy } from '../../scripts/local-proxy.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** A stand-in dev server: answers "<name> <path>", and accepts WebSocket upgrades. */
async function standIn(t, name) {
  const port = await freePort();
  const s = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`${name} ${req.url}`); });
  s.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }));
  return { host: '127.0.0.1', port };
}

async function setup(t, { devNoVerify }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-stage3p-'));
  const d = new DatabaseSync(path.join(dataDir, 'app.db'));
  applySchema(d);
  applyMigrations(d, { ownerEmail: 'owner@example.com' });
  d.close();
  const apiPort = await freePort();
  const proxyPort = await freePort();
  const origin = `http://localhost:${proxyPort}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir, PORT: String(apiPort), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_ACCOUNTS: '1', SAS_DEV_NO_VERIFY: devNoVerify ? '1' : '', SAS_PUBLIC_ORIGIN: origin, APP_ORIGIN: origin,
      SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', NODE_ENV: '', SAS_COOKIE_SECURE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
  for (let i = 0; i < 150 && !/API ready/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /API ready/, out);

  const proxy = createLocalProxy({ api: { host: '127.0.0.1', port: apiPort }, app: await standIn(t, 'APP'), site: await standIn(t, 'SITE') });
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => { proxy.closeAllConnections?.(); proxy.close(r); }));

  // Requests as a browser on the one address sends them (Host = the public address).
  const call = (method, p, { cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method, path: p,
      headers: { host: `localhost:${proxyPort}`, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json', origin } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const upgrade = (p, cookie) => new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: localhost:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
    });
    let got = '';
    s.on('data', (c) => { got += c; s.destroy(); resolve(got.split('\r\n')[0]); });
    s.on('error', () => resolve('error'));
    s.on('close', () => resolve(got.split('\r\n')[0] || 'closed'));
  });
  return { call, upgrade };
}

const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' };

test('one address: / is the marketing site, /api the API, /app/ only for a signed-in verified account', { timeout: 120000 }, async (t) => {
  const { call, upgrade } = await setup(t, { devNoVerify: true });

  assert.equal((await call('GET', '/')).text, 'SITE /');
  assert.equal((await call('GET', '/auth?mode=signup')).text, 'SITE /auth?mode=signup');
  assert.equal((await call('GET', '/api/health')).status, 200);
  const root = await call('GET', '/app?x=1');
  assert.deepEqual([root.status, root.headers.location], [302, '/app/?x=1']);

  // Not signed in: a page goes to the marketing sign-in with ?next=, anything else is refused.
  const page = await call('GET', '/app/', { headers: HTML });
  assert.deepEqual([page.status, page.headers.location], [302, '/auth?mode=signin&next=%2Fapp%2F']);
  const deep = await call('GET', '/app/?site=a', { headers: HTML });
  assert.equal(deep.headers.location, '/auth?mode=signin&next=%2Fapp%2F%3Fsite%3Da');
  assert.equal((await call('GET', '/app/src/main.jsx')).status, 401);
  assert.equal(await upgrade('/app/', null), 'HTTP/1.1 401 Unauthorized', 'the dev server socket too');
  // The API answers for itself, streams and files included.
  for (const p of ['/api/projects', '/api/projects/x/analyze/y/events', '/api/projects/x/analyses/y/screens/desktop-fold.webp', '/api/projects/x/report']) {
    assert.equal((await call('GET', p)).status, 401, p);
  }
  const forged = await call('GET', '/app/', { cookie: 'sas_session=not-a-real-token', headers: HTML });
  assert.equal(forged.status, 302, 'a made-up cookie is not a session');

  // Sign up through the proxy (as the marketing form does: fetch to /api, same origin): the cookie opens /app/.
  const up = await call('POST', '/api/auth/signup', { body: { email: 'me@example.com', password: 'password123' } });
  assert.equal(up.status, 201, up.text);
  const cookie = up.headers['set-cookie'][0].split(';')[0];
  assert.equal((await call('GET', '/app/', { cookie, headers: HTML })).text, 'APP /app/');
  assert.equal((await call('GET', '/app/src/main.jsx', { cookie })).text, 'APP /app/src/main.jsx');
  assert.equal(await upgrade('/app/', cookie), 'HTTP/1.1 101 Switching Protocols');
  assert.equal((await call('GET', '/api/projects', { cookie })).text, '[]', 'my own dashboard: empty, not the owner\'s projects');

  // Signed out: the cached verdict lasts at most a few seconds, then the gate closes again.
  assert.equal((await call('POST', '/api/auth/logout', { cookie, body: {} })).status, 204);
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal((await call('GET', '/app/', { cookie, headers: HTML })).status, 302);
});

test('verification required: an unverified account is sent to sign in with verify=1, and kept out of /app/', { timeout: 120000 }, async (t) => {
  const { call } = await setup(t, { devNoVerify: false });
  const up = await call('POST', '/api/auth/signup', { body: { email: 'new@example.com', password: 'password123' } });
  assert.equal(up.status, 201);
  assert.equal(JSON.parse(up.text).user.verified, false);
  const cookie = up.headers['set-cookie'][0].split(';')[0];
  const page = await call('GET', '/app/', { cookie, headers: HTML });
  assert.deepEqual([page.status, page.headers.location], [302, '/auth?mode=signin&verify=1&next=%2Fapp%2F']);
  assert.equal((await call('GET', '/api/projects', { cookie })).status, 403);
});
