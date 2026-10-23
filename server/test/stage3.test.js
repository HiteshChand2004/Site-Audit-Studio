// Stage 3 of accounts (docs/ACCOUNTS.md): every project belongs to its owner. Two accounts on one real server process: neither
// can list, read, change, delete, start a job on, stream, or download anything of the other's — every such request answers
// exactly like a project that does not exist (404 "Project not found."). Also: a new project is its creator's, a project with no
// owner is nobody's, a job takes its owner from the project (not a session), and the password can be changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { db } from '../src/db/index.js';
import { JobManager } from '../src/jobs/manager.js';
import { streamJob } from '../src/jobs/sse.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const WEBP = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00', 'latin1');

/**
 * Two accounts (alice, bob), each with one project that has a finished analysis (with a screenshot on disk), a finished copy
 * (with a capture and a fidelity picture on disk) and a finished re-audit; plus one project nobody owns.
 */
async function twoAccounts(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-stage3-'));
  const file = path.join(dataDir, 'app.db');
  const d = new DatabaseSync(file);
  applySchema(d);
  applyMigrations(d, { ownerEmail: 'owner@example.com' });
  const now = new Date().toISOString();
  const pw = await hashPassword('password123');
  const ids = {};
  for (const who of ['alice', 'bob']) {
    const user = randomUUID();
    const project = randomUUID();
    const analysis = randomUUID();
    const recreate = randomUUID();
    const reaudit = randomUUID();
    d.prepare("INSERT INTO users (id, email, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").run(user, `${who}@example.com`, pw, now, now, now);
    d.prepare('INSERT INTO projects (id, name, url, authorized, created_at, updated_at, owner_id) VALUES (?, ?, ?, 1, ?, ?, ?)').run(project, `${who}'s site`, `https://${who}.example/`, now, now, user);
    d.prepare("INSERT INTO analyses (id, project_id, status, started_at, finished_at, result_json) VALUES (?, ?, 'done', ?, ?, '{}')").run(analysis, project, now, now);
    d.prepare("INSERT INTO recreates (id, project_id, status, started_at, finished_at, result_json) VALUES (?, ?, 'done', ?, ?, ?)").run(recreate, project, now, now, JSON.stringify({ stack: 'html', outputs: { html: { status: 'ready', dir: 'dist' } }, safety: { safe: true } }));
    d.prepare("INSERT INTO reaudits (id, project_id, recreate_id, analysis_id, status, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, 'done', ?, ?, '{}')").run(reaudit, project, recreate, analysis, now, now);
    const pdir = path.join(dataDir, 'projects', project);
    await mkdir(path.join(pdir, 'audit', analysis, 'screens'), { recursive: true });
    await writeFile(path.join(pdir, 'audit', analysis, 'screens', 'desktop-fold.webp'), WEBP);
    await mkdir(path.join(pdir, 'recreate', recreate, 'capture', 'index'), { recursive: true });
    await writeFile(path.join(pdir, 'recreate', recreate, 'capture', 'index', 'desktop-fold.webp'), WEBP);
    await mkdir(path.join(pdir, 'recreate', recreate, 'fidelity', 'index'), { recursive: true });
    await writeFile(path.join(pdir, 'recreate', recreate, 'fidelity', 'index', 'desktop-full.webp'), WEBP);
    ids[who] = { user, project, analysis, recreate, reaudit };
  }
  ids.nobody = randomUUID();
  d.prepare("INSERT INTO projects (id, name, url, authorized, created_at, updated_at) VALUES (?, 'Nobody', 'https://nobody.example/', 1, ?, ?)").run(ids.nobody, now, now);
  d.close();

  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir, PORT: String(port), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_ACCOUNTS: '1', SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', SAS_DEV_NO_VERIFY: '', NODE_ENV: '', SAS_COOKIE_SECURE: '', SAS_PUBLIC_ORIGIN: '',
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

  const base = `http://127.0.0.1:${port}`;
  const session = async (email, password = 'password123') => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `${email} signs in`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, p, body) => {
      const r = await fetch(base + p, {
        method, redirect: 'manual', headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* a file */ }
      return { status: r.status, json, type: r.headers.get('content-type') };
    };
  };
  return { ids, file, output: () => out, alice: await session('alice@example.com'), bob: await session('bob@example.com'), session };
}

/** Every route of one project, with the method and body it takes. */
const routesOf = (x) => [
  ['GET', `/api/projects/${x.project}`],
  ['PATCH', `/api/projects/${x.project}`, { name: 'taken' }],
  ['PATCH', `/api/projects/${x.project}`, { url: 'https://elsewhere.example/' }],
  ['GET', `/api/projects/${x.project}/audit`],
  ['GET', `/api/projects/${x.project}/pages`],
  ['GET', `/api/projects/${x.project}/favicon`],
  ['GET', `/api/projects/${x.project}/report`],
  ['GET', `/api/projects/${x.project}/report?format=json`],
  ['GET', `/api/projects/${x.project}/report?format=pdf&download=1`],
  ['POST', `/api/projects/${x.project}/analyze`, {}],
  ['GET', `/api/projects/${x.project}/analyze/current`],
  ['GET', `/api/projects/${x.project}/analyze/${x.analysis}/events`],
  ['GET', `/api/projects/${x.project}/analyses/${x.analysis}/screens/desktop-fold.webp`],
  ['POST', `/api/projects/${x.project}/recreate`, {}],
  ['POST', `/api/projects/${x.project}/recreate`, { resume: true }],
  ['POST', `/api/projects/${x.project}/recreate/stop`, {}],
  ['GET', `/api/projects/${x.project}/recreate`],
  ['GET', `/api/projects/${x.project}/recreate/current`],
  ['GET', `/api/projects/${x.project}/recreate/${x.recreate}/events`],
  ['GET', `/api/projects/${x.project}/recreate/${x.recreate}/captures/index/desktop-fold.webp`],
  ['GET', `/api/projects/${x.project}/recreate/${x.recreate}/fidelity/index/desktop-full.webp`],
  ['GET', `/api/projects/${x.project}/recreate/${x.recreate}/exact/index/1440-full.webp`],
  ['GET', `/api/projects/${x.project}/recreate/${x.recreate}/download`],
  ['HEAD', `/api/projects/${x.project}/recreate/${x.recreate}/download`],
  ['POST', `/api/projects/${x.project}/recreate/${x.recreate}/export`, { stack: 'react-vite' }],
  ['POST', `/api/projects/${x.project}/recreate/${x.recreate}/asis-preview`, {}],
  ['DELETE', `/api/projects/${x.project}/recreate/${x.recreate}/asis-preview`],
  ['GET', `/api/projects/${x.project}/preview`],
  ['POST', `/api/projects/${x.project}/preview`, {}],
  ['DELETE', `/api/projects/${x.project}/preview`],
  ['POST', `/api/projects/${x.project}/reaudit`, {}],
  ['GET', `/api/projects/${x.project}/reaudit`],
  ['GET', `/api/projects/${x.project}/reaudit/current`],
  ['GET', `/api/projects/${x.project}/reaudit/${x.reaudit}/events`],
  ['DELETE', `/api/projects/${x.project}`],
];

test('two accounts: each lists only its own projects; nothing of the other\'s is reachable, and it reads as "not found"', { timeout: 180000 }, async (t) => {
  const { ids, file, alice, bob } = await twoAccounts(t);

  const mine = await alice('GET', '/api/projects');
  assert.deepEqual(mine.json.map((p) => p.id), [ids.alice.project], 'alice sees her project only (not bob\'s, not the unowned one)');
  assert.deepEqual((await bob('GET', '/api/projects')).json.map((p) => p.id), [ids.bob.project]);

  // Bob's own files are there: what alice is refused below is refused for ownership, not because it is missing.
  const own = await bob('GET', `/api/projects/${ids.bob.project}/analyses/${ids.bob.analysis}/screens/desktop-fold.webp`);
  assert.deepEqual([own.status, own.type], [200, 'image/webp']);
  assert.equal((await bob('GET', `/api/projects/${ids.bob.project}/recreate/${ids.bob.recreate}/captures/index/desktop-fold.webp`)).status, 200);
  assert.equal((await bob('GET', `/api/projects/${ids.bob.project}/recreate/${ids.bob.recreate}/fidelity/index/desktop-full.webp`)).status, 200);

  const notFound = { error: 'Project not found.' };
  for (const [method, p, body] of routesOf(ids.bob)) {
    const r = await alice(method, p, body);
    assert.equal(r.status, 404, `${method} ${p} → ${r.status} ${JSON.stringify(r.json)}`);
    if (method !== 'HEAD') assert.deepEqual(r.json, notFound, `${method} ${p}: the same answer as a project that does not exist`);
    // …and a project that really does not exist answers the same.
    const ghost = await alice(method, p.replace(ids.bob.project, randomUUID()), body);
    assert.equal(ghost.status, 404, `ghost ${method} ${p}`);
  }
  // Mixing her own project with bob's ids under it does not reach bob's files either (the sub-id is tied to the project).
  const mixed = await alice('GET', `/api/projects/${ids.alice.project}/analyses/${ids.bob.analysis}/screens/desktop-fold.webp`);
  assert.equal(mixed.status, 404);
  assert.equal((await alice('GET', `/api/projects/${ids.alice.project}/recreate/${ids.bob.recreate}/download`)).status, 404);
  assert.equal((await alice('GET', `/api/projects/${ids.nobody}`)).status, 404, 'an unowned project is nobody\'s');

  // Bob's project is untouched: still there, same name and address.
  const d = new DatabaseSync(file, { readOnly: true });
  const row = d.prepare('SELECT name, url, owner_id FROM projects WHERE id = ?').get(ids.bob.project);
  assert.deepEqual({ ...row }, { name: "bob's site", url: 'https://bob.example/', owner_id: ids.bob.user });
  assert.equal(d.prepare('SELECT count(*) AS n FROM recreates WHERE project_id = ?').get(ids.bob.project).n, 1);
  d.close();

  // A new project is its creator's and nobody else's.
  const made = await alice('POST', '/api/projects', { url: 'https://new-site.example/', authorized: true });
  assert.equal(made.status, 201);
  assert.equal('owner_id' in made.json, false);
  const d2 = new DatabaseSync(file, { readOnly: true });
  assert.equal(d2.prepare('SELECT owner_id FROM projects WHERE id = ?').get(made.json.id).owner_id, ids.alice.user);
  d2.close();
  assert.equal((await bob('GET', `/api/projects/${made.json.id}`)).status, 404);
  assert.equal((await alice('GET', '/api/projects')).json.length, 2);
  // The owner can delete her own.
  assert.equal((await alice('DELETE', `/api/projects/${made.json.id}`)).status, 204);
});

test('change password: the current one is needed, other sessions end, the new one signs in', { timeout: 120000 }, async (t) => {
  const { alice, session } = await twoAccounts(t);
  const other = await session('alice@example.com'); // a second browser
  const wrong = await alice('POST', '/api/auth/password', { currentPassword: 'nope-nope', newPassword: 'newpassword1' });
  assert.deepEqual([wrong.status, wrong.json.field], [400, 'currentPassword']);
  const weak = await alice('POST', '/api/auth/password', { currentPassword: 'password123', newPassword: 'short' });
  assert.deepEqual([weak.status, weak.json.field], [400, 'newPassword']);
  const ok = await alice('POST', '/api/auth/password', { currentPassword: 'password123', newPassword: 'newpassword1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await alice('GET', '/api/auth/me')).status, 200, 'this session stays');
  assert.equal((await other('GET', '/api/auth/me')).status, 401, 'the other session ended');
  await assert.rejects(session('alice@example.com', 'password123'), 'the old password no longer signs in');
  await session('alice@example.com', 'newpassword1');
});

test('a job takes its owner from the project row, not from a session (an auto-resume has none)', async () => {
  const projectId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, name, url, authorized, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(projectId, 'p', 'https://p.example/', now, now);
  const manager = new JobManager({ table: 'analyses', noun: 'a test job', steps: [], run: async () => ({}) });
  const job = manager.start({ id: projectId, owner_id: 'owner-from-the-row', authorized: 1 });
  assert.equal(manager.ownerOf(job.id), 'owner-from-the-row');
  assert.equal('ownerId' in job, false, 'not in what the app is sent');
  const unowned = new JobManager({ table: 'reaudits', noun: 'another test job', steps: [], run: async () => ({}) });
  assert.equal(unowned.ownerOf(unowned.start({ id: projectId }).id), null);
});

test('the SSE stream of a live job is only reachable under the job\'s own project', () => {
  const live = { id: 'j1', projectId: 'A', status: 'running' };
  const manager = { get: (id) => (id === 'j1' ? live : null) };
  const res = () => {
    const r = { code: 200, body: null, headers: {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, set() { return r; }, flushHeaders() {}, write() {}, end() {}, on() {} };
    return r;
  };
  const other = res();
  streamJob({ params: { id: 'B' }, on() {} }, other, manager, 'j1', () => undefined);
  assert.deepEqual([other.code, other.body], [404, { error: 'Job not found.' }]);
});
