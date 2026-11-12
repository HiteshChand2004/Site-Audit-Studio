// @ts-check
// Build runs: "Build my site" turns a confirmed plan into a site. The prompt is composed again on the server from the plan
// (compose.js: no model, and the client never supplies a prompt), the design's fonts are made local (fonts.js), and the
// agent (agent.js) writes the site into data/builds/<id>/site. A run lives in memory while it works and is written to
// run.json when it starts and when it ends; the latest RETAIN runs are kept on disk, and every run a saved site lists
// (sites.js), so a built site can be found again. One run at a time on this server.
// A run builds a new site in plain HTML or one of the app stacks (stacks.js): an app stack starts from a fixed project pinned
// to the toolchain the server builds with, and its built site (dist/, out/, build/) is what the preview shows; the download is
// the whole project, built site included. Any other technology is written as source only: no preview, the download is the
// source, said to be unbuilt and untested. Changing an existing site comes next.
// Every build gets a design of its own: when the chosen direction was built before ("Build again"), a new direction is drawn
// (variety.js) and written (steps.js writeDirection) for the same pages and copy before the site is written.
// After the build, the owner changes its words without the agent on the same run (edit.js) and shares it with a link
// (publish.js); one such change at a time per run (lockRun).
// Cost (spend.js): a build is refused when the owner's day is used up, and may spend the build's limit or what is left of the
// day, whichever is less; its cost so far (a repeat build's new design included) is on the run while it works.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';
import { composeBuild } from './index.js';
import { prepareFonts } from './fonts.js';
import { runAgent } from './agent.js';
import { listFiles } from './workspace.js';
import { createLlm } from './llm.js';
import { writeDirection } from './steps.js';
import { claimBuild, planVariety, recordDesigns } from './variety.js';
import { keptRuns } from './sites.js';
import { placeImages } from './images.js';
import { BUILD_STACKS, buildStack, projectFile, stackUnavailable, writeScaffold } from './stacks.js';
import { issuePreviewToken, previewPath, resolvePreviewToken, revokePreviewToken } from '../recreate/previewTokens.js';
import { forgetPublished, publishedPath, publishedRunIds } from './publish.js';
import { BUILD_BUDGET, checkDailyBudget, costOf, leftToday, recordSpend, roundUsd } from './spend.js';

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
export const runDirOf = runDir;
export const siteDirOf = (/** @type {string} */ id) => path.join(runDir(id), 'site');

/** What can be built now; null when the request can, else the reason in the owner's words. */
export function unsupported(/** @type {any} */ request) {
  if (request?.input?.kind !== 'scratch') return 'Building is available for new sites for now; changing an existing site comes next.';
  if (!buildStack(request.stack)) return `Building is available in ${Object.values(BUILD_STACKS).filter((st) => !st.sourceOnly).map((st) => st.name).join(', ')}, or as source code in another technology.`;
  return null;
}

/** The stack a run was built with (runs from before stacks are plain HTML). */
export const stackOf = (/** @type {any} */ run) => buildStack(run.stack) ?? BUILD_STACKS.html;
/** The folder of a run's built site: what the preview shows and the checks read. */
export const builtDirOf = (/** @type {any} */ run) => path.join(siteDirOf(run.id), stackOf(run).out);
/** Whether a run has a built page to show and download. */
export const hasPages = async (/** @type {any} */ run) => !stackOf(run).sourceOnly && (await listFiles(builtDirOf(run))).includes('index.html');
/** Whether a run has something to download: its built site, or the source of a source-only project. */
export const hasDownload = async (/** @type {any} */ run) => (stackOf(run).sourceOnly
  ? (await listFiles(siteDirOf(run.id))).some((f) => projectFile(f) && f !== 'README.md')
  : hasPages(run));

/** A run as the API returns it (no internals). */
function view(/** @type {any} */ run) {
  const token = previews.get(run.id);
  return {
    id: run.id, status: run.status, stack: stackOf(run).id, stackName: run.stackName ?? null, sourceOnly: stackOf(run).sourceOnly, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
    activity: run.activity, files: run.files ?? [], turns: run.turns ?? 0, usage: run.usage ?? null, model: run.model ?? null,
    costUsd: run.costUsd ?? null, costLimitUsd: run.costLimitUsd ?? null,
    report: run.report ?? null, checks: run.checks ?? null, error: run.error ?? null, design: run.design ?? null,
    // A lasting address (routes/build.js GET /runs/:id/preview), not the preview token itself: tokens live in this server's
    // memory, so a link kept on an open page or in a list would die with the next restart.
    previewUrl: token ? `/api/build/runs/${run.id}/preview` : null,
    // Changes made after the build (edit.js) and the shared link (publish.js); outdated: changed since it was shared.
    revision: run.revision ?? 0, changedAt: run.changedAt ?? run.finishedAt ?? null, edits: (run.edits ?? []).slice(-20),
    published: run.published ? { url: publishedPath(run.published.slug), at: run.published.at, outdated: (run.published.revision ?? 0) !== (run.revision ?? 0) } : null,
  };
}
export const viewRun = view;

/** The preview address of a run's built site for its owner, opened again when this server has none (a restart); null when there is no site. */
export async function previewOf(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  if (!(await getBuild(id, ownerId))) return null;
  const run = runs.get(id);
  if (!(await hasPages(run))) return null;
  // A token this server no longer serves (revoked, or from before a restart) is replaced.
  if (!resolvePreviewToken(previews.get(id))) previews.delete(id);
  openPreview(run);
  return previewPath(/** @type {string} */ (previews.get(id)));
}

async function save(/** @type {any} */ run) {
  const { controller, ...stored } = run;
  await writeFile(path.join(runDir(run.id), 'run.json'), JSON.stringify(stored, null, 2));
}
export const saveRun = save;

/** The business name the owner gave (a fact of the plan), for the project's name. */
const businessName = (/** @type {any} */ request) => (request.understanding?.facts ?? []).map((/** @type {any} */ f) => /^Business name:\s*(.+)/i.exec(String(f))?.[1]).find(Boolean);

/** A change after the build (edit.js) keeps the files it changes here, and moves the built site of an app aside here. */
export const EDIT_JOURNAL = 'edit-journal.json';
export const EDIT_BACKUP = 'edit-backup';

/** A change after the build that a restart cut off: its files and its built site put back as they were before it. */
async function undoInterruptedEdit(/** @type {any} */ run) {
  const journal = await readFile(path.join(runDir(run.id), EDIT_JOURNAL), 'utf8').then(JSON.parse, () => null);
  if (!journal) return;
  const site = siteDirOf(run.id);
  for (const f of journal.files ?? []) {
    const file = path.resolve(site, String(f.rel));
    if (file.startsWith(site + path.sep) && typeof f.text === 'string') await writeFile(file, f.text);
  }
  if (typeof journal.out === 'string' && journal.out) {
    const backup = path.join(runDir(run.id), EDIT_BACKUP);
    if (await stat(backup).catch(() => null)) {
      await rm(path.join(site, journal.out), { recursive: true, force: true });
      await rename(backup, path.join(site, journal.out));
    }
  }
  await rm(path.join(runDir(run.id), EDIT_JOURNAL), { force: true });
}

/** Removes a run that is not running nor being changed, with its preview. */
async function remove(/** @type {string} */ id) {
  if (runs.get(id)?.status === 'running' || locked.has(id)) return false;
  const token = previews.get(id);
  if (token) revokePreviewToken(token);
  previews.delete(id);
  runs.delete(id);
  await forgetPublished(id);
  await rm(runDir(id), { recursive: true, force: true });
  return true;
}

/** The ids of the runs on disk, newest first. */
async function storedIds() {
  const ids = (await readdir(BUILDS_DIR).catch(() => [])).filter((d) => ID.test(d));
  const dated = await Promise.all(ids.map(async (id) => ({ id, t: (await stat(runDir(id)).catch(() => null))?.mtimeMs ?? 0 })));
  return dated.sort((a, b) => b.t - a.t).map((d) => d.id);
}

/** Keeps the newest RETAIN runs on disk, every run a saved site lists, and every run shared with a link. */
async function prune() {
  const kept = new Set([...await keptRuns(), ...await publishedRunIds()]);
  for (const id of (await storedIds()).slice(RETAIN)) {
    if (!kept.has(id)) await remove(id);
  }
}

/** The preview of a finished run's site: a token of the app's own preview route (sandboxed by header). */
function openPreview(/** @type {any} */ run) {
  // A framework that starts its pages with an inline script of its own (SvelteKit) gets that script allowed by its hash.
  if (!previews.has(run.id)) previews.set(run.id, issuePreviewToken({ root: builtDirOf(run), kind: 'copy', scripts: stackOf(run).inlineBoot ? 'inline' : true }));
}

/** The design a run shows: what the owner sees of a direction, and whether it was made for this build. */
const designOf = (/** @type {any} */ d, /** @type {boolean} */ fresh) => (d ? { name: d.name, palette: d.palette ?? [], fonts: d.fonts ?? {}, why: d.why ?? '', fresh } : null);

/**
 * A new direction for a repeat build, put in place of the chosen one; the prompt is composed again around it.
 * @param {any} request @param {any} deps @param {string | null} ownerId @param {any} run  its cost goes on the run
 */
async function redesign(request, deps, ownerId, run) {
  const llm = deps.llm ?? createLlm();
  const variety = await (deps.planVariety ?? planVariety)({ ownerId });
  const { direction, model, usage } = await writeDirection({ llm, understanding: request.understanding, brief: request.brief, description: request.description, variety });
  const cost = roundUsd(costOf(usage, model));
  run.costUsd = cost;
  await recordSpend(ownerId, cost);
  await (deps.recordDesigns ?? recordDesigns)({ directions: [direction], siteType: request.understanding?.site_type, ownerId }).catch(() => {});
  const index = request.direction ?? 0;
  const directions = [...(request.brief.design?.directions ?? [])];
  directions[index] = direction;
  return composeBuild({ ...request, brief: { ...request.brief, design: { ...request.brief.design, directions } }, direction: index }, deps);
}

/**
 * Starts a build from a confirmed plan.
 * @param {any} request  { input, stack?, stackName?, description, answers?, understanding, brief, direction? } as composeBuild takes it
 * @param {{ ownerId?: string | null, deps?: any, agent?: typeof runAgent, fonts?: typeof prepareFonts, images?: any[] }} [o]
 *   deps (also llm, planVariety, recordDesigns, claimBuild) / agent / fonts: tests; images: the owner's photos and logo of the
 *   saved site the build is made from (images.js resolveImages), copied into the project before the agent starts
 */
export async function startBuild(request, { ownerId = null, deps = {}, agent = runAgent, fonts = prepareFonts, images = [] } = {}) {
  const reason = unsupported(request);
  if (reason) throw new BuildError(reason, 422);
  const stack = /** @type {import('./stacks.js').BuildStack} */ (buildStack(request.stack));
  const unavailable = await stackUnavailable(stack);
  if (unavailable) throw new BuildError(unavailable, 422);
  if ([...runs.values()].some((r) => r.status === 'running')) throw new BuildError('Another site is being built on this server. Try again when it has finished.', 409);
  await checkDailyBudget(ownerId);
  const costLimitUsd = Math.min(BUILD_BUDGET.perBuildUsd, await leftToday(ownerId));
  // The prompt is composed here, from the plan: never taken from the client.
  let composed = await composeBuild(request, deps);
  // Decided before answering, so two clicks on "Build again" cannot both count as the first build.
  const repeat = await (deps.claimBuild ?? claimBuild)({ direction: composed.prompt.direction, ownerId }).catch(() => false);
  const id = randomUUID();
  const siteDir = siteDirOf(id);
  await mkdir(siteDir, { recursive: true });
  const run = {
    id, ownerId, status: 'running', stack: stack.id, ...(stack.sourceOnly && { stackName: composed.setup?.stackName ?? null }), startedAt: new Date().toISOString(), activity: [], files: [],
    controller: new AbortController(), plan: { description: request.description, summary: request.brief?.summary ?? '' },
    design: repeat ? null : designOf(composed.prompt.direction, false), costUsd: 0, costLimitUsd: roundUsd(costLimitUsd),
  };
  runs.set(id, run);
  // On disk from the start, so a server restart in the middle is reported instead of the build vanishing.
  await save(run).catch(() => {});
  const log = (/** @type {string} */ text) => {
    run.activity.push({ at: new Date().toISOString(), text });
    if (run.activity.length > MAX_ACTIVITY) run.activity.splice(0, run.activity.length - MAX_ACTIVITY);
  };

  /** @type {{ path: string }[]} the owner's images as placed in the project */
  let placed = [];
  (async () => {
    try {
      if (repeat) {
        log('This plan was built before: drawing a new design for this build');
        composed = await redesign(request, deps, ownerId, run);
        run.design = designOf(composed.prompt.direction, true);
        log(`New design: ${composed.prompt.direction?.name}`);
      }
      const direction = composed.prompt.direction;
      if (stack.toolchain) {
        log(`Setting up the ${stack.name} project`);
        await writeScaffold(stack, siteDir, { name: businessName(request) });
      }
      if (images.length) {
        log(`Adding your ${images.some((i) => i.role === 'logo') ? (images.length > 1 ? 'logo and photos' : 'logo') : 'photos'}`);
        placed = await placeImages(images, siteDir, stack);
      }
      log('Preparing the design\'s fonts');
      const madeFonts = direction ? await fonts([direction.fonts?.heading, direction.fonts?.body], path.join(siteDir, stack.publicDir)) : null;
      log('Writing the site');
      // The agent's dollars so far; each `usage` event adds the difference to the owner's day.
      const before = run.costUsd;
      let agentCost = 0;
      const out = await agent({
        prompt: composed.prompt,
        siteDir,
        stack,
        tmp: path.join(runDir(id), 'tmp'),
        fonts: madeFonts,
        images: placed,
        signal: run.controller.signal,
        limits: { usd: Math.max(0, costLimitUsd - before) },
        onEvent: (e) => {
          if (e.type === 'usage') {
            const added = (e.costUsd ?? 0) - agentCost;
            agentCost = e.costUsd ?? agentCost;
            Object.assign(run, { usage: e.usage, turns: e.turns, costUsd: roundUsd(before + agentCost) });
            recordSpend(ownerId, added).catch(() => {});
          } else if (e.type === 'file' && e.file && !run.files.includes(e.file)) run.files.push(e.file);
          else if (e.text && e.type !== 'note') log(e.text);
        },
      });
      Object.assign(run, { status: out.checks.ok ? 'done' : 'failed', report: out.report, checks: { ok: out.checks.ok, issues: out.checks.issues, pages: out.checks.pages }, turns: out.turns, usage: out.usage, model: out.model, costUsd: roundUsd(before + (out.costUsd ?? agentCost)) });
      if (!out.checks.ok) run.error = 'The site was written but does not pass every check yet. It is kept, so you can look at it.';
      if (await hasPages(run)) openPreview(run);
    } catch (err) {
      run.status = err?.code === 'stopped' ? 'stopped' : 'failed';
      run.error = err?.message ?? String(err);
      if (await hasPages(run)) openPreview(run);
    } finally {
      // The files the agent wrote: not the fonts and the owner's images put there for it, the fixed setup or the build's output.
      const given = new Set(placed.map((p) => p.path));
      run.files = (await listFiles(siteDir)).filter((f) => projectFile(f) && stack.writable(f) && !given.has(f) && !f.startsWith(stack.publicDir ? `${stack.publicDir}/fonts/` : 'fonts/') && !(stack.toolchain && f === 'README.md'));
      await rm(path.join(runDir(id), 'tmp'), { recursive: true, force: true }).catch(() => {});
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
    await undoInterruptedEdit(run).catch(() => {});
    if (await hasPages(run)) openPreview(run);
  }
  if (run.ownerId && run.ownerId !== ownerId) return null;
  return view(run);
}

/** A run as a list shows it: what it is, where it stands, and whether it can be seen and downloaded. */
const brief = (/** @type {any} */ v, /** @type {any} */ run) => ({
  id: v.id, status: v.status, startedAt: v.startedAt, finishedAt: v.finishedAt, design: v.design, previewUrl: v.previewUrl, error: v.error,
  publishedUrl: v.published?.url ?? null,
  summary: run.plan?.summary || run.plan?.description?.split('\n')[0] || '',
});

/** Whether a run is this owner's own (a list never shows another account's runs, nor runs made with accounts off). */
const ownRun = async (/** @type {string} */ id, /** @type {string | null} */ ownerId) => Boolean(await getBuild(id, ownerId)) && (runs.get(id)?.ownerId ?? null) === ownerId;

/** An owner's runs on disk, newest first, as a list shows them; `ids` limits it to those runs. */
export async function listBuilds(/** @type {string | null} */ ownerId = null, /** @type {string[] | null} */ ids = null) {
  const out = [];
  for (const id of ids ?? await storedIds()) {
    if (!(await ownRun(id, ownerId))) continue;
    const v = /** @type {any} */ (await getBuild(id, ownerId));
    out.push({ ...brief(v, runs.get(id)), sourceOnly: v.sourceOnly, downloadable: v.status !== 'running' && v.checks?.ok !== false && await hasDownload(runs.get(id)) });
  }
  return out;
}

/** Removes an owner's run that is not running; false when it is running or not theirs. */
export async function removeBuild(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  return (await ownRun(id, ownerId)) && remove(id);
}

/** Whether a site is being built on this server now. */
export const buildRunning = () => [...runs.values()].some((r) => r.status === 'running');

/**
 * The stored run of an owner (not a copy), or null: for the changes made after the build (edit.js, publish.js). Strictly
 * the owner's own, as a list shows it (a run made with accounts off is nobody's to change once accounts are on).
 */
export async function runRecord(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  return (await ownRun(id, ownerId)) ? runs.get(id) ?? null : null;
}

/** @type {Set<string>} the runs a change after the build is being made to */
const locked = new Set();
/**
 * Runs `work` with the run locked: one change at a time per run, and none while a site is being built (a rebuild and a
 * build share the toolchain; `duringBuild`: a change that builds nothing, such as sharing, may). The message says which.
 * @template T @param {string} id @param {() => Promise<T>} work @param {{ duringBuild?: boolean }} [o] @returns {Promise<T>}
 */
export async function lockRun(id, work, { duringBuild = false } = {}) {
  if (locked.has(id)) throw new BuildError('Another change to this site is being saved. Try again in a moment.', 409);
  if (!duringBuild && buildRunning()) throw new BuildError('A site is being built on this server. Try again when it has finished.', 409);
  locked.add(id);
  try {
    return await work();
  } finally {
    locked.delete(id);
  }
}

/** Stops a running build; false when it was not running. */
export function stopBuild(/** @type {string} */ id, /** @type {string | null} */ ownerId = null) {
  const run = runs.get(id);
  if (!run || run.status !== 'running' || (run.ownerId && run.ownerId !== ownerId)) return false;
  run.controller.abort();
  return true;
}
