// @ts-check
// How many jobs a server runs, per server and per account, how long one may take, and how much memory must be free before one
// starts. Every number is an env setting read at call time (tests set them), host-agnostic: a hosted deployment sizes them to
// its machine, a laptop keeps the defaults. One job (a capture with four browser contexts, Lighthouse twice) uses several GB;
// two at once took a 15 GB machine down, which is why the default is one.
//
//   SAS_MAX_JOBS          jobs that run at once on this server (1–8, default 1). The rest wait in line, first come first served
//                         (jobs/manager.js). Parallel Lighthouse runs also distort each other's numbers.
//   SAS_JOBS_PER_USER     jobs one account may have running or waiting at once (1–20, default 1). With accounts off there is one
//                         local user, so this is the whole queue's depth there; raise it to queue work on several sites.
//   SAS_JOB_MAX_MINUTES   the hard time limit of one job (1–1440, default 480; 0 = none). Every pipeline has its own budget first
//                         and ends itself: Analyze 6 min × SAS_TIMEOUT_SCALE (at most 30), Recreate 12 min (SAS_RECREATE_MINUTES
//                         at most 60) or, for every page of a site, limits that grow with the page count (about 7 min per page
//                         over all steps), an as-is copy 20 min per page + 10 per stack (recreate/index.js asIsBudgetMs), an
//                         exact-mode run none. This is the backstop above them, for a job whose own budget did not end it (a
//                         browser that hangs, a step that never returns, an exact run that was meant to take hours). 480 covers
//                         every fixed budget, an as-is copy of 23 pages and every real run recorded so far (the longest, an
//                         exact-mode copy of 12 pages, took hours, not days); a site larger than that needs the setting raised or
//                         0, and the job's error says so.
//   SAS_JOB_MIN_FREE_MB   free memory a job needs before it starts (0 = no check, default 2048). Below it the job stays in line,
//                         says why, and is looked at again every few seconds. 2 GB is what the pipeline's own rules add up to for
//                         one job (audit/resources.js: 150 MB per browser context × 4, 300 MB kept free for the machine, and 900 MB
//                         more before a second browser opens next to the first), with Lighthouse's own Chrome on top.
import { freeMemoryMB } from '../audit/resources.js';

/** @param {string | undefined} raw @param {{ min: number, max: number, def: number, integer?: boolean }} r */
function setting(raw, { min, max, def, integer = true }) {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) return def;
  return n;
}

export const maxJobs = (env = process.env) => setting(env.SAS_MAX_JOBS, { min: 1, max: 8, def: 1 });
export const jobsPerUser = (env = process.env) => setting(env.SAS_JOBS_PER_USER, { min: 1, max: 20, def: 1 });
/** The hard limit in milliseconds, 0 = none. Minutes, fractions allowed (tests use seconds). */
export const jobMaxMs = (env = process.env) => setting(env.SAS_JOB_MAX_MINUTES, { min: 0, max: 1440, def: 480, integer: false }) * 60000;
export const minFreeMB = (env = process.env) => setting(env.SAS_JOB_MIN_FREE_MB, { min: 0, max: 1048576, def: 2048 });

/** The memory reader the gate uses (tests replace `free`). macOS reports "unknown" as Infinity: never gated there. */
export const memory = { free: freeMemoryMB };

/** One line for the start-up log and GET /api/health. */
export function describeLimits(env = process.env) {
  const max = jobMaxMs(env);
  return {
    maxJobs: maxJobs(env),
    jobsPerUser: jobsPerUser(env),
    jobMaxMinutes: max ? max / 60000 : null,
    minFreeMB: minFreeMB(env) || null,
  };
}
