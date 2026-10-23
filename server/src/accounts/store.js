// @ts-check
// Every SQL statement about accounts, behind small functions (docs/ACCOUNTS.md: a later move to Postgres is this one module).
// Tables from db/migrations.js: users, sessions, email_codes. Session tokens and email codes are never stored, only their hashes.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';

export const SESSION_DAYS = 30;
const TOUCH_EVERY_MS = 10 * 60 * 1000;
export { CODE_MINUTES, CODE_ATTEMPTS } from './policy.js'; // the numbers live without the database, so the mail template can read them
import { CODE_MINUTES, CODE_ATTEMPTS } from './policy.js';
// Codes emailed to one address (whoever asked): a cap per hour and per day, so a stranger typing someone's address into sign-up
// again and again cannot flood that inbox, and the sending account is not reported for it. There is no resend route, so each
// code is one sign-up.
export const CODES_PER_HOUR = 3;
export const CODES_PER_DAY = 6;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** @typedef {{ id: string, email: string, name: string | null, password_hash: string | null, role: string, email_verified_at: string | null, created_at: string, updated_at: string }} UserRow */

/** What the app is told about an account: never the password hash. */
export const publicUser = (/** @type {UserRow} */ u) => ({ id: u.id, email: u.email, name: u.name ?? null, role: u.role, verified: Boolean(u.email_verified_at), createdAt: u.created_at });

// --- users ------------------------------------------------------------------------------------------------------------------
const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const byId = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare("INSERT INTO users (id, email, name, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)");
const setName = db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?');
const setPassword = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?');
const setVerified = db.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?');

/** @returns {UserRow | undefined} */
export const findUserByEmail = (email) => /** @type {any} */ (byEmail.get(email));
/** @returns {UserRow | undefined} */
export const findUser = (id) => /** @type {any} */ (byId.get(id));

/** @param {{ email: string, passwordHash: string, verified: boolean }} o @returns {UserRow} */
export function createUser({ email, name = null, passwordHash, verified }) {
  const id = randomUUID();
  const now = iso();
  insertUser.run(id, email, name, passwordHash, verified ? now : null, now, now);
  return /** @type {UserRow} */ (findUser(id));
}

/**
 * An unverified account is a claim, not an ownership: signing up again with its address sets a new password and ends its
 * sessions (whoever verifies the address keeps it). This is also how the owner account (made by db:migrate, no password) is taken.
 * @param {string} userId @param {{ passwordHash: string, verified: boolean }} o
 */
export function reclaimUser(userId, { passwordHash, verified, name = null }) {
  const now = iso();
  db.exec('BEGIN IMMEDIATE');
  try {
    setPassword.run(passwordHash, now, userId);
    if (verified) setVerified.run(now, now, userId);
    if (name) setName.run(name, now, userId);
    deleteUserSessions.run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return /** @type {UserRow} */ (findUser(userId));
}

export const markVerified = (userId) => setVerified.run(iso(), iso(), userId);

const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?');

/** A new password; every other session of the account ends (a password is changed because it may be known). */
export function changePassword(userId, passwordHash, keepSessionId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    setPassword.run(passwordHash, iso(), userId);
    deleteOtherSessions.run(userId, keepSessionId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
const latestCode = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1');
const countAttempt = db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?');
const useCode = db.prepare('UPDATE email_codes SET used_at = ? WHERE id = ?');
const retireCodes = db.prepare('UPDATE email_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL');
const deleteCodeById = db.prepare('DELETE FROM email_codes WHERE id = ?');
const codesSince = db.prepare('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? AND created_at > ? ORDER BY created_at ASC');

const codeHash = (id, code) => sha256(`${id}:${code}`);

/**
 * A new six-digit code for this purpose; earlier unused ones stop working. The code itself is returned once, to be emailed, and
 * only its hash (salted with the row's own id) is stored.
 * @param {UserRow} user @param {string} purpose
 * @returns {{ id: string, code: string, expiresAt: string }}
 */
export function createCode(user, purpose) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = iso(now + CODE_MINUTES * 60_000);
  retireCodes.run(iso(now), user.id, purpose);
  insertCode.run(id, user.id, user.email, purpose, codeHash(id, code), iso(now), expiresAt);
  return { id, code, expiresAt };
}

/** A code whose email could not be sent is removed: it counts for nothing (not for the per-address cap either). */
export const discardCode = (id) => deleteCodeById.run(id);

/**
 * Whether one more code may be emailed to this address now, under CODES_PER_HOUR / CODES_PER_DAY (every code made for the
 * address counts, used or not: what matters is what reached the inbox).
 * @returns {{ ok: true } | { ok: false, retryAfterMs: number, window: 'hour' | 'day' }}
 */
export function codeAllowance(email, purpose, now = Date.now()) {
  const day = /** @type {{ created_at: string }[]} */ (codesSince.all(email, purpose, iso(now - 86400_000))).map((r) => Date.parse(r.created_at));
  if (day.length >= CODES_PER_DAY) return { ok: false, retryAfterMs: day[day.length - CODES_PER_DAY] + 86400_000 - now, window: 'day' };
  const hour = day.filter((t) => t > now - 3600_000);
  if (hour.length >= CODES_PER_HOUR) return { ok: false, retryAfterMs: hour[hour.length - CODES_PER_HOUR] + 3600_000 - now, window: 'hour' };
  return { ok: true };
}

/**
 * Checks a code against the latest one of this purpose. 'ok' uses it up. A used, expired or exhausted code is refused whatever is
 * typed; a wrong try counts, and the try that reaches CODE_ATTEMPTS retires the code. The hashes are compared in constant time.
 * @returns {{ status: 'ok' | 'wrong' | 'used' | 'expired' | 'none' | 'too-many', triesLeft: number }}
 */
export function checkCode(userId, purpose, code) {
  const row = /** @type {any} */ (latestCode.get(userId, purpose));
  if (!row) return { status: 'none', triesLeft: 0 };
  if (row.attempts >= CODE_ATTEMPTS) return { status: 'too-many', triesLeft: 0 };
  if (row.used_at) return { status: 'used', triesLeft: 0 };
  if (Date.parse(row.expires_at) <= Date.now()) return { status: 'expired', triesLeft: 0 };
  const given = Buffer.from(codeHash(row.id, String(code ?? '').trim()), 'hex');
  const stored = Buffer.from(String(row.code_hash), 'hex');
  const same = given.length === stored.length && timingSafeEqual(given, stored);
  if (!same) {
    countAttempt.run(row.id);
    const left = CODE_ATTEMPTS - (row.attempts + 1);
    if (left <= 0) {
      useCode.run(iso(), row.id); // dead: a later correct guess is refused too
      return { status: 'too-many', triesLeft: 0 };
    }
    return { status: 'wrong', triesLeft: left };
  }
  useCode.run(iso(), row.id);
  return { status: 'ok', triesLeft: 0 };
}
