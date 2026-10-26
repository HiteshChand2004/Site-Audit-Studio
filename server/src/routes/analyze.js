import { Router } from 'express';
import { db } from '../db/index.js';
import { ConflictError, JobLimitError, jobs } from '../audit/jobs.js';
import { PUBLIC_STEPS } from '../audit/index.js';
import { streamJob } from '../jobs/sse.js';
import { pageUrlOf } from '../recreate/inputs.js';

const router = Router();

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const selectAnalysis = db.prepare('SELECT id, status, error FROM analyses WHERE id = ? AND project_id = ?');

export function parseMaxPages(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

router.post('/:id/analyze', (req, res) => {
  const project = selectProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!project.authorized) {
    return res.status(403).json({ error: 'This project is not confirmed as authorized for auditing.' });
  }
  const requested = req.body?.maxPages;
  const maxPages = requested === undefined ? project.max_pages : parseMaxPages(requested);
  if (!maxPages) return res.status(400).json({ error: 'maxPages must be a whole number from 1 to 100.' });

  try {
    // One page only (projects.page_url): that page is the one fetched, rendered, measured and checked, and nothing else.
    const page = pageUrlOf(project);
    const job = jobs.start(project, page ? { maxPages: 1, url: page } : { maxPages });
    res.status(202).json({ analysisId: job.id, job, steps: PUBLIC_STEPS });
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message, analysisId: err.job.id });
    }
    // The account's own limit (SAS_JOBS_PER_USER): no job id of this kind, so the app shows the sentence instead of following a job.
    if (err instanceof JobLimitError) return res.status(409).json({ error: err.message, limit: 'user', busy: { kind: err.job.kind, projectId: err.job.projectId, jobId: err.job.id } });
    throw err;
  }
});

router.get('/:id/analyze/current', (req, res) => {
  const job = jobs.active(req.params.id);
  res.json(job ? { job, steps: PUBLIC_STEPS } : null);
});

router.get('/:id/analyze/:analysisId/events', (req, res) => {
  const { id, analysisId } = req.params;
  streamJob(req, res, jobs, analysisId, () => selectAnalysis.get(analysisId, id));
});

export default router;
