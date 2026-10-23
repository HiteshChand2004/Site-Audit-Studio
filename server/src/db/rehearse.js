// @ts-check
// The migration rehearsal: what this server would do to a database, done to a copy of it, with proof that nothing was lost.
//   1. a consistent copy of the source (db/backup.js: read-only, VACUUM INTO) in a folder of its own — the source is never written;
//   2. the copy described: every table, its columns, its row count and a hash of every row's id;
//   3. the server's own startup schema (db/schema.js applySchema) and then every pending migration (db/migrations.js), all in ONE
//      transaction exactly as db/migrate.js applies them (db/apply.js), applied to the copy;
//   4. described again and compared: no table, column, row or id may be lost or changed; integrity_check and foreign_key_check pass;
//      once the accounts tables exist, every project has an owner who exists (db/apply.js ownershipProblems).
// Also reported: columns the source has that this code neither creates nor knows (another branch's migration).
// Nothing here opens the configured database: db/index.js is never imported.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { backupDatabase } from './backup.js';
import { applySchema } from './schema.js';
import { MIGRATIONS } from './migrations.js';
import { applyMigrations, hasTable, ownershipProblems } from './apply.js';

/** @typedef {{ columns: string[], rows: number, ids: string }} TableInfo */

/**
 * @param {DatabaseSync} db
 * @returns {Record<string, TableInfo>}
 */
export function describe(db) {
  const names = /** @type {{ name: string }[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
  /** @type {Record<string, TableInfo>} */
  const out = {};
  for (const { name } of names) {
    const q = `"${name.replace(/"/g, '""')}"`;
    const cols = /** @type {{ name: string, pk: number }[]} */ (db.prepare(`PRAGMA table_info(${q})`).all());
    const key = cols.find((c) => c.pk === 1)?.name;
    const idExpr = key ? `"${key.replace(/"/g, '""')}"` : 'rowid';
    const hash = createHash('sha256');
    for (const r of /** @type {{ k: unknown }[]} */ (db.prepare(`SELECT ${idExpr} AS k FROM ${q} ORDER BY ${idExpr}`).all())) hash.update(`${String(r.k)}\n`);
    out[name] = {
      columns: cols.map((c) => c.name),
      rows: Number(/** @type {{ n: number }} */ (db.prepare(`SELECT count(*) AS n FROM ${q}`).get()).n),
      ids: hash.digest('hex').slice(0, 16),
    };
  }
  return out;
}

/**
 * The tables and columns this code creates on an empty database (startup schema + pending migrations). A migration that cannot
 * run on an empty database (it expects data or a column another branch added) adds nothing to the list; it is the rehearsal of
 * the real copy that judges it.
 */
export function knownSchema(migrations = MIGRATIONS) {
  const mem = new DatabaseSync(':memory:');
  try {
    applySchema(mem);
    try {
      applyMigrations(mem, { migrations, ownerEmail: 'owner@example.invalid' });
    } catch {
      // see above
    }
    return describe(mem);
  } finally {
    mem.close();
  }
}

/**
 * @param {{ dbFile: string, workDir: string, migrations?: typeof MIGRATIONS, ownerEmail?: string }} o  workDir: a scratch folder for
 *   the copy; ownerEmail: the account the owner migration creates (SAS_OWNER_EMAIL)
 */
export async function rehearse({ dbFile, workDir, migrations = MIGRATIONS, ownerEmail = process.env.SAS_OWNER_EMAIL }) {
  const copy = await backupDatabase({ dbFile, dir: workDir });
  const db = new DatabaseSync(copy.file);
  const steps = [];
  let before;
  let after;
  try {
    before = describe(db);
    db.exec('PRAGMA foreign_keys = ON;');
    try {
      applySchema(db);
      steps.push({ id: 'startup schema', ok: true });
    } catch (err) {
      steps.push({ id: 'startup schema', ok: false, error: String(/** @type {Error} */ (err).message ?? err) });
    }
    try {
      for (const id of applyMigrations(db, { migrations, ownerEmail })) steps.push({ id, ok: true });
    } catch (err) {
      // One transaction: the failing migration is named, and every one of them was rolled back.
      const e = /** @type {Error & { migration?: string }} */ (err);
      steps.push({ id: e.migration || 'migrations', ok: false, error: String(e.cause?.message ?? e.message ?? e) });
    }
    after = describe(db);
    const integrity = /** @type {{ integrity_check: string }} */ (db.prepare('PRAGMA integrity_check').get()).integrity_check;
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length;
    const ownership = hasTable(db, 'users') ? ownershipProblems(db) : [];

    const lostTables = Object.keys(before).filter((t) => !after[t]);
    const lostColumns = Object.keys(before).flatMap((t) => (after[t] ? before[t].columns.filter((c) => !after[t].columns.includes(c)).map((c) => `${t}.${c}`) : []));
    const rowChanges = Object.keys(before).filter((t) => after[t] && after[t].rows !== before[t].rows).map((t) => `${t}: ${before[t].rows} → ${after[t].rows}`);
    const idChanges = Object.keys(before).filter((t) => after[t] && after[t].rows === before[t].rows && after[t].ids !== before[t].ids);
    const addedTables = Object.keys(after).filter((t) => !before[t]);
    const addedColumns = Object.keys(after).flatMap((t) => (before[t] ? after[t].columns.filter((c) => !before[t].columns.includes(c)).map((c) => `${t}.${c}`) : []));
    const known = knownSchema(migrations);
    const unknownColumns = Object.keys(before).flatMap((t) => before[t].columns.filter((c) => !known[t]?.columns.includes(c)).map((c) => `${t}.${c}`));
    const unknownTables = Object.keys(before).filter((t) => !known[t]);
    const ok = steps.every((s) => s.ok) && !lostTables.length && !lostColumns.length && !rowChanges.length && !idChanges.length
      && integrity === 'ok' && foreignKeys === 0 && !ownership.length;
    return {
      ok, copy: copy.file, steps, integrity, foreignKeyProblems: foreignKeys, ownership,
      lostTables, lostColumns, rowChanges, idChanges, addedTables, addedColumns, unknownTables, unknownColumns,
      tables: Object.fromEntries(Object.entries(after).map(([t, i]) => [t, { rows: i.rows, rowsBefore: before[t]?.rows ?? null }])),
    };
  } finally {
    db.close();
  }
}
