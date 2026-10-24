// A database changes shape only through "npm run db:migrate -w server". db/index.js refuses an existing database that lacks a
// migration the code needs at load (`required`), changing nothing; a database it has just created gets those at once; and the
// regular migration path (backup, rehearsal, one transaction) adds them to a database like the real one with every row kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applySchema } from '../src/db/schema.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { applyMigrations, recordedMigrations } from '../src/db/apply.js';
import { migrateDatabase } from '../src/db/migrate.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'owner@example.com';
const JOB_COLUMNS = ['analyses.heartbeat_at', 'analyses.payload_json', 'recreates.heartbeat_at', 'recreates.payload_json', 'recreates.removed_at', 'reaudits.heartbeat_at', 'reaudits.payload_json'];
const BEFORE_JOB_COLUMNS = MIGRATIONS.filter((m) => !m.required);

const columnsOf = (db) => ['projects', 'analyses', 'recreates', 'reaudits'].flatMap((t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${t}.${c.name}`));

/** Opens db/index.js in a process of its own, the way the server and every script do. */
function openInChild(dataDir) {
  const url = pathToFileURL(path.join(SERVER, 'src/db/index.js')).href;
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `import('${url}').then((m) => { console.log('opened'); m.db.close(); })`], {
    cwd: SERVER, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir },
  });
}

/** A database like the real one before the merge: the startup schema, rows, the accounts migrations, no job columns. */
async function realBeforeMerge(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-dbreq-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.db');
  const db = new DatabaseSync(file);
  applySchema(db);
  db.exec(`INSERT INTO projects (id, name, url, created_at, updated_at) VALUES ('p1', 'One', 'https://one.dev', 't', 't');
    INSERT INTO analyses (id, project_id, status, started_at) VALUES ('a1', 'p1', 'done', 't');
    INSERT INTO recreates (id, project_id, status, started_at) VALUES ('r1', 'p1', 'running', 't');`);
  applyMigrations(db, { migrations: BEFORE_JOB_COLUMNS, ownerEmail: OWNER });
  db.close();
  return { dir, file };
}

test('an existing database without the job columns is refused, with the command to run, and nothing in it changes', async (t) => {
  const { dir, file } = await realBeforeMerge(t);
  const r = openInChild(dir);
  assert.notEqual(r.status, 0, 'refused');
  assert.doesNotMatch(r.stdout, /opened/);
  assert.match(r.stderr, /Not starting: the database .*app\.db needs migrating \(pending: 2026-10-24-job-columns\)\. Nothing was changed\. Run "npm run db:migrate -w server"/);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const c of JOB_COLUMNS) assert.ok(!columnsOf(db).includes(c), `${c} was not added silently`);
    assert.deepEqual(recordedMigrations(db), BEFORE_JOB_COLUMNS.map((m) => m.id).sort());
    assert.equal(db.prepare("SELECT status FROM recreates WHERE id = 'r1'").get().status, 'running', 'no job row was touched');
  } finally {
    db.close(); // before the folder is removed: Windows cannot delete an open database
  }
});

test('a database created just now gets the required migrations at once, and only those', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-dbreq-new-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = openInChild(dir);
  assert.equal(r.status, 0, r.stderr);
  const db = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
  try {
    for (const c of JOB_COLUMNS) assert.ok(columnsOf(db).includes(c), c);
    assert.deepEqual(recordedMigrations(db), MIGRATIONS.filter((m) => m.required).map((m) => m.id));
  } finally {
    db.close();
  }
  assert.equal(openInChild(dir).status, 0, 'and opens again');
});

test('db:migrate adds the job columns to a database like the real one: rehearsed, one transaction, every row kept; then it opens', async (t) => {
  const { dir, file } = await realBeforeMerge(t);
  const m = await migrateDatabase({ dbFile: file, ownerEmail: OWNER, backupDir: path.join(dir, 'backups') });
  assert.equal(m.ok, true, (m.problems || []).join('; '));
  assert.deepEqual(m.pending, ['2026-10-24-job-columns']);
  assert.deepEqual(m.applied, ['2026-10-24-job-columns']);
  assert.deepEqual(m.rehearsal.addedColumns.sort(), [...JOB_COLUMNS].sort(), 'the rehearsal names exactly the seven columns');
  assert.deepEqual(m.rowChanges, []);
  const r = openInChild(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /opened/);
});
