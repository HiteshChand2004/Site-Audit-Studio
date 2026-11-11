// @ts-check
// Build mode's API (src/buildmode/index.js):
//   GET  /api/build/modules  the playbook library (kind, id, version, title)
//   POST /api/build/plan     { input, stack?, description, answers? } → understanding, brief and the composed agent prompt (2 model calls)
//   POST /api/build/compose  { input, stack?, description, answers?, understanding, brief, direction? } → the prompt again (no model)
//   POST /api/build/runs     the same body as compose → starts building the site (buildmode/builds.js); 202 + the run
//   GET  /api/build/runs/:id the run: progress, files, report, checks, preview address
//   GET  /api/build/runs/:id/preview  the built site's live preview: redirects to a preview address this server holds now
//   POST /api/build/runs/:id/stop    stops a running build
//   GET  /api/build/runs/:id/download   the built site as a zip (an app stack: its whole project, the built site in it)
//   GET  /api/build/runs/:id/texts  a finished site's words: each page's text blocks, its placeholders (buildmode/edit.js)
//   POST /api/build/runs/:id/edits  { kind: 'fill', token, value } | { kind: 'text', page, from, to } → changed without the
//                                   agent, rebuilt and checked; { run, files } (422 with the reason when it cannot be)
//   POST /api/build/runs/:id/publish   shares the site at /sites/<slug>/ (buildmode/publish.js); DELETE stops sharing it
//   GET  /api/build/sites    the owner's saved sites, each with its builds, and earlier builds no saved site lists
//   POST /api/build/sites    { state } → a new saved site (201); PUT /api/build/sites/:id { state } saves it again
//   GET  /api/build/sites/:id   a saved site with the app's state and its builds; DELETE removes it, its images and its builds
//   GET  /api/build/sites/:id/images   the site's photos and logo (buildmode/images.js): [{ id, role, width, height, bytes }]
//   POST /api/build/sites/:id/images?role=photo|logo   the image file as the body (JPEG, PNG or WebP, ≤ 8 MB) → 201 + the image
//   GET  /api/build/sites/:id/images/:imageId/thumb   its small version; DELETE /api/build/sites/:id/images/:imageId removes it
//   GET  /api/build/fonts/:family.css, /api/build/fonts/files/:file.woff2   a design direction's fonts for its preview card,
//        fetched once by the server and served from the app's own address (buildmode/fontPreview.js)
// A run started with { siteId } is listed with that site (buildmode/sites.js), and gets the site's images its request names
// (images: [{ id, alt }]) copied into the project.
// input = { kind: 'scratch' } | { kind: 'url', url, authorized: true } (a live website, read now by its address)
//   | { kind: 'url', projectId } (a website checked in the app, its copy is the base)
//   | { kind: 'source', files: [{ path, content }] | github: { url, ref? }, site?: { url }, authorized?, projectId? } (the website's
//   own code, uploaded or a public repo, and optionally the address of the live site it runs).
// With accounts on, a website of another account answers like one that does not exist.
import express, { Router } from 'express';
import { db } from '../db/index.js';
import { accountsEnabled } from '../config/index.js';
import path from 'node:path';
import { composeBuild, library, planBuild } from '../buildmode/index.js';
import { BuildError, getBuild, hasDownload, listBuilds, stackOf, previewOf, removeBuild, siteDirOf, startBuild, stopBuild } from '../buildmode/builds.js';
import { projectFile } from '../buildmode/stacks.js';
import { editSite, siteTexts } from '../buildmode/edit.js';
import { publishBuild, unpublishBuild } from '../buildmode/publish.js';
import { attachRun, createSite, deleteSite, getSite, listSites, saveSite, summarize } from '../buildmode/sites.js';
import { listFiles } from '../buildmode/workspace.js';
import { IMAGE_LIMITS, ImageError, addImage, listImages, removeImage, resolveImages, thumbnailOf } from '../buildmode/images.js';
import { writeZip } from '../recreate/export/zip.js';
import { fontPreviewRouter } from '../buildmode/fontPreview.js';

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

const ownerOf = (/** @type {any} */ req) => (accountsEnabled() ? req.user?.id ?? null : null);

router.use('/fonts', fontPreviewRouter());

router.get('/modules', (_req, res) => {
  res.json({ modules: library().modules.map(({ kind, id, version, title }) => ({ kind, id, version, title })) });
});

router.post('/plan', async (req, res, next) => {
  try {
    res.json(await planBuild(req.body ?? {}, { loadProject: projectLoader(req), ownerId: ownerOf(req) }));
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

router.post('/runs', async (req, res, next) => {
  try {
    const ownerId = ownerOf(req);
    const { siteId, ...request } = req.body ?? {};
    if (siteId != null && (typeof siteId !== 'string' || !(await getSite(siteId, ownerId)))) return res.status(404).json({ error: 'Saved site not found.' });
    // The owner's photos and logo come from the saved site only: ids the site does not have are left out.
    const images = siteId ? await resolveImages(siteId, ownerId, request.images) : [];
    const run = await startBuild(request, { ownerId, images, deps: { loadProject: projectLoader(req) } });
    if (siteId) await attachRun(siteId, ownerId, run.id);
    res.status(202).json(run);
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

router.get('/runs/:id/preview', async (req, res, next) => {
  try {
    const where = await previewOf(req.params.id, ownerOf(req));
    if (!where) return res.status(404).json({ error: 'This build has no site to show.' });
    res.set('Cache-Control', 'no-store').redirect(302, where);
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
    if (!(await hasDownload(run))) return res.status(404).json({ error: 'This build has no pages to download.' });
    const dir = siteDirOf(run.id);
    // The project as the owner gets it: what the build links in or caches is not part of it; the built site (dist/, out/,
    // build/, client/dist/) is. A source-only project is its source.
    const { out } = stackOf(run);
    const files = (await listFiles(dir)).filter((f) => projectFile(f) || (out && f.startsWith(`${out}/`)));
    const name = `site-${run.id.slice(0, 8)}`;
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}.zip"`, 'Cache-Control': 'no-store' });
    await writeZip({ entries: files.map((f) => ({ name: `${name}/${f}`, file: path.join(dir, f), store: /\.woff2$/.test(f) })) }, res);
  } catch (err) {
    if (err instanceof BuildError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// The changes after the build: every one is the owner's (ownerOf), on the same run, without the agent.
router.get('/runs/:id/texts', async (req, res, next) => {
  try {
    res.json(await siteTexts(req.params.id, ownerOf(req)));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.post('/runs/:id/edits', async (req, res, next) => {
  try {
    res.json(await editSite(req.params.id, ownerOf(req), req.body ?? {}));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.post('/runs/:id/publish', async (req, res, next) => {
  try {
    res.json(await publishBuild(req.params.id, ownerOf(req)));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.delete('/runs/:id/publish', async (req, res, next) => {
  try {
    res.json(await unpublishBuild(req.params.id, ownerOf(req)));
  } catch (err) {
    answerError(err, res, next);
  }
});

/** A saved site as the app lists it: its summary and its builds, newest first. */
const withBuilds = async (/** @type {any} */ site, /** @type {string | null} */ ownerId) => {
  const { runs, ...rest } = summarize(site);
  return { ...rest, builds: await listBuilds(ownerId, [...runs].reverse()) };
};

router.get('/sites', async (req, res, next) => {
  try {
    const ownerId = ownerOf(req);
    const saved = await listSites(ownerId);
    const listed = new Set(saved.flatMap((s) => s.runs ?? []));
    res.json({
      sites: await Promise.all(saved.map((s) => withBuilds(s, ownerId))),
      // Builds started before sites were saved, or whose site was not saved: still found, seen and downloaded here.
      earlier: (await listBuilds(ownerId)).filter((b) => !listed.has(b.id)),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sites', async (req, res, next) => {
  try {
    const site = await createSite({ ownerId: ownerOf(req), state: req.body?.state });
    res.status(201).json(await withBuilds(site, ownerOf(req)));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.get('/sites/:id', async (req, res, next) => {
  try {
    const site = await getSite(req.params.id, ownerOf(req));
    if (!site) return res.status(404).json({ error: 'Saved site not found.' });
    res.json({ ...(await withBuilds(site, ownerOf(req))), state: site.state });
  } catch (err) {
    next(err);
  }
});

router.put('/sites/:id', async (req, res, next) => {
  try {
    const site = await saveSite(req.params.id, ownerOf(req), req.body?.state);
    if (!site) return res.status(404).json({ error: 'Saved site not found.' });
    res.json(summarize(site));
  } catch (err) {
    answerError(err, res, next);
  }
});

router.delete('/sites/:id', async (req, res, next) => {
  try {
    const ownerId = ownerOf(req);
    const site = await getSite(req.params.id, ownerId);
    if (!site) return res.status(404).json({ error: 'Saved site not found.' });
    const builds = await listBuilds(ownerId, site.runs ?? []);
    if (builds.some((b) => b.status === 'running')) return res.status(409).json({ error: 'This site is being built. Stop the build first.' });
    await deleteSite(site.id, ownerId);
    for (const b of builds) await removeBuild(b.id, ownerId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** The image upload's own body parser: raw bytes up to the limit, whatever type the request names (the bytes decide, images.js). */
const rawImage = express.raw({ type: () => true, limit: IMAGE_LIMITS.uploadBytes });
/** Only the site's owner gets to send a file at all: the body is read after the check. */
const ownSite = async (/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) => {
  try {
    if (!(await getSite(req.params.id, ownerOf(req)))) return res.status(404).json({ error: 'Saved site not found.' });
    next();
  } catch (err) {
    next(err);
  }
};
const readImage = (/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) => rawImage(req, res, (/** @type {any} */ err) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `An image may be at most ${IMAGE_LIMITS.uploadBytes / 1024 / 1024} MB.` });
  res.status(400).json({ error: 'The image could not be received. Try again.' });
});

router.get('/sites/:id/images', async (req, res, next) => {
  try {
    const images = await listImages(req.params.id, ownerOf(req));
    if (!images) return res.status(404).json({ error: 'Saved site not found.' });
    res.json({ images });
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/images', ownSite, readImage, async (req, res, next) => {
  try {
    const image = await addImage(req.params.id, ownerOf(req), req.body, req.query.role);
    if (!image) return res.status(404).json({ error: 'Saved site not found.' });
    res.status(201).json(image);
  } catch (err) {
    if (err instanceof ImageError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/sites/:id/images/:imageId/thumb', async (req, res, next) => {
  try {
    const data = await thumbnailOf(req.params.id, ownerOf(req), req.params.imageId);
    if (!data) return res.status(404).json({ error: 'Image not found.' });
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.send(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/sites/:id/images/:imageId', async (req, res, next) => {
  try {
    const removed = await removeImage(req.params.id, ownerOf(req), req.params.imageId);
    if (removed === null) return res.status(404).json({ error: 'Saved site not found.' });
    if (!removed) return res.status(404).json({ error: 'Image not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
