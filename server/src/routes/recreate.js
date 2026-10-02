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
import { getEmitter, isReadyStack, listStacks } from '../recreate/emit/index.js';
import { exportStack, outputRoot, reportOutputs, targetStack } from '../recreate/export/fromIr.js';
import { planZip, writeZip } from '../recreate/export/zip.js';
import { RecreateError } from '../recreate/errors.js';

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
  if (!isReadyStack(project.stack)) {
    const names = listStacks().filter((s) => s.status === 'ready').map((s) => s.label).join(', ');
    return res.status(400).json({ error: `Only ${names} can be recreated for now. Change the output stack.` });
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
  SELECT id, result_json FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1
`);

/**
 * The build to preview: the project's own stack when that output is ready (an app: its scripts may run
 * under the preview's `script-src 'self'`), the plain-HTML build otherwise.
 */
async function latestBuild(project) {
  const row = latestDoneId.get(project.id);
  if (!row) return null;
  const dir = recreateDir(project.id, row.id);
  const report = row.result_json ? JSON.parse(row.result_json) : {};
  const stack = targetStack(report, project.stack);
  const root = outputRoot(dir, report, stack);
  if (!(await stat(root).catch(() => null))?.isDirectory()) return null;
  // The plain-HTML build carries a script only when it has scroll-reveal effects (js/motion.js, recorded by the build step).
  return { recreateId: row.id, root, scripts: getEmitter(stack)?.scripts || reportOutputs(report)[stack]?.scripts || false, stack };
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
  const project = selectProject.get(id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const build = await latestBuild(project);
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
const CAPTURE_FILE = /^(desktop|laptop|tablet|mobile)-(fold|full)\.webp$/;
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

// Screenshots of the recreated pages and the heatmaps of the visual diff (fidelity/<slug>/<view>-{full,diff}.webp).
const FIDELITY_FILE = /^(desktop|laptop|tablet|mobile)-(full|diff)\.webp$/;

router.get('/:id/recreate/:recreateId/fidelity/:slug/:file', (req, res) => {
  const { id, recreateId, slug, file } = req.params;
  if (!UUID.test(id) || !UUID.test(recreateId) || !CAPTURE_SLUG.test(slug) || !FIDELITY_FILE.test(file)) {
    return res.status(404).json({ error: 'Image not found.' });
  }
  if (!doneRecreate.get(recreateId, id)) return res.status(404).json({ error: 'Recreate not found.' });
  res.sendFile(
    path.join(recreateDir(id, recreateId), 'fidelity', slug, file),
    { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } },
    (err) => {
      if (!err || res.headersSent) return;
      res.status(404).json({ error: 'Image not found. Only the latest 2 recreates of a project keep their files.' });
    },
  );
});

// Download zip of a completed recreate, streamed from its folder. The stack is the one the recreate
// was built for; only a recreate that passed the safety gate is offered.
const doneReport = db.prepare(`SELECT result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);

router.get('/:id/recreate/:recreateId/download', async (req, res) => {
  const { id, recreateId } = req.params;
  if (!UUID.test(id) || !UUID.test(recreateId)) return res.status(404).json({ error: 'Recreate not found.' });
  const row = doneReport.get(recreateId, id);
  if (!row?.result_json) return res.status(404).json({ error: 'Recreate not found.' });
  const report = JSON.parse(row.result_json);
  const stack = req.query.stack ?? report.stack;
  if (reportOutputs(report)[stack]?.status !== 'ready') {
    const have = Object.keys(reportOutputs(report)).join(', ');
    const error = `This recreate has no ${stack} output (available: ${have}).`;
    return res.status(400).set('X-Download-Error', error).json({ error });
  }
  if (report.safety?.safe !== true) {
    const error = 'This recreate has no passed safety check, so it cannot be downloaded. Run Recreate again.';
    return res.status(409).set('X-Download-Error', error).json({ error });
  }
  let plan;
  try {
    plan = await planZip({ dir: recreateDir(id, recreateId), report, stack });
  } catch (err) {
    if (err instanceof RecreateError) {
      // The app checks with HEAD first (a failed download would otherwise navigate to a JSON page).
      return res.status(err.status ?? 404).set('X-Download-Error', err.message).json({ error: err.message });
    }
    throw err;
  }
  res.status(200).set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${plan.name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  try {
    await writeZip(plan, res);
  } catch (err) {
    console.error('Download failed:', err.message);
    res.destroy(); // headers are sent: a cut stream is the only honest signal
  }
});

// Export a completed recreate as another stack from its saved IR (no new capture). Idempotent: an
// existing output is returned. The emit runs under the global job lock.
router.post('/:id/recreate/:recreateId/export', async (req, res) => {
  const { id, recreateId } = req.params;
  const stack = req.body?.stack;
  if (!UUID.test(id) || !UUID.test(recreateId)) return res.status(404).json({ error: 'Recreate not found.' });
  if (typeof stack !== 'string' || !getEmitter(stack)) return res.status(400).json({ error: 'Choose one of the listed stacks.' });
  try {
    const { output, created } = await exportStack({ projectId: id, recreateId, stack });
    res.status(created ? 201 : 200).json({ stack, output, created });
  } catch (err) {
    if (err instanceof RecreateError) return res.status(err.status ?? 500).json({ error: err.message });
    throw err;
  }
});

router.get('/:id/recreate/:recreateId/events', (req, res) => {
  const { id, recreateId } = req.params;
  streamJob(req, res, recreateJobs, recreateId, () => selectRecreate.get(recreateId, id));
});

export default router;
