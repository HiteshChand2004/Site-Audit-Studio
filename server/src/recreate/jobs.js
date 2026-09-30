// Recreate jobs. They share the global one-job-at-a-time lock with Analyze and Re-audit (jobs/manager.js).
// A successful job starts the preview of its production build (the one active preview) and queues a
// re-audit of that build (Phase 5 fix checklist).
import path from 'node:path';
import { db } from '../db/index.js';
import { JobManager } from '../jobs/manager.js';
import { startReaudit } from '../reaudit/jobs.js';
import { overallPct, runRecreate, STEPS } from './index.js';
import { startPreview } from './preview.js';
import { pruneRecreates, recreateDir } from './workspace.js';

export const recreateJobs = new JobManager({
  table: 'recreates',
  noun: 'a recreate',
  steps: STEPS,
  overallPct,
  doneMessage: 'Recreate complete',
  run: async ({ job, project, progress }) => {
    const report = await runRecreate({ project, recreateId: job.id, progress, warnings: job.warnings });
    // The preview is runtime state: its port is not part of the report. The app asks for it
    // (GET/POST /preview), which also starts it again after a server restart.
    await startPreview({ projectId: project.id, recreateId: job.id, root: path.join(recreateDir(project.id, job.id), 'dist') }).catch(() => {});
    return report;
  },
  // Keep the latest completed recreates only; also removes any leftover temporary workspace.
  // Then queue the re-audit (it runs after anything already waiting for the lock).
  after: async ({ job, project, ok }) => {
    await pruneRecreates(project.id);
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
