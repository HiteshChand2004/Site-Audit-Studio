// The preview of an "Original as-is" copy: the app serves the lifted folder itself under /preview/<token>/… (one address;
// recreate/previewRoute.js). The copy's own scripts run there, inside a document the browser sandboxes by header into an
// opaque origin: nothing of the app (its cookies, storage, API) is reachable from it, and it can register no service worker.
// Previews stop when their project is deleted, when the app shuts down, and after IDLE_MS without use.
import { stat } from 'node:fs/promises';
import { issuePreviewToken, previewPath, revokePreviewToken } from '../../previewTokens.js';

export const IDLE_MS = 30 * 60 * 1000;
/** key → { url, close, used, projectId } */
const previews = new Map();
const keyOf = (projectId, recreateId) => `${projectId}/${recreateId}`;

/**
 * Starts (or reuses) the preview of a copy folder. Resolves with its address.
 * @param {string} projectId
 * @param {string} recreateId
 * @param {string} copyDir  the lifted copy (as-is/copy in the job's folder)
 */
export async function startAsIsPreview(projectId, recreateId, copyDir) {
  const key = keyOf(projectId, recreateId);
  const have = previews.get(key);
  if (have) {
    have.used = Date.now();
    return have.url;
  }
  if (!(await stat(copyDir).then((s) => s.isDirectory(), () => false))) throw new Error('The lifted copy of this copy is gone.');
  const token = issuePreviewToken({ root: copyDir, kind: 'as-is', scripts: true });
  const url = previewPath(token);
  previews.set(key, { url, close: async () => { revokePreviewToken(token); }, used: Date.now(), projectId });
  return url;
}

/** The address of a running preview, or null. */
export function asIsPreviewUrl(projectId, recreateId) {
  const p = previews.get(keyOf(projectId, recreateId));
  if (p) p.used = Date.now();
  return p?.url ?? null;
}

async function stopOne(key) {
  const p = previews.get(key);
  if (!p) return;
  previews.delete(key);
  await p.close().catch(() => {});
}

/** Stops the preview of one copy. */
export async function stopAsIsPreview(projectId, recreateId) {
  await stopOne(keyOf(projectId, recreateId));
}

/** Stops every preview of a project (its deletion). */
export async function stopAsIsPreviewsOf(projectId) {
  for (const key of [...previews.keys()]) if (key.startsWith(`${projectId}/`)) await stopOne(key);
}

/** Stops every preview (the app shuts down). */
export async function stopAllAsIsPreviews() {
  for (const key of [...previews.keys()]) await stopOne(key);
}

/** Stops the previews nobody has used for IDLE_MS. */
export async function stopIdleAsIsPreviews(now = Date.now()) {
  for (const [key, p] of [...previews.entries()]) if (now - p.used > IDLE_MS) await stopOne(key);
}

// Idle previews are stopped on a timer; the timer never keeps the process alive.
const sweep = setInterval(() => { stopIdleAsIsPreviews().catch(() => {}); }, 60 * 1000);
sweep.unref();
