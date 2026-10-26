// Stage 1 of accounts (docs/ACCOUNTS.md): the accounts tables, nullable projects.owner_id with no cascade, the owner account from
// SAS_OWNER_EMAIL with every existing project given to it — all pending migrations in one transaction that rolls back entirely,
// proven on a copy before the real database is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, normalizeEmail } from '../src/db/migrations.js';
import { applyMigrations, pendingMigrations, ownershipProblems } from '../src/db/apply.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { applySchema } from '../src/db/schema.js';
import { rowCounts } from '../src/db/backup.js';

const OWNER = 'Owner@Example.com';
const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();
const sha = async (f) => createHash('sha256').update(await readFile(f)).digest('hex');
const boom = { id: 'boom', up: (d) => d.exec('ALTER TABLE nowhere ADD COLUMN x TEXT') };

/** A database like the real one: the server's schema, rows, and a column only another branch knows (mirror_mode). */
async function realisticDb(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-stage1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.db');
  const db = new DatabaseSync(file);
  applySchema(db);
  db.exec(`ALTER TABLE projects ADD COLUMN mirror_mode INTEGER NOT NULL DEFAULT 0;
    INSERT INTO projects (id, name, url, created_at, updated_at, mirror_mode) VALUES
      ('p1', 'One', 'https://one.dev', 't', 't', 1), ('p2', 'Two', 'https://two.dev', 't', 't', 0), ('p3', 'Three', 'https://three.dev', 't', 't', 0);
    INSERT INTO analyses (id, project_id, started_at) VALUES ('a1', 'p1', 't'), ('a2', 'p2', 't');
    INSERT INTO recreates (id, project_id, started_at) VALUES ('r1', 'p1', 't');`);
  return { dir, file, db };
}

test('the accounts migrations: tables, a nullable owner column, the owner account, every project given to it', async (t) => {
  const { db } = await realisticDb(t);
  const before = rowCounts(db);
  const applied = applyMigrations(db, { ownerEmail: OWNER });
  assert.deepEqual(applied, MIGRATIONS.map((m) => m.id));
  for (const table of ['users', 'sessions', 'email_codes', 'schema_migrations']) assert.ok(columns(db, table).length, table);
  const owner = columns(db, 'projects').find((c) => c.name === 'owner_id');
  assert.ok(owner && owner.notnull === 0, 'owner_id is nullable');
  assert.ok(columns(db, 'projects').some((c) => c.name === 'mirror_mode'), 'a column another branch added is kept');
  assert.equal(db.prepare('SELECT mirror_mode FROM projects WHERE id = ?').get('p1').mirror_mode, 1, '…with its values');
  const users = db.prepare('SELECT * FROM users').all();
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'owner@example.com', 'stored lower-cased');
  assert.equal(users[0].role, 'owner');
  assert.equal(users[0].password_hash, null);
  assert.deepEqual(db.prepare('SELECT DISTINCT owner_id FROM projects').all().map((r) => r.owner_id), [users[0].id]);
  assert.deepEqual(ownershipProblems(db), []);
  const after = rowCounts(db);
  for (const table of Object.keys(before)) assert.equal(after[table], before[table], `${table} keeps its rows`);

  // Twice is nothing: recorded as applied.
  assert.deepEqual(pendingMigrations(db), []);
  assert.deepEqual(applyMigrations(db, { ownerEmail: OWNER }), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  // …and each migration's own body is idempotent too.
  for (const m of MIGRATIONS) m.up(db, { ownerEmail: OWNER });
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  db.close();
});

test('no cascade: a user who owns projects cannot be deleted; a project can be deleted as before', async (t) => {
  const { db } = await realisticDb(t);
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, { ownerEmail: OWNER });
  const { id } = db.prepare('SELECT id FROM users').get();
  assert.throws(() => db.prepare('DELETE FROM users WHERE id = ?').run(id), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n, 3, 'no project went with it');
  db.prepare("DELETE FROM projects WHERE id = 'p3'").run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get().n, 2);
  // A project created the old way (no owner) still inserts.
  db.prepare("INSERT INTO projects (id, name, url, created_at, updated_at) VALUES ('p9', 'New', 'https://new.dev', 't', 't')").run();
  assert.equal(db.prepare("SELECT owner_id FROM projects WHERE id = 'p9'").get().owner_id, null);
  db.close();
});

test('one transaction: any failure rolls back every migration, the database stays exactly as it was', async (t) => {
  const { db } = await realisticDb(t);
  const shape = () => JSON.stringify([db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(), rowCounts(db)]);
  const before = shape();
  // A later migration fails after the accounts ones ran: all of it goes.
  assert.throws(() => applyMigrations(db, { migrations: [...MIGRATIONS, boom], ownerEmail: OWNER }), /migration boom failed, nothing was changed/);
  assert.equal(shape(), before);
  // No usable owner email: the owner migration fails, and the tables migration before it is rolled back too.
  for (const ownerEmail of [undefined, '', 'not-an-address']) {
    assert.throws(() => applyMigrations(db, { ownerEmail }), /SAS_OWNER_EMAIL/);
    assert.equal(shape(), before);
  }
  db.close();
});

test('migrateDatabase: backup, rehearsal on a copy, then apply with the counts unchanged; a failed rehearsal writes nothing', async (t) => {
  const { dir, file, db } = await realisticDb(t);
  db.close();
  const backups = path.join(dir, 'backups');

  const untouched = await sha(file);
  const bad = await migrateDatabase({ dbFile: file, ownerEmail: OWNER, backupDir: backups, migrations: [...MIGRATIONS, boom] });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, 'rehearsal');
  assert.equal(await sha(file), untouched, 'the real database was not written');
  const noOwner = await migrateDatabase({ dbFile: file, ownerEmail: '', backupDir: backups });
  assert.equal(noOwner.stage, 'rehearsal');
  assert.equal(await sha(file), untouched);

  const r = await migrateDatabase({ dbFile: file, ownerEmail: OWNER, backupDir: backups });
  assert.equal(r.ok, true, JSON.stringify(r, null, 1));
  assert.equal(r.stage, 'applied');
  assert.ok((await stat(r.backup.file)).size > 0, 'a backup was written first');
  assert.equal(r.backup.tables.projects, 3);
  assert.equal(r.rehearsal.ok, true);
  assert.deepEqual(r.rehearsal.unknownColumns, ['projects.mirror_mode'], 'the other branch\'s column is named, and kept');
  assert.equal(r.rehearsal.tables.users.rows, 1);
  assert.deepEqual(r.rowChanges, []);
  assert.deepEqual(r.ownership, []);
  assert.equal(r.before.projects, 3);
  assert.equal(r.after.projects, 3);
  assert.equal(r.after.analyses, 2);
  assert.equal(r.after.users, 1);

  const again = await migrateDatabase({ dbFile: file, ownerEmail: OWNER, backupDir: backups });
  assert.equal(again.stage, 'nothing');
});

test('email addresses', () => {
  assert.equal(normalizeEmail('  A@B.co '), 'a@b.co');
  for (const bad of ['', null, 'a@b', '@b.co', 'a b@c.co']) assert.equal(normalizeEmail(bad), null, String(bad));
});

// The 2026-10-23 incident: on a database that already had migrations recorded, the rehearsal counted the new migration's own
// row in schema_migrations as a "row count change" and refused — and printed no reason. The bookkeeping table must grow by
// exactly the migrations applied; every other table must not change; and a refusal must always say why.
const nameMigration = { id: '2099-01-01-test-column', up: (d) => { if (!d.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'test_col')) d.exec('ALTER TABLE users ADD COLUMN test_col TEXT'); } };

test('a later migration on an already-migrated database rehearses and applies; schema_migrations grows by exactly it', async (t) => {
  const { dir, file, db } = await realisticDb(t);
  applyMigrations(db, { ownerEmail: OWNER });
  db.close();
  const { rehearse } = await import('../src/db/rehearse.js');
  const work = path.join(dir, 'work');
  const r = await rehearse({ dbFile: file, workDir: work, migrations: [...MIGRATIONS, nameMigration], ownerEmail: OWNER });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.rowChanges, [], 'the bookkeeping row is not a data change');
  const m = await migrateDatabase({ dbFile: file, ownerEmail: OWNER, backupDir: path.join(dir, 'b'), migrations: [...MIGRATIONS, nameMigration] });
  assert.equal(m.ok, true, JSON.stringify(m.problems));
  assert.deepEqual(m.applied, [nameMigration.id]);
  assert.deepEqual(m.problems, []);
});

test('every refusal says why: ok is false exactly when there is at least one problem sentence naming the cause', async (t) => {
  const { dir, file, db } = await realisticDb(t);
  applyMigrations(db, { ownerEmail: OWNER });
  db.close();
  const { rehearse } = await import('../src/db/rehearse.js');
  const cases = [
    ['a dropped column', { id: 'x1', up: (d) => d.exec('ALTER TABLE projects DROP COLUMN mirror_mode') }, /column projects\.mirror_mode would be lost/],
    ['deleted rows', { id: 'x2', up: (d) => d.exec("DELETE FROM analyses WHERE id = 'a2'") }, /row count changed: analyses: 2 → 1/],
    ['replaced rows', { id: 'x3', up: (d) => d.exec("UPDATE analyses SET id = 'zz' WHERE id = 'a2'") }, /rows of analyses were replaced/],
    ['a failing migration', { id: 'x4', up: (d) => d.exec('ALTER TABLE nowhere ADD COLUMN x TEXT') }, /x4 failed: .*nowhere/],
    ['a lost migration record', { id: 'x5', up: (d) => d.exec("DELETE FROM schema_migrations WHERE id = '2026-10-23-accounts-owner'") }, /schema_migrations: records disappeared \(2026-10-23-accounts-owner\)/],
    ['a record no migration applied', { id: 'x6', up: (d) => d.exec("INSERT INTO schema_migrations (id, applied_at) VALUES ('forged', 't')") }, /records appeared that no migration applied \(forged\)/],
    ['a project losing its owner', { id: 'x7', up: (d) => d.exec("UPDATE projects SET owner_id = NULL WHERE id = 'p1'") }, /ownership: 1 project\(s\) without an owner/],
  ];
  for (const [name, migration, reason] of cases) {
    const r = await rehearse({ dbFile: file, workDir: path.join(dir, `w-${migration.id}`), migrations: [...MIGRATIONS, migration], ownerEmail: OWNER });
    assert.equal(r.ok, false, name);
    assert.ok(r.problems.length > 0, `${name}: a refusal with no reason`);
    assert.match(r.problems.join(' | '), reason, name);
    const m = await migrateDatabase({ dbFile: file, ownerEmail: OWNER, backupDir: path.join(dir, `b-${migration.id}`), migrations: [...MIGRATIONS, migration] });
    assert.equal(m.ok, false, `${name} (migrate)`);
    assert.deepEqual([m.stage, m.problems], ['rehearsal', r.problems], `${name}: migrate refuses with the rehearsal's reasons`);
  }
});
