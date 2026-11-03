// @ts-check
// Build runs: "Build my site" turns a confirmed plan into a site. The prompt is composed again on the server from the plan
// (compose.js: no model, and the client never supplies a prompt), the design's fonts are made local (fonts.js), and the
// agent (agent.js) writes the site into data/builds/<id>/site. A run lives in memory while it works and is written to
// run.json when it ends; the latest RETAIN runs are kept on disk. One run at a time on this server.
// For now a run builds a new site in plain HTML: the other stacks need their toolchains, and an existing site its code.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';
import { composeBuild } from './index.js';
import { prepareFonts } from './fonts.js';
import { runAgent } from './agent.js';
import { listFiles } from './workspace.js';
import { issuePreviewToken, previewPath, revokePreviewToken } from '../recreate/previewTokens.js';

export const BUILDS_DIR = path.join(DATA_DIR, 'builds');
const RETAIN = 10;
const MAX_ACTIVITY = 200;
const ID = /^[0-9a-f-]{36}$/;

export class BuildError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** @type {Map<string, any>} */
const runs = new Map();
/** @type {Map<string, string>} the preview token of each run */
const previews = new Map();

const runDir = (/** @type {string} */ id) => path.join(BUILDS_DIR, id);
export const siteDirOf = (/** @type {string} */ id) => path.join(runDir(id), 'site');

/** What can be built now; null when the request can, else the reason in the owner's words. */
export function unsupported(/** @type {any} */ request) {
  if (request?.input?.kind !== 'scratch') return 'Building is available for new sites for now; changing an existing site comes next.';
  if ((request.stack ?? 'html') !== 'html') return 'Building is available in Plain HTML / CSS / JS for now; the other technologies come next.';
  return null;
}

/** A run as the API returns it (no internals). */
function view(/** @type {any} */ run) {
  const token = previews.get(run.id);
  return {
    id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
    activity: run.activity, files: run.files ?? [], turns: run.turns ?? 0, usage: run.usage ?? null, model: run.model ?? null,
    report: run.report ?? null, checks: run.checks ?? null, error: run.error ?? null,
    previewUrl: token ? previewPath(token) : null,
  };
}

async function save(/** @type {any} */ run) {
  const { controller, ...stored } = run;
  await writeFile(path.join(runDir(run.id), 'run.json'), JSON.stringify(stored, null, 2));
}

/** Keeps the newest RETAIN runs on disk. */
async function prune() {
  const ids = (await readdir(BUILDS_DIR).catch(() => [])).filter((d) => ID.test(d));
  const dated = await Promise.all(ids.map(async (id) => ({ id, t: (await stat(runDir(id)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const { id } of dated.sort((a, b) => b.t - a.t).slice(RETAIN)) {
    if (runs.get(id)?.status === 'running') continue;
    const token = previews.get(id);
    if (token) revokePreviewToken(token);
    previews.delete(id);
    runs.delete(id);
    await rm(runDir(id), { recursive: true, force: true });
  }
}

/** The preview of a finished run's site: a token of the app's own preview route (sandboxed by header). */
function openPreview(/** @type {string} */ id) {
  if (!previews.has(id)) previews.set(id, issuePreviewToken({ root: siteDirOf(id), kind: 'copy', scripts: true }));
}

/**
 * Starts a build from a confirmed plan.
 * @param {any} request  { input, stack?, stackName?, description, understanding, brief, direction? } as composeBuild takes it
 * @param {{ ownerId?: string | null, deps?: any, agent?: typeof runAgent, fonts?: typeof prepareFonts }} [o]  deps / agent / fonts: tests
 */
export async function startBuild(request, { ownerId = null, deps = {}, agent = runAgent, fonts = prepareFonts } = {}) {
  const reason = unsupported(request);
  if (reason) throw new BuildError(reason, 422);
  if ([...runs.values()].some((r) => r.status === 'running')) throw new BuildError('Another site is being built on this server. Try again when it has finished.', 409);
  // The prompt is composed here, from the plan: never taken from the client.
  const composed = await composeBuild(request, deps);
  const id = randomUUID();
  const siteDir = siteDirOf(id);
  await mkdir(siteDir, { recursive: true });
  const run = {
    id, ownerId, status: 'running', startedAt: new Date().toISOString(), activity: [], files: [],
    controller: new AbortController(), plan: { description: request.description, summary: request.brief?.summary ?? '' },
  };
  runs.set(id, run);
  const log = (/** @type {string} */ text) => {
    run.activity.push({ at: new Date().toISOString(), text });
    if (run.activity.length > MAX_ACTIVITY) run.activity.splice(0, run.activity.length - MAX_ACTIVITY);
  };

  (async () => {
    try {
      const direction = composed.prompt.direction;
      log('Preparing the design\'s fonts');
      const madeFonts = direction ? await fonts([direction.fonts?.heading, direction.fonts?.body], siteDir) : null;
      log('Writing the site');
      const out = await agent({
        prompt: composed.prompt,
        siteDir,
        fonts: madeFonts,
        signal: run.controller.signal,
        onEvent: (e) => {
          if (e.type === 'file' && e.file && !run.files.includes(e.file)) run.files.push(e.file);
          else if (e.text && e.type !== 'note') log(e.text);
        },
      });
      Object.assign(run, { status: out.checks.ok ? 'done' : 'failed', report: out.report, checks: { ok: out.checks.ok, issues: out.checks.issues, pages: out.checks.pages }, turns: out.turns, usage: out.usage, model: out.model });
      if (!out.checks.ok) run.error = 'The site was written but does not pass every check yet. It is kept, so you can look at it.';
      openPreview(id);
    } catch (err) {
      run.status = err?.code === 'stopped' ? 'stopped' : 'failed';
      run.error = err?.message ?? String(err);
      if ((await listFiles(siteDir)).some((f) => f.endsWith('.html'))) openPreview(id);
    } finally {
      run.files = (await listFiles(siteDir)).filter((f) => !f.startsWith('fonts/'));
      run.finishedAt = new Date().toISOString();
      await save(run).catch(() => {});
      await prune().catch(() => {});
    }
  })();
  return view(run);
}

/** A run by id, for its owner; from disk when the server restarted since. */
export async function getBuild(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  if (!ID.test(id)) return null;
  let run = runs.get(id);
  if (!run) {
    const stored = await readFile(path.join(runDir(id), 'run.json'), 'utf8').then(JSON.parse, () => null);
    if (!stored) return null;
    run = stored.status === 'running' ? { ...stored, status: 'failed', error: 'The server restarted while this site was being built.' } : stored;
    runs.set(id, run);
    if ((await listFiles(siteDirOf(id))).some((f) => f.endsWith('.html'))) openPreview(id);
  }
  if (run.ownerId && run.ownerId !== ownerId) return null;
  return view(run);
}

/** Stops a running build; false when it was not running. */
export function stopBuild(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  const run = runs.get(id);
  if (!run || run.status !== 'running' || (run.ownerId && run.ownerId !== ownerId)) return false;
  run.controller.abort();
  return true;
}
