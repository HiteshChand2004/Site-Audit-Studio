// @ts-check
// Lists accounts, and deletes test accounts you name — with their sessions and email codes, nothing else. It never touches
// projects, analyses, copies or re-audits: an account that owns a project, and the owner account, are refused, not deleted.
// Without --yes it only shows what it would delete.
//
// Usage:
//   npm run accounts -w server                                  list every account
//   npm run accounts -w server -- delete a@x.com b@y.com        show what would go
//   npm run accounts -w server -- delete a@x.com b@y.com --yes  delete them
//   npm run accounts -w server -- transfer-owner new@x.com [--move-projects]        show what would change
//   npm run accounts -w server -- transfer-owner new@x.com [--move-projects] --yes  back up, then hand the owner role over
//   (--db <file> for another database than SAS_DATA_DIR's; --backup-dir <folder> for transfer-owner's backup)
//
// transfer-owner (src/accounts/transfer.js): the target must have an account with a verified email. A checked backup is written
// first (db/backup.js, as db:migrate does; default <data>/backups, or a backups folder next to --db); then, in one transaction,
// the target becomes the owner and the old owner an ordinary user, and with --move-projects every project of the old owner
// moves to the target. Row counts and owners are checked before COMMIT; any problem rolls it all back. Refused while a server
// answers on the API port when the database is the configured one (the same check as db:migrate).
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKUPS_DIR, DB_FILE } from '../src/config/paths.js';
import { normalizeEmail } from '../src/db/migrations.js';
import { backupDatabase } from '../src/db/backup.js';
import { applyTransfer, planTransfer, serverListening } from '../src/accounts/transfer.js';

const argv = process.argv.slice(2);
const dbIndex = argv.indexOf('--db');
const dbFile = dbIndex >= 0 ? argv[dbIndex + 1] : DB_FILE;
const backupIndex = argv.indexOf('--backup-dir');
const words = argv.filter((a, i) => !a.startsWith('--') && !(dbIndex >= 0 && i === dbIndex + 1) && !(backupIndex >= 0 && i === backupIndex + 1));
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

if (command === 'transfer-owner') {
  const email = words[1];
  if (!email || words.length > 2) {
    console.error('Name exactly one account: transfer-owner <email> [--move-projects] [--yes].');
    process.exit(1);
  }
  const moveProjects = argv.includes('--move-projects');
  const plan = planTransfer(db, email, { moveProjects });
  if (!plan.ok) {
    for (const p of plan.problems) console.error(`  refused: ${p}`);
    console.error('Nothing was changed.');
    process.exit(1);
  }
  const { target, owner } = plan;
  console.log(`${yes ? 'Changing' : 'Would change'} (${dbFile}):`);
  console.log(`  ${target.email}: role user → owner`);
  console.log(`  ${owner.email}: role owner → user`);
  if (moveProjects) console.log(`  projects: ${owner.projects} move from ${owner.email} to ${target.email} (${owner.email} ${owner.projects} → 0, ${target.email} ${target.projects} → ${target.projects + owner.projects})`);
  else console.log(`  projects: none move (${owner.email} keeps ${owner.projects}, ${target.email} keeps ${target.projects}); add --move-projects to move them`);
  if (!yes) {
    console.log('Nothing changed. Add --yes to make the change (a backup is written first).');
    process.exit(0);
  }
  const configured = (f) => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
  const port = Number(process.env.PORT || 4000);
  if (configured(dbFile) === configured(DB_FILE) && await serverListening(port)) {
    console.error(`  refused: something is listening on 127.0.0.1:${port} (a server with this database open?). Stop it first.`);
    console.error('Nothing was changed.');
    process.exit(1);
  }
  const backupDir = backupIndex >= 0 ? argv[backupIndex + 1] : dbIndex >= 0 ? path.join(path.dirname(path.resolve(dbFile)), 'backups') : BACKUPS_DIR;
  let backup;
  try {
    backup = await backupDatabase({ dbFile, dir: backupDir });
  } catch (err) {
    console.error(`  refused: the backup failed: ${/** @type {Error} */ (err).message}`);
    console.error('Nothing was changed.');
    process.exit(1);
  }
  console.log(`Backup written: ${backup.file}`);
  let r;
  try {
    r = applyTransfer(db, plan);
  } catch (err) {
    console.error(`Nothing was changed (rolled back): ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
  console.log('Changed:');
  console.log(`  ${r.target.email}: owner, ${r.target.projects} project(s)`);
  console.log(`  ${r.owner.email}: user, ${r.owner.projects} project(s)`);
  console.log(`  projects moved: ${r.moved}`);
  console.log(`Unchanged row counts: ${Object.entries(r.after).map(([t, n]) => `${t} ${n}`).join(', ')}.`);
  process.exit(0);
}

if (command !== 'delete') {
  console.error(`Unknown command "${command}". Use "list", "delete <email> [...] [--yes]" or "transfer-owner <email> [--move-projects] [--yes]".`);
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
