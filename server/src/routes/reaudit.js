// Re-audit of the latest recreated site (Phase 5). Recreate queues one automatically; POST starts
// one again (after a failure, or when the recreate or its analysis changed).
import { Router } from 'express';
import { db } from '../db/index.js';
import { ConflictError } from '../jobs/manager.js';
import { streamJob } from '../jobs/sse.js';
import { PUBLIC_STEPS } from '../reaudit/index.js';
import { reauditJobs, startReaudit } from '../reaudit/jobs.js';

const router = Router();

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const selectReaudit = db.prepare('SELECT id, status, error FROM reaudits WHERE id = ? AND project_id = ?');
const latestRecreate = db.prepare(`
  SELECT id FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1
`);
const latestRow = db.prepare(`
  SELECT id, recreate_id, analysis_id, status, error, started_at, finished_at FROM reaudits
  WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
`);
const latestDone = db.prepare(`
  SELECT result_json FROM reaudits
  WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL
  ORDER BY started_at DESC LIMIT 1
`);

const withSteps = (job) => (job ? { job, steps: PUBLIC_STEPS } : null);

router.post('/:id/reaudit', (req, res) => {
  const project = selectProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!project.authorized) {
    return res.status(403).json({ error: 'This project is not confirmed as authorized for auditing.' });
  }
  const recreate = latestRecreate.get(project.id);
  if (!recreate) return res.status(409).json({ error: 'Run Recreate first: the re-audit checks the recreated site.' });
  try {
    const job = startReaudit(project, recreate.id);
    if (!job) return res.status(409).json({ error: 'Run Recreate first: the re-audit checks the recreated site.' });
    res.status(202).json({ reauditId: job.id, ...withSteps(job) });
  } catch (err) {
    if (err instanceof ConflictError) return res.status(409).json({ error: err.message, reauditId: err.job.id });
    throw err;
  }
});

router.get('/:id/reaudit/current', (req, res) => {
  res.json(withSteps(reauditJobs.active(req.params.id)));
});

// Latest attempt (any status) plus the result of the latest successful re-audit. `stale` is true when
// that result is not about the latest completed recreate.
router.get('/:id/reaudit', (req, res) => {
  const { id } = req.params;
  if (!selectProject.get(id)) return res.status(404).json({ error: 'Project not found.' });
  const last = latestRow.get(id);
  const done = latestDone.get(id);
  const result = done ? JSON.parse(done.result_json) : null;
  const recreateId = latestRecreate.get(id)?.id ?? null;
  res.json({
    last: last ? {
      id: last.id,
      recreateId: last.recreate_id,
      analysisId: last.analysis_id,
      status: last.status,
      error: last.error,
      startedAt: last.started_at,
      finishedAt: last.finished_at,
    } : null,
    result,
    stale: Boolean(result && result.recreateId !== recreateId),
  });
});

router.get('/:id/reaudit/:reauditId/events', (req, res) => {
  const { id, reauditId } = req.params;
  streamJob(req, res, reauditJobs, reauditId, () => selectReaudit.get(reauditId, id));
});

export default router;
