// In-memory background job manager shared by Analyze, Recreate and Re-audit. All drive Chromium and are memory-heavy, so one
// line of work serves every kind: at most SAS_MAX_JOBS run at once (default 1), the rest wait first come first served and are
// told their place; a job starts only when enough memory is free (SAS_JOB_MIN_FREE_MB); one account has at most
// SAS_JOBS_PER_USER jobs running or waiting; and a running job is stopped at SAS_JOB_MAX_MINUTES whatever its own budget says
// (jobs/limits.js). Each manager allows one active job per project, mirrors state to its table, keeps the row's heartbeat
// (jobs/liveness.js) and pushes state to SSE subscribers as events on the job id. A queued job of a server that died is put back
// in line, same row and same place, when the next server starts (requeueJobs).
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { holdAwake, releaseAwake } from './keepAwake.js';
import { stripAnsi } from './ansi.js';
import { claimQueued, heartbeat, HEARTBEAT_MS, isoAt, ownJobs } from './liveness.js';
import { jobMaxMs, jobsPerUser, maxJobs, memory, minFreeMB } from './limits.js';

const RETAIN_MS = 60000;
/** A duration in words for a message: minutes when it is at least one, else seconds (tests run with limits of a few seconds). */
const humanMs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`);
const DB_WRITE_INTERVAL = 1000;

/** Waits the manager uses; tests shorten them. */
export const TIMING = {
  /** How often the memory gate looks again while the first job in line waits for memory. */
  memoryPollMs: 5000,
  /** How long a job stopped at the hard limit may take to end by itself before its slot is given to the next job anyway. */
  hardStopGraceMs: 60000,
};

// ---------------------------------------------------------------------------------------------------------------- the line
// One FIFO for every kind of work. An entry is a function to run; the entries that are jobs also carry the job and its manager,
// so they can be told their place and be held back for memory. Order is never changed: the first in line waits for memory with
// everything behind it (a smaller job jumping ahead would starve a large one for ever).
const line = [];
let running = 0;
let memoryTimer = null;
let lastFree = null;

export function exclusive(fn, meta = {}) {
  return new Promise((resolve, reject) => {
    // The computer is kept awake while any job runs or waits (a laptop that sleeps mid-job stalls it into timeouts).
    if (running + line.length === 0) holdAwake();
    line.push({ fn, resolve, reject, ...meta });
    schedule();
  });
}

/** True while any job (of any kind) is running or queued. */
export const lockBusy = () => running + line.length > 0;

/** For GET /api/health and the start-up log. */
export const queueState = () => ({ running, waiting: line.length, max: maxJobs(), ...(lastFree != null && { freeMB: Math.round(lastFree) }) });

function schedule() {
  while (running < maxJobs() && line.length) {
    const head = line[0];
    if (head.job && !memoryAllows(head)) break;
    line.shift();
    running++;
    Promise.resolve()
      .then(head.fn)
      .then(head.resolve, head.reject)
      .finally(() => {
        running--;
        if (running + line.length === 0) releaseAwake();
        schedule();
      });
  }
  announce();
}

/**
 * Whether the first job in line may start now: enough memory is free, or no check is configured. A job that waited for memory
 * longer than the hard limit is taken out of the line and fails with the reason (a leak elsewhere must not stall the queue for
 * ever with no one told).
 */
function memoryAllows(entry) {
  const need = minFreeMB();
  if (!need) return true;
  const free = memory.free();
  lastFree = free;
  if (!(free < need)) {
    entry.memoryWaitSince = null;
    return true;
  }
  const { job, manager } = entry;
  entry.memoryWaitSince ??= Date.now();
  const limit = jobMaxMs();
  if (limit && Date.now() - entry.memoryWaitSince > limit) {
    line.shift();
    entry.reject(Object.assign(new Error(`Not started: the server had less than ${need} MB of memory free for ${humanMs(limit)} (${Math.round(free)} MB free now; SAS_JOB_MIN_FREE_MB).`), { notStarted: true }));
    if (running + line.length === 0) releaseAwake();
    setImmediate(schedule); // the next in line is looked at on its own pass
    return false;
  }
  const text = `Waiting for memory: ${Math.round(free)} MB free, ${need} MB needed before a job may start. Looked at again in a few seconds.`;
  if (job.message !== text) {
    job.message = text;
    job.queue = { ...(job.queue ?? { ahead: running, position: 1 }), memory: { freeMB: Math.round(free), neededMB: need } };
    manager.emitState(job);
  }
  if (!memoryTimer) {
    memoryTimer = setTimeout(() => {
      memoryTimer = null;
      schedule();
    }, TIMING.memoryPollMs);
    memoryTimer.unref();
  }
  return false;
}

/** Tells every waiting job its place, in plain words, when it changed. */
function announce() {
  line.forEach((entry, i) => {
    if (!entry.job) return;
    const ahead = running + i;
    if (i === 0 && entry.memoryWaitSince) return; // its message says what it waits for
    const text = ahead === 0
      ? 'Starting…'
      : ahead === 1
        ? 'Next in line: starts when the job before it finishes.'
        : `Waiting in line: ${ahead} jobs run or wait before this one.`;
    const queue = { ahead, position: i + 1 };
    if (entry.job.message === text && entry.job.queue?.ahead === ahead) return;
    entry.job.message = text;
    entry.job.queue = queue;
    entry.manager.emitState(entry.job);
  });
}

// --------------------------------------------------------------------------------------------------------------- errors

export class ConflictError extends Error {
  constructor(job, noun) {
    super(`${noun[0].toUpperCase()}${noun.slice(1)} is already running for this project.`);
    this.job = job;
  }
}

/** One account has its SAS_JOBS_PER_USER jobs already (running or waiting). `job`: one of them. */
export class JobLimitError extends Error {
  constructor(job, limit) {
    super(
      limit === 1
        ? 'You already have a job running or waiting. Wait for it to finish, or stop it first: one job per account at a time.'
        : `You already have ${limit} jobs running or waiting, the most one account may have at a time. Wait for one to finish, or stop one.`,
    );
    this.job = job;
    this.limit = limit;
  }
}

// ---------------------------------------------------------------------------------------------------------- progress
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
  // Where the job stands in line while it is queued: { ahead, position, memory? } (ahead = jobs running or waiting before it).
  ...(job.status === 'queued' && job.queue && { queue: job.queue }),
});

/** Every manager by its table: the per-account count looks across kinds, and a restart puts queued rows back with their manager. */
const managers = new Map();
const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');

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
   * @param {(o:{job:object, project:object, payload:object, progress:Function, signal:AbortSignal})=>Promise<object>} o.run
   * @param {(o:{job:object, project:object, payload:object, ok:boolean})=>Promise<void>} [o.after]  cleanup after every job
   * @param {string} o.doneMessage
   * @param {number} [o.heartbeatMs]  how often the row's heartbeat is written while the job is queued or running (tests shorten it)
   */
  constructor(opts) {
    super();
    this.setMaxListeners(0);
    this.#opts = opts;
    this.#rows = {
      // The heartbeat starts with the row: a queued job is alive too (its process waits for the lock), and a row with no
      // heartbeat at all is one an older server wrote (jobs/liveness.js treats it as stale). The payload is kept so a queued
      // job of a server that died can be put back in line by the next one (requeue).
      insert: db.prepare(`INSERT INTO ${opts.table} (id, project_id, status, progress, started_at, heartbeat_at, payload_json) VALUES (?, ?, 'queued', 0, ?, ?, ?)`),
      progress: db.prepare(`UPDATE ${opts.table} SET status = ?, step = ?, progress = ? WHERE id = ?`),
      finish: db.prepare(
        `UPDATE ${opts.table} SET status = ?, progress = ?, error = ?, finished_at = ?, result_json = ? WHERE id = ?`,
      ),
    };
    managers.set(opts.table, this);
  }

  get table() {
    return this.#opts.table;
  }

  get(id) {
    const job = this.#jobs.get(id);
    return job ? snapshot(job) : null;
  }

  /** The account that owns the job's project when it started (null: accounts off, or a project with no owner). */
  ownerOf(id) {
    return this.#jobs.get(id)?.ownerId ?? null;
  }

  active(projectId) {
    for (const job of this.#jobs.values()) {
      if (job.projectId === projectId && (job.status === 'queued' || job.status === 'running')) return snapshot(job);
    }
    return null;
  }

  /** This manager's running or queued jobs of one account (null = the local user when accounts are off), with `system`. */
  activeOfUser(ownerId) {
    const out = [];
    for (const job of this.#jobs.values()) {
      if ((job.ownerId ?? null) === (ownerId ?? null) && (job.status === 'queued' || job.status === 'running')) out.push({ ...snapshot(job), system: job.system });
    }
    return out;
  }

  /**
   * @param {object} project
   * @param {object} [payload]
   * @param {{ warnings?: string[], system?: boolean }} [o]  system: a job the server starts for itself (a resume after a restart,
   *   the re-audit after a copy); it is not held against the account's own count, and it is not what a person is waiting on.
   */
  start(project, payload = {}, { warnings = [], system = false } = {}) {
    const existing = this.active(project.id);
    if (existing) throw new ConflictError(existing, this.#opts.noun);
    // Whose job it is comes from the project row, never from a session: a job the server starts by itself (an auto-resume
    // after a restart, a queued export or re-audit) has no signed-in user. Not part of the snapshot the app is sent.
    const ownerId = project.owner_id ?? null;
    if (!system) {
      const limit = jobsPerUser();
      const mine = activeJobsOfUser(ownerId).filter((j) => !j.system);
      if (mine.length >= limit) throw new JobLimitError(mine[0], limit);
    }
    const job = this.#job({ id: randomUUID(), projectId: project.id, ownerId, startedAt: new Date().toISOString(), payload, warnings, system });
    this.#rows.insert.run(job.id, project.id, job.startedAt, isoAt(Date.now()), JSON.stringify({ payload, warnings, system }));
    this.#enqueue(job, project, payload);
    return snapshot(job);
  }

  /**
   * Puts a queued row of a server that died back in line: same id, same place (the caller passes rows oldest first), the row
   * claimed by its heartbeat so two servers can never both take it (jobs/liveness.js claimQueued).
   * @returns {object|null} the job snapshot, or null when the row was taken meanwhile, has no payload, or its project is gone
   */
  requeue(row) {
    let saved;
    try {
      saved = JSON.parse(row.payload_json ?? 'null');
    } catch {
      saved = null;
    }
    if (!saved?.payload) return null;
    if (!claimQueued(this.#opts.table, row.id, row.heartbeat_at ?? null)) return null;
    const project = selectProject.get(row.project_id);
    if (!project?.authorized) {
      this.#rows.finish.run('failed', 0, 'The project of this job is no longer there.', isoAt(Date.now()), null, row.id);
      return null;
    }
    const job = this.#job({ id: row.id, projectId: row.project_id, ownerId: project.owner_id ?? null, startedAt: row.started_at, payload: saved.payload, warnings: saved.warnings ?? [], system: saved.system ?? false });
    job.requeued = true;
    this.#enqueue(job, project, saved.payload);
    return snapshot(job);
  }

  #job({ id, projectId, ownerId, startedAt, payload, warnings, system }) {
    return {
      id,
      projectId,
      ownerId,
      system,
      payload,
      status: 'queued',
      step: null,
      pct: 0,
      message: 'Starting…',
      error: null,
      warnings,
      startedAt,
      queue: null,
      // Asked to stop from the app (stop() below) or by the hard limit. A job that has not started yet sees it as soon as it does.
      controller: new AbortController(),
    };
  }

  #enqueue(job, project, payload) {
    this.#jobs.set(job.id, job);
    // Alive, as far as any other process can tell: the heartbeat runs from the moment the row exists until the job has ended,
    // through the wait for the lock included (jobs/liveness.js).
    ownJobs.add(job.id);
    const table = this.#opts.table;
    job.beat = setInterval(() => {
      try {
        heartbeat(table, job.id);
      } catch (err) {
        console.warn(`[${table} ${job.id}] heartbeat not written: ${err.message}`);
      }
    }, this.#opts.heartbeatMs ?? HEARTBEAT_MS);
    job.beat.unref();
    exclusive(() => this.#run(job, project, payload), { job, manager: this }).catch((err) => {
      // Taken out of the line before it ran (the memory wait outlasted the hard limit): the row says why.
      if (err?.notStarted) this.#finish(job, 'failed', err.message);
    });
  }

  /**
   * Asks the project's running or queued job to stop. The job's own run function ends it (and keeps what it can:
   * a recreate saves its checkpoint, so the app can continue where it stopped).
   * @returns {object|null} the job, or null when nothing is running for this project
   */
  stop(projectId) {
    for (const job of this.#jobs.values()) {
      if (job.projectId !== projectId || (job.status !== 'queued' && job.status !== 'running')) continue;
      job.stopping = true;
      job.message = 'Stopping…';
      job.controller.abort();
      this.#emit(job, 'progress');
      return snapshot(job);
    }
    return null;
  }

  /** Pushes the job's state to its subscribers (the line uses it for a waiting job's place). */
  emitState(job) {
    this.#emit(job, 'progress');
  }

  #emit(job, type) {
    this.emit(job.id, type, snapshot(job));
  }

  /** Ends the job in memory and in its row, once; the heartbeat stops with it. */
  #finish(job, status, error, result = null) {
    if (job.finished) return false;
    job.finished = true;
    clearInterval(job.beat);
    clearTimeout(job.limitTimer);
    clearTimeout(job.graceTimer);
    ownJobs.delete(job.id);
    job.status = status;
    if (status === 'done') {
      job.pct = 100;
      job.message = this.#opts.doneMessage;
      this.#rows.finish.run('done', 100, null, isoAt(Date.now()), JSON.stringify(result), job.id);
    } else {
      job.error = error;
      this.#rows.finish.run('failed', job.pct, error, isoAt(Date.now()), null, job.id);
    }
    this.#emit(job, status);
    setTimeout(() => this.#jobs.delete(job.id), RETAIN_MS).unref();
    return true;
  }

  async #run(job, project, payload) {
    const { steps, overallPct, run, after } = this.#opts;
    if (job.finished) return; // closed while it waited (defensive: the line rejects such an entry instead of running it)
    job.status = 'running';
    job.queue = null;
    let lastWrite = 0;
    let lastStep = null;

    const track = progressTracker(steps, overallPct);
    const progress = (reported, fraction, message) => {
      if (job.finished) return;
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
    this.#rows.progress.run('running', null, 0, job.id);
    this.#emit(job, 'progress');

    // The hard limit (jobs/limits.js): the job is asked to stop like from the app; what does not end by itself within the grace
    // period loses its slot anyway, so the next job in line starts, and the row says what happened. The pipeline's own
    // cleanup (browsers, checkpoint) runs when the stop reaches it; a run that never answers is logged when it finally ends.
    const limit = jobMaxMs();
    let forced = null;
    const outcome = await new Promise((resolve) => {
      forced = () => resolve({ ok: false, abandoned: true });
      if (limit) {
        job.limitTimer = setTimeout(() => {
          job.hardStop = `Stopped after ${humanMs(limit)}: the time limit for one job (SAS_JOB_MAX_MINUTES). What was finished is kept.`;
          job.message = `Stopping: the time limit for one job (${humanMs(limit)}) was reached.`;
          this.#emit(job, 'progress');
          job.controller.abort();
          job.graceTimer = setTimeout(() => {
            console.error(`[${this.#opts.table} ${job.id}] did not end ${TIMING.hardStopGraceMs / 1000} s after the hard limit; its slot is given to the next job.`);
            forced();
          }, TIMING.hardStopGraceMs);
          job.graceTimer.unref();
        }, limit);
        job.limitTimer.unref();
      }
      run({ job, project, payload, progress, signal: job.controller.signal }).then(
        (result) => resolve({ ok: true, result }),
        (err) => resolve({ ok: false, err }),
      );
    });

    let ok = false;
    if (outcome.abandoned) {
      this.#finish(job, 'failed', job.hardStop);
    } else if (job.finished) {
      // Already closed (its slot was given away); the late outcome is logged only.
      console.warn(`[${this.#opts.table} ${job.id}] ended ${outcome.ok ? 'without error' : `with "${stripAnsi(outcome.err?.message ?? '')}"`} after its slot was given away.`);
      return;
    } else if (outcome.ok) {
      this.#finish(job, 'done', null, outcome.result);
      ok = true;
    } else {
      console.error(`[${this.#opts.table} ${job.id}]`, outcome.err);
      this.#finish(job, 'failed', job.hardStop ?? (stripAnsi(outcome.err.message) || 'The job failed.'));
    }
    await after?.({ job, project, payload, ok }).catch((err) => console.error(`[${this.#opts.table} cleanup ${job.id}]`, err));
  }
}

/** Running or queued jobs of one account across every manager, oldest first (each with `kind` = its table and `system`). */
export function activeJobsOfUser(ownerId) {
  const out = [];
  for (const manager of managers.values()) {
    for (const job of manager.activeOfUser(ownerId)) out.push({ ...job, kind: manager.table });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Puts queued rows of a dead server back in line, oldest first, each with the manager of its table. Rows a manager has not
 * registered for (none in the server; a test without that manager) are left for the stale-job pass to mark failed.
 * @param {{ table: string, id: string, project_id?: string, projectId?: string, started_at?: string, startedAt?: string, heartbeat_at?: string|null, payload_json?: string|null }[]} rows
 * @returns {{ requeued: object[], left: object[] }}
 */
export function requeueJobs(rows) {
  const requeued = [];
  const left = [];
  const sorted = [...rows].sort((a, b) => String(a.started_at ?? a.startedAt ?? '').localeCompare(String(b.started_at ?? b.startedAt ?? '')));
  for (const row of sorted) {
    const manager = managers.get(row.table);
    const normalised = { ...row, project_id: row.project_id ?? row.projectId, started_at: row.started_at ?? row.startedAt, heartbeat_at: row.heartbeat_at ?? row.heartbeatAt ?? null, payload_json: row.payload_json ?? row.payloadJson ?? null };
    const job = manager?.requeue(normalised) ?? null;
    (job ? requeued : left).push(job ?? row);
  }
  return { requeued, left };
}

/** The managers that exist in this process, by table (tests). */
export const registeredManagers = () => new Map(managers);
