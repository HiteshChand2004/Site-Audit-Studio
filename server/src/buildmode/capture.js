// @ts-check
// A live site Build mode starts from that was never copied in this app: the app's own pipeline makes the starting point, with
// only its fast parts. The website is found or added (authorized by the build's request), checked when it never was (the Check
// is also the baseline the build is measured against), and copied as-is with `liftOnly` (behavior/preserve/stage.js): the
// pages are captured, lifted with their images and fonts, and packaged, and the copy stops there. The slow parts of "Copy my
// site" (proving every fix leaves the page looking the same, the per-page checks, Lighthouse, the comparison after it) are
// skipped: the build changes the site anyway, and measures the result itself (quality.js).
// The jobs run through the app's job managers, so they wait their turn like any job and show on the website in the app.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { db } from '../db/index.js';
import { jobs as analyzeJobs } from '../audit/jobs.js';
import { recreateJobs } from '../recreate/jobs.js';
import { recreateRoot } from '../config/paths.js';
import { asIsPageChoice } from '../recreate/behavior/preserve/asis.js';
import { sitePagesOf } from '../routes/projects.js';
import { BuildError } from './builds.js';

/** The most pages a build copies (SAS_BUILD_MAX_PAGES): the agent changes every one, so a build stays a size it can finish. */
export const BUILD_MAX_PAGES = (() => {
  const n = Number(process.env.SAS_BUILD_MAX_PAGES);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 20;
})();

const hostOf = (/** @type {string} */ u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

/** Waits for a job of a manager to end; the build's stop stops it. */
async function waitFor(/** @type {any} */ manager, /** @type {string} */ id, /** @type {string} */ projectId, /** @type {AbortSignal | undefined} */ signal, /** @type {(t: string) => void} */ onStep) {
  let last = '';
  while (true) {
    if (signal?.aborted) {
      manager.stop?.(projectId);
      throw Object.assign(new Error('The build was stopped.'), { code: 'stopped' });
    }
    const job = manager.get(id);
    const status = job?.status ?? /** @type {any} */ (db.prepare(`SELECT status FROM ${manager === analyzeJobs ? 'analyses' : 'recreates'} WHERE id = ?`).get(id))?.status;
    if (status === 'done') return true;
    if (status === 'failed' || status === 'stopped') return false;
    if (job?.message && job.message !== last) {
      last = job.message;
      onStep(job.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * The starting point of a live site this app never copied, made now. Returns the seed (seed.js placeSeed).
 * @param {{ url: string, projectId?: string | null, stack: string, signal?: AbortSignal, log: (t: string) => void, ownerId?: string | null }} o
 */
export async function captureSite({ url, projectId = null, stack, signal, log, ownerId = null }) {
  const hasOwner = /** @type {any[]} */ (db.prepare('PRAGMA table_info(projects)').all()).some((c) => c.name === 'owner_id');
  const mine = (/** @type {any} */ p) => !ownerId || !hasOwner || p.owner_id === ownerId;
  let project = projectId ? /** @type {any} */ (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)) : null;
  if (!project) {
    const host = hostOf(url);
    project = /** @type {any[]} */ (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()).find((p) => mine(p) && hostOf(p.url) === host) ?? null;
  }
  if (project && !mine(project)) project = null;
  if (!project) {
    // Added like "Add a website" does: the build's request confirmed the owner may change it.
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, max_pages, created_at, updated_at) VALUES (?, ?, ?, ?, 1, -1, ?, ?, ?)')
      .run(id, hostOf(url) ?? url, url, stack, BUILD_MAX_PAGES, now, now);
    if (hasOwner && ownerId) db.prepare('UPDATE projects SET owner_id = ? WHERE id = ?').run(ownerId, id);
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    log(`Added ${project.name} to your websites`);
  }
  if (!project.authorized) throw new BuildError('This website is not confirmed as yours to change. Confirm it in the app first.', 403);

  // The Check: its pages are the copy's, and its scores are what the build is measured against.
  const checked = db.prepare(`SELECT id FROM analyses WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get(project.id);
  if (!checked) {
    log('Checking your site first (pages, speed, search, accessibility)');
    const job = analyzeJobs.start(project, { maxPages: Math.min(project.max_pages ?? BUILD_MAX_PAGES, BUILD_MAX_PAGES) }, { system: true });
    if (!(await waitFor(analyzeJobs, job.id, project.id, signal, (m) => log(`Check: ${m}`)))) throw new BuildError('The check of your site did not finish. Run Check in the app, then build again.', 502);
  }

  // The copy, lift only: the pages as they are, with their images and fonts, and nothing slow after that.
  const { rankOf } = await sitePagesOf(project);
  const chosen = asIsPageChoice({ ...project, max_pages: BUILD_MAX_PAGES }, undefined, rankOf);
  if (!chosen?.pages?.length) throw new BuildError('No page of your site could be found to copy.', 502);
  const pages = chosen.pages.slice(0, BUILD_MAX_PAGES);
  log(`Copying ${pages.length} page(s) of your site (pages, images and fonts)`);
  const job = recreateJobs.start(project, { preserve: true, asIs: { stack, pages, liftOnly: true, ...(chosen.choice && { pageChoice: chosen.choice }) } }, { system: true });
  if (!(await waitFor(recreateJobs, job.id, project.id, signal, (m) => log(`Copy: ${m}`)))) throw new BuildError('Copying your site did not finish. Try again, or make the copy in the app first.', 502);
  return { kind: /** @type {'copy'} */ ('copy'), dir: path.join(recreateRoot(project.id), job.id, 'stacks', stack), from: 'a copy of your site made for this build', projectId: project.id };
}
