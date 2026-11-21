// @ts-check
// The change tables (db/migrations.js '2026-11-20-change-requests'). Statements are prepared on first use, never at load, so a
// database without them still starts: the routes ask changesReady() first.
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { hasTable } from '../db/apply.js';

export const changesReady = () => hasTable(db, 'change_requests') && hasTable(db, 'change_live') && hasTable(db, 'change_callbacks');

/** Statuses a request can be in; the last four are final. */
export const STATUSES = ['received', 'building', 'ready', 'publishing', 'published', 'rejected', 'failed', 'cancelled'];
export const OPEN = new Set(['received', 'building', 'ready', 'publishing']);
export const FINAL = new Set(['published', 'rejected', 'failed', 'cancelled']);

/** @type {Map<string, import('node:sqlite').StatementSync>} */
const cache = new Map();
/** @param {string} sql */
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};
const now = () => new Date().toISOString();
const parse = (/** @type {any} */ s) => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The row as the API and the app show it. @param {any} row */
export function viewChange(row) {
  if (!row) return null;
  const payload = parse(row.payload_json) ?? {};
  const result = parse(row.result_json) ?? {};
  return {
    id: row.id,
    requestId: row.request_id,
    source: row.source,
    projectId: row.project_id,
    type: row.type,
    page: row.page,
    status: row.status,
    step: row.step,
    message: row.message,
    draft: payload.draft ?? null,
    fix: payload.fix ?? null,
    context: payload.context ?? null,
    previewUrl: row.preview_url,
    liveUrl: row.live_url,
    score: result.score ?? null,
    checks: result.checks ?? [],
    notes: result.notes ?? [],
    files: result.files ?? [],
    shots: result.shots ?? null,
    template: result.template ?? null,
    by: result.by ?? null,
    neighbour: result.neighbour ?? null,
    design: result.design ?? null,
    // when its checks and pictures were taken again ("Check again"); the pictures' address changes with it
    checkedAt: result.checkedAt ?? null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    publishedAt: row.published_at,
    deploymentId: row.deployment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** @param {string} id */
export const changeRow = (id) => /** @type {any} */ (stmt('SELECT * FROM change_requests WHERE id = ?').get(id)) ?? null;

/** The change whose saved preview address holds this token (a link handed out before the server restarted). */
export const changeByPreviewToken = (/** @type {string} */ token) => /** @type {any} */ (
  stmt("SELECT * FROM change_requests WHERE preview_url IS NOT NULL AND instr(preview_url, ?) > 0 LIMIT 1").get(`/preview/${token}/`)) ?? null;
/** @param {string} source @param {string} requestId */
export const changeByRequest = (source, requestId) => /** @type {any} */ (stmt('SELECT * FROM change_requests WHERE source = ? AND request_id = ?').get(source, requestId)) ?? null;
/** @param {string} projectId */
export const listChanges = (projectId) => stmt('SELECT * FROM change_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT 200').all(projectId);
/** An open request for the same page of the same website (one at a time). @param {string} projectId @param {string} page */
export const openForPage = (projectId, page) =>
  /** @type {any} */ (stmt(`SELECT * FROM change_requests WHERE project_id = ? AND page = ? AND status IN ('received','building','ready','publishing') LIMIT 1`).get(projectId, page)) ?? null;
/** Rows waiting their turn, oldest first. */
export const waiting = () => stmt(`SELECT * FROM change_requests WHERE status = 'received' ORDER BY created_at`).all();
/** The newest published change of a website (what the next change builds on). @param {string} projectId */
export const lastPublished = (projectId) =>
  /** @type {any} */ (stmt(`SELECT * FROM change_requests WHERE project_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`).get(projectId)) ?? null;

/**
 * @param {{ requestId: string, source?: string, projectId: string, type: string, page: string | null, payload: any, callbackUrl: string | null }} c
 */
export function insertChange({ requestId, source = 'growth-os', projectId, type, page, payload, callbackUrl }) {
  const id = randomUUID();
  const at = now();
  stmt(`INSERT INTO change_requests (id, request_id, source, project_id, type, page, payload_json, callback_url, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`).run(id, requestId, source, projectId, type, page, JSON.stringify(payload), callbackUrl, at, at);
  return changeRow(id);
}

const COLUMNS = {
  status: 'status', step: 'step', message: 'message', baseRecreate: 'base_recreate', baseChange: 'base_change', previewUrl: 'preview_url',
  liveUrl: 'live_url', decidedBy: 'decided_by', decidedAt: 'decided_at', publishedAt: 'published_at', deploymentId: 'deployment_id', page: 'page',
};

/** @param {string} id @param {Record<string, any>} fields  `result` is stored as JSON */
export function updateChange(id, fields) {
  const sets = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'result') {
      sets.push('result_json = ?');
      values.push(v == null ? null : JSON.stringify(v));
    } else if (COLUMNS[k]) {
      sets.push(`${COLUMNS[k]} = ?`);
      values.push(v ?? null);
    }
  }
  if (!sets.length) return changeRow(id);
  sets.push('updated_at = ?');
  values.push(now(), id);
  stmt(`UPDATE change_requests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return changeRow(id);
}

/** Rows a stopped server left in the middle of their work: failed, with a message (once per start). */
export function interruptedChanges() {
  return stmt(`SELECT * FROM change_requests WHERE status IN ('building','publishing')`).all();
}

// ---- callbacks ----

/** @param {{ changeId: string, status: string, httpStatus: number | null, error: string | null, attempts: number }} c */
export function recordCallback({ changeId, status, httpStatus, error, attempts }) {
  stmt('INSERT INTO change_callbacks (id, change_id, status, http_status, error, attempts, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), changeId, status, httpStatus, error, attempts, now());
}
/** @param {string} changeId */
export const callbacksOf = (changeId) => stmt('SELECT status, http_status AS httpStatus, error, attempts, at FROM change_callbacks WHERE change_id = ? ORDER BY at').all(changeId);

// ---- local live address (/live/<slug>/) ----

/** @param {string} projectId */
export const liveOf = (projectId) => /** @type {any} */ (stmt('SELECT * FROM change_live WHERE project_id = ?').get(projectId)) ?? null;
/** @param {string} slug */
export const liveBySlug = (slug) => /** @type {any} */ (stmt('SELECT * FROM change_live WHERE slug = ?').get(slug)) ?? null;

/** Points the website's local live address at a change (the slug is made once and kept). @param {string} projectId @param {string} changeId */
export function setLive(projectId, changeId) {
  const at = now();
  const known = liveOf(projectId);
  if (known) {
    stmt('UPDATE change_live SET change_id = ?, published_at = ? WHERE project_id = ?').run(changeId, at, projectId);
    return { ...known, change_id: changeId, published_at: at };
  }
  const slug = randomBytes(12).toString('base64url');
  stmt('INSERT INTO change_live (project_id, slug, change_id, published_at) VALUES (?, ?, ?, ?)').run(projectId, slug, changeId, at);
  return liveOf(projectId);
}
