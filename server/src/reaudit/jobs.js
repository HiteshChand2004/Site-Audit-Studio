// Re-audit jobs. They share the global one-job-at-a-time lock with Analyze and Recreate
// (jobs/manager.js): all three drive Chromium, and parallel Lighthouse runs distort each other's numbers.
// A successful Recreate queues one automatically (recreate/jobs.js); the app can also start one.
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/index.js';
import { JobManager } from '../jobs/manager.js';
import { recreateDir } from '../recreate/workspace.js';
import { overallPct, runReaudit, SKIPPED_STEPS, STEPS } from './index.js';

const selectRecreate = db.prepare(`SELECT id, result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);
const setInputs = db.prepare('UPDATE reaudits SET recreate_id = ?, analysis_id = ? WHERE id = ?');
const latestDone = db.prepare(`
  SELECT id FROM reaudits WHERE project_id = ? AND recreate_id = ? AND status = 'done'
  ORDER BY started_at DESC LIMIT 1
`);

// Replaceable in tests (they leave out Lighthouse).
export const JOB_OPTIONS = { skip: SKIPPED_STEPS };

export const reauditJobs = new JobManager({
  table: 'reaudits',
  noun: 'a re-audit',
  steps: STEPS,
  overallPct,
  doneMessage: 'Re-audit complete',
  run: ({ job, project, payload, progress }) =>
    runReaudit({ project, reauditId: job.id, recreateId: payload.recreateId, progress, skip: JOB_OPTIONS.skip }),
  after: ({ project, payload }) => pruneReaudits(project.id, payload.recreateId),
});

/**
 * Queues a re-audit of one completed recreate of the project.
 * @throws {import('../jobs/manager.js').ConflictError} when one is already queued or running for the project
 * @returns {object|null} the job snapshot, or null when the recreate is not a completed one
 */
export function startReaudit(project, recreateId) {
  const row = selectRecreate.get(recreateId, project.id);
  if (!row) return null;
  const analysisId = JSON.parse(row.result_json)?.analysisId ?? null;
  const job = reauditJobs.start(project, { recreateId });
  setInputs.run(recreateId, analysisId, job.id);
  return { ...job, recreateId, analysisId };
}

/**
 * Keeps the raw results of the latest completed re-audit of a recreate and removes the rest
 * (failed runs included). A recreate removed by its own retention takes its re-audits with it.
 */
export async function pruneReaudits(projectId, recreateId) {
  if (!recreateId) return [];
  const keep = latestDone.get(projectId, recreateId)?.id;
  const root = path.join(recreateDir(projectId, recreateId), 'reaudit');
  const removed = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
    removed.push(entry.name);
  }
  return removed;
}
