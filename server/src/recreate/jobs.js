// Recreate jobs. They share the global one-job-at-a-time lock with Analyze (jobs/manager.js).
import { JobManager } from '../jobs/manager.js';
import { overallPct, runRecreate, STEPS } from './index.js';
import { pruneRecreates } from './workspace.js';

export const recreateJobs = new JobManager({
  table: 'recreates',
  noun: 'a recreate',
  steps: STEPS,
  overallPct,
  doneMessage: 'Recreate complete',
  run: ({ job, project, progress }) => runRecreate({ project, recreateId: job.id, progress, warnings: job.warnings }),
  // Keep the latest completed recreates only; also removes any leftover temporary workspace.
  after: ({ project }) => pruneRecreates(project.id),
});
