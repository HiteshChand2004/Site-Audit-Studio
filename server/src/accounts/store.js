// @ts-check
// Every SQL statement about accounts, behind small functions (docs/ACCOUNTS.md: a later move to Postgres is this one module).
// Tables from db/migrations.js: users, sessions, email_codes. Session tokens and email codes are never stored, only their hashes.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { db } from '../db/index.js';

export const SESSION_DAYS = 30;
const TOUCH_EVERY_MS = 10 * 60 * 1000;
export const CODE_MINUTES = 15;
export const CODE_ATTEMPTS = 5;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** @typedef {{ id: string, email: string, password_hash: string | null, role: string, email_verified_at: string | null, created_at: string, updated_at: string }} UserRow */

/** What the app is told about an account: never the password hash. */
export const publicUser = (/** @type {UserRow} */ u) => ({ id: u.id, email: u.email, role: u.role, verified: Boolean(u.email_verified_at), createdAt: u.created_at });

// --- users ------------------------------------------------------------------------------------------------------------------
const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const byId = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare("INSERT INTO users (id, email, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, ?)");
const setPassword = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?');
const setVerified = db.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?');

/** @returns {UserRow | undefined} */
export const findUserByEmail = (email) => /** @type {any} */ (byEmail.get(email));
/** @returns {UserRow | undefined} */
export const findUser = (id) => /** @type {any} */ (byId.get(id));

/** @param {{ email: string, passwordHash: string, verified: boolean }} o @returns {UserRow} */
export function createUser({ email, passwordHash, verified }) {
  const id = randomUUID();
  const now = iso();
  insertUser.run(id, email, passwordHash, verified ? now : null, now, now);
  return /** @type {UserRow} */ (findUser(id));
}

/**
 * An unverified account is a claim, not an ownership: signing up again with its address sets a new password and ends its
 * sessions (whoever verifies the address keeps it). This is also how the owner account (made by db:migrate, no password) is taken.
 * @param {string} userId @param {{ passwordHash: string, verified: boolean }} o
 */
export function reclaimUser(userId, { passwordHash, verified }) {
  const now = iso();
  db.exec('BEGIN IMMEDIATE');
  try {
    setPassword.run(passwordHash, now, userId);
    if (verified) setVerified.run(now, now, userId);
    deleteUserSessions.run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return /** @type {UserRow} */ (findUser(userId));
}

export const markVerified = (userId) => setVerified.run(iso(), iso(), userId);

// --- sessions -----------------------------------------------------------------------------------------------------------------
const insertSession = db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)');
const sessionByToken = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
const touchSession = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
const deleteSessionByToken = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteSessionById = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');

/**
 * A new session. The token goes into the cookie and nowhere else.
 * @param {string} userId @param {{ userAgent?: string }} [o]
 * @returns {{ token: string, expiresAt: string }}
 */
export function createSession(userId, { userAgent } = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = iso(now + SESSION_DAYS * 86400_000);
  insertSession.run(randomUUID(), userId, sha256(token), iso(now), expiresAt, iso(now), String(userAgent ?? '').slice(0, 300) || null);
  return { token, expiresAt };
}

/**
 * The session and its user for a cookie token, or null (unknown, expired: an expired one is removed).
 * @param {string | undefined} token
 * @returns {{ session: { id: string, expires_at: string }, user: UserRow } | null}
 */
export function sessionFor(token) {
  if (!token || token.length > 200) return null;
  const s = /** @type {any} */ (sessionByToken.get(sha256(token)));
  if (!s) return null;
  if (Date.parse(s.expires_at) <= Date.now()) {
    deleteSessionById.run(s.id);
    return null;
  }
  const user = findUser(s.user_id);
  if (!user) return null;
  if (!s.last_seen_at || Date.now() - Date.parse(s.last_seen_at) > TOUCH_EVERY_MS) touchSession.run(iso(), s.id);
  return { session: s, user };
}

export const endSession = (token) => { if (token) deleteSessionByToken.run(sha256(token)); };

// --- email codes ------------------------------------------------------------------------------------------------------------
const insertCode = db.prepare('INSERT INTO email_codes (id, user_id, email, purpose, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
const latestCode = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1');
const countAttempt = db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?');
const useCode = db.prepare('UPDATE email_codes SET used_at = ? WHERE id = ?');
const retireCodes = db.prepare('UPDATE email_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL');

const codeHash = (id, code) => sha256(`${id}:${code}`);

/**
 * A new six-digit code for this purpose; earlier unused ones stop working.
 * @param {UserRow} user @param {string} purpose
 * @returns {{ code: string, expiresAt: string }}
 */
export function createCode(user, purpose) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = iso(now + CODE_MINUTES * 60_000);
  retireCodes.run(iso(now), user.id, purpose);
  insertCode.run(id, user.id, user.email, purpose, codeHash(id, code), iso(now), expiresAt);
  return { code, expiresAt };
}

/** When the latest unused code of this purpose was made, or null. */
export function lastCodeAt(userId, purpose) {
  const row = /** @type {any} */ (latestCode.get(userId, purpose));
  return row ? Date.parse(row.created_at) : null;
}

/**
 * Checks a code. 'ok' uses it up; every wrong try counts, and after CODE_ATTEMPTS the code is dead.
 * @returns {'ok' | 'wrong' | 'expired' | 'none' | 'too-many'}
 */
export function checkCode(userId, purpose, code) {
  const row = /** @type {any} */ (latestCode.get(userId, purpose));
  if (!row) return 'none';
  if (Date.parse(row.expires_at) <= Date.now()) return 'expired';
  if (row.attempts >= CODE_ATTEMPTS) return 'too-many';
  if (codeHash(row.id, String(code ?? '').trim()) !== row.code_hash) {
    countAttempt.run(row.id);
    return row.attempts + 1 >= CODE_ATTEMPTS ? 'too-many' : 'wrong';
  }
  useCode.run(iso(), row.id);
  return 'ok';
}
