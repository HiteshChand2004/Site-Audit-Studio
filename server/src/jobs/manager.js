// In-memory background job manager shared by Analyze, Recreate and Re-audit. All drive Chromium and
// are memory-heavy, so one global lock runs a single job at a time across every kind; the rest wait
// in FIFO order. Each manager allows one active job per project, mirrors state to its table and
// pushes it to SSE subscribers as events on the job id.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { holdAwake, releaseAwake } from './keepAwake.js';

const RETAIN_MS = 60000;
const DB_WRITE_INTERVAL = 1000;

// Global lock: tasks run strictly one after another, in the order they were queued.
let tail = Promise.resolve();
let pending = 0;

export function exclusive(fn) {
  // The computer is kept awake while any job runs or waits (a laptop that sleeps mid-job stalls it into timeouts).
  if (pending++ === 0) holdAwake();
  const run = tail.then(fn).finally(() => {
    if (--pending === 0) releaseAwake();
  });
  tail = run.catch(() => {});
  return run;
}

/** True while any job (of any kind) is running or queued. */
export const lockBusy = () => pending > 0;

export class ConflictError extends Error {
  constructor(job, noun) {
    super(`${noun[0].toUpperCase()}${noun.slice(1)} is already running for this project.`);
    this.job = job;
  }
}

/**
 * Progress of a job whose steps may run side by side (Analyze renders, screenshots and reads robots.txt at once; Recreate
 * captures more widths while it downloads assets). Each step reports its own fraction; the job's percentage is the weighted
 * sum of all of them, and the step shown is the first one that has not finished, so the bar and the step list never jump back.
 * Steps without weights fall back to `overallPct` (one step at a time).
 * @param {{key:string, weight?:number}[]} steps
 * @param {(step:string, fraction:number)=>number} [overallPct]
 * @returns {(step:string, fraction:number)=>{ step:string, pct:number }}
 */
export function progressTracker(steps, overallPct) {
  const weighted = steps.length > 0 && steps.every((s) => Number.isFinite(s.weight));
  const total = weighted ? steps.reduce((n, s) => n + s.weight, 0) : 0;
  const fractions = new Map();
  return (step, fraction) => {
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    fractions.set(step, Math.max(fractions.get(step) ?? 0, f));
    // The first step of the list that has not finished, started or not: a step running ahead in the background (listed where
    // it is awaited) is never shown while a step before it is still to come, so the list never ticks a step and then unticks it.
    // Every step in the list reports (the jobs leave out the steps they skip from their lists, re-audit: screenshots).
    const current = steps.find((s) => (fractions.get(s.key) ?? 0) < 1)?.key ?? step;
    if (!weighted || !total) return { step: current, pct: overallPct ? overallPct(step, f) : 0 };
    const sum = steps.reduce((n, s) => n + s.weight * (fractions.get(s.key) ?? 0), 0);
    return { step: current, pct: Math.round((sum / total) * 100) };
  };
}

const snapshot = (job) => ({
  id: job.id,
  projectId: job.projectId,
  status: job.status,
  step: job.step,
  pct: job.pct,
  message: job.message,
  error: job.error,
  warnings: job.warnings,
  startedAt: job.startedAt,
});

export class JobManager extends EventEmitter {
  #jobs = new Map();
  #opts;
  #rows;

  /**
   * @param {object} o
   * @param {'analyses'|'recreates'|'reaudits'} o.table  rows: id, project_id, status, step, progress, error, started_at, finished_at, result_json
   * @param {string} o.noun  "an analysis", used in messages
   * @param {{key:string,label:string}[]} o.steps
   * @param {(step:string, fraction:number)=>number} o.overallPct
   * @param {(o:{job:object, project:object, payload:object, progress:Function})=>Promise<object>} o.run
   * @param {(o:{job:object, project:object, payload:object, ok:boolean})=>Promise<void>} [o.after]  cleanup after every job
   * @param {string} o.doneMessage
   */
  constructor(opts) {
    super();
    this.setMaxListeners(0);
    this.#opts = opts;
    this.#rows = {
      insert: db.prepare(`INSERT INTO ${opts.table} (id, project_id, status, progress, started_at) VALUES (?, ?, 'queued', 0, ?)`),
      progress: db.prepare(`UPDATE ${opts.table} SET status = ?, step = ?, progress = ? WHERE id = ?`),
      finish: db.prepare(
        `UPDATE ${opts.table} SET status = ?, progress = ?, error = ?, finished_at = ?, result_json = ? WHERE id = ?`,
      ),
    };
  }

  get(id) {
    const job = this.#jobs.get(id);
    return job ? snapshot(job) : null;
  }

  active(projectId) {
    for (const job of this.#jobs.values()) {
      if (job.projectId === projectId && (job.status === 'queued' || job.status === 'running')) return snapshot(job);
    }
    return null;
  }

  start(project, payload = {}, { warnings = [] } = {}) {
    const existing = this.active(project.id);
    if (existing) throw new ConflictError(existing, this.#opts.noun);
    const job = {
      id: randomUUID(),
      projectId: project.id,
      status: 'queued',
      step: null,
      pct: 0,
      message: lockBusy() ? 'Waiting for another job to finish…' : 'Starting…',
      error: null,
      warnings,
      startedAt: new Date().toISOString(),
    };
    this.#jobs.set(job.id, job);
    this.#rows.insert.run(job.id, project.id, job.startedAt);
    exclusive(() => this.#run(job, project, payload));
    return snapshot(job);
  }

  #emit(job, type) {
    this.emit(job.id, type, snapshot(job));
  }

  async #run(job, project, payload) {
    const { steps, overallPct, run, after, doneMessage } = this.#opts;
    job.status = 'running';
    let lastWrite = 0;
    let lastStep = null;

    const track = progressTracker(steps, overallPct);
    const progress = (reported, fraction, message) => {
      const { step, pct } = track(reported, fraction);
      job.step = step;
      job.pct = Math.max(job.pct, pct);
      // A step running next to the one shown reports its own messages; only the shown step's are displayed.
      if (message && reported === step) job.message = message;
      else if (step !== lastStep) job.message = steps.find((s) => s.key === step)?.label ?? step;
      const now = Date.now();
      if (step !== lastStep || now - lastWrite > DB_WRITE_INTERVAL) {
        this.#rows.progress.run(job.status, step, job.pct, job.id);
        lastWrite = now;
      }
      lastStep = step;
      this.#emit(job, 'progress');
    };

    let ok = false;
    try {
      const result = await run({ job, project, payload, progress });
      job.status = 'done';
      job.pct = 100;
      job.message = doneMessage;
      this.#rows.finish.run('done', 100, null, new Date().toISOString(), JSON.stringify(result), job.id);
      ok = true;
      this.#emit(job, 'done');
    } catch (err) {
      console.error(`[${this.#opts.table} ${job.id}]`, err);
      job.status = 'failed';
      job.error = err.message || 'The job failed.';
      this.#rows.finish.run('failed', job.pct, job.error, new Date().toISOString(), null, job.id);
      this.#emit(job, 'failed');
    }
    await after?.({ job, project, payload, ok }).catch((err) => console.error(`[${this.#opts.table} cleanup ${job.id}]`, err));
    setTimeout(() => this.#jobs.delete(job.id), RETAIN_MS).unref();
  }
}
