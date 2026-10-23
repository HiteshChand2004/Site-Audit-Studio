// @ts-check
// Applying pending migrations (db/migrations.js) to an open database: every one of them and its record in `schema_migrations` in
// ONE transaction, so a failure anywhere rolls all of it back and the database is exactly as it was. Used on a scratch copy by the
// rehearsal (db/rehearse.js) and on the real database by db/migrate.js, so both run the very same code.
import { MIGRATIONS } from './migrations.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('./migrations.js').Migration} Migration */
/** @typedef {import('./migrations.js').MigrationContext} MigrationContext */

/** @param {DatabaseSync} db @param {string} name */
export const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * The migrations not yet recorded as applied.
 * @param {DatabaseSync} db @param {Migration[]} [migrations]
 */
export function pendingMigrations(db, migrations = MIGRATIONS) {
  if (!hasTable(db, 'schema_migrations')) return [...migrations];
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  return migrations.filter((m) => !done.has(m.id));
}

/**
 * Every pending migration in one transaction. Throws (after rolling everything back) when one fails.
 * @param {DatabaseSync} db @param {{ migrations?: Migration[] } & MigrationContext} [o]
 * @returns {string[]} the ids applied
 */
export function applyMigrations(db, { migrations = MIGRATIONS, ...ctx } = {}) {
  const pending = pendingMigrations(db, migrations);
  if (!pending.length) return [];
  db.exec('BEGIN IMMEDIATE');
  let current = '';
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
    for (const m of pending) {
      current = m.id;
      m.up(db, ctx);
      record.run(m.id, new Date().toISOString());
    }
    db.exec('COMMIT');
    return pending.map((m) => m.id);
  } catch (err) {
    db.exec('ROLLBACK');
    const e = /** @type {Error} */ (err);
    throw Object.assign(new Error(`migration ${current} failed, nothing was changed: ${e.message ?? e}`), { migration: current, cause: e });
  }
}

/**
 * Checks about the data, not the shape, once the accounts migrations ran: every project has an owner, that owner exists, and
 * there is an owner account.
 * @param {DatabaseSync} db
 * @returns {string[]}
 */
export function ownershipProblems(db) {
  if (!hasTable(db, 'users')) return ['no users table'];
  const problems = [];
  const unowned = Number(db.prepare('SELECT count(*) AS n FROM projects WHERE owner_id IS NULL').get().n);
  if (unowned) problems.push(`${unowned} project(s) without an owner`);
  const dangling = Number(db.prepare('SELECT count(*) AS n FROM projects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.owner_id IS NOT NULL AND u.id IS NULL').get().n);
  if (dangling) problems.push(`${dangling} project(s) owned by a user who does not exist`);
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get()) problems.push('no owner account');
  return problems;
}
