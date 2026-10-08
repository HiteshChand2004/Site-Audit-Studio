// Output folders of Recreate jobs: data/projects/<id>/recreate/<recreateId>/.
// A job writes into "<recreateId>.tmp" and the folder is renamed only when the job succeeds, so a
// failed or timed-out job never leaves a half-written site behind. A job that stopped with work worth keeping (its
// checkpoint.json, recreate/checkpoint.js) keeps its "<recreateId>.tmp" until it is continued, a newer recreate succeeds,
// a newer stopped job replaces it, or RESUMABLE_DAYS pass.
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../db/index.js';
import { checkpointSummary, isReusable, readCheckpoint, RESUMABLE_DAYS } from './checkpoint.js';
import { RecreateError } from './errors.js';
import { stopPreview } from './preview.js';

export const KEEP_RECREATES = 2;

export const recreateRoot = (projectId) => path.join(projectDir(projectId), 'recreate');
export const recreateDir = (projectId, recreateId) => path.join(recreateRoot(projectId), recreateId);
export const tmpDir = (projectId, recreateId) => `${recreateDir(projectId, recreateId)}.tmp`;

/** Creates a fresh temporary workspace and returns its path. */
export async function openWorkspace(projectId, recreateId) {
  const dir = tmpDir(projectId, recreateId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Takes over the kept workspace of a stopped job (`fromId`) for the job that continues it (`toId`). */
export async function adoptWorkspace(projectId, fromId, toId) {
  const from = tmpDir(projectId, fromId);
  if (!(await stat(from).catch(() => null))?.isDirectory()) {
    throw new RecreateError('The work of the stopped recreate is no longer there: start a new Recreate.');
  }
  const to = tmpDir(projectId, toId);
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
  return to;
}

/** Publishes the workspace under its final name. */
export async function commitWorkspace(projectId, recreateId) {
  const final = recreateDir(projectId, recreateId);
  await rm(final, { recursive: true, force: true });
  await rename(tmpDir(projectId, recreateId), final);
  return final;
}

export async function discardWorkspace(projectId, recreateId) {
  await rm(tmpDir(projectId, recreateId), { recursive: true, force: true });
}

const doneRecreates = db.prepare(
  `SELECT id FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT ?`,
);

// Stopped jobs newer than the latest completed recreate, newest first: the first whose work is kept can be continued.
const stoppedRecreates = db.prepare(`
  SELECT id, started_at FROM recreates
  WHERE project_id = ? AND status = 'failed'
    AND started_at > COALESCE((SELECT MAX(started_at) FROM recreates WHERE project_id = ? AND status = 'done'), '')
  ORDER BY started_at DESC LIMIT 10
`);

/**
 * The stopped recreate of a project that can be continued: the newest failed one since the latest success whose workspace
 * kept a usable checkpoint, stopped less than RESUMABLE_DAYS ago.
 * @returns {Promise<{ recreateId: string, startedAt: string, checkpoint: object, summary: object } | null>}
 */
export async function findResumable(projectId, now = Date.now()) {
  for (const row of stoppedRecreates.all(projectId, projectId)) {
    const checkpoint = await readCheckpoint(tmpDir(projectId, row.id));
    if (!isReusable(checkpoint)) continue;
    const at = Date.parse(checkpoint.stopped?.at ?? checkpoint.updatedAt ?? row.started_at);
    if (now - at > RESUMABLE_DAYS * 86400000) return null;
    return { recreateId: row.id, startedAt: row.started_at, checkpoint, summary: checkpointSummary(row.id, checkpoint) };
  }
  return null;
}

/**
 * Keeps the folders of the latest completed recreates and the workspace of the one stopped recreate that can be continued
 * (findResumable), and removes everything else, including other ".tmp" workspaces. Jobs run one at a time, so no other
 * workspace is in use here.
 * @returns {Promise<string[]>} removed folder names
 */
export async function pruneRecreates(projectId, { keep = KEEP_RECREATES } = {}) {
  const kept = new Set(doneRecreates.all(projectId, keep).map((r) => r.id));
  const resumable = await findResumable(projectId);
  if (resumable) kept.add(`${resumable.recreateId}.tmp`);
  const root = recreateRoot(projectId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || kept.has(entry.name)) continue;
    await stopPreview({ projectId, recreateId: entry.name }); // never serve a folder being removed
    await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
    removed.push(entry.name);
  }
  return removed;
}
