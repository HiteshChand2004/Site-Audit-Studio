// Recreate jobs. They share the global one-job-at-a-time lock with Analyze (jobs/manager.js).
// A successful job starts the preview of its production build (the one active preview).
import path from 'node:path';
import { JobManager } from '../jobs/manager.js';
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
  after: ({ project }) => pruneRecreates(project.id),
});
