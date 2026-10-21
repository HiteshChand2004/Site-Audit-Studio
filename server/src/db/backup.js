// @ts-check
// A dated, consistent copy of the database (SQLite VACUUM INTO), taken over a read-only connection: the source is never written,
// and a copy taken while the server runs is still whole (VACUUM INTO reads one consistent snapshot, WAL included). Each copy is
// checked before it is reported: it opens, passes integrity_check, and has the same tables with the same row counts.
// Used before any migration of a real database, and by the rehearsal (db/rehearse.js), which copies before it changes anything.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BACKUPS_DIR, DB_FILE } from '../config/paths.js';

/** app-2026-10-21T14-05-09.db: sorts by time, safe on every file system. */
export const backupName = (date = new Date()) => `app-${date.toISOString().slice(0, 19).replace(/:/g, '-')}.db`;

/**
 * Tables and their row counts.
 * @param {DatabaseSync} db
 * @returns {Record<string, number>}
 */
export function rowCounts(db) {
  const tables = /** @type {{ name: string }[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
  /** @type {Record<string, number>} */
  const out = {};
  for (const { name } of tables) out[name] = Number(/** @type {{ n: number }} */ (db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get()).n);
  return out;
}

/**
 * @param {{ dbFile?: string, dir?: string, now?: Date }} [o]  dir: where the copy goes (default <data>/backups)
 * @returns {Promise<{ file: string, bytes: number, tables: Record<string, number> }>}
 */
export async function backupDatabase({ dbFile = DB_FILE, dir = BACKUPS_DIR, now = new Date() } = {}) {
  await stat(dbFile); // a missing source is an error, never an empty backup
  await mkdir(dir, { recursive: true });
  let file = path.join(dir, backupName(now));
  for (let n = 2; await stat(file).then(() => true, () => false); n++) file = path.join(dir, backupName(now).replace(/\.db$/, `-${n}.db`));

  const source = new DatabaseSync(dbFile, { readOnly: true });
  let expected;
  try {
    source.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    expected = rowCounts(source);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = /** @type {{ integrity_check: string }} */ (copy.prepare('PRAGMA integrity_check').get()).integrity_check;
    if (integrity !== 'ok') throw new Error(`the backup ${file} failed its integrity check: ${integrity}`);
    const tables = rowCounts(copy);
    const differ = Object.keys({ ...expected, ...tables }).filter((t) => expected[t] !== tables[t]);
    if (differ.length) throw new Error(`the backup ${file} does not match the database (${differ.join(', ')})`);
    return { file, bytes: (await stat(file)).size, tables };
  } finally {
    copy.close();
  }
}
