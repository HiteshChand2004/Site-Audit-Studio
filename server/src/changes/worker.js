// @ts-check
// The life of a change request: received → building → ready → (a person approves in Remastly) publishing → published; or
// rejected / failed / cancelled. One change is built at a time on this server (a browser opens for its checks); publishing is
// network work and runs beside it. Every status is sent to Growth OS (callback.js), in order, per change.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { issuePreviewToken, previewPath, resolvePreviewToken } from '../recreate/previewTokens.js';
import { applyChange, ApplyError } from './apply.js';
import { sendCallback } from './callback.js';
import { checkChange } from './checks.js';
import { absolute } from './config.js';
import { ContractError, PAGE_TYPES } from './contract.js';
import { publishChange, PublishError } from './publish.js';
import { changeShotsDir, changeSiteDir, findProject, linkTree, resolveBase, SiteError } from './site.js';
import { changeByRequest, changeRow, FINAL, insertChange, interruptedChanges, openForPage, updateChange, viewChange, waiting } from './store.js';

/** @type {Map<string, Promise<any>>} change id → its callbacks, one after another */
const notifications = new Map();
/** @type {Map<string, string>} change id → preview token (in memory: a restart issues a new one on the next look) */
const previews = new Map();

/** Sends the row's status as it is now, after the change's earlier callbacks. @param {any} row */
export function notify(row, opts = {}) {
  if (!row?.callback_url) return Promise.resolve();
  const snapshot = { ...row };
  const next = (notifications.get(row.id) ?? Promise.resolve()).then(() => sendCallback(snapshot, opts)).catch(() => {});
  notifications.set(row.id, next);
  return next;
}
/** Waits for every callback still on its way (tests). */
export const callbacksSettled = () => Promise.all([...notifications.values()]);

/** @param {string} id @param {Record<string, any>} fields */
const move = (id, fields) => {
  const row = updateChange(id, fields);
  notify(row);
  return row;
};

/** The preview address of a change (issued again after a restart). @param {any} row */
export function previewOf(row) {
  if (!row || !['ready', 'publishing', 'published'].includes(row.status)) return null;
  let token = previews.get(row.id);
  if (!token || !resolvePreviewToken(token)) {
    token = issuePreviewToken({ root: changeSiteDir(row.project_id, row.id), kind: 'as-is', scripts: true });
    previews.set(row.id, token);
  }
  const result = row.result_json ? JSON.parse(row.result_json) : {};
  const page = String(result.servedAt ?? row.page ?? '/').replace(/^\/+/, '');
  return absolute(`${previewPath(token)}${page}`);
}

/**
 * A request from Growth OS, checked (contract.js parseChangeRequest). Returns { row, existing }.
 * Throws ContractError / SiteError with a sentence for the caller.
 * @param {ReturnType<typeof import('./contract.js').parseChangeRequest>} req @param {{ callbackCheck?: (url: string) => boolean }} [o]
 */
export function submitChange(req, { callbackCheck } = {}) {
  const known = changeByRequest('growth-os', req.requestId);
  if (known) return { row: known, existing: true };
  const project = findProject({ projectId: req.projectId, siteUrl: req.siteUrl });
  if (!project) throw new SiteError(`No website in Remastly for ${req.siteUrl || req.projectId}. Add it in Remastly and make its copy first.`, 404);
  if (req.callbackUrl && callbackCheck && !callbackCheck(req.callbackUrl)) throw new ContractError('"callbackUrl" must be under Growth OS\'s own address (SAS_GROWTHOS_URL on the Remastly server).');
  const page = req.page ?? '*';
  const open = openForPage(project.id, page);
  if (open) throw new SiteError(`A change of ${page === '*' ? 'every page' : page} is still open (${open.status}, ${open.id}). One change per page at a time.`, 409);
  const payload = { draft: req.draft, fix: req.fix, context: req.context, siteUrl: req.siteUrl };
  const row = insertChange({ requestId: req.requestId, projectId: project.id, type: req.type, page, payload, callbackUrl: req.callbackUrl });
  notify(row);
  kick();
  return { row, existing: false };
}

let busy = false;
/** @type {Promise<void> | null} */
let draining = null;

/** Starts working through the waiting changes (no-op while it already is). */
export function kick() {
  if (busy) return draining;
  busy = true;
  draining = (async () => {
    try {
      for (;;) {
        const next = /** @type {any} */ (waiting()[0]);
        if (!next) break;
        await buildChange(next.id);
      }
    } finally {
      busy = false;
    }
  })();
  return draining;
}
/** Waits until nothing is being built (tests). */
export const idle = () => draining ?? Promise.resolve();

/** @type {{ check?: typeof checkChange }} */
export const testHooks = {};

/** Makes and checks one change. Never throws: the outcome is in the row. @param {string} id */
export async function buildChange(id) {
  let row = changeRow(id);
  if (!row || row.status !== 'received') return row;
  const dir = changeSiteDir(row.project_id, row.id);
  try {
    row = move(id, { status: 'building', step: 'Preparing the site', message: null });
    const project = findProject({ projectId: row.project_id });
    if (!project) throw new SiteError('The website was removed from Remastly.', 404);
    const base = await resolveBase(project);
    updateChange(id, { baseRecreate: base.recreateId, baseChange: base.baseChange });
    await rm(dir, { recursive: true, force: true });
    await linkTree(base.root, dir);
    updateChange(id, { step: PAGE_TYPES.has(row.type) ? 'Making the page' : 'Making the change' });
    const payload = JSON.parse(row.payload_json);
    updateChange(id, { step: PAGE_TYPES.has(row.type) ? 'Making the page (the template of the site; the AI writes the words)' : 'Making the change' });
    const applied = await applyChange({ id: row.id, type: row.type, page: row.page === '*' ? null : row.page, draft: payload.draft, fix: payload.fix, context: payload.context }, dir);
    // a tool screen asked to be improved became a new page: the change is now about that page (apply.js)
    updateChange(id, { step: 'Checking it (page checks, a computer and a phone)', ...(applied.redirectedFrom && { page: applied.page }) });
    const checked = await (testHooks.check ?? checkChange)({ baseRoot: base.root, root: dir, applied, shotsDir: changeShotsDir(row.project_id, row.id) });
    const result = {
      stack: base.stack, servedAt: applied.page, files: applied.files, checks: checked.checks, score: checked.score, shots: checked.shots, template: applied.template ?? null, by: applied.by ?? null, neighbour: applied.neighbour ?? null, design: checked.design ?? null,
      notes: [...applied.notes, ...checked.notes], ok: checked.ok,
    };
    updateChange(id, { result, step: null });
    row = changeRow(id);
    const message = checked.ok ? null : 'A check did not pass: look at the page before approving it.';
    return move(id, { status: 'ready', previewUrl: previewOf({ ...row, status: 'ready' }), message });
  } catch (err) {
    const known = err instanceof ApplyError || err instanceof SiteError || err instanceof ContractError;
    if (!known) console.error(`[change ${id}]`, err);
    await rm(path.dirname(dir), { recursive: true, force: true }).catch(() => {});
    return move(id, { status: 'failed', step: null, message: known ? /** @type {Error} */ (err).message : 'Something went wrong while making the change (the server log has the details).' });
  }
}

export class DecisionError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 409) {
    super(message);
    this.name = 'DecisionError';
    this.status = status;
  }
}

/**
 * The person's yes in Remastly: the change goes live. Resolves when it is live (or back to ready with the reason).
 * @param {string} id @param {{ by?: string, ownerKey?: string }} [o]
 */
export async function approveChange(id, { by = 'the team', ownerKey = 'local' } = {}) {
  const row = changeRow(id);
  if (!row) throw new DecisionError('No such change.', 404);
  if (row.status !== 'ready') throw new DecisionError(`Only a change that is ready can be approved (this one is ${row.status}).`);
  move(id, { status: 'publishing', decidedBy: by, decidedAt: new Date().toISOString(), message: null, step: 'Putting it live' });
  try {
    const live = await publishChange(id, { ownerKey });
    return move(id, { status: 'published', step: null, liveUrl: live.liveUrl, deploymentId: live.deploymentId, publishedAt: new Date().toISOString(), message: `Live on ${live.where}.` });
  } catch (err) {
    const known = err instanceof PublishError;
    if (!known) console.error(`[change ${id}] publish`, err);
    return move(id, { status: 'ready', step: null, message: `It could not go live: ${known ? /** @type {Error} */ (err).message : 'something went wrong (the server log has the details)'}. Try again.` });
  }
}

/** The person's no. @param {string} id @param {{ by?: string, reason?: string }} [o] */
export function rejectChange(id, { by = 'the team', reason = '' } = {}) {
  const row = changeRow(id);
  if (!row) throw new DecisionError('No such change.', 404);
  if (row.status !== 'ready') throw new DecisionError(`Only a change that is ready can be turned down (this one is ${row.status}).`);
  return move(id, { status: 'rejected', decidedBy: by, decidedAt: new Date().toISOString(), message: reason ? `Turned down: ${reason}` : 'Turned down in Remastly.' });
}

/** Growth OS takes a request back. @param {string} id */
export function cancelChange(id) {
  const row = changeRow(id);
  if (!row) throw new DecisionError('No such change.', 404);
  if (FINAL.has(row.status)) throw new DecisionError(`It is already ${row.status}.`);
  if (row.status === 'publishing' || row.status === 'building') throw new DecisionError(`It is ${row.status} now; cancel it once that has finished.`);
  return move(id, { status: 'cancelled', message: 'Cancelled by Growth OS.' });
}

let recovered = false;
/** Once per start: work a stopped server left half-done is marked, and the waiting changes are picked up. */
export function recoverChanges() {
  if (recovered) return;
  recovered = true;
  for (const row of /** @type {any[]} */ (interruptedChanges())) {
    if (row.status === 'building') move(row.id, { status: 'received', step: null, message: 'The server restarted while making it; made again.' });
    else move(row.id, { status: 'ready', step: null, message: 'The server restarted while it was going live. Approve it again.' });
  }
  kick();
}

export { viewChange };
