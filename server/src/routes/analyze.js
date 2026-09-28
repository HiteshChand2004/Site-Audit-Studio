import { Router } from 'express';
import { db } from '../db/index.js';
import { ConflictError, jobs } from '../audit/jobs.js';
import { PUBLIC_STEPS } from '../audit/index.js';

const router = Router();

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const selectAnalysis = db.prepare('SELECT id, status, error FROM analyses WHERE id = ? AND project_id = ?');

const HEARTBEAT_MS = 15000;

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
    const job = jobs.start(project, { maxPages });
    res.status(202).json({ analysisId: job.id, job, steps: PUBLIC_STEPS });
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message, analysisId: err.job.id });
    }
    throw err;
  }
});

router.get('/:id/analyze/current', (req, res) => {
  const job = jobs.active(req.params.id);
  res.json(job ? { job, steps: PUBLIC_STEPS } : null);
});

router.get('/:id/analyze/:analysisId/events', (req, res) => {
  const { id, analysisId } = req.params;
  const job = jobs.get(analysisId);
  const row = job ? null : selectAnalysis.get(analysisId, id);
  if (!job && !row) return res.status(404).json({ error: 'Analysis not found.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // The job has already left memory: answer from the database and close.
  if (!job) {
    if (row.status === 'done') send('done', { id: row.id, status: 'done' });
    else send('failed', { id: row.id, status: row.status, error: row.error || 'This analysis is no longer running.' });
    return res.end();
  }

  send('progress', job);
  if (job.status === 'done' || job.status === 'failed') {
    send(job.status === 'done' ? 'done' : 'failed', job);
    return res.end();
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const cleanup = () => {
    clearInterval(heartbeat);
    jobs.off(analysisId, listener);
  };
  function listener(type, data) {
    send(type, data);
    if (type === 'done' || type === 'failed') {
      cleanup();
      res.end();
    }
  }
  jobs.on(analysisId, listener);
  req.on('close', cleanup);
});

export default router;
