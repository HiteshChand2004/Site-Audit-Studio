// @ts-check
// A built site shared with a link: "Publish" copies the built site (the folder the preview shows) into
// data/builds/<id>/published and gives it a stable public address on this server, /sites/<slug>/, which anyone with the link
// can open — for showing the site to others and checking it on a phone, not hosting (the owner downloads the zip for that).
// Publishing again after changes copies the changed site over the same address; "Unpublish" removes the copy and the address.
// The slug is recorded in run.json, and the lookup slug → run is read again from the runs on disk the first time it is
// needed after a start, so a shared link survives a restart.
// Served by the preview's own router (recreate/previewRoute.js, mounted at PUBLISHED_PREFIX outside /api and outside the
// accounts gate, since a shared link is opened by people without an account): the same headers, so every document is
// sandboxed into an opaque origin and the site's scripts can never act as the app; only files inside the published copy are
// served; nothing else of the app is reachable through it.
import { randomBytes } from 'node:crypto';
import { cp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { BuildError, BUILDS_DIR, builtDirOf, hasPages, lockRun, runDirOf, runRecord, saveRun, viewRun } from './builds.js';

export const PUBLISHED_PREFIX = '/sites';
const SLUG = /^[A-Za-z0-9_-]{24}$/;
const ID = /^[0-9a-f-]{36}$/;

/** @type {Map<string, string>} slug → run id */
const bySlug = new Map();
/** @type {Promise<void> | null} */
let loaded = null;

/** The public path of a shared site. */
export const publishedPath = (/** @type {string} */ slug) => `${PUBLISHED_PREFIX}/${slug}/`;
const copyDir = (/** @type {string} */ id) => path.join(runDirOf(id), 'published');

/** The lookup from the runs on disk, once per start. */
export function loadPublished() {
  loaded ??= (async () => {
    for (const id of (await readdir(BUILDS_DIR).catch(() => [])).filter((d) => ID.test(d))) {
      const stored = await readFile(path.join(runDirOf(id), 'run.json'), 'utf8').then(JSON.parse, () => null);
      const slug = stored?.published?.slug;
      if (typeof slug === 'string' && SLUG.test(slug)) bySlug.set(slug, id);
    }
  })();
  return loaded;
}

/** The ids of the runs shared with a link (kept by the clean-up of old builds). */
export async function publishedRunIds() {
  await loadPublished();
  return new Set(bySlug.values());
}

/** A removed run's link goes with it. */
export async function forgetPublished(/** @type {string} */ id) {
  await loadPublished();
  for (const [slug, runId] of bySlug) if (runId === id) bySlug.delete(slug);
}

/**
 * What a shared address serves, for the preview router: the published copy, as a build of ours (strict policy, the site's
 * own scripts only, the same as its preview). Null for an unknown address.
 * @param {string} slug
 */
export async function resolvePublished(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  await loadPublished();
  const id = bySlug.get(slug);
  return id ? { root: copyDir(id), kind: /** @type {'copy'} */ ('copy'), scripts: true } : null;
}

/** Shares a finished run's site (again): its current built site copied over its stable address. */
export async function publishBuild(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  await loadPublished();
  const run = await runRecord(id, ownerId);
  if (!run) throw new BuildError('Build not found.', 404);
  if (run.status !== 'done' || run.checks?.ok === false || !(await hasPages(run))) throw new BuildError('Only a finished site that passed its checks can be shared.', 409);
  return lockRun(id, async () => {
    const dest = copyDir(id);
    const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await cp(builtDirOf(run), tmp, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
      await rm(dest, { recursive: true, force: true });
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    const slug = run.published?.slug ?? randomBytes(18).toString('base64url');
    run.published = { slug, at: new Date().toISOString(), revision: run.revision ?? 0 };
    bySlug.set(slug, id);
    await saveRun(run);
    return viewRun(run);
  }, { duringBuild: true });
}

/** Stops sharing a run's site: the address answers "not found" and the copy is removed. */
export async function unpublishBuild(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  await loadPublished();
  const run = await runRecord(id, ownerId);
  if (!run) throw new BuildError('Build not found.', 404);
  return lockRun(id, async () => {
    if (run.published?.slug) bySlug.delete(run.published.slug);
    delete run.published;
    await rm(copyDir(id), { recursive: true, force: true });
    await saveRun(run);
    return viewRun(run);
  }, { duringBuild: true });
}
