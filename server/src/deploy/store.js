// @ts-check
// The deploy tables (db/migrations.js '2026-11-14-deploy-tables'). Statements are prepared on first use, never when the module
// loads, so a database that has not been migrated yet still starts: the routes ask deployReady() and say what to run.
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { hasTable } from '../db/apply.js';
import { seal, unseal } from './secrets.js';

/** Whether the database has the deploy tables. */
export const deployReady = () => hasTable(db, 'deployments') && hasTable(db, 'hosting_connections');

export const MIGRATE_HINT = 'Going live needs a database update first. Stop the app, run "npm run db:migrate -w server" (it backs up the database and rehearses the change on a copy first), then start it again.';

/**
 * Remastly hosting (Go live, Step 1): the hosting account of Remastly itself, set up once by the owner, that every website can
 * be published on without an account of its own. Kept as a connection like any other, under this key, which no user id can be
 * (ids are UUIDs) and which `ownerKeyOf` never returns.
 */
export const REMASTLY = 'remastly';
/** Remastly as the host (hosting/): deploys of a website to Remastly's own server, under this key; no hosting account. */
export const SERVER = 'remastly-server';

/** Whose connection: the signed-in user, or the single user of the local tool. @param {any} req */
export const ownerKeyOf = (req) => (req?.user?.id ? String(req.user.id) : 'local');

const now = () => new Date().toISOString();

/** @type {Map<string, import('node:sqlite').StatementSync>} */
const cache = new Map();
/** @param {string} sql */
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};

// ---- connections ----

/** @param {any} row */
const publicConnection = (row) => (row ? { provider: row.provider, accountName: row.account_name, accountEmail: row.account_email, connectedAt: row.created_at, updatedAt: row.updated_at } : null);

/** @param {string} ownerKey @param {string} provider */
export function getConnection(ownerKey, provider) {
  return publicConnection(stmt('SELECT * FROM hosting_connections WHERE owner_key = ? AND provider = ?').get(ownerKey, provider));
}

/** @param {string} ownerKey */
export function listConnections(ownerKey) {
  return stmt('SELECT * FROM hosting_connections WHERE owner_key = ? ORDER BY provider').all(ownerKey).map(publicConnection);
}

/** The token of a connection, unsealed for one call. Null when there is none. @param {string} ownerKey @param {string} provider */
export function connectionToken(ownerKey, provider) {
  const row = /** @type {any} */ (stmt('SELECT token_sealed FROM hosting_connections WHERE owner_key = ? AND provider = ?').get(ownerKey, provider));
  return row ? unseal(row.token_sealed) : null;
}

/**
 * Saves (or replaces) a connection.
 * @param {{ ownerKey: string, provider: string, token: string, accountName?: string | null, accountEmail?: string | null }} c
 */
export function saveConnection({ ownerKey, provider, token, accountName = null, accountEmail = null }) {
  const at = now();
  stmt(`INSERT INTO hosting_connections (id, owner_key, provider, account_name, account_email, token_sealed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_key, provider) DO UPDATE SET account_name = excluded.account_name, account_email = excluded.account_email,
          token_sealed = excluded.token_sealed, updated_at = excluded.updated_at`)
    .run(randomUUID(), ownerKey, provider, accountName, accountEmail, seal(token), at, at);
  return getConnection(ownerKey, provider);
}

/** @param {string} ownerKey @param {string} provider @returns {boolean} whether one was removed */
export function removeConnection(ownerKey, provider) {
  return Number(stmt('DELETE FROM hosting_connections WHERE owner_key = ? AND provider = ?').run(ownerKey, provider).changes) > 0;
}

// ---- deployments ----

/** Where a deploy went, by its key: Remastly's own server, Remastly's Netlify account, or the person's own. @param {string} key */
const hostingOf = (key) => (key === SERVER ? 'server' : key === REMASTLY ? 'remastly' : 'own');

/** @param {any} r */
export const publicDeployment = (r) => (r ? {
  id: r.id, recreateId: r.recreate_id, stack: r.stack, provider: r.provider, status: r.status, step: r.step, error: r.error,
  siteName: r.site_name, url: r.url, deployUrl: r.deploy_url, adminUrl: r.admin_url, files: r.files, bytes: r.bytes,
  startedAt: r.started_at, finishedAt: r.finished_at, hosting: hostingOf(r.owner_key),
  restoredFrom: r.step === 'restored' ? true : undefined,
} : null);

/** @param {{ projectId: string, recreateId: string, stack: string, provider: string, ownerKey: string }} d */
export function insertDeployment({ projectId, recreateId, stack, provider, ownerKey }) {
  const id = randomUUID();
  stmt(`INSERT INTO deployments (id, project_id, recreate_id, stack, provider, owner_key, status, step, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 'package', ?)`).run(id, projectId, recreateId, stack, provider, ownerKey, now());
  return getDeployment(id);
}

const COLUMNS = { status: 'status', step: 'step', error: 'error', siteId: 'site_id', siteName: 'site_name', deployId: 'deploy_id', url: 'url', deployUrl: 'deploy_url', adminUrl: 'admin_url', files: 'files', bytes: 'bytes', finishedAt: 'finished_at' };

/** @param {string} id @param {Partial<Record<keyof typeof COLUMNS, any>>} fields */
export function updateDeployment(id, fields) {
  const keys = Object.keys(fields).filter((k) => k in COLUMNS);
  if (!keys.length) return;
  db.prepare(`UPDATE deployments SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
}

/** @param {string} id */
export const getDeployment = (id) => publicDeployment(stmt('SELECT * FROM deployments WHERE id = ?').get(id));

/** @param {string} projectId @param {number} [limit] */
export const listDeployments = (projectId, limit = 10) => stmt('SELECT * FROM deployments WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, limit).map(publicDeployment);

/**
 * The host site this website already has with this account (its last deploy that got one), so a new deploy updates the same
 * address instead of making another site.
 * @param {string} projectId @param {string} provider @param {string} ownerKey
 */
export function siteOfProject(projectId, provider, ownerKey) {
  const row = /** @type {any} */ (stmt(`SELECT site_id FROM deployments WHERE project_id = ? AND provider = ? AND owner_key = ? AND site_id IS NOT NULL
                       ORDER BY started_at DESC LIMIT 1`).get(projectId, provider, ownerKey));
  return row?.site_id ?? null;
}

/**
 * The site this website is live on now: its latest finished deploy, with the account it is on (Remastly hosting or the
 * person's own). Null when it never went live.
 * @param {string} projectId
 * @returns {{ siteId: string, ownerKey: string, hosting: 'remastly' | 'own', url: string | null } | null}
 */
export function liveSiteOf(projectId) {
  const row = /** @type {any} */ (stmt(`SELECT site_id, owner_key, url FROM deployments WHERE project_id = ? AND status = 'ready' AND site_id IS NOT NULL
                       ORDER BY started_at DESC LIMIT 1`).get(projectId));
  return row ? { siteId: row.site_id, ownerKey: row.owner_key, hosting: hostingOf(row.owner_key), url: row.url } : null;
}

/**
 * Go live Step 4: an earlier finished deploy of this website put back as the live one. It is recorded as a new deploy (step
 * 'restored') with the earlier one's files, so the newest finished deploy is always what is live.
 * @param {string} projectId @param {string} deploymentId
 * @returns {{ row: any, live: any } | null}  null when it is not a finished deploy of this website on its current site
 */
export function restorable(projectId, deploymentId) {
  const row = /** @type {any} */ (stmt(`SELECT * FROM deployments WHERE id = ? AND project_id = ? AND status = 'ready' AND deploy_id IS NOT NULL AND site_id IS NOT NULL`).get(deploymentId, projectId));
  const live = liveSiteOf(projectId);
  if (!row || !live || row.site_id !== live.siteId || row.owner_key !== live.ownerKey) return null;
  return { row, live };
}

/** @param {any} row  the earlier deploy @returns {any} the new, live row */
export function insertRestored(row) {
  const id = randomUUID();
  const at = now();
  stmt(`INSERT INTO deployments (id, project_id, recreate_id, stack, provider, owner_key, site_id, site_name, deploy_id, url, deploy_url, admin_url,
        status, step, files, bytes, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'restored', ?, ?, ?, ?)`)
    .run(id, row.project_id, row.recreate_id, row.stack, row.provider, row.owner_key, row.site_id, row.site_name, row.deploy_id, row.url,
      row.deploy_url, row.admin_url, row.files, row.bytes, at, at);
  return getDeployment(id);
}

/** Finished deploys of a website to Remastly's own server, newest first (their releases are kept on disk). @param {string} projectId */
export const serverReleases = (projectId) => /** @type {any[]} */ (stmt(`SELECT deploy_id FROM deployments WHERE project_id = ? AND owner_key = ? AND status = 'ready'
  ORDER BY started_at DESC`).all(projectId, SERVER)).map((r) => r.deploy_id);

const RUNNING = "status IN ('queued', 'running')";

/**
 * Deploys a stopped server left unfinished: marked failed, so the app does not wait for them forever. `running` = the ids this
 * process is still working on.
 * @param {Set<string>} running
 */
export function failInterrupted(running) {
  const rows = /** @type {any[]} */ (stmt(`SELECT id FROM deployments WHERE ${RUNNING}`).all());
  for (const r of rows) {
    if (running.has(r.id)) continue;
    updateDeployment(r.id, { status: 'failed', error: 'The server restarted during this deploy. Deploy again.', finishedAt: now() });
  }
}
