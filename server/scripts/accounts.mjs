// @ts-check
// Lists accounts, and deletes test accounts you name — with their sessions and email codes, nothing else. It never touches
// projects, analyses, copies or re-audits: an account that owns a project, and the owner account, are refused, not deleted.
// Without --yes it only shows what it would delete.
//
// Usage:
//   npm run accounts -w server                                  list every account
//   npm run accounts -w server -- delete a@x.com b@y.com        show what would go
//   npm run accounts -w server -- delete a@x.com b@y.com --yes  delete them
//   (--db <file> for another database than SAS_DATA_DIR's)
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../src/config/paths.js';
import { normalizeEmail } from '../src/db/migrations.js';

const argv = process.argv.slice(2);
const dbIndex = argv.indexOf('--db');
const dbFile = dbIndex >= 0 ? argv[dbIndex + 1] : DB_FILE;
const words = argv.filter((a, i) => !a.startsWith('--') && !(dbIndex >= 0 && i === dbIndex + 1));
const command = words[0] ?? 'list';
const yes = argv.includes('--yes');

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) {
  console.error(`${dbFile} has no accounts tables (run npm run db:migrate -w server first).`);
  process.exit(1);
}

const describe = db.prepare(`
  SELECT u.id, u.email, u.role, u.email_verified_at AS verified, u.created_at,
         (SELECT count(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
         (SELECT count(*) FROM email_codes c WHERE c.user_id = u.id) AS codes,
         (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) AS projects
  FROM users u`);
const line = (u) => `${u.email.padEnd(36)} ${u.role.padEnd(6)} ${u.verified ? 'verified  ' : 'unverified'} sessions ${u.sessions}, codes ${u.codes}, projects ${u.projects}  (created ${u.created_at.slice(0, 16).replace('T', ' ')})`;

if (command === 'list') {
  const rows = describe.all().sort((a, b) => a.created_at.localeCompare(b.created_at));
  console.log(`${rows.length} account(s) in ${dbFile}`);
  for (const u of rows) console.log(`  ${line(u)}`);
  process.exit(0);
}

if (command !== 'delete') {
  console.error(`Unknown command "${command}". Use "list" or "delete <email> [...] [--yes]".`);
  process.exit(1);
}
const emails = words.slice(1);
if (!emails.length) {
  console.error('Name the accounts to delete by email address (no wildcards).');
  process.exit(1);
}
const all = new Map(describe.all().map((u) => [u.email, u]));
const doomed = [];
let refused = false;
for (const raw of emails) {
  const email = normalizeEmail(raw);
  const u = email && all.get(email);
  if (!u) { console.error(`  not found: ${raw}`); refused = true; continue; }
  if (u.role === 'owner') { console.error(`  refused:   ${u.email} is the owner account`); refused = true; continue; }
  if (u.projects > 0) { console.error(`  refused:   ${u.email} owns ${u.projects} project(s); projects are never deleted here`); refused = true; continue; }
  doomed.push(u);
}
if (refused) {
  console.error('Nothing was deleted. Fix the list and run again.');
  process.exit(1);
}
console.log(`${yes ? 'Deleting' : 'Would delete'} ${doomed.length} account(s) (with their sessions and email codes):`);
for (const u of doomed) console.log(`  ${line(u)}`);
if (!yes) {
  console.log('Nothing deleted. Add --yes to delete them.');
  process.exit(0);
}

const tables = ['projects', 'analyses', 'recreates', 'reaudits'];
const count = (t) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
const before = Object.fromEntries(tables.map((t) => [t, count(t)]));
db.exec('BEGIN IMMEDIATE');
try {
  for (const u of doomed) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // a project still pointing at it would make this fail (no cascade)
  }
  const after = Object.fromEntries(tables.map((t) => [t, count(t)]));
  const changed = tables.filter((t) => after[t] !== before[t]);
  if (changed.length) throw new Error(`refusing: ${changed.join(', ')} would change`);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`Nothing was deleted: ${/** @type {Error} */ (err).message}`);
  process.exit(1);
}
console.log(`Deleted. Unchanged: ${tables.map((t) => `${t} ${before[t]}`).join(', ')}.`);
