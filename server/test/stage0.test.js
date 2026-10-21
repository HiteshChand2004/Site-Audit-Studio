// Stage 0 of accounts (docs/HANDOFF.md): who can reach the API, what user URLs may reach, the accounts switch, one module for
// every path, and a database backup + migration rehearsal that never writes the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindHost, isLoopbackHost, allowLocalhost, startupProblems, accountsEnabled, DEFAULT_BIND_HOST } from '../src/config/index.js';
import * as paths from '../src/config/paths.js';
import { precheckUrl } from '../src/security/netGuard.js';
import { backupDatabase, backupName } from '../src/db/backup.js';
import { rehearse } from '../src/db/rehearse.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_KEYS = ['SAS_BIND_HOST', 'SAS_ALLOW_LOCALHOST', 'SAS_ACCOUNTS'];

/** Runs fn with these env values (undefined = unset), then puts the env back. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('the API listens on this computer only unless SAS_BIND_HOST says otherwise', () => withEnv({ SAS_BIND_HOST: undefined }, () => {
  assert.equal(DEFAULT_BIND_HOST, '127.0.0.1');
  assert.equal(bindHost(), '127.0.0.1');
  process.env.SAS_BIND_HOST = '0.0.0.0';
  assert.equal(bindHost(), '0.0.0.0');
  process.env.SAS_BIND_HOST = '  ';
  assert.equal(bindHost(), '127.0.0.1', 'blank is the default');
  for (const h of ['127.0.0.1', '127.5.6.7', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.1', 'example.com']) assert.equal(isLoopbackHost(h), false, h);
}));

test('SAS_ALLOW_LOCALHOST is off by default and never in effect unless the API is bound to this computer', () => withEnv({}, async () => {
  await withEnv({ SAS_ALLOW_LOCALHOST: undefined, SAS_BIND_HOST: undefined }, () => {
    assert.equal(allowLocalhost(), false);
    assert.match(precheckUrl('http://localhost:4100/'), /loopback/);
  });
  await withEnv({ SAS_ALLOW_LOCALHOST: '1', SAS_BIND_HOST: undefined }, () => {
    assert.equal(allowLocalhost(), true);
    assert.equal(precheckUrl('http://localhost:4100/'), null, 'the dev flag on a loopback-bound server still works (fixture site)');
    assert.deepEqual(startupProblems(), []);
  });
  await withEnv({ SAS_ALLOW_LOCALHOST: '1', SAS_BIND_HOST: '0.0.0.0' }, () => {
    assert.equal(allowLocalhost(), false, 'bound to the network, the flag has no effect');
    assert.match(precheckUrl('http://localhost:4100/'), /loopback/);
    assert.match(precheckUrl('http://127.0.0.1:4100/'), /loopback/);
    assert.match(startupProblems()[0], /SAS_ALLOW_LOCALHOST/, 'and the server refuses to start');
  });
}));

test('SAS_ACCOUNTS is off by default; on, the server refuses to start (accounts are not built yet)', () => withEnv({ SAS_ACCOUNTS: undefined, SAS_ALLOW_LOCALHOST: undefined }, async () => {
  assert.equal(accountsEnabled(), false);
  assert.deepEqual(startupProblems(), []);
  for (const off of ['0', '', 'false']) {
    process.env.SAS_ACCOUNTS = off;
    assert.equal(accountsEnabled(), false, `"${off}" is off`);
  }
  process.env.SAS_ACCOUNTS = '1';
  assert.match(startupProblems()[0], /SAS_ACCOUNTS/);
}));

test('every path comes from config/paths.js and resolves where it always did', () => {
  assert.equal(paths.DATA_DIR, path.resolve(process.env.SAS_DATA_DIR));
  assert.equal(paths.DB_FILE, path.join(paths.DATA_DIR, 'app.db'));
  assert.equal(paths.projectDir('p1'), path.join(paths.DATA_DIR, 'projects', 'p1'));
  assert.equal(paths.auditDir('p1'), path.join(paths.DATA_DIR, 'projects', 'p1', 'audit'));
  assert.equal(paths.auditDir('p1', 'a1'), path.join(paths.DATA_DIR, 'projects', 'p1', 'audit', 'a1'));
  assert.equal(paths.recreateRoot('p1'), path.join(paths.DATA_DIR, 'projects', 'p1', 'recreate'));
  assert.equal(paths.toolchainDir('next'), path.join(SERVER, 'toolchains', 'next'));
  assert.equal(paths.LOGS_DIR, paths.DATA_DIR);
  const saved = process.env.SAS_TEMP_DIR;
  try {
    delete process.env.SAS_TEMP_DIR;
    assert.equal(paths.tempDir(), os.tmpdir());
    process.env.SAS_TEMP_DIR = 'X:/elsewhere';
    assert.equal(paths.tempDir(), 'X:/elsewhere', 'read at call time');
  } finally {
    if (saved === undefined) delete process.env.SAS_TEMP_DIR; else process.env.SAS_TEMP_DIR = saved;
  }
});

/** A database like the app's: some rows still in the WAL file (the server is running), one column another branch added. */
async function sampleDb(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-stage0-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, stack TEXT NOT NULL DEFAULT 'html',
      authorized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, mirror_mode INTEGER NOT NULL DEFAULT 0);
    INSERT INTO projects (id, name, url, created_at, updated_at) VALUES ('p1', 'One', 'https://one.dev', 't', 't'), ('p2', 'Two', 'https://two.dev', 't', 't');`);
  return { dir, file, db };
}
const sha = async (f) => createHash('sha256').update(await readFile(f)).digest('hex');

test('a backup is a whole, checked copy taken read-only, even with rows still in the WAL', async (t) => {
  const { dir, file, db } = await sampleDb(t);
  // The writer stays open (as the running server does), so its rows are still in the WAL: the source is the main file + WAL.
  const source = async () => `${await sha(file)}:${await sha(`${file}-wal`)}`;
  const before = await source();
  const out = path.join(dir, 'backups');
  const now = new Date('2026-10-21T10:11:12Z');
  const a = await backupDatabase({ dbFile: file, dir: out, now });
  const b = await backupDatabase({ dbFile: file, dir: out, now });
  assert.equal(await source(), before, 'neither the database file nor its WAL is written by a backup');
  db.close();
  assert.equal(path.basename(a.file), backupName(now));
  assert.equal(path.basename(a.file), 'app-2026-10-21T10-11-12.db');
  assert.notEqual(a.file, b.file, 'a second backup in the same second gets its own name');
  assert.equal(a.tables.projects, 2, 'the rows still in the WAL are in the copy');
  await assert.rejects(backupDatabase({ dbFile: path.join(dir, 'missing.db'), dir: out }), 'no source, no empty backup');
});

test('the rehearsal applies the server\'s schema to a copy and proves nothing was lost; the source is untouched', async (t) => {
  const { dir, file, db } = await sampleDb(t);
  db.close();
  const before = await sha(file);
  const work = await mkdtemp(path.join(os.tmpdir(), 'sas-stage0-work-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const r = await rehearse({ dbFile: file, workDir: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.unknownColumns, ['projects.mirror_mode'], 'a column another branch added is named');
  assert.ok(r.addedTables.includes('analyses') && r.addedColumns.includes('projects.page_url'), 'the startup schema brought an older database up to date');
  assert.equal(r.tables.projects.rows, 2);
  assert.equal(await sha(file), before, 'the source is never written');

  // A migration that would lose data is caught: a dropped column, deleted rows.
  const drop = await rehearse({ dbFile: file, workDir: work, migrations: [{ id: 'drop', up: (d) => d.exec('ALTER TABLE projects DROP COLUMN mirror_mode') }] });
  assert.equal(drop.ok, false);
  assert.deepEqual(drop.lostColumns, ['projects.mirror_mode']);
  const del = await rehearse({ dbFile: file, workDir: work, migrations: [{ id: 'delete', up: (d) => d.exec("DELETE FROM projects WHERE id = 'p2'") }] });
  assert.equal(del.ok, false);
  assert.deepEqual(del.rowChanges, ['projects: 2 → 1']);
  // A failing migration is rolled back and reported.
  const bad = await rehearse({ dbFile: file, workDir: work, migrations: [{ id: 'bad', up: (d) => d.exec('ALTER TABLE nowhere ADD COLUMN x TEXT') }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.find((s) => s.id === 'bad').ok, false);
  assert.equal(await sha(file), before);
  assert.ok((await readdir(dir)).every((f) => !f.startsWith('app-')), 'no copy is left beside the source');
});

// The real server process: where it listens, and the settings it refuses to start with (before it opens any database).
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const lanAddress = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
const get = (host, port) => new Promise((resolve) => {
  const req = request({ host, port, path: '/api/health', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', (e) => resolve(e.code));
  req.on('timeout', () => { req.destroy(); resolve('timeout'); });
  req.end();
});

async function startServer(t, env) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-stage0-srv-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: { ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir, PORT: String(port), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0', SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', SAS_ACCOUNTS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // The process first (it holds the database open), then its folder.
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const ready = await Promise.race([
    (async () => { for (let i = 0; i < 100; i++) { if (/API ready/.test(out)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })(),
    exited.then(() => false),
  ]);
  return { port, dataDir, ready, exited, output: () => out };
}

test('the server listens on 127.0.0.1 by default: this computer answers, the network does not', { timeout: 120000 }, async (t) => {
  const s = await startServer(t, {});
  assert.equal(s.ready, true, s.output());
  assert.match(s.output(), /127\.0\.0\.1:\d+ \(this computer only\)/);
  assert.equal(await get('127.0.0.1', s.port), 200);
  const lan = lanAddress();
  if (!lan) return t.skip('no network address on this computer to try');
  assert.notEqual(await get(lan, s.port), 200, `not reachable on ${lan}`);
});

test('unsafe or unbuilt settings stop the server before it opens the database', { timeout: 120000 }, async (t) => {
  for (const env of [{ SAS_BIND_HOST: '0.0.0.0', SAS_ALLOW_LOCALHOST: '1' }, { SAS_ACCOUNTS: '1' }]) {
    const s = await startServer(t, env);
    assert.equal(s.ready, false);
    assert.equal(await s.exited, 1, s.output());
    assert.match(s.output(), /Not starting:/);
    assert.equal(await stat(path.join(s.dataDir, 'app.db')).then(() => true, () => false), false, `no database opened (${JSON.stringify(env)})`);
  }
});
