// @ts-check
// Handing the owner role to another account (`npm run accounts -w server -- transfer-owner <email>`, scripts/accounts.mjs).
// The owner is users.role = 'owner', set once by the owner migration (db/migrations.js, SAS_OWNER_EMAIL); after that, this is
// the only way to change it. Works on a database handle the caller opened, never on the server's own connection (db/index.js),
// so it can be run on a scratch database by a test.
//
// planTransfer only reads and says what would change (or why it refuses); applyTransfer makes the change in ONE transaction and
// checks it before COMMIT: every table keeps its row count, there is exactly one owner and it is the target, and the projects are
// where they should be. Any failed check rolls everything back. Nothing but users.role (+ updated_at) and, with moveProjects,
// projects.owner_id changes. Sessions are left alone: the role is read from the database on every request.
import { connect } from 'node:net';
import { rowCounts } from '../db/backup.js';
import { ownershipProblems } from '../db/apply.js';
import { normalizeEmail } from '../db/migrations.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {{ id: string, email: string, role: string, verified: boolean, projects: number }} Account */
/** @typedef {{ ok: false, problems: string[] } | { ok: true, target: Account, owner: Account, moveProjects: boolean }} Plan */

/** @param {DatabaseSync} db @param {string} where @param {unknown[]} args @returns {Account[]} */
function accounts(db, where, ...args) {
  return /** @type {any[]} */ (db.prepare(`
    SELECT u.id, u.email, u.role, u.email_verified_at IS NOT NULL AS verified,
           (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) AS projects
    FROM users u WHERE ${where}`).all(...args)).map((u) => ({ id: u.id, email: u.email, role: u.role, verified: Boolean(u.verified), projects: Number(u.projects) }));
}

/**
 * What a transfer to `email` would change, or why it is refused (in plain words).
 * @param {DatabaseSync} db @param {string} email @param {{ moveProjects?: boolean }} [o]
 * @returns {Plan}
 */
export function planTransfer(db, email, { moveProjects = false } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, problems: [`"${email ?? ''}" is not an email address.`] };
  const [target] = accounts(db, 'u.email = ?', normalized);
  if (!target) return { ok: false, problems: [`${normalized} has no account. Sign up with it first, then run this again.`] };
  if (!target.verified) return { ok: false, problems: [`${normalized} has not verified its email address yet. Verify it first, then run this again.`] };
  if (target.role === 'owner') return { ok: false, problems: [`${normalized} is already the owner. Nothing to do.`] };
  const owners = accounts(db, "u.role = 'owner'");
  if (owners.length !== 1) {
    return { ok: false, problems: [`There must be exactly one owner account to hand over; this database has ${owners.length}${owners.length ? ` (${owners.map((o) => o.email).join(', ')})` : ''}.`] };
  }
  return { ok: true, target, owner: owners[0], moveProjects };
}

/**
 * The transfer, in one transaction, checked before COMMIT. Throws (after ROLLBACK) when any check fails.
 * @param {DatabaseSync} db
 * @param {Plan & { ok: true }} plan
 * @param {{ now?: string, beforeCheck?: (db: DatabaseSync) => void }} [o]  beforeCheck: tests only, runs inside the transaction
 * @returns {{ before: Record<string, number>, after: Record<string, number>, moved: number, target: Account, owner: Account }}
 */
export function applyTransfer(db, plan, { now = new Date().toISOString(), beforeCheck } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again inside the transaction: nothing may have changed since the plan.
    const [target] = accounts(db, 'u.id = ?', plan.target.id);
    const owners = accounts(db, "u.role = 'owner'");
    if (!target || !target.verified || target.role === 'owner') throw new Error(`${plan.target.email} changed since the check; run the command again`);
    if (owners.length !== 1 || owners[0].id !== plan.owner.id) throw new Error('the owner account changed since the check; run the command again');
    const owner = owners[0];
    const others = accounts(db, 'u.id NOT IN (?, ?)', target.id, owner.id);

    const before = rowCounts(db);
    const setRole = db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?');
    setRole.run('owner', now, target.id);
    setRole.run('user', now, owner.id);
    const moved = plan.moveProjects ? Number(db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id = ?').run(target.id, owner.id).changes) : 0;
    beforeCheck?.(db);

    const after = rowCounts(db);
    const problems = [];
    const rowChanges = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
    if (rowChanges.length) problems.push(`row counts changed (${rowChanges.map((t) => `${t}: ${before[t]} → ${after[t]}`).join(', ')})`);
    const nowOwners = accounts(db, "u.role = 'owner'");
    if (nowOwners.length !== 1 || nowOwners[0].id !== target.id) problems.push(`the owner is not exactly ${target.email} (owners: ${nowOwners.map((o) => o.email).join(', ') || 'none'})`);
    const [targetAfter] = accounts(db, 'u.id = ?', target.id);
    const [ownerAfter] = accounts(db, 'u.id = ?', owner.id);
    if (ownerAfter?.role !== 'user') problems.push(`${owner.email} is not an ordinary user`);
    const wantTarget = plan.moveProjects ? target.projects + owner.projects : target.projects;
    const wantOwner = plan.moveProjects ? 0 : owner.projects;
    if (moved !== (plan.moveProjects ? owner.projects : 0)) problems.push(`${moved} project(s) moved, expected ${plan.moveProjects ? owner.projects : 0}`);
    if (targetAfter?.projects !== wantTarget) problems.push(`${target.email} owns ${targetAfter?.projects} project(s), expected ${wantTarget}`);
    if (ownerAfter?.projects !== wantOwner) problems.push(`${owner.email} owns ${ownerAfter?.projects} project(s), expected ${wantOwner}`);
    for (const o of others) {
      const [x] = accounts(db, 'u.id = ?', o.id);
      if (x?.role !== o.role || x?.projects !== o.projects) problems.push(`${o.email} changed (it must not)`);
    }
    problems.push(...ownershipProblems(db));
    if (problems.length) throw new Error(problems.join('; '));

    db.exec('COMMIT');
    return { before, after, moved, target: /** @type {Account} */ (targetAfter), owner: /** @type {Account} */ (ownerAfter) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Whether something answers on 127.0.0.1:port (a server holding the database open). The same check as scripts/db-migrate.mjs.
 * @param {number} port @returns {Promise<boolean>}
 */
export function serverListening(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
