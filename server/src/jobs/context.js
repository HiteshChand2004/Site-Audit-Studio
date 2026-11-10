// @ts-check
// Which job the running code belongs to, so the work inside a job sizes itself from that job's own share of the machine rather
// than from the whole machine (audit/resources.js). The job line (jobs/manager.js) runs every job inside `runInJob` and installs
// the share provider; code outside a job (tests, scripts, a request handler) sees no job and keeps the whole-machine rules.
// No imports from the job line, so audit/resources.js can read it without a cycle.
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();
/** @type {null | ((job: object) => { freeMB: number, cpus: number } | null)} */
let provider = null;

/** Runs `fn` as the work of `job` (the line's record of it): everything it awaits or schedules belongs to that job. */
export const runInJob = (job, fn) => store.run(job, fn);

/** The line's record of the job this code runs for, or null outside a job. */
export const currentJob = () => store.getStore() ?? null;

/** The job line tells this module how to work out a job's share (jobs/manager.js). */
export function setShareProvider(fn) {
  provider = fn;
}

/**
 * The share of the machine the current job may plan with right now: memory (MB) and CPU threads. Null outside a job.
 * @returns {{ freeMB: number, cpus: number } | null}
 */
export function jobShare() {
  const job = currentJob();
  return job && provider ? provider(job) : null;
}

/** @type {null | ((job: object | null) => { otherJobs: number, otherKinds: string[], availableMB: number | null })} */
let loadProvider = null;

/** The job line tells this module how to describe what else runs right now (jobs/manager.js). */
export function setLoadProvider(fn) {
  loadProvider = fn;
}

/**
 * What else the job line runs right now, seen from the current job (or from outside any job): for a Lighthouse run to record
 * the conditions it was measured under. Null when no job line is loaded (a script, a test that never loads it).
 */
export function jobLoad() {
  return loadProvider ? loadProvider(currentJob()) : null;
}

/**
 * Registers `{ start(at), end() }` on the current job: told the moment the job starts waiting for something shared (the
 * Lighthouse lane), so a deadline can stop counting before it would fire, and when that wait ends. Returns "stop listening".
 */
export function onWaiting(listener) {
  const job = currentJob();
  if (!job) return () => {};
  (job.waitListeners ??= new Set()).add(listener);
  return () => job.waitListeners.delete(listener);
}

/** The current job starts waiting (not working); call the function it returns when the wait ends (once is enough, more is harmless). */
export function startWaiting() {
  const listeners = [...(currentJob()?.waitListeners ?? [])];
  if (!listeners.length) return () => {};
  const at = Date.now();
  for (const l of listeners) l.start(at);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    for (const l of listeners) l.end();
  };
}
