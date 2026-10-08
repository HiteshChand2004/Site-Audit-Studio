// Checkpoints of a Recreate job, so a job that fails or is interrupted (an error, the time limit, a server restart, a crash)
// continues where it stopped instead of starting over. General for any site: what is kept is the work of the job itself.
//
// The workspace (<recreateId>.tmp) holds checkpoint.json next to the files it describes:
//   discovery   the pages found (saved once, so a resume captures the same pages in the same order, with the same slugs)
//   pages       every page whose capture finished (by discovery index); its files are under capture/<slug>/
//   sweep       every page the sweep of the original at more widths finished (by slug); files under capture/<slug>/sweep/
//   steps       inspect / sweep / assets once finished: what the step put on the report and on the job context
//   stopped     when, at which step and why the job stopped (none = the server died while it ran)
// A resume (recreate/index.js) adopts the folder under its new job id, skips the finished steps (their results restored),
// captures only the missing pages and sweeps only the missing ones. Generate, build and what follows run again: they are
// local and quick next to the capture, and they keep their work in memory.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const CHECKPOINT_FILE = 'checkpoint.json';
// A stopped job's work is kept this long (and only the latest one per project: workspace.js pruneRecreates).
export const RESUMABLE_DAYS = 7;
// A job that stopped on its own (a server restart, the time limit) continues by itself at most this many times in a row.
export const MAX_AUTO_RESUMES = 2;
// The steps whose results are kept; the ones after them run again on a resume.
export const REUSABLE_STEPS = ['inspect', 'sweep', 'assets'];
// What each kept step leaves on the job context, and the report keys it sets (arrays it appends to are kept as appended).
const STEP_CTX = { inspect: ['pages', 'discovery', 'livePages'], sweep: ['sweep'], assets: ['assets'] };
const STEP_REPORT = { inspect: ['pages', 'motion', 'discovery', 'blockedHosts'], sweep: ['sweep'], assets: ['assets'] };
const APPENDED = ['warnings', 'manual', 'errors'];
const VERSION = 1;

export const checkpointPath = (dir) => path.join(dir, CHECKPOINT_FILE);

/** @returns {Promise<object|null>} the checkpoint of a workspace, null when there is none or it cannot be read */
export async function readCheckpoint(dir) {
  try {
    const data = JSON.parse(await readFile(checkpointPath(dir), 'utf8'));
    return data?.version === VERSION ? data : null;
  } catch {
    return null;
  }
}

export const hasCheckpoint = (dir) => existsSync(checkpointPath(dir));

/** Can a resume start from this checkpoint (the pages were found)? */
export const isReusable = (data) => Boolean(data?.discovery?.pages?.length);

/** The first step a resume runs. */
export function resumeStep(data) {
  if (!data?.steps?.inspect) return 'inspect';
  return REUSABLE_STEPS.find((k) => !data.steps[k]) ?? 'generate';
}

/** What the app shows for a stopped job: where it stopped and how much is kept. */
export function checkpointSummary(recreateId, data) {
  return {
    recreateId,
    step: resumeStep(data),
    stoppedStep: data.stopped?.step ?? null,
    pagesDone: Object.keys(data.pages ?? {}).length,
    pagesTotal: data.discovery?.pages?.length ?? 0,
    stoppedAt: data.stopped?.at ?? data.updatedAt ?? null,
    // restart = the server stopped while the job ran (nothing recorded the stop).
    reason: data.stopped?.reason ?? 'restart',
    message: data.stopped?.message ?? null,
  };
}

/**
 * The checkpoint of a running job. Every write replaces the file atomically (a job killed mid-write leaves the previous
 * version), one write at a time.
 * @param {string} dir  the job's workspace
 * @param {{ recreateId: string, analysisId?: string, saved?: object|null, auto?: boolean }} o  saved: the checkpoint resumed from
 */
export function openCheckpoint(dir, { recreateId, analysisId = null, saved = null, auto = false }) {
  const now = new Date().toISOString();
  const data = saved
    ? {
        ...saved,
        recreateId,
        // A manual "continue" allows the automatic ones again.
        autoResumes: auto ? (saved.autoResumes ?? 0) + 1 : 0,
        stopped: null,
        updatedAt: now,
      }
    : { version: VERSION, recreateId, analysisId, createdAt: now, updatedAt: now, autoResumes: 0, resumed: [], discovery: null, pages: {}, sweep: {}, steps: {}, stopped: null };
  data.pages ??= {};
  data.sweep ??= {};
  data.steps ??= {};
  data.resumed ??= [];
  let chain = Promise.resolve();
  // Did this run add anything (a page, a sweep page, a step)? A job that stopped without progress is not resumed by itself.
  let progressed = false;
  const save = () => {
    data.updatedAt = new Date().toISOString();
    const text = JSON.stringify(data);
    chain = chain
      .then(async () => {
        const tmp = `${checkpointPath(dir)}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, checkpointPath(dir));
      })
      .catch((err) => console.warn(`[recreate ${recreateId.slice(0, 8)}] checkpoint not written: ${err.message}`));
    return chain;
  };
  const mark = () => {
    progressed = true;
    return save();
  };

  return {
    data,
    save,
    flush: () => chain,
    get progressed() {
      return progressed;
    },
    reusable: () => isReusable(data),
    discovery: () => data.discovery ?? null,
    saveDiscovery: (discovery) => {
      data.discovery = discovery;
      return mark();
    },
    /** A finished page capture (discovery index i), when it is the same page. */
    page: (i, slug) => {
      const p = data.pages[i];
      return p && (!slug || p.slug === slug) ? p : null;
    },
    savePage: (i, page) => {
      data.pages[i] = page;
      return mark();
    },
    sweepPage: (slug) => data.sweep[slug] ?? null,
    saveSweepPage: (slug, result) => {
      data.sweep[slug] = result;
      return mark();
    },
    step: (key) => data.steps[key] ?? null,
    /** A kept step finished: its report keys and context fields (`before` = the report's array lengths when it started). */
    saveStep: (key, ctx, before) => {
      if (!STEP_CTX[key]) return null;
      const report = {};
      for (const k of STEP_REPORT[key]) if (ctx.report[k] !== undefined) report[k] = ctx.report[k];
      const appended = {};
      for (const k of APPENDED) appended[k] = (ctx.report[k] ?? []).slice(before?.[k] ?? 0);
      const fields = {};
      for (const k of STEP_CTX[key]) if (ctx[k] !== undefined) fields[k] = ctx[k];
      data.steps[key] = { at: new Date().toISOString(), report, appended, ctx: fields };
      return mark();
    },
    stop: ({ step, reason, message }) => {
      data.stopped = { at: new Date().toISOString(), step, reason, message, progressed };
      return save();
    },
  };
}

/** The report's array lengths before a step (see saveStep). */
export const reportMarks = (report) => Object.fromEntries(APPENDED.map((k) => [k, report[k]?.length ?? 0]));

/** Puts a kept step's results back on the job context and report; appended items already there are not added twice. */
export function restoreStep(ctx, saved) {
  Object.assign(ctx, saved.ctx ?? {});
  Object.assign(ctx.report, saved.report ?? {});
  for (const [k, items] of Object.entries(saved.appended ?? {})) {
    ctx.report[k] ??= [];
    const seen = new Set(ctx.report[k].map((x) => JSON.stringify(x)));
    for (const item of items) if (!seen.has(JSON.stringify(item))) ctx.report[k].push(item);
  }
}

/**
 * Before a resume runs: removes what the steps that run again would write (half-written by the stopped job), and the
 * capture folders of pages that did not finish (they are captured again).
 */
export async function clearUnfinished(dir, data) {
  for (const name of ['site', 'dist', 'dist.tmp', 'ir', 'fidelity', 'stacks', 'report.json']) {
    await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
  if (!data.steps?.assets) await rm(path.join(dir, 'assets'), { recursive: true, force: true }).catch(() => {});
  if (!data.steps?.inspect) {
    const done = new Set(Object.values(data.pages ?? {}).map((p) => p.slug));
    for (const p of data.discovery?.pages ?? []) {
      if (!done.has(p.slug)) await rm(path.join(dir, 'capture', p.slug), { recursive: true, force: true }).catch(() => {});
    }
  }
}
