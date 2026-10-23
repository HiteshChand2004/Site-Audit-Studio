// @ts-check
// Migrating a real database: a checked backup first, then the rehearsal on a scratch copy of it (db/rehearse.js), and only when
// that passed, the same migrations applied to the database itself in one transaction (db/apply.js), with row counts, integrity,
// foreign keys and ownership checked before and after.
// The server never runs this by itself at startup (db/index.js applies only the startup schema): migrating is an explicit
// `npm run db:migrate -w server`.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { backupDatabase, rowCounts } from './backup.js';
import { applySchema } from './schema.js';
import { MIGRATIONS } from './migrations.js';
import { applyMigrations, pendingMigrations, ownershipProblems } from './apply.js';
import { rehearse } from './rehearse.js';
import { BACKUPS_DIR, tempDir } from '../config/paths.js';

/** @typedef {import('./migrations.js').Migration} Migration */

/**
 * Backup → rehearsal on a copy → apply → re-check. Nothing is written to dbFile unless the backup and the rehearsal succeeded.
 * @param {{ dbFile: string, ownerEmail?: string, backupDir?: string, migrations?: Migration[], log?: (line: string) => void }} o
 */
export async function migrateDatabase({ dbFile, ownerEmail, backupDir = BACKUPS_DIR, migrations = MIGRATIONS, log = () => {} }) {
  // 1. Is there anything to do? (a read-only look)
  const peek = new DatabaseSync(dbFile, { readOnly: true });
  let pending;
  try {
    pending = pendingMigrations(peek, migrations).map((m) => m.id);
  } finally {
    peek.close();
  }
  if (!pending.length) return { ok: true, stage: 'nothing', applied: [], pending };

  // 2. A checked backup of the real database.
  const backup = await backupDatabase({ dbFile, dir: backupDir });
  log(`Backup written: ${backup.file}`);

  // 3. The rehearsal on a scratch copy; it must pass, ownership checks included.
  const workDir = await mkdtemp(path.join(tempDir(), 'sas-migrate-'));
  let rehearsal;
  try {
    rehearsal = await rehearse({ dbFile, workDir, migrations, ownerEmail });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  if (!rehearsal.ok) return { ok: false, stage: 'rehearsal', backup, rehearsal, pending, applied: [] };

  // 4. The real database, in one transaction, with its counts before and after.
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const before = rowCounts(db);
    applySchema(db); // what the server does at every start anyway (idempotent): the migrations meet the schema they were rehearsed on
    let applied;
    try {
      applied = applyMigrations(db, { migrations, ownerEmail });
    } catch (err) {
      return { ok: false, stage: 'apply', backup, rehearsal, pending, applied: [], error: String(/** @type {Error} */ (err).message), before, after: rowCounts(db) };
    }
    const after = rowCounts(db);
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length;
    const rowChanges = Object.keys(before).filter((t) => after[t] !== before[t]).map((t) => `${t}: ${before[t]} → ${after[t]}`);
    const ownership = ownershipProblems(db);
    const ok = integrity === 'ok' && foreignKeys === 0 && !rowChanges.length && !ownership.length;
    return { ok, stage: 'applied', backup, rehearsal, pending, applied, before, after, integrity, foreignKeyProblems: foreignKeys, rowChanges, ownership };
  } finally {
    db.close();
  }
}
