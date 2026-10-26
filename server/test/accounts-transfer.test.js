// transfer-owner (scripts/accounts.mjs + src/accounts/transfer.js): the owner role handed to another verified account, with a
// backup first and one checked transaction. Scratch databases only (a temp folder per test); the real data folder is never named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { applyTransfer, planTransfer } from '../src/accounts/transfer.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'owner@example.com';
const NEW = 'new@example.com';
const now = '2026-10-26T00:00:00.000Z';

/** A migrated scratch database: the owner (3 projects), a verified new@ (1), an unverified one, a bystander (1). */
async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-transfer-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const dbFile = path.join(dir, 'app.db');
  const db = new DatabaseSync(dbFile);
  applySchema(db);
  db.exec("INSERT INTO projects (id, name, url, created_at, updated_at) VALUES ('p1', 'a', 'https://a.dev', 't', 't'), ('p2', 'b', 'https://b.dev', 't', 't'), ('p3', 'c', 'https://c.dev', 't', 't')");
  applyMigrations(db, { ownerEmail: OWNER });
  db.exec(`UPDATE users SET email_verified_at = '${now}' WHERE email = '${OWNER}';
    INSERT INTO users (id, email, role, email_verified_at, created_at, updated_at) VALUES
      ('n', '${NEW}', 'user', '${now}', '${now}', '${now}'),
      ('u', 'unverified@example.com', 'user', NULL, '${now}', '${now}'),
      ('b', 'bystander@example.com', 'user', '${now}', '${now}', '${now}');
    INSERT INTO projects (id, name, url, owner_id, created_at, updated_at) VALUES ('p4', 'd', 'https://d.dev', 'n', 't', 't'), ('p5', 'e', 'https://e.dev', 'b', 't', 't');
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('s1', 'n', 'h1', 't', 't');`);
  db.close();
  return { dir, dbFile };
}

/** role and project count per email, and every table's row count. */
function state(dbFile) {
  const d = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const users = Object.fromEntries(d.prepare('SELECT u.email, u.role, (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) AS n FROM users u').all().map((u) => [u.email, `${u.role}:${u.n}`]));
    const rows = Object.fromEntries(['users', 'sessions', 'email_codes', 'projects', 'analyses', 'recreates', 'reaudits'].map((tb) => [tb, d.prepare(`SELECT count(*) AS n FROM ${tb}`).get().n]));
    return { users, rows };
  } finally {
    d.close();
  }
}

const START = { [OWNER]: 'owner:3', [NEW]: 'user:1', 'unverified@example.com': 'user:0', 'bystander@example.com': 'user:1' };

const run = (args, env = {}) => promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/accounts.mjs', ...args], {
  cwd: SERVER, env: { ...process.env, NODE_TEST_CONTEXT: '', ...env },
}).then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: e.stdout + e.stderr }));

const backups = (dir) => readdir(path.join(dir, 'backups')).catch(() => []);

test('refusals change nothing and write no backup', { timeout: 60000 }, async (t) => {
  const { dir, dbFile } = await scratch(t);
  const start = state(dbFile);
  assert.deepEqual(start.users, START);
  for (const [who, why] of [
    ['ghost@example.com', /has no account\. Sign up with it first/],
    ['unverified@example.com', /has not verified its email address/],
    [OWNER, /is already the owner/],
    ['not-an-email', /is not an email address/],
  ]) {
    const r = await run(['transfer-owner', who, '--move-projects', '--yes', '--db', dbFile]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, why);
    assert.match(r.out, /Nothing was changed/);
    assert.deepEqual(state(dbFile), start);
  }
  const two = await run(['transfer-owner', NEW, 'bystander@example.com', '--yes', '--db', dbFile]);
  assert.equal(two.code, 1);
  assert.match(two.out, /Name exactly one account/);
  assert.deepEqual(await backups(dir), [], 'no backup for a refusal');

  // Not exactly one owner: refused by the plan.
  const db = new DatabaseSync(dbFile);
  db.exec("UPDATE users SET role = 'owner' WHERE id = 'b'");
  const plan = planTransfer(db, NEW);
  db.close();
  assert.equal(plan.ok, false);
  assert.match(plan.problems[0], /exactly one owner account.*has 2/);
});

test('without --yes it only shows what would change', { timeout: 60000 }, async (t) => {
  const { dir, dbFile } = await scratch(t);
  const start = state(dbFile);
  const r = await run(['transfer-owner', NEW, '--move-projects', '--db', dbFile]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Would change/);
  assert.match(r.out, /new@example\.com: role user → owner/);
  assert.match(r.out, /owner@example\.com: role owner → user/);
  assert.match(r.out, /projects: 3 move from owner@example\.com to new@example\.com \(owner@example\.com 3 → 0, new@example\.com 1 → 4\)/);
  assert.match(r.out, /Nothing changed\. Add --yes/);
  assert.deepEqual(state(dbFile), start);
  assert.deepEqual(await backups(dir), []);
});

test('--yes hands the role over after a backup; projects stay without --move-projects', { timeout: 60000 }, async (t) => {
  const { dir, dbFile } = await scratch(t);
  const start = state(dbFile);
  const r = await run(['transfer-owner', NEW, '--yes', '--db', dbFile]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Backup written: .*app-.*\.db/);
  assert.match(r.out, /projects moved: 0/);
  const end = state(dbFile);
  assert.deepEqual(end.users, { ...START, [OWNER]: 'user:3', [NEW]: 'owner:1' });
  assert.deepEqual(end.rows, start.rows, 'no row added or removed, sessions kept');

  const files = await backups(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(state(path.join(dir, 'backups', files[0])), start, 'the backup is the database before the change');
});

test('--move-projects moves every project of the old owner and nobody else\'s', { timeout: 60000 }, async (t) => {
  const { dir, dbFile } = await scratch(t);
  const start = state(dbFile);
  const backupDir = path.join(dir, 'elsewhere');
  const r = await run(['transfer-owner', NEW, '--move-projects', '--yes', '--db', dbFile, '--backup-dir', backupDir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /projects moved: 3/);
  assert.match(r.out, /new@example\.com: owner, 4 project\(s\)/);
  assert.match(r.out, /owner@example\.com: user, 0 project\(s\)/);
  const end = state(dbFile);
  assert.deepEqual(end.users, { ...START, [OWNER]: 'user:0', [NEW]: 'owner:4' });
  assert.deepEqual(end.rows, start.rows);
  assert.equal((await readdir(backupDir)).length, 1, '--backup-dir is used');
  assert.deepEqual(await backups(dir), []);
});

test('a backup that cannot be written refuses before any change', { timeout: 60000 }, async (t) => {
  const { dir, dbFile } = await scratch(t);
  const start = state(dbFile);
  const blocker = path.join(dir, 'a-file');
  await writeFile(blocker, 'not a folder');
  const r = await run(['transfer-owner', NEW, '--move-projects', '--yes', '--db', dbFile, '--backup-dir', path.join(blocker, 'backups')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the backup failed/);
  assert.match(r.out, /Nothing was changed/);
  assert.deepEqual(state(dbFile), start);
});

test('a check failing inside the transaction rolls everything back', { timeout: 60000 }, async (t) => {
  const { dbFile } = await scratch(t);
  const start = state(dbFile);
  const db = new DatabaseSync(dbFile);
  try {
    const plan = planTransfer(db, NEW, { moveProjects: true });
    assert.equal(plan.ok, true);
    // A row appearing during the transfer breaks the row-count check.
    assert.throws(() => applyTransfer(/** @type {any} */ (db), /** @type {any} */ (plan), {
      beforeCheck: (d) => d.exec(`INSERT INTO users (id, email, role, created_at, updated_at) VALUES ('x', 'x@example.com', 'user', '${now}', '${now}')`),
    }), /row counts changed \(users: 4 → 5\)/);
    // A second owner appearing breaks the owner check.
    assert.throws(() => applyTransfer(/** @type {any} */ (db), /** @type {any} */ (plan), {
      beforeCheck: (d) => d.exec("UPDATE users SET role = 'owner' WHERE id = 'b'"),
    }), /the owner is not exactly new@example\.com/);
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
  assert.deepEqual(state(dbFile), start);
});

test('refused while a server answers on the API port for the configured database', { timeout: 60000 }, async (t) => {
  const { dir, dbFile } = await scratch(t);
  const start = state(dbFile);
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = String(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
  // No --db: the database is the configured one (SAS_DATA_DIR = this scratch folder).
  const r = await run(['transfer-owner', NEW, '--move-projects', '--yes'], { SAS_DATA_DIR: dir, PORT: port });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));
  assert.match(r.out, /Nothing was changed/);
  assert.deepEqual(state(dbFile), start);
  assert.deepEqual(await backups(dir), []);

  // The same with the port free goes through.
  await new Promise((resolve) => server.close(resolve));
  const ok = await run(['transfer-owner', NEW, '--yes'], { SAS_DATA_DIR: dir, PORT: port });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(state(dbFile).users[NEW], 'owner:1');
  assert.equal((await backups(dir)).length, 1);
});
