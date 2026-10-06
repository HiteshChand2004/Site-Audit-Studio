// Recreate jobs. They share the global one-job-at-a-time lock with Analyze and Re-audit (jobs/manager.js).
// A successful job starts the preview of its production build (the one active preview) and queues a
// re-audit of that build (Phase 5 fix checklist). When the project's stack is not plain HTML, the stack
// output is built from the saved IR right after (queued behind this job, never discarding the recreate).
import path from 'node:path';
import { db } from '../db/index.js';
import { JobManager } from '../jobs/manager.js';
import { startReaudit } from '../reaudit/jobs.js';
import { overallPct, runRecreate, STAGES, STEPS } from './index.js';
import { replayStages } from './replay.js';
import { getEmitter } from './emit/index.js';
import { exportStack } from './export/fromIr.js';
import { activePreview, startPreview } from './preview.js';
import { pruneRecreates, recreateDir } from './workspace.js';

export const recreateJobs = new JobManager({
  table: 'recreates',
  noun: 'a recreate',
  steps: STEPS,
  overallPct,
  doneMessage: 'Recreate complete',
  run: async ({ job, project, payload, progress }) => {
    // A rebuild from a saved capture (recreate/replay.js): the site is not opened again, only generate → build → preview run.
    const stages = payload?.reuseFrom
      ? { ...STAGES, ...replayStages(recreateDir(project.id, payload.reuseFrom.recreateId), payload.reuseFrom) }
      : undefined;
    const report = await runRecreate({ project, recreateId: job.id, progress, warnings: job.warnings, ...(stages && { stages }) });
    // The preview is runtime state: its port is not part of the report. The app asks for it
    // (GET/POST /preview), which also starts it again after a server restart.
    await startPreview({ projectId: project.id, recreateId: job.id, root: path.join(recreateDir(project.id, job.id), 'dist'), scripts: Boolean(report.outputs?.html?.scripts) }).catch(() => {});
    return report;
  },
  // Keep the latest completed recreates only; also removes any leftover temporary workspace.
  // Then queue the re-audit (it runs after anything already waiting for the lock).
  after: async ({ job, project, ok }) => {
    await pruneRecreates(project.id);
    if (ok) queueStackExport(project, job.id);
    if (ok) queueReaudit(project.id, job.id);
  },
});

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');

function queueReaudit(projectId, recreateId) {
  const project = selectProject.get(projectId); // may have been deleted while the job ran
  if (!project?.authorized) return;
  try {
    startReaudit(project, recreateId);
  } catch (err) {
    // One re-audit per project at a time: one already queued stays (the app offers a manual run).
    console.warn(`[recreates ${recreateId}] re-audit not queued: ${err.message}`);
  }
}

/**
 * Builds the project's stack from the saved IR (plain HTML is the recreate itself). A failure is stored on the
 * recreate (`outputs[stack]`: failed + why) and logged; the recreate and its HTML build stay.
 */
function queueStackExport(project, recreateId) {
  const stack = project.stack;
  if (!stack || stack === 'html' || getEmitter(stack)?.status !== 'ready') return;
  exportStack({ projectId: project.id, recreateId, stack })
    .then(async ({ output }) => {
      // The app shows the stack's own build when it is ready: move this project's preview onto it.
      if (activePreview()?.projectId !== project.id) return;
      const root = path.join(recreateDir(project.id, recreateId), output.dir, output.dist ?? '');
      await startPreview({ projectId: project.id, recreateId, root, scripts: getEmitter(stack)?.scripts ?? false, stack });
    })
    .catch((err) => console.warn(`[recreates ${recreateId}] ${stack} output not built: ${err.message}`));
}
