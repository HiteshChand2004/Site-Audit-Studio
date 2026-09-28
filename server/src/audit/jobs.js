// Analyze jobs. Queueing, the global Chromium lock and SSE events live in jobs/manager.js.
import { JobManager } from '../jobs/manager.js';
import { overallPct, runAnalysis, STEPS } from './index.js';
import { pruneScreenshots } from './retention.js';

export { ConflictError } from '../jobs/manager.js';

export const jobs = new JobManager({
  table: 'analyses',
  noun: 'an analysis',
  steps: STEPS,
  overallPct,
  doneMessage: 'Analysis complete',
  run: ({ job, project, payload, progress }) =>
    runAnalysis({ project, analysisId: job.id, maxPages: payload.maxPages, progress }),
  // Keep screenshots of the latest analyses only (failed ones never count).
  after: ({ project }) => pruneScreenshots(project.id),
});
