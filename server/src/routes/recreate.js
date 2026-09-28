import { Router } from 'express';
import { db } from '../db/index.js';
import { ConflictError } from '../jobs/manager.js';
import { streamJob } from '../jobs/sse.js';
import { PUBLIC_STEPS } from '../recreate/index.js';
import { analysisWarnings, latestAnalysis } from '../recreate/inputs.js';
import { recreateJobs } from '../recreate/jobs.js';

// Stacks the recreate pipeline can emit so far (Phase 6 adds the others).
export const RECREATE_STACKS = ['html'];

const router = Router();

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const selectRecreate = db.prepare('SELECT id, status, error FROM recreates WHERE id = ? AND project_id = ?');
const latestRow = db.prepare(`
  SELECT id, status, error, started_at, finished_at FROM recreates
  WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
`);
const latestDone = db.prepare(`
  SELECT result_json FROM recreates
  WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL
  ORDER BY started_at DESC LIMIT 1
`);

router.post('/:id/recreate', (req, res) => {
  const project = selectProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!project.authorized) {
    return res.status(403).json({ error: 'This project is not confirmed as authorized for recreating.' });
  }
  if (!RECREATE_STACKS.includes(project.stack)) {
    return res.status(400).json({ error: 'Only the Plain HTML / CSS / JS stack can be recreated for now. Change the output stack.' });
  }
  const analysis = latestAnalysis(project.id);
  if (!analysis) {
    return res.status(409).json({ error: 'Run Analyze first: Recreate works from a completed analysis.' });
  }

  try {
    const job = recreateJobs.start(project, {}, { warnings: analysisWarnings(analysis) });
    res.status(202).json({ recreateId: job.id, job, steps: PUBLIC_STEPS });
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message, recreateId: err.job.id });
    }
    throw err;
  }
});

router.get('/:id/recreate/current', (req, res) => {
  const job = recreateJobs.active(req.params.id);
  res.json(job ? { job, steps: PUBLIC_STEPS } : null);
});

// Latest attempt (any status) plus the report of the latest successful recreate.
router.get('/:id/recreate', (req, res) => {
  if (!selectProject.get(req.params.id)) return res.status(404).json({ error: 'Project not found.' });
  const last = latestRow.get(req.params.id);
  const done = latestDone.get(req.params.id);
  res.json({
    last: last ? {
      id: last.id,
      status: last.status,
      error: last.error,
      startedAt: last.started_at,
      finishedAt: last.finished_at,
    } : null,
    result: done ? JSON.parse(done.result_json) : null,
  });
});

router.get('/:id/recreate/:recreateId/events', (req, res) => {
  const { id, recreateId } = req.params;
  streamJob(req, res, recreateJobs, recreateId, () => selectRecreate.get(recreateId, id));
});

export default router;
