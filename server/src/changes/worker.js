// @ts-check
// The life of a change request: received → building → ready → (a person approves in Remastly) publishing → published; or
// rejected / failed / cancelled. One change is built at a time on this server (a browser opens for its checks); publishing is
// network work and runs beside it. Every status is sent to Growth OS (callback.js), in order, per change.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { addPreviewSource, issuePreviewToken, previewPath, resolvePreviewToken, tokenOf } from '../recreate/previewTokens.js';
import { applyChange, ApplyError } from './apply.js';
import { sendCallback } from './callback.js';
import { checkChange } from './checks.js';
import { absolute } from './config.js';
import { ContractError, PAGE_TYPES } from './contract.js';
import { publishChange, PublishError } from './publish.js';
import { changeShotsDir, changeSiteDir, findProject, linkTree, resolveBase, SiteError } from './site.js';
import { changeByPreviewToken, changeByRequest, changeRow, changesReady, FINAL, insertChange, interruptedChanges, openForPage, updateChange, viewChange, waiting } from './store.js';

/** @type {Map<string, Promise<any>>} change id → its callbacks, one after another */
const notifications = new Map();
/** @type {Map<string, string>} change id → preview token */
const previews = new Map();
/** Statuses whose folder holds the made page, so its preview may be shown. */
const SHOWN = ['ready', 'publishing', 'published'];

// A preview address handed out before a restart (in the app, in Growth OS, in an open tab) keeps working: its token is in
// the change's saved preview address, and it stands for that change's folder again (recreate/previewTokens.js).
addPreviewSource((token) => {
  if (!changesReady()) return null;
  const row = changeByPreviewToken(token);
  if (!row || !SHOWN.includes(row.status)) return null;
  return { root: changeSiteDir(row.project_id, row.id), kind: 'as-is', scripts: true };
});

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

/** The preview address of a change: always the same one (the token of its saved address, restored after a restart). @param {any} row */
export function previewOf(row) {
  if (!row || !SHOWN.includes(row.status)) return null;
  let token = previews.get(row.id) ?? tokenOf(row.preview_url);
  if (!token || !resolvePreviewToken(token)) {
    token = issuePreviewToken({ root: changeSiteDir(row.project_id, row.id), kind: 'as-is', scripts: true });
    previews.set(row.id, token);
  }
  const result = row.result_json ? JSON.parse(row.result_json) : {};
  const page = String(result.servedAt ?? row.page ?? '/').replace(/^\/+/, '');
  const url = absolute(`${previewPath(token)}${page}`);
  // Kept with the change, so this address is the one restored after a restart.
  if (tokenOf(row.preview_url) !== token) {
    try { updateChange(row.id, { previewUrl: url }); } catch { /* shown anyway; issued again next time */ }
  }
  return url;
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

/** Changes being checked again: change id → the run. */
const rechecks = new Map();
/** Statuses a change can be made again from (never one that is live: its folder is what the next change builds on). */
export const REMAKE_FROM = ['ready', 'failed', 'rejected'];
/** Statuses a change can be checked again in (its made page is in its folder). */
export const RECHECK_IN = ['ready', 'published'];

/**
 * "Make again": the change is built again from its request, as the code is now (a fix to how pages are made reaches a
 * change made before it). It goes back to waiting, then through making and checking to ready, for the person to look at
 * again; its preview address stays the same. Growth OS is told each status, as for a new request.
 * @param {string} id
 */
export function remakeChange(id) {
  const row = changeRow(id);
  if (!row) throw new DecisionError('No such change.', 404);
  if (!REMAKE_FROM.includes(row.status)) {
    throw new DecisionError(row.status === 'published'
      ? 'This change is live: it cannot be made again here. Growth OS can send the page again as a new change.'
      : `A change that is ${row.status} cannot be made again now.`);
  }
  const open = openForPage(row.project_id, row.page);
  if (open && open.id !== id) throw new DecisionError(`Another change of ${row.page === '*' ? 'every page' : row.page} is open (${open.status}). Finish that one first.`);
  const next = move(id, { status: 'received', step: null, result: null, message: 'Made again in Remastly with the latest code.', decidedBy: null, decidedAt: null });
  kick();
  return next;
}

/**
 * "Check again": the page as it is made is checked again (page checks, the pictures on a computer and a phone, the design
 * check), without making it again. Runs in the background; the change keeps its status, `step` says it is being checked.
 * @param {string} id @param {{ check?: typeof checkChange }} [o]
 */
export function recheckChange(id, { check = testHooks.check ?? checkChange } = {}) {
  const row = changeRow(id);
  if (!row) throw new DecisionError('No such change.', 404);
  if (!RECHECK_IN.includes(row.status)) throw new DecisionError(`Only a change that is ready or live can be checked again (this one is ${row.status}).`);
  if (rechecks.has(id)) throw new DecisionError('It is being checked again already.');
  const result = row.result_json ? JSON.parse(row.result_json) : null;
  const file = (result?.files ?? []).find((/** @type {string} */ f) => /\.html?$/i.test(f)) ?? null;
  if (!result || !file) throw new DecisionError('This change has no page to check again.');
  updateChange(id, { step: 'Checking it again (page checks, a computer and a phone)' });
  const run = (async () => {
    try {
      const dir = changeSiteDir(row.project_id, row.id);
      // the page's heading as it stands now (the AI may have written it shorter than the draft): what "still there" looks for
      const html = await readFile(path.join(dir, file), 'utf8');
      const heading = (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      let baseRoot = dir;
      const project = findProject({ projectId: row.project_id });
      if (project) baseRoot = (await resolveBase(project).catch(() => null))?.root ?? dir;
      const applied = {
        page: result.servedAt, file, files: result.files, notes: [], expect: heading ? [heading] : [],
        beforeFile: row.type === 'page.improve' ? file : null, neighbour: result.neighbour ?? null,
      };
      const checked = await check({ baseRoot, root: dir, applied: /** @type {any} */ (applied), shotsDir: changeShotsDir(row.project_id, row.id) });
      const at = new Date().toISOString();
      const notes = [...(result.notes ?? []).filter((/** @type {string} */ n) => !/^(Script errors on the page|Checked again )/.test(n)), `Checked again ${at.slice(0, 16).replace('T', ' ')} UTC.`, ...checked.notes];
      updateChange(id, {
        result: { ...result, checks: checked.checks, score: checked.score, shots: checked.shots, design: checked.design ?? null, ok: checked.ok, notes, checkedAt: at },
        step: null,
        message: checked.ok ? null : 'A check did not pass: look at the page before approving it.',
      });
    } catch (err) {
      console.error(`[change ${id}] check again`, err);
      updateChange(id, { step: null, message: 'Checking it again did not finish (the server log has the details). Try again.' });
    } finally {
      rechecks.delete(id);
    }
  })();
  rechecks.set(id, run);
  return changeRow(id);
}
/** Waits for a change's check-again run (tests). @param {string} id */
export const recheckSettled = (id) => rechecks.get(id) ?? Promise.resolve();

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
