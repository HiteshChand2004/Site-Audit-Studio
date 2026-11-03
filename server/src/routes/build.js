// @ts-check
// Build mode's API (src/buildmode/index.js):
//   GET  /api/build/modules  the playbook library (kind, id, version, title)
//   POST /api/build/plan     { input, stack?, description, answers? } → understanding, brief and the composed agent prompt (2 model calls)
//   POST /api/build/compose  { input, stack?, description, understanding, brief, direction? } → the prompt again (no model)
//   POST /api/build/runs     the same body as compose → starts building the site (buildmode/builds.js); 202 + the run
//   GET  /api/build/runs/:id the run: progress, files, report, checks, preview address
//   POST /api/build/runs/:id/stop    stops a running build
//   GET  /api/build/runs/:id/download   the built site as a zip
// input = { kind: 'scratch' } | { kind: 'url', url, authorized: true } (a live website, read now by its address)
//   | { kind: 'url', projectId } (a website checked in the app, its copy is the base)
//   | { kind: 'source', files: [{ path, content }] | github: { url, ref? }, site?: { url }, authorized?, projectId? } (the website's
//   own code, uploaded or a public repo, and optionally the address of the live site it runs).
// With accounts on, a website of another account answers like one that does not exist.
import { Router } from 'express';
import { db } from '../db/index.js';
import { accountsEnabled } from '../config/index.js';
import path from 'node:path';
import { composeBuild, library, planBuild } from '../buildmode/index.js';
import { BuildError, getBuild, siteDirOf, startBuild, stopBuild } from '../buildmode/builds.js';
import { listFiles } from '../buildmode/workspace.js';
import { writeZip } from '../recreate/export/zip.js';

const router = Router();

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const latestAudit = db.prepare(`
  SELECT result_json FROM analyses
  WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL
  ORDER BY started_at DESC LIMIT 1
`);

/** Reads a website and its latest finished check, for the signed-in account only. */
const projectLoader = (/** @type {any} */ req) => (/** @type {string} */ id) => {
  const project = /** @type {any} */ (selectProject.get(id));
  if (!project) return null;
  if (accountsEnabled() && (!req.user || project.owner_id !== req.user.id)) return null;
  const row = /** @type {any} */ (latestAudit.get(id));
  return { project, audit: row ? JSON.parse(row.result_json) : null };
};

/** Errors of build mode carry the status to answer with; anything else is a server error. */
function answerError(/** @type {any} */ err, /** @type {import('express').Response} */ res, /** @type {Function} */ next) {
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) {
    return res.status(err.status).json({ error: err.message, ...(err.code && { code: err.code }) });
  }
  next(err);
}

router.get('/modules', (_req, res) => {
  res.json({ modules: library().modules.map(({ kind, id, version, title }) => ({ kind, id, version, title })) });
});

router.post('/plan', async (req, res, next) => {
  try {
    res.json(await planBuild(req.body ?? {}, { loadProject: projectLoader(req) }));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.post('/compose', async (req, res, next) => {
  try {
    res.json(await composeBuild(req.body ?? {}, { loadProject: projectLoader(req) }));
  } catch (err) {
    answerError(err, res, next);
  }
});

const ownerOf = (/** @type {any} */ req) => (accountsEnabled() ? req.user?.id ?? null : null);

router.post('/runs', async (req, res, next) => {
  try {
    res.status(202).json(await startBuild(req.body ?? {}, { ownerId: ownerOf(req), deps: { loadProject: projectLoader(req) } }));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    const run = await getBuild(req.params.id, ownerOf(req));
    if (!run) return res.status(404).json({ error: 'Build not found.' });
    res.json(run);
  } catch (err) {
    next(err);
  }
});

router.post('/runs/:id/stop', (req, res) => {
  if (!stopBuild(req.params.id, ownerOf(req))) return res.status(409).json({ error: 'This build is not running.' });
  res.json({ stopping: true });
});

router.get('/runs/:id/download', async (req, res, next) => {
  try {
    const run = await getBuild(req.params.id, ownerOf(req));
    if (!run) return res.status(404).json({ error: 'Build not found.' });
    if (run.status === 'running') return res.status(409).json({ error: 'The site is still being built.' });
    if (run.checks && run.checks.ok === false) return res.status(409).json({ error: 'This site did not pass every check, so it cannot be downloaded. Build it again.' });
    const dir = siteDirOf(run.id);
    const files = await listFiles(dir);
    if (!files.some((f) => f.endsWith('.html'))) return res.status(404).json({ error: 'This build has no pages to download.' });
    const name = `site-${run.id.slice(0, 8)}`;
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}.zip"`, 'Cache-Control': 'no-store' });
    await writeZip({ entries: files.map((f) => ({ name: `${name}/${f}`, file: path.join(dir, f), store: /\.woff2$/.test(f) })) }, res);
  } catch (err) {
    if (err instanceof BuildError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
