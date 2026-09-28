// Output folders of Recreate jobs: data/projects/<id>/recreate/<recreateId>/.
// A job writes into "<recreateId>.tmp" and the folder is renamed only when the job succeeds, so a
// failed or timed-out job never leaves a half-written site behind.
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../db/index.js';

export const KEEP_RECREATES = 2;

export const recreateRoot = (projectId) => path.join(projectDir(projectId), 'recreate');
export const recreateDir = (projectId, recreateId) => path.join(recreateRoot(projectId), recreateId);
const tmpDir = (projectId, recreateId) => `${recreateDir(projectId, recreateId)}.tmp`;

/** Creates a fresh temporary workspace and returns its path. */
export async function openWorkspace(projectId, recreateId) {
  const dir = tmpDir(projectId, recreateId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
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

/**
 * Keeps the folders of the latest completed recreates and removes everything else, including
 * leftover ".tmp" workspaces. Jobs run one at a time, so no other workspace is in use here.
 * @returns {Promise<string[]>} removed folder names
 */
export async function pruneRecreates(projectId, { keep = KEEP_RECREATES } = {}) {
  const kept = new Set(doneRecreates.all(projectId, keep).map((r) => r.id));
  const root = recreateRoot(projectId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || kept.has(entry.name)) continue;
    await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
    removed.push(entry.name);
  }
  return removed;
}
