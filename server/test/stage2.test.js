// Stage 2 of accounts (docs/ACCOUNTS.md): sign-up, sign-in, sessions, the gate, email codes built but not required, and the
// SAS_DEV_NO_VERIFY bypass with its guard — tested on real server processes over HTTP, each with a database of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { devNoVerify, startupProblems, startupNotices, cookieSecure } from '../src/config/index.js';
import { hashPassword, verifyPassword, passwordProblem } from '../src/accounts/passwords.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'owner@example.com';
const ENV_KEYS = ['SAS_BIND_HOST', 'SAS_DEV_NO_VERIFY', 'NODE_ENV', 'SAS_ACCOUNTS', 'SAS_COOKIE_SECURE', 'SAS_PUBLIC_ORIGIN'];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('SAS_DEV_NO_VERIFY: off by default, in effect only off production on a loopback bind, refused anywhere else', () => withEnv({}, async () => {
  assert.equal(devNoVerify(), false, 'off by default');
  assert.deepEqual(startupProblems(), []);
  await withEnv({ SAS_DEV_NO_VERIFY: '1' }, () => {
    assert.equal(devNoVerify(), true);
    assert.deepEqual(startupProblems(), []);
  });
  await withEnv({ SAS_DEV_NO_VERIFY: '1', SAS_ACCOUNTS: '1', SAS_BIND_HOST: '127.0.0.1' }, () => {
    assert.match(startupNotices()[0], /SAS_DEV_NO_VERIFY is ON/, 'a visible line at every start');
  });
  for (const env of [{ SAS_BIND_HOST: '0.0.0.0' }, { SAS_BIND_HOST: '192.168.1.5' }, { NODE_ENV: 'production' }, { NODE_ENV: 'production', SAS_BIND_HOST: '0.0.0.0' }]) {
    await withEnv({ SAS_DEV_NO_VERIFY: '1', ...env }, () => {
      assert.equal(devNoVerify(), false, JSON.stringify(env));
      assert.match(startupProblems().join(' '), /SAS_DEV_NO_VERIFY=1 .* only allowed for local development/, JSON.stringify(env));
    });
  }
  for (const v of ['0', '', 'true', 'yes']) {
    await withEnv({ SAS_DEV_NO_VERIFY: v, SAS_BIND_HOST: '0.0.0.0' }, () => {
      assert.equal(devNoVerify(), false, `"${v}" is off`);
      assert.deepEqual(startupProblems(), [], `"${v}" is not "on", so nothing to refuse`);
    });
  }
}));

test('cookie Secure follows SAS_COOKIE_SECURE, else the public origin', () => withEnv({}, async () => {
  assert.equal(cookieSecure(), false, 'local http by default');
  await withEnv({ SAS_PUBLIC_ORIGIN: 'https://app.example.com' }, () => assert.equal(cookieSecure(), true));
  await withEnv({ SAS_PUBLIC_ORIGIN: 'https://app.example.com', SAS_COOKIE_SECURE: '0' }, () => assert.equal(cookieSecure(), false));
  await withEnv({ SAS_COOKIE_SECURE: '1' }, () => assert.equal(cookieSecure(), true));
}));

test('passwords: scrypt with its own parameters, a fresh salt each time, and the same work for an account with none', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.match(a, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(a, b, 'salted');
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('Correct horse', a), false);
  assert.equal(await verifyPassword('correct horse', null), false);
  assert.equal(passwordProblem('short'), 'Use at least 8 characters for the password.');
  assert.equal(passwordProblem('long enough'), null);
});

// --- real server processes ------------------------------------------------------------------------------------------------
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** A data folder with a database like a migrated real one: two projects owned by the owner account. The caller removes it
 *  (startServer does, after its process has exited: on Windows an open database cannot be deleted). */
async function migratedData({ migrate = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-stage2-'));
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  applySchema(db);
  db.exec("INSERT INTO projects (id, name, url, created_at, updated_at) VALUES ('p1', 'One', 'https://one.dev', 't', 't'), ('p2', 'Two', 'https://two.dev', 't', 't')");
  if (migrate) applyMigrations(db, { ownerEmail: OWNER });
  db.close();
  return dataDir;
}

async function startServer(t, env, dataDir) {
  const dir = dataDir ?? await mkdtemp(path.join(os.tmpdir(), 'sas-stage2-srv-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dir, PORT: String(port), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', SAS_ACCOUNTS: '', SAS_DEV_NO_VERIFY: '', NODE_ENV: '', SAS_COOKIE_SECURE: '', SAS_PUBLIC_ORIGIN: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // One hook, in this order: the process first (it holds the database open), then its folder.
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ready = await Promise.race([
    (async () => { for (let i = 0; i < 150; i++) { if (/API ready/.test(out)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })(),
    exited.then(() => false),
  ]);
  const base = `http://127.0.0.1:${port}`;
  /** fetch with a cookie jar of one cookie */
  const jar = { cookie: '' };
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) jar.cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, setCookie: set };
  };
  return { port, dataDir: dir, ready, exited, output: () => out, call, jar };
}

test('the server refuses to start with SAS_DEV_NO_VERIFY on and a non-local bind (or in production), before opening a database', { timeout: 120000 }, async (t) => {
  for (const env of [
    { SAS_DEV_NO_VERIFY: '1', SAS_BIND_HOST: '0.0.0.0' },
    { SAS_DEV_NO_VERIFY: '1', SAS_BIND_HOST: '0.0.0.0', SAS_ACCOUNTS: '1' },
    { SAS_DEV_NO_VERIFY: '1', NODE_ENV: 'production' },
  ]) {
    const s = await startServer(t, env);
    assert.equal(s.ready, false, JSON.stringify(env));
    assert.equal(await s.exited, 1, s.output());
    assert.match(s.output(), /Not starting: SAS_DEV_NO_VERIFY=1 skips email verification and is only allowed for local development/);
    assert.equal(await stat(path.join(s.dataDir, 'app.db')).then(() => true, () => false), false, `no database opened (${JSON.stringify(env)})`);
  }
});

test('SAS_ACCOUNTS=1 refuses to start on a database that still has migrations to apply', { timeout: 60000 }, async (t) => {
  const dataDir = await migratedData({ migrate: false });
  const s = await startServer(t, { SAS_ACCOUNTS: '1' }, dataDir);
  assert.equal(s.ready, false);
  assert.equal(await s.exited, 1);
  assert.match(s.output(), /Not starting: SAS_ACCOUNTS=1 needs the accounts tables.*db:migrate/s);
});

test('accounts off: no auth routes, no gate, the API as before (also on a migrated database)', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, {}, await migratedData());
  assert.equal(s.ready, true, s.output());
  assert.equal((await s.call('GET', '/api/auth/me')).status, 404);
  const list = await s.call('GET', '/api/projects');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 2);
  assert.equal('owner_id' in list.json[0], false, 'owner_id is not sent to the app');
});

test('verification required (flag off): sign-up makes an unverified account the gate blocks; the code verifies it', { timeout: 120000 }, async (t) => {
  const dataDir = await migratedData();
  const s = await startServer(t, { SAS_ACCOUNTS: '1' }, dataDir);
  assert.equal(s.ready, true, s.output());
  assert.doesNotMatch(s.output(), /SAS_DEV_NO_VERIFY/);

  // No session: every gated route says so, SSE / screenshots / downloads / reports included.
  for (const p of ['/api/projects', '/api/projects/p1/analyze/a1/events', '/api/projects/p1/analyses/a1/screens/desktop-fold.webp',
    '/api/projects/p1/recreate/r1/download', '/api/projects/p1/report', '/api/projects/p1/favicon', '/api/stacks']) {
    const r = await s.call('GET', p);
    assert.equal(r.status, 401, p);
    assert.equal(r.json.auth, 'signin', p);
  }
  assert.equal((await s.call('GET', '/api/health')).status, 200, 'health stays open');

  // Errors are sentences for the form.
  assert.deepEqual((await s.call('POST', '/api/auth/signup', { email: 'nope', password: 'longenough' })).json, { error: 'Enter a valid email address.', field: 'email' });
  assert.equal((await s.call('POST', '/api/auth/signup', { email: 'a@b.co', password: 'short' })).json.field, 'password');

  const up = await s.call('POST', '/api/auth/signup', { email: 'Test@Example.com', password: 'longenough' });
  assert.equal(up.status, 201);
  assert.equal(up.json.user.email, 'test@example.com');
  assert.equal(up.json.user.verified, false);
  assert.equal(up.json.verification.sentTo, 'test@example.com');
  assert.equal('code' in up.json.verification, false, 'the code is never in a response');
  assert.match(up.setCookie, /^sas_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/, 'HttpOnly, Lax, Path=/, no Secure on local http');

  const blocked = await s.call('GET', '/api/projects');
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.json, { error: 'Verify your email address to continue.', auth: 'verify' });
  assert.equal((await s.call('GET', '/api/auth/me')).json.user.verified, false);

  // Only a hash of the token is stored.
  const token = s.jar.cookie.split('=')[1];
  const raw = await readFile(path.join(dataDir, 'app.db')).then((b) => b.toString('latin1'));
  const wal = await readFile(path.join(dataDir, 'app.db-wal')).then((b) => b.toString('latin1'), () => '');
  assert.equal((raw + wal).includes(token), false, 'the session token is not in the database');

  // The code: without SMTP_HOST the mail goes to the server log (development only; otp.test.js covers the real sending).
  assert.match(s.output(), /Mail: no SMTP_HOST set/);
  assert.equal((await s.call('POST', '/api/auth/verify', { code: '000000' })).json.reason ?? 'wrong', 'wrong');
  const code = s.output().match(/\[mail\] \(not sent: no SMTP_HOST\) to test@example\.com — (\d{6}) is your Remastly verification code/)?.[1];
  assert.ok(code, s.output());
  assert.equal((await s.call('POST', '/api/auth/verify/send')).status, 404, 'there is no resend');
  const ok = await s.call('POST', '/api/auth/verify', { code });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.verified, true);
  assert.equal((await s.call('GET', '/api/projects')).status, 200, 'verified: through the gate');

  // Sign out, sign in.
  assert.equal((await s.call('POST', '/api/auth/logout')).status, 204);
  assert.equal(s.jar.cookie, '', 'cookie cleared');
  assert.equal((await s.call('GET', '/api/auth/me')).status, 401);
  const wrong = await s.call('POST', '/api/auth/login', { email: 'test@example.com', password: 'wrongwrong' });
  assert.deepEqual([wrong.status, wrong.json], [401, { error: 'Wrong email or password.' }]);
  const nobody = await s.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrongwrong' });
  assert.deepEqual(nobody.json, wrong.json, 'an unknown address gets the same answer');
  const owner = await s.call('POST', '/api/auth/login', { email: OWNER, password: 'anything!' });
  assert.equal(owner.status, 401, 'the owner account has no password until it is claimed');
  const inn = await s.call('POST', '/api/auth/login', { email: 'TEST@example.com', password: 'longenough' });
  assert.equal(inn.status, 200);
  assert.equal((await s.call('GET', '/api/projects')).status, 200);

  // A verified address cannot be signed up again.
  const again = await s.call('POST', '/api/auth/signup', { email: 'test@example.com', password: 'otherpassword' });
  assert.deepEqual([again.status, again.json.field], [409, 'email']);

  // Another site's page cannot post with the visitor's cookie.
  const csrf = await s.call('POST', '/api/projects', { name: 'x', url: 'https://x.dev', authorized: true }, { origin: 'https://evil.example' });
  assert.deepEqual([csrf.status, csrf.json.error], [403, 'This request did not come from the app.']);
  const own = await s.call('POST', '/api/auth/logout', null, { origin: 'http://localhost:5173' });
  assert.equal(own.status, 204, 'the app\'s own origin passes');
});

test('SAS_DEV_NO_VERIFY on (local): a visible line at start, sign-up verified at once, the owner account claimed by sign-up', { timeout: 120000 }, async (t) => {
  const dataDir = await migratedData();
  const s = await startServer(t, { SAS_ACCOUNTS: '1', SAS_DEV_NO_VERIFY: '1' }, dataDir);
  assert.equal(s.ready, true, s.output());
  assert.match(s.output(), /!!! SAS_DEV_NO_VERIFY is ON: new accounts are marked verified on sign-up without any email/);

  const badName = await s.call('POST', '/api/auth/signup', { email: 'dev@example.com', password: 'longenough', name: '<script>' });
  assert.deepEqual([badName.status, badName.json.field], [400, 'name']);
  const up = await s.call('POST', '/api/auth/signup', { email: 'dev@example.com', password: 'longenough', name: '  Asha   Rao ' });
  assert.equal(up.status, 201);
  assert.equal(up.json.user.verified, true);
  assert.equal(up.json.user.name, 'Asha Rao', 'the name the form asks for is kept (trimmed)');
  assert.equal((await s.call('GET', '/api/auth/me')).json.user.name, 'Asha Rao');
  assert.equal('verification' in up.json, false);
  assert.equal((await s.call('GET', '/api/projects')).status, 200, 'straight in');

  s.jar.cookie = '';
  const claim = await s.call('POST', '/api/auth/signup', { email: OWNER, password: 'ownerpassword' });
  assert.equal(claim.status, 201);
  assert.equal(claim.json.user.role, 'owner', 'the owner account made by db:migrate, now with a password');
  const db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2, 'claimed, not duplicated');
  assert.equal(db.prepare("SELECT count(*) AS n FROM projects p JOIN users u ON u.id = p.owner_id WHERE u.email = ?").get(OWNER).n, 2);
  db.close();
});

test('the test-account script lists, refuses the owner and project owners, and deletes only users, sessions and codes', { timeout: 60000 }, async (t) => {
  const dataDir = await migratedData();
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  const dbFile = path.join(dataDir, 'app.db');
  const db = new DatabaseSync(dbFile);
  const now = new Date().toISOString();
  db.exec(`INSERT INTO users (id, email, role, created_at, updated_at) VALUES ('u1', 'test1@example.com', 'user', '${now}', '${now}'), ('u2', 'test2@example.com', 'user', '${now}', '${now}'), ('u3', 'keeper@example.com', 'user', '${now}', '${now}');
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('s1', 'u1', 'h1', 't', 't'), ('s2', 'u1', 'h2', 't', 't'), ('s3', 'u3', 'h3', 't', 't');
    INSERT INTO email_codes (id, user_id, email, purpose, code_hash, created_at, expires_at) VALUES ('c1', 'u1', 'test1@example.com', 'verify', 'x', 't', 't');
    UPDATE projects SET owner_id = 'u3' WHERE id = 'p2';`);
  db.close();
  const run = (...args) => promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/accounts.mjs', ...args, '--db', dbFile], { cwd: SERVER }).then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: e.stdout + e.stderr }));
  const counts = () => {
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try { return Object.fromEntries(['users', 'sessions', 'email_codes', 'projects', 'analyses', 'recreates', 'reaudits'].map((tb) => [tb, d.prepare(`SELECT count(*) AS n FROM ${tb}`).get().n])); } finally { d.close(); }
  };

  const list = await run('list');
  assert.match(list.out, /4 account\(s\)/);
  assert.match(list.out, /test1@example\.com\s+user\s+unverified sessions 2, codes 1, projects 0/);

  const start = counts();
  for (const [who, why] of [[OWNER, /is the owner account/], ['keeper@example.com', /owns 1 project/], ['ghost@example.com', /not found/]]) {
    const r = await run('delete', 'test1@example.com', who, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.out, why);
    assert.match(r.out, /Nothing was deleted/);
    assert.deepEqual(counts(), start, 'one refusal, nothing deleted at all');
  }
  const dry = await run('delete', 'test1@example.com', 'test2@example.com');
  assert.match(dry.out, /Would delete 2 account/);
  assert.deepEqual(counts(), start, 'without --yes nothing changes');

  const del = await run('delete', 'test1@example.com', 'test2@example.com', '--yes');
  assert.equal(del.code, 0, del.out);
  const end = counts();
  assert.deepEqual(end, { ...start, users: start.users - 2, sessions: start.sessions - 2, email_codes: start.email_codes - 1 });
});
