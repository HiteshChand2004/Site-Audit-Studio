import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { db } from '../db/index.js';
import { ConflictError } from '../jobs/manager.js';
import { streamJob } from '../jobs/sse.js';
import { PUBLIC_STEPS } from '../recreate/index.js';
import { analysisWarnings, latestAnalysis, parseExactMode } from '../recreate/inputs.js';
import { recreateJobs } from '../recreate/jobs.js';
import { activePreview, PreviewError, startPreview, stopPreview } from '../recreate/preview.js';
import { findResumable, recreateDir } from '../recreate/workspace.js';
import { slugFor } from '../recreate/discover.js';
import { getEmitter, isReadyStack, listStacks } from '../recreate/emit/index.js';
import { exportStack, outputRoot, reportOutputs, targetStack } from '../recreate/export/fromIr.js';
import { planZip, writeZip } from '../recreate/export/zip.js';
import { RecreateError } from '../recreate/errors.js';
import { ASIS_DIR, ASIS_STACKS, readLifted } from '../recreate/behavior/preserve/stage.js';
import { startAsIsPreview, stopAsIsPreview } from '../recreate/behavior/preserve/asisPreview.js';
import { asIsPagesOf } from '../recreate/behavior/preserve/asis.js';

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

// Finished recreates, newest first: the latest one whose capture is still on disk can be rebuilt from.
/** The finished copies with their reports, newest first (the output of each stack of an as-is copy). */
const doneCopies = db.prepare(`
  SELECT id, result_json FROM recreates
  WHERE project_id = ? AND status = 'done'
  ORDER BY started_at DESC LIMIT 20
`);

/** The finished copies, newest first, that may hold a lifted copy to package (see the reuse of an as-is copy). */
const latestAsIsSource = db.prepare(`
  SELECT id, started_at FROM recreates
  WHERE project_id = ? AND status = 'done'
  ORDER BY started_at DESC LIMIT 20
`);

const latestReplayable = db.prepare(`
  SELECT id, started_at FROM recreates
  WHERE project_id = ? AND status = 'done'
  ORDER BY started_at DESC LIMIT 5
`);

router.post('/:id/recreate', async (req, res) => {
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

  // `reuseCapture`: rebuild from the capture of the latest finished recreate (recreate/replay.js) instead of opening the
  // site again: only generate → build → preview run, for trying a change to the generated site quickly.
  if (req.body?.resume && req.body?.reuseCapture) {
    return res.status(400).json({ error: 'Choose one: continue the stopped copy, or rebuild from the last visit.' });
  }
  let payload = {};
  if (req.body?.reuseCapture) {
    const source = latestReplayable.all(project.id).find((r) => r && existsSync(path.join(recreateDir(project.id, r.id), 'capture', 'manifest.json'))
      && existsSync(path.join(recreateDir(project.id, r.id), 'assets', 'manifest.json')));
    if (!source) return res.status(409).json({ error: 'There is no saved capture to rebuild from: run a full Recreate first.' });
    payload = { reuseFrom: { recreateId: source.id, createdAt: source.started_at } };
  }
  // `resume`: continue the stopped recreate whose work was kept (recreate/checkpoint.js) instead of starting over.
  if (req.body?.resume) {
    if (recreateJobs.active(project.id)) {
      return res.status(409).json({ error: 'A recreate is already running for this project.', recreateId: recreateJobs.active(project.id).id });
    }
    const stopped = await findResumable(project.id);
    if (!stopped) return res.status(409).json({ error: 'There is no stopped recreate to continue: start a new one.' });
    payload = { resumeFrom: { recreateId: stopped.recreateId } };
  }
  // `exact`: this one run is an exact copy (the project's own setting decides when this is not given).
  if (req.body?.exact !== undefined) {
    const parsed = parseExactMode(req.body.exact);
    if (parsed === null) return res.status(400).json({ error: 'Exact mode must be true or false.' });
    payload.exact = Boolean(parsed);
  }
  // `noLimit`: an ordinary run that is allowed to take as long as its work needs.
  if (req.body?.noLimit) payload.noLimit = true;
  // `preserve`: an authorised project whose original parts are kept as they are (CLONER_SPEC): also fetches every picture and video.
  if (req.body?.preserve === true) payload.preserve = true;
  // `mode: 'as-is'`: the original's own code and animations, saved locally (behavior/preserve). Only for an authorised project,
  // and only when the request confirms it; the pages are the chosen ones of this site (the homepage always among them).
  if (req.body?.mode !== undefined && req.body.mode !== 'clean' && req.body.mode !== 'as-is') {
    return res.status(400).json({ error: 'The mode must be "clean" or "as-is".' });
  }
  if (req.body?.mode === 'as-is') {
    if (!project.authorized) return res.status(403).json({ error: 'The original as-is copy is only available for a project marked as authorised.' });
    if (req.body.confirmed !== true) return res.status(400).json({ error: 'Confirm that you may copy this site as it is.' });
    const stack = req.body.stack ?? project.stack ?? 'html';
    if (!ASIS_STACKS.includes(stack)) return res.status(400).json({ error: `The as-is copy can be packaged as: ${ASIS_STACKS.join(', ')}.` });
    // `reuseAsIs`: another stack from the lifted copy of the latest as-is copy (no capture, no lift again).
    let pages;
    let from = null;
    if (req.body.reuseAsIs === true) {
      // The newest finished copy that still has its lifted folder (older ones may have been removed by the retention rule).
      const source = latestAsIsSource.all(project.id).find((r) => existsSync(path.join(recreateDir(project.id, r.id), ASIS_DIR, 'copy')));
      const lifted = source ? await readLifted(recreateDir(project.id, source.id)) : null;
      if (!source || !lifted) return res.status(409).json({ error: 'There is no lifted copy to package: make an original as-is copy first.' });
      from = source.id;
      pages = lifted.pages.map((p) => p.url);
    } else {
      pages = asIsPagesOf(project, req.body.pages);
      if (pages === null) return res.status(400).json({ error: 'The pages must be addresses of this site (the homepage first or among them), up to 40.' });
    }
    payload.preserve = true;
    payload.asIs = { stack, pages, ...(from && { from }) };
  }

  try {
    const job = recreateJobs.start(project, payload, { warnings: analysisWarnings(analysis) });
    res.status(202).json({
      recreateId: job.id, job, steps: PUBLIC_STEPS,
      ...(payload.reuseFrom && { reuseFrom: payload.reuseFrom }),
      ...(payload.resumeFrom && { resumeFrom: payload.resumeFrom }),
      ...(payload.exact !== undefined && { exact: payload.exact }),
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message, recreateId: err.job.id });
    }
    throw err;
  }
});

router.post('/:id/recreate/stop', (req, res) => {
  const job = recreateJobs.stop(req.params.id);
  if (!job) return res.status(409).json({ error: 'No copy is running for this project.' });
  res.json({ job, steps: PUBLIC_STEPS });
});

router.get('/:id/recreate/current', (req, res) => {
  const job = recreateJobs.active(req.params.id);
  res.json(job ? { job, steps: PUBLIC_STEPS } : null);
});

// Reports written before pages carried their capture folder get it here (additive).
const withSlugs = (report) => ({ ...report, pages: (report.pages ?? []).map((p) => ({ ...p, slug: p.slug ?? slugFor(p.outPath) })) });

// Latest attempt (any status) plus the report of the latest successful recreate.
router.get('/:id/recreate', async (req, res) => {
  if (!selectProject.get(req.params.id)) return res.status(404).json({ error: 'Project not found.' });
  const last = latestRow.get(req.params.id);
  const done = latestDone.get(req.params.id);
  // A stopped recreate whose work was kept: the app offers to continue it (POST { resume: true }).
  const stopped = recreateJobs.active(req.params.id) ? null : await findResumable(req.params.id);
  // The newest output of each stack of an as-is copy, with the copy that holds it (each stack has its own download).
  const asIsOutputs = {};
  for (const row of doneCopies.all(req.params.id)) {
    const rep = row.result_json ? JSON.parse(row.result_json) : null;
    for (const [stack, out] of Object.entries(rep?.outputs ?? {})) {
      if (out?.mode !== 'as-is' || out.status !== 'ready' || asIsOutputs[stack]) continue;
      if (!existsSync(path.join(recreateDir(req.params.id, row.id), out.dir ?? ''))) continue;
      asIsOutputs[stack] = { recreateId: row.id };
    }
  }
  res.json({
    asIsOutputs,
    resumable: stopped?.summary ?? null,
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

const previewOf = (projectId) => activePreview(projectId);

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

// The exact comparison's pictures: the original as it was measured (capture/<slug>/exact/) and the copy beside it,
// with the map of where they differ and the magnified crops (fidelity/<slug>/exact/). A slot id is a width, or a
// width and a height, so the file names are bounded by that.
const EXACT_FILE = /^(copy-)?d{3,4}(xd{3,4})?(-b[1-3]|-full|-map|-crop[1-3]).webp$/;

router.get('/:id/recreate/:recreateId/exact/:slug/:file', (req, res) => {
  const { id, recreateId, slug, file } = req.params;
  if (!UUID.test(id) || !UUID.test(recreateId) || !CAPTURE_SLUG.test(slug) || !EXACT_FILE.test(file)) {
    return res.status(404).json({ error: 'Image not found.' });
  }
  if (!doneRecreate.get(recreateId, id)) return res.status(404).json({ error: 'Recreate not found.' });
  // The original's own shots live with the capture; everything the comparison made lives with the fidelity output.
  const dir = file.startsWith('copy-') || /-(map|crop[1-3]).webp$/.test(file)
    ? path.join(recreateDir(id, recreateId), 'fidelity', slug, 'exact')
    : path.join(recreateDir(id, recreateId), 'capture', slug, 'exact');
  res.sendFile(
    path.join(dir, file),
    { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } },
    (err) => {
      if (!err || res.headersSent) return;
      res.status(404).json({ error: 'Image not found. Only the latest 2 recreates of a project keep their files.' });
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

// The preview of an "Original as-is" copy: served from its own address (behavior/preserve/asisPreview.js), never the app's origin.
router.post('/:id/recreate/:recreateId/asis-preview', async (req, res) => {
  const row = doneReport.get(req.params.recreateId, req.params.id);
  const report = row?.result_json ? JSON.parse(row.result_json) : null;
  if (!report?.asIs) return res.status(409).json({ error: 'This is not a finished original as-is copy.' });
  try {
    const url = await startAsIsPreview(req.params.id, req.params.recreateId, path.join(recreateDir(req.params.id, req.params.recreateId), ASIS_DIR, 'copy'));
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: `The preview could not be started: ${err.message}` });
  }
});

router.delete('/:id/recreate/:recreateId/asis-preview', async (req, res) => {
  await stopAsIsPreview(req.params.id, req.params.recreateId);
  res.status(204).end();
});

router.get('/:id/recreate/:recreateId/events', (req, res) => {
  const { id, recreateId } = req.params;
  streamJob(req, res, recreateJobs, recreateId, () => selectRecreate.get(recreateId, id));
});

export default router;
