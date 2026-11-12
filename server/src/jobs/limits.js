// @ts-check
// How many jobs a server runs, per server and per account, and how long one may take. Every number is an env setting read at call time (tests set them), host-agnostic: a hosted deployment sizes them to
// its machine, a laptop keeps the defaults. One job (a capture with four browser contexts, Lighthouse twice) uses several GB;
// two at once took a 15 GB machine down, which is why the default is one.
//
//   SAS_MAX_JOBS          jobs that run at once on this server: a whole number 1–64 (default 1, also for anything unreadable),
//                         or `auto`: as many as the machine holds (jobs/capacity.js: CPUs, memory, container limits), at most
//                         AUTO_MAX_JOBS. Whatever the number, a job starts only when its reservation fits next to the running
//                         ones (jobs/manager.js); the rest wait in line. Lighthouse runs never overlap whatever this says
//                         (audit/lighthouse/run.js), because parallel runs distort each other's numbers.
//   SAS_JOBS_PER_USER     jobs one account may have running or waiting at once (1–20, default 1). With accounts off there is one
//                         local user, so this is the whole queue's depth there; raise it to queue work on several sites.
//   SAS_JOB_MAX_MINUTES   the hard time limit of one job (1–1440, default 240; 0 = none). Every pipeline has its own budget first
//                         and ends itself: Analyze 6 min × SAS_TIMEOUT_SCALE (at most 30), Recreate 12 min (SAS_RECREATE_MINUTES
//                         at most 60) or, for every page of a site, limits that grow with the page count (about 7 min per page
//                         over all steps), an as-is copy 20 min per page + 10 per stack (recreate/index.js asIsBudgetMs), an
//                         exact-mode run none. This is the backstop above them, for a job whose own budget did not end it (a
//                         browser that hangs, a step that never returns, an exact run that was meant to take hours). 240 covers
//                         every fixed budget, every real run recorded (the longest a clean copy of 30 pages, 146 min; an as-is
//                         copy of one page 17–22 min) and an as-is copy of up to 11 pages at its budget rate (11 × 20 + 10 = 230);
//                         with one job at a time (SAS_MAX_JOBS) it is also the longest anyone waits behind one job, which is why
//                         it is not higher (docs/HANDOFF.md, "Launch readiness"). A larger site needs the setting raised or 0,
//                         and the job's error says so.
//   SAS_JOB_MIN_FREE_MB   removed (2026-11-12): a job no longer waits for free memory before it starts. Only the room rule of
//                         jobs/manager.js (reservations against the machine's total) holds a job back. The setting is ignored.
import { freeMemoryMB } from '../audit/resources.js';

/** @param {string | undefined} raw @param {{ min: number, max: number, def: number, integer?: boolean }} r */
export function setting(raw, { min, max, def, integer = true }) {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) return def;
  return n;
}

/** The ceiling of SAS_MAX_JOBS=auto: a guard against a misread machine, not the expected number (capacity decides first). */
export const AUTO_MAX_JOBS = 16;
/** SAS_MAX_JOBS=auto: the machine decides how many jobs run at once. */
export const autoJobs = (env = process.env) => String(env.SAS_MAX_JOBS ?? '').trim().toLowerCase() === 'auto';
export const maxJobs = (env = process.env) => (autoJobs(env) ? AUTO_MAX_JOBS : setting(env.SAS_MAX_JOBS, { min: 1, max: 64, def: 1 }));
export const jobsPerUser = (env = process.env) => setting(env.SAS_JOBS_PER_USER, { min: 1, max: 20, def: 1 });
/** The hard limit in milliseconds, 0 = none. Minutes, fractions allowed (tests use seconds). */
export const jobMaxMs = (env = process.env) => setting(env.SAS_JOB_MAX_MINUTES, { min: 0, max: 1440, def: 240, integer: false }) * 60000;

/** The free-memory reader jobs/capacity.js uses for a running job's own share (tests replace `free`). macOS reports "unknown" as Infinity. */
export const memory = { free: freeMemoryMB };

/** One line for the start-up log and GET /api/health. */
export function describeLimits(env = process.env) {
  const max = jobMaxMs(env);
  return {
    maxJobs: maxJobs(env),
    ...(autoJobs(env) && { auto: true }),
    jobsPerUser: jobsPerUser(env),
    jobMaxMinutes: max ? max / 60000 : null,
  };
}
