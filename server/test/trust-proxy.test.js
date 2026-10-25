// Behind a reverse proxy (Caddy) every visitor reaches the API from 127.0.0.1, so the per-address limits (sign-ups per address,
// failed sign-ins per email + address) were one limit for the whole site. The API now believes X-Forwarded-For from the proxies
// SAS_TRUST_PROXY names (default: one on this computer) and from nobody else (config/index.js trustProxySetting). Real server
// processes over HTTP with a migrated database of their own; the test stands in for the proxy by sending X-Forwarded-For from
// 127.0.0.1 with the visitor's address last, as a proxy appends it. No browser, no mail (SAS_DEV_NO_VERIFY on a loopback API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { startupProblems, trustProxySetting } from '../src/config/index.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGNUPS_PER_ADDRESS = 20; // accounts/routes.js signups
const SIGNINS_PER_ADDRESS = 10; // accounts/routes.js signins

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function withTrust(value, fn) {
  const saved = process.env.SAS_TRUST_PROXY;
  try {
    if (value === undefined) delete process.env.SAS_TRUST_PROXY; else process.env.SAS_TRUST_PROXY = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.SAS_TRUST_PROXY; else process.env.SAS_TRUST_PROXY = saved;
  }
}

async function startServer(t, env) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-trust-proxy-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  applySchema(db);
  applyMigrations(db, { ownerEmail: 'owner@example.com' });
  db.close();
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dir, PORT: String(port), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', NODE_ENV: '', SAS_COOKIE_SECURE: '', SAS_PUBLIC_ORIGIN: '', SMTP_HOST: '',
      SAS_ACCOUNTS: '1', SAS_DEV_NO_VERIFY: '1', SAS_TRUST_PROXY: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  for (let i = 0; i < 150 && !/API ready/.test(out) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  const call = async (p, body, forwardedFor) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(forwardedFor && { 'x-forwarded-for': forwardedFor }) },
      body: JSON.stringify(body),
    });
    return res.status;
  };
  return { ready: /API ready/.test(out), output: () => out, exited, call };
}

let n = 0;
const signup = (s, forwardedFor) => s.call('/api/auth/signup', { email: `user${++n}@example.com`, password: 'longenough1' }, forwardedFor);

test('the setting: loopback by default, a list or "off" as asked, never a value that lets a visitor choose their address', () => {
  withTrust(undefined, () => assert.deepEqual(trustProxySetting(), { value: 'loopback', problem: null }));
  withTrust('off', () => assert.deepEqual(trustProxySetting(), { value: false, problem: null }));
  withTrust(' Loopback, 10.0.0.0/8 , fd00::1 ', () => assert.deepEqual(trustProxySetting(), { value: 'loopback, 10.0.0.0/8, fd00::1', problem: null }));
  for (const bad of ['true', '1', '2', 'caddy', '10.0.0.0/33', '300.1.1.1']) {
    withTrust(bad, () => {
      const s = trustProxySetting();
      assert.equal(s.value, false, bad);
      assert.match(s.problem, /SAS_TRUST_PROXY/, bad);
      assert.ok(startupProblems().some((p) => /SAS_TRUST_PROXY/.test(p)), `${bad}: the server refuses to start`);
    });
  }
  withTrust('true', () => assert.match(trustProxySetting().problem, /would believe any visitor/));
});

test('behind a proxy on this computer each visitor has a limit of their own, and a made-up address in front changes nothing', { timeout: 180000 }, async (t) => {
  const s = await startServer(t, {});
  assert.equal(s.ready, true, s.output());
  // Visitor A uses up the sign-ups of one address; visitor B, through the same proxy, still signs up.
  for (let i = 0; i < SIGNUPS_PER_ADDRESS; i++) assert.equal(await signup(s, '203.0.113.1'), 201, `sign-up ${i + 1} of A`);
  assert.equal(await signup(s, '203.0.113.1'), 429, 'A is over the limit');
  assert.equal(await signup(s, '203.0.113.2'), 201, 'B is a visitor of their own');
  // A claims another address in front of the real one (the proxy appends the real one): still A.
  assert.equal(await signup(s, '198.51.100.7, 203.0.113.1'), 429, 'a made-up X-Forwarded-For entry is not believed');
  // Failed sign-ins: per email + address. A's tries for one email do not lock B out of it.
  for (let i = 0; i < SIGNINS_PER_ADDRESS; i++) assert.equal(await s.call('/api/auth/login', { email: 'user1@example.com', password: 'wrong-password' }, '203.0.113.1'), 401);
  assert.equal(await s.call('/api/auth/login', { email: 'user1@example.com', password: 'wrong-password' }, '203.0.113.1'), 429, 'A is locked out');
  assert.equal(await s.call('/api/auth/login', { email: 'user1@example.com', password: 'wrong-password' }, '203.0.113.2'), 401, 'B is not');
});

test('a proxy that is not trusted is not believed: every X-Forwarded-For is the same visitor (the connection\'s address)', { timeout: 180000 }, async (t) => {
  // Trusting only another machine's address: the connection from 127.0.0.1 is not a trusted proxy.
  const s = await startServer(t, { SAS_TRUST_PROXY: '10.9.8.7' });
  assert.equal(s.ready, true, s.output());
  for (let i = 0; i < SIGNUPS_PER_ADDRESS; i++) assert.equal(await signup(s, `203.0.113.${i + 10}`), 201, `sign-up ${i + 1}`);
  assert.equal(await signup(s, '203.0.113.99'), 429, 'a new X-Forwarded-For from an untrusted connection is ignored');
});

test('an unusable SAS_TRUST_PROXY stops the server before it serves anything', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { SAS_TRUST_PROXY: 'true' });
  assert.equal(s.ready, false);
  await s.exited;
  assert.match(s.output(), /SAS_TRUST_PROXY/);
});
