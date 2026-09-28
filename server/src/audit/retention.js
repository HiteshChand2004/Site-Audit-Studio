// Screenshots are the only large artifacts. Each project keeps them for its latest completed
// analyses; older and failed analyses lose their screens/ folder (the small JSON files stay).
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../db/index.js';
import { screensDir } from './screenshots.js';

export const KEEP_SCREENSHOTS = 3;

const doneAnalyses = db.prepare(
  `SELECT id FROM analyses WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT ?`,
);

/**
 * @param {string} projectId
 * @param {{ keep?: number, skip?: string[] }} [opts]  skip: analysis ids that must not be touched (still running)
 * @returns {Promise<string[]>} analysis ids whose screenshots were removed
 */
export async function pruneScreenshots(projectId, { keep = KEEP_SCREENSHOTS, skip = [] } = {}) {
  const kept = new Set([...doneAnalyses.all(projectId, keep).map((r) => r.id), ...skip]);
  const auditDir = path.join(projectDir(projectId), 'audit');
  const entries = await readdir(auditDir, { withFileTypes: true }).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || kept.has(entry.name)) continue;
    const dir = screensDir(path.join(auditDir, entry.name));
    const had = await readdir(dir).then(() => true, () => false);
    if (!had) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(entry.name);
  }
  return removed;
}
