// @ts-check
// Migrates the configured database (db/migrate.js): a checked backup, the rehearsal on a scratch copy, and only when that passed,
// every pending migration applied in one transaction, with row counts shown before and after. Refuses while a server answers on
// the API port (it holds the database open and would race the migration). Exit code 1 when anything is not right.
//
// Usage:
//   npm run db:migrate -w server                      SAS_OWNER_EMAIL from server/.env
//   npm run db:migrate -w server -- --owner you@example.com [--db <file>] [--backup-dir <folder>]
import { connect } from 'node:net';
import { migrateDatabase } from '../src/db/migrate.js';
import { BACKUPS_DIR, DB_FILE } from '../src/config/paths.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const dbFile = arg('db', DB_FILE);
const ownerEmail = arg('owner', process.env.SAS_OWNER_EMAIL);
const port = Number(process.env.PORT || 4000);

const listening = await new Promise((resolve) => {
  const s = connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(1500, () => { s.destroy(); resolve(false); });
});
if (listening && !process.argv.includes('--db')) {
  console.error(`Not migrating: something is listening on 127.0.0.1:${port} (a server with the database open?). Stop it first.`);
  process.exit(1);
}

const counts = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`Database: ${dbFile}`);
const r = await migrateDatabase({ dbFile, ownerEmail, backupDir: arg('backup-dir', BACKUPS_DIR), log: (l) => console.log(l) });
if (r.stage === 'nothing') {
  console.log('Nothing to migrate: every migration is already applied.');
  process.exit(0);
}
console.log(`Pending: ${r.pending.join(', ')}`);
if (r.rehearsal) {
  console.log('Rehearsal on a scratch copy:');
  for (const s of r.rehearsal.steps) console.log(`  ${s.ok ? 'ok    ' : 'FAILED'} ${s.id}${s.error ? `: ${s.error}` : ''}`);
  for (const [t, i] of Object.entries(r.rehearsal.tables)) console.log(`  ${t}: ${i.rowsBefore ?? '-'} → ${i.rows} rows`);
  console.log(`  integrity ${r.rehearsal.integrity}, foreign-key problems ${r.rehearsal.foreignKeyProblems}, ownership ${r.rehearsal.ownership.join('; ') || 'ok'}`);
  if (r.rehearsal.unknownColumns.length) console.log(`  columns this code does not know (kept as they are): ${r.rehearsal.unknownColumns.join(', ')}`);
}
if (r.stage === 'rehearsal') {
  console.error('Rehearsal FAILED: the database was not changed.');
  process.exit(1);
}
if (r.stage === 'apply') {
  console.error(`Applying FAILED and was rolled back: ${r.error}`);
  console.error(`  counts before: ${counts(r.before)}`);
  console.error(`  counts after:  ${counts(r.after)}`);
  process.exit(1);
}
console.log(`Applied: ${r.applied.join(', ')}`);
console.log(`  counts before: ${counts(r.before)}`);
console.log(`  counts after:  ${counts(r.after)}`);
console.log(`  integrity ${r.integrity}, foreign-key problems ${r.foreignKeyProblems}, row changes ${r.rowChanges.join('; ') || 'none'}, ownership ${r.ownership.join('; ') || 'ok'}`);
console.log(r.ok ? `Migration done. Backup: ${r.backup.file}` : `Migration applied but a check FAILED. Restore from ${r.backup.file} if needed.`);
process.exitCode = r.ok ? 0 : 1;
