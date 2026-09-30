import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { db } from '../db/index.js';
import { ConflictError } from '../jobs/manager.js';
import { streamJob } from '../jobs/sse.js';
import { PUBLIC_STEPS } from '../recreate/index.js';
import { analysisWarnings, latestAnalysis } from '../recreate/inputs.js';
import { recreateJobs } from '../recreate/jobs.js';
import { activePreview, PreviewError, startPreview, stopPreview } from '../recreate/preview.js';
import { recreateDir } from '../recreate/workspace.js';
import { slugFor } from '../recreate/discover.js';

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

// Reports written before pages carried their capture folder get it here (additive).
const withSlugs = (report) => ({ ...report, pages: (report.pages ?? []).map((p) => ({ ...p, slug: p.slug ?? slugFor(p.outPath) })) });

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
    result: done ? withSlugs(JSON.parse(done.result_json)) : null,
  });
});

// Preview of the latest completed recreate (its dist/ folder). One preview is active at a time, so
// starting one for this project stops any other.
const latestDoneId = db.prepare(`
  SELECT id FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1
`);

async function latestBuild(projectId) {
  const row = latestDoneId.get(projectId);
  if (!row) return null;
  const root = path.join(recreateDir(projectId, row.id), 'dist');
  return (await stat(root).catch(() => null))?.isDirectory() ? { recreateId: row.id, root } : null;
}

const previewOf = (projectId) => {
  const p = activePreview();
  return p?.projectId === projectId ? p : null;
};

router.get('/:id/preview', (req, res) => {
  if (!selectProject.get(req.params.id)) return res.status(404).json({ error: 'Project not found.' });
  res.json({ preview: previewOf(req.params.id) });
});

router.post('/:id/preview', async (req, res) => {
  const { id } = req.params;
  if (!selectProject.get(id)) return res.status(404).json({ error: 'Project not found.' });
  const build = await latestBuild(id);
  if (!build) return res.status(404).json({ error: 'There is no recreated site to preview yet. Run Recreate first.' });
  try {
    res.json({ preview: await startPreview({ projectId: id, ...build }) });
  } catch (err) {
    if (err instanceof PreviewError) return res.status(503).json({ error: err.message });
    throw err;
  }
});

router.delete('/:id/preview', async (req, res) => {
  await stopPreview({ projectId: req.params.id });
  res.status(204).end();
});

// Screenshots the Recreate capture took of each page (the OLD panel shows the page the NEW preview
// shows). Only fold/full WebP files of a completed recreate of this project; the recreate id is in
// the path, so a file never changes. Recreates past the retention (latest 2) are gone: 404.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_FILE = /^(desktop|tablet|mobile)-(fold|full)\.webp$/;
// A capture folder name (discover.js slugFor): letters, digits, _ . - only; never "." or "..".
const CAPTURE_SLUG = /^(?!\.{1,2}$)[\w.-]{1,200}$/;
const doneRecreate = db.prepare(`SELECT id FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);

router.get('/:id/recreate/:recreateId/captures/:slug/:file', (req, res) => {
  const { id, recreateId, slug, file } = req.params;
  if (!UUID.test(id) || !UUID.test(recreateId) || !CAPTURE_SLUG.test(slug) || !CAPTURE_FILE.test(file)) {
    return res.status(404).json({ error: 'Capture not found.' });
  }
  if (!doneRecreate.get(recreateId, id)) return res.status(404).json({ error: 'Recreate not found.' });
  res.sendFile(
    path.join(recreateDir(id, recreateId), 'capture', slug, file),
    { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } },
    (err) => {
      if (!err || res.headersSent) return;
      res.status(404).json({ error: 'Capture not found. Only the latest 2 recreates of a project keep their files.' });
    },
  );
});

router.get('/:id/recreate/:recreateId/events', (req, res) => {
  const { id, recreateId } = req.params;
  streamJob(req, res, recreateJobs, recreateId, () => selectRecreate.get(recreateId, id));
});

export default router;
