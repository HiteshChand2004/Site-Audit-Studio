// Analyze jobs. Queueing, the global Chromium lock and SSE events live in jobs/manager.js.
import { JobManager } from '../jobs/manager.js';
import { overallPct, runAnalysis, STEPS } from './index.js';
import { pruneScreenshots } from './retention.js';

export { ConflictError, JobLimitError } from '../jobs/manager.js';

export const jobs = new JobManager({
  table: 'analyses',
  noun: 'an analysis',
  steps: STEPS,
  overallPct,
  doneMessage: 'Analysis complete',
  run: async ({ job, project, payload, progress, signal }) => {
    const audit = await runAnalysis({ project, analysisId: job.id, maxPages: payload.maxPages, progress, signal, ...(payload.url && { url: payload.url }) });
    // Which part of the site this analysis is about, so its report and what is built from it say so.
    return payload.url ? { ...audit, scope: { kind: 'page', url: payload.url } } : audit;
  },
  // Keep screenshots of the latest analyses only (failed ones never count).
  after: ({ project }) => pruneScreenshots(project.id),
});
