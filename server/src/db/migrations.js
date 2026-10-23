// @ts-check
// Migrations, in order. Each is additive (new tables, nullable columns, never a drop, never a cascade from users), assumes nothing
// about which columns a table already has (another branch may have added some: projects.mirror_mode), and is safe to run twice.
// They are applied by db/migrate.js, all pending ones in ONE transaction, only after db/rehearse.js has proven them on a copy.
//
// A migration: { id: 'yyyy-mm-dd-name', up(db, ctx) }; ctx.ownerEmail is the operator's account (SAS_OWNER_EMAIL).

/** @typedef {{ ownerEmail?: string, now?: string }} MigrationContext */
/** @typedef {{ id: string, up: (db: import('node:sqlite').DatabaseSync, ctx: MigrationContext) => void }} Migration */

import { randomUUID } from 'node:crypto';

/** @param {import('node:sqlite').DatabaseSync} db @param {string} table @param {string} column */
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

/** A lower-cased address, or null when it is not one. */
export function normalizeEmail(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}

/** @type {Migration[]} */
export const MIGRATIONS = [
  {
    // Stage 1: the accounts data model, dormant (nothing reads it while SAS_ACCOUNTS is off).
    id: '2026-10-23-accounts-tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id                 TEXT PRIMARY KEY,
          email              TEXT NOT NULL,
          password_hash      TEXT,
          role               TEXT NOT NULL DEFAULT 'user',
          email_verified_at  TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email);

        -- Only a hash of the session token is stored: the token itself lives in the visitor's cookie alone.
        CREATE TABLE IF NOT EXISTS sessions (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL REFERENCES users(id),
          token_hash    TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          expires_at    TEXT NOT NULL,
          last_seen_at  TEXT,
          user_agent    TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS sessions_token ON sessions(token_hash);
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

        -- One-time codes sent by email (verification, later sign-in); only a hash of the code is stored.
        CREATE TABLE IF NOT EXISTS email_codes (
          id          TEXT PRIMARY KEY,
          user_id     TEXT REFERENCES users(id),
          email       TEXT NOT NULL,
          purpose     TEXT NOT NULL,
          code_hash   TEXT NOT NULL,
          attempts    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          used_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS email_codes_email ON email_codes(email, purpose);
      `);
      // Nullable, no ON DELETE action: deleting a user who still owns projects fails instead of deleting their projects.
      if (!hasColumn(db, 'projects', 'owner_id')) db.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id)');
      db.exec('CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id)');
    },
  },
  {
    // Stage 1: the operator's own account, and every project that has no owner yet given to it.
    id: '2026-10-23-accounts-owner',
    up(db, { ownerEmail, now = new Date().toISOString() }) {
      const email = normalizeEmail(ownerEmail);
      if (!email) throw new Error(`SAS_OWNER_EMAIL must be an email address (got ${ownerEmail ? `"${ownerEmail}"` : 'nothing'})`);
      let owner = /** @type {{ id: string } | undefined} */ (db.prepare('SELECT id FROM users WHERE email = ?').get(email));
      if (!owner) {
        owner = { id: randomUUID() };
        db.prepare("INSERT INTO users (id, email, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)").run(owner.id, email, now, now);
      } else {
        db.prepare("UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?").run(now, owner.id);
      }
      db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(owner.id);
    },
  },
];
