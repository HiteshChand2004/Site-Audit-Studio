// @ts-check
// A comparison (re-audit) that stops — a server restart, an error, the hard time limit, Stop in the app — keeps what it
// finished, and "Continue where it stopped" picks up from there instead of measuring everything again.
//
// What is kept, in the re-audit's own folder (reauditDir):
//   checkpoint.json  { version, origins: { served, mobile, desktop }, audit?, motion? } — written after each part finishes:
//                    the analysis of the copy (crawl, axe, links, homepage Lighthouse), then the motion check
//   lighthouse-pages/<slug>-<mode>-<n>.json  each Lighthouse run of the copy, as it is made (lighthousePages.js); the
//                    original's runs are kept per project already and reused by any comparison
// A continued comparison takes the stopped one's folder (renamed to its own id), so the files are where its steps look.
// The copy is served on new ports each time: every address of the old ports in the kept files is moved to the new ones
// (moveOrigins), so the kept results read as if measured by this run.
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/index.js';
import { recreateDir } from '../recreate/workspace.js';

export const CHECKPOINT_FILE = 'checkpoint.json';
const VERSION = 1;

/** The checkpoint kept in a re-audit's folder, or null. */
export async function readCheckpoint(dir) {
  const cp = await readFile(path.join(dir, CHECKPOINT_FILE), 'utf8').then(JSON.parse, () => null);
  return cp?.version === VERSION ? cp : null;
}

/** Adds to the checkpoint (written whole, through a temporary file, so a stop mid-write leaves the last good one). */
export async function saveCheckpoint(dir, patch) {
  const cp = { ...((await readCheckpoint(dir)) ?? { version: VERSION }), ...patch, savedAt: new Date().toISOString() };
  const tmp = path.join(dir, `${CHECKPOINT_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(cp), 'utf8');
  await rename(tmp, path.join(dir, CHECKPOINT_FILE));
  return cp;
}

/**
 * The stopped comparison's folder made this one's (renamed), with its checkpoint; null when there is nothing to take over.
 * @param {string} fromDir  the stopped re-audit's folder
 * @param {string} dir      this re-audit's folder (must not exist yet)
 */
export async function adoptCheckpoint(fromDir, dir) {
  if (!(await readCheckpoint(fromDir))) return null;
  if (await stat(dir).then(() => true, () => false)) return null;
  await rename(fromDir, dir);
  return readCheckpoint(dir);
}

const swap = (text, pairs) => pairs.reduce((t, [from, to]) => (from && to && from !== to ? t.split(from).join(to) : t), text);

/**
 * Every kept JSON file of the folder (and the checkpoint's own values) with the old ports' addresses moved to this run's.
 * @param {string} dir
 * @param {object} cp  the checkpoint as read
 * @param {{ served: string, mobile: string, desktop: string }} now  this run's origins
 * @returns {Promise<object>} the checkpoint with its addresses moved (also saved)
 */
export async function moveOrigins(dir, cp, now) {
  const was = cp.origins ?? {};
  const pairs = [['served', was.served], ['mobile', was.mobile], ['desktop', was.desktop]].map(([k, from]) => [from, now[k]]);
  if (!pairs.some(([from, to]) => from && to && from !== to)) return cp;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.json$/i.test(e.name) || e.name === CHECKPOINT_FILE) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text == null) continue;
    const next = swap(text, pairs);
    if (next !== text) await writeFile(file, next, 'utf8');
  }
  const moved = JSON.parse(swap(JSON.stringify(cp), pairs));
  return saveCheckpoint(dir, { ...moved, origins: now });
}

const latestAttempt = db.prepare(`
  SELECT id, recreate_id, status, error, started_at, finished_at FROM reaudits WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
`);
const latestDoneRecreate = db.prepare(`SELECT id FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`);

/**
 * The comparison that can be continued: the project's latest attempt, when it stopped before finishing, is about the latest
 * finished copy, and kept a checkpoint. `done` says which parts it finished.
 * @param {string} projectId
 * @returns {Promise<{ reauditId: string, recreateId: string, error: string|null, stoppedAt: string|null, done: string[] } | null>}
 */
export async function resumableReaudit(projectId) {
  const last = latestAttempt.get(projectId);
  if (!last || last.status !== 'failed' || !last.recreate_id) return null;
  if (latestDoneRecreate.get(projectId)?.id !== last.recreate_id) return null;
  const cp = await readCheckpoint(path.join(recreateDir(projectId, last.recreate_id), 'reaudit', last.id));
  if (!cp) return null;
  const done = [...(cp.audit ? ['analysis'] : []), ...(cp.motion ? ['motion'] : [])];
  const runs = await readdir(path.join(recreateDir(projectId, last.recreate_id), 'reaudit', last.id, 'lighthouse-pages')).catch(() => []);
  const pageRuns = runs.filter((n) => /-(mobile|desktop)-\d+\.json$/.test(n)).length;
  return { reauditId: last.id, recreateId: last.recreate_id, error: last.error ?? null, stoppedAt: last.finished_at ?? null, done, pageRuns };
}
