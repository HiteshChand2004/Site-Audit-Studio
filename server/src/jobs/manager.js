// In-memory background job manager shared by Analyze, Recreate and Re-audit. All drive Chromium and are memory-heavy, so one
// line of work serves every kind: at most SAS_MAX_JOBS run at once (default 1; `auto` = as many as the machine holds), and a
// job starts only when what it is counted with (jobs/capacity.js) fits next to the running jobs; the rest wait and are told why.
// The memory free at the moment is not a reason to wait (that check was removed, 2026-11-12). One account has at most
// SAS_JOBS_PER_USER jobs running or waiting,
// and a running job is stopped at SAS_JOB_MAX_MINUTES whatever its own budget says (jobs/limits.js). Each manager allows one
// active job per project, and jobs of different kinds on one website take turns; mirrors state to its table, keeps the row's
// heartbeat (jobs/liveness.js) and pushes state to SSE subscribers as events on the job id. A queued job of a server that died
// is put back in line, same row and same place, when the next server starts (requeueJobs).
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { holdAwake, releaseAwake } from './keepAwake.js';
import { meterJob } from './meter.js';
import { stripAnsi } from './ansi.js';
import { claimQueued, heartbeat, HEARTBEAT_MS, isoAt, ownJobs } from './liveness.js';
import { jobMaxMs, jobsPerUser, maxJobs } from './limits.js';
import { capacity, jobCpus, jobMB, KIND_OF_TABLE } from './capacity.js';
import { onWaiting, runInJob, setLoadProvider, setShareProvider } from './context.js';

const RETAIN_MS = 60000;
/** Why a job stopped while it waited in line ended (its row's error). */
const STOPPED_IN_LINE = 'Stopped before it started: it was stopped from the app while it waited in line. Nothing ran.';
/** A duration in words for a message: minutes when it is at least one, else seconds (tests run with limits of a few seconds). */
const humanMs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`);
const DB_WRITE_INTERVAL = 1000;

/** Waits the manager uses; tests shorten them. */
export const TIMING = {
  /** How long a job stopped at the hard limit may take to end by itself before its slot is given to the next job anyway. */
  hardStopGraceMs: 60000,
  /**
   * How long a job that just started is counted as not yet visible in the free-memory reading: its browsers are still opening,
   * so the reading taken a moment after its start says nothing about what it will use. Within this time its reservation is
   * taken off the reading another running job sizes its own work from (setShareProvider below).
   */
  rampMs: 90000,
};

// ---------------------------------------------------------------------------------------------------------------- the line
// One line for every kind of work. An entry is a function to run; the entries that are jobs also carry the job and its manager,
// so they can be told their place and be held back. Which entry is next: the one whose account has the fewest jobs running,
// oldest first among equals; an entry whose website already has a job running waits for it (jobs of one website take turns).
// When the next entry does not fit (not enough room), nothing behind it starts (a smaller job jumping ahead would starve a
// large one for ever).
//
// What a job is counted with (its reservation, jobs/capacity.js) is booked the moment it starts, before any of its browsers has
// opened, and freed the moment it ends.
const line = [];
/** What the running entries are counted with: { kind, mb, cpus, startedAt, projectId, ownerId, jobId }. */
const active = new Set();

/**
 * Runs `fn` when its turn comes. `meta`: { job, manager } for a job of a manager; { kind, projectId, ownerId } for other work
 * that opens browsers or runs a build (a stack export: held for room and memory like a job, not counted against an account);
 * nothing for work that only needs a turn (it reserves nothing and is never held for memory).
 */
export function exclusive(fn, meta = {}) {
  return new Promise((resolve, reject) => {
    // The computer is kept awake while any job runs or waits (a laptop that sleeps mid-job stalls it into timeouts).
    if (active.size + line.length === 0) holdAwake();
    const kind = meta.job ? (KIND_OF_TABLE[meta.manager?.table] ?? 'recreate') : (meta.kind ?? null);
    line.push({
      fn,
      resolve,
      reject,
      ...meta,
      kind,
      projectId: meta.job ? meta.job.projectId : (meta.projectId ?? null),
      ownerId: meta.job ? (meta.job.ownerId ?? null) : (meta.ownerId ?? null),
      mb: kind ? jobMB(kind) : 0,
      cpus: kind ? jobCpus() : 0,
    });
    schedule();
  });
}

/** True while any job (of any kind) is running or queued. */
export const lockBusy = () => active.size + line.length > 0;

/** For GET /api/health and the start-up log. */
export const queueState = () => ({ running: active.size, waiting: line.length, max: maxJobs() });

const sum = (items, key) => items.reduce((n, a) => n + a[key], 0);
/** Reservations of jobs started less than TIMING.rampMs ago (not yet visible in a reading), leaving out `except`. */
const rampingMB = (except = null, now = Date.now()) => sum([...active].filter((a) => a !== except && now - a.startedAt < TIMING.rampMs), 'mb');

/** The machine and what the running jobs are counted with, for GET /api/health. */
export function capacityState() {
  const cap = capacity.read();
  const running = [...active];
  return {
    cpus: cap.cpus,
    budgetMB: cap.budgetMB,
    availableMB: Number.isFinite(cap.availableMB) ? Math.round(cap.availableMB) : null,
    reservedMB: sum(running, 'mb'),
    reservedCpus: sum(running, 'cpus'),
    source: cap.source,
  };
}

// A job's own share of the machine (jobs/context.js → audit/resources.js): the memory really available now minus what jobs that
// just started will still take, never more than its own reservation; the CPU threads divided among the running jobs.
setShareProvider((job) => {
  if (!active.has(job)) return null;
  const cap = capacity.read();
  const jobs = [...active].filter((a) => a.kind).length || 1;
  return {
    freeMB: Math.max(0, Math.min(cap.availableMB - rampingMB(job), job.mb || Infinity)),
    cpus: Math.max(1, Math.floor(cap.cpus / jobs)),
  };
});

// What else runs right now, for a Lighthouse run to record the conditions it was measured under (audit/lighthouse/run.js):
// the other jobs (their kinds) and the memory available. Plain work without a kind (a lock taken for a moment) is not a job.
setLoadProvider((job) => {
  const others = [...active].filter((a) => a.kind && a !== job);
  const cap = capacity.read();
  return {
    otherJobs: others.length,
    otherKinds: [...new Set(others.map((a) => a.kind))].sort(),
    availableMB: Number.isFinite(cap.availableMB) ? Math.round(cap.availableMB) : null,
  };
});

function schedule() {
  for (const entry of line) entry.waitingFor = null;
  while (line.length && active.size < maxJobs()) {
    const i = nextIndex();
    if (i < 0) break; // everything waiting waits for its website's running job
    const head = line[i];
    if (!admits(head)) break;
    line.splice(i, 1);
    start(head);
  }
  announce();
}

/** The index of the entry whose turn it is, or -1 when every waiting entry's website has a job running. */
function nextIndex() {
  const running = [...active];
  const busySites = new Set(running.map((a) => a.projectId).filter(Boolean));
  const runningOf = (ownerId) => running.filter((a) => a.ownerId === ownerId).length;
  let best = -1;
  let fewest = Infinity;
  line.forEach((entry, i) => {
    if (entry.projectId && busySites.has(entry.projectId)) {
      entry.waitingFor = 'site';
      return;
    }
    const n = runningOf(entry.ownerId);
    if (n < fewest) {
      best = i;
      fewest = n;
    }
  });
  return best;
}

/**
 * Takes a waiting job out of the line before it ran (stopped while it waited): its promise is settled with a `notStarted`
 * error, the jobs behind it move up, and one that waited behind it for room may start now. False when the job is not
 * waiting (it runs, or has ended).
 */
function leaveLine(job, why) {
  const i = line.findIndex((entry) => entry.job === job);
  if (i < 0) return false;
  const [entry] = line.splice(i, 1);
  entry.reject(Object.assign(new Error(why), { notStarted: true }));
  if (active.size + line.length === 0) releaseAwake();
  schedule();
  return true;
}

function start(head) {
  const job = { kind: head.kind, mb: head.mb, cpus: head.cpus, startedAt: Date.now(), projectId: head.projectId, ownerId: head.ownerId, jobId: head.job?.id ?? null };
  active.add(job);
  Promise.resolve()
    .then(() => runInJob(job, head.fn))
    .then(head.resolve, head.reject)
    .finally(() => {
      active.delete(job);
      if (active.size + line.length === 0) releaseAwake();
      schedule();
    });
}

/**
 * Whether `entry` may start now. Work that reserves nothing only needs a turn. A job needs room: what the running jobs are
 * counted with plus its own fits the machine's memory budget and CPU threads (always true when nothing runs, so a small
 * machine still runs one job at a time). The memory free at this moment is not looked at (the SAS_JOB_MIN_FREE_MB check was
 * removed on 2026-11-12: on the hosted server it kept every second copy waiting).
 */
function admits(entry) {
  if (!entry.kind) return true;
  const cap = capacity.read();
  const running = [...active];
  if (running.length) {
    const mb = sum(running, 'mb') + entry.mb;
    const cpus = sum(running, 'cpus') + entry.cpus;
    if (mb > cap.budgetMB || cpus > cap.cpus) {
      entry.waitingFor = 'room';
      tell(entry, `Waiting for room: the ${running.length === 1 ? 'job' : `${running.length} jobs`} running now use what this server can hold. Starts when one of them finishes.`, {
        room: { reservedMB: mb - entry.mb, neededMB: entry.mb, budgetMB: cap.budgetMB, reservedCpus: cpus - entry.cpus, cpus: cap.cpus },
      });
      return false;
    }
  }
  return true;
}

/** Sets a waiting job's message and queue details, pushing them only when they changed. */
function tell(entry, text, extra) {
  const { job, manager } = entry;
  if (!job || job.message === text) return;
  job.message = text;
  job.queue = { ...(job.queue ?? { ahead: active.size, position: 1 }), ...extra };
  manager.emitState(job);
}

/** Tells every waiting job its place, in plain words, when it changed. */
function announce() {
  line.forEach((entry, i) => {
    if (!entry.job) return;
    if (entry.waitingFor === 'room') return; // its message says what it waits for
    if (entry.waitingFor === 'site') {
      tell(entry, 'Waiting for the other job on this website to finish.', { ahead: active.size + i, position: i + 1 });
      return;
    }
    const ahead = active.size + i;
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
      // Asked to stop from the app (stop() below) or by the hard limit. A job still waiting in line is not run at all: stop()
      // takes it out of the line and ends it there.
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
      // Taken out of the line before it ran (stopped while it waited, stop() below): the row says why. stop() has ended it
      // already; this only makes sure.
      if (err?.notStarted) this.#finish(job, 'failed', err.message);
    });
  }

  /**
   * Asks the project's running or queued job to stop. A running job is ended by its own run function (which keeps what it
   * can: a recreate saves its checkpoint, so the app can continue where it stopped). A job still waiting in line has done
   * nothing yet: it leaves the line and ends at once, so it never waits for a free slot just to stop (it held "Stopping…"
   * until one of the running jobs finished, which could take hours). Nothing of it is on disk; an earlier copy that can be
   * continued keeps its saved workspace (recreate/workspace.js findResumable passes over a failed row without one).
   * @returns {object|null} the job, or null when nothing is running for this project
   */
  stop(projectId) {
    for (const job of this.#jobs.values()) {
      if (job.projectId !== projectId || (job.status !== 'queued' && job.status !== 'running')) continue;
      job.stopping = true;
      job.controller.abort();
      if (job.status === 'queued' && leaveLine(job, STOPPED_IN_LINE)) {
        job.message = 'Stopped before it started.';
        this.#finish(job, 'failed', STOPPED_IN_LINE);
        return snapshot(job);
      }
      job.message = 'Stopping…';
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
    job.stopListening?.();
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
    // RAM / CPU of this job, per step (jobs/meter.js): null unless SAS_METER=1.
    const meter = meterJob(job, this.#opts.table);

    // The hard limit (jobs/limits.js): the job is asked to stop like from the app; what does not end by itself within the grace
    // period loses its slot anyway, so the next job in line starts, and the row says what happened. The pipeline's own
    // cleanup (browsers, checkpoint) runs when the stop reaches it; a run that never answers is logged when it finally ends.
    const limit = jobMaxMs();
    let forced = null;
    // Time spent waiting behind another job's Lighthouse run is not this job's work: while the job waits, the hard limit cannot
    // expire (it is held at the latest end the cap allows), and when the wait ends the limit moves later by the time waited. At
    // most the limit itself is given back in all (jobs/context.js startWaiting), so no job is ever held past twice its limit.
    let limitEndsAt = Date.now() + limit;
    let givenBack = 0;
    let waits = 0;
    let waitStart = 0;
    // What the wait in progress has earned so far, within what is left of the cap.
    const earning = () => (waits ? Math.min(Date.now() - waitStart, limit - givenBack) : 0);
    const outcome = await new Promise((resolve) => {
      forced = () => resolve({ ok: false, abandoned: true });
      const onLimit = () => {
        const credited = givenBack + earning();
        const waited = credited ? `, plus ${humanMs(credited)} spent waiting for Lighthouse` : '';
        job.hardStop = credited
          ? `Stopped after the time limit for one job (${humanMs(limit)}${waited}; SAS_JOB_MAX_MINUTES). What was finished is kept.`
          : `Stopped after ${humanMs(limit)}: the time limit for one job (SAS_JOB_MAX_MINUTES). What was finished is kept.`;
        job.message = `Stopping: the time limit for one job (${humanMs(limit)}${waited}) was reached.`;
        this.#emit(job, 'progress');
        job.controller.abort();
        job.graceTimer = setTimeout(() => {
          console.error(`[${this.#opts.table} ${job.id}] did not end ${TIMING.hardStopGraceMs / 1000} s after the hard limit; its slot is given to the next job.`);
          forced();
        }, TIMING.hardStopGraceMs);
        job.graceTimer.unref();
      };
      // While a wait is in progress the timer is held at the latest end the cap allows; otherwise at the current end.
      const arm = () => {
        clearTimeout(job.limitTimer);
        const end = waits ? limitEndsAt + (limit - givenBack) : limitEndsAt;
        job.limitTimer = setTimeout(onLimit, Math.max(0, end - Date.now()));
        job.limitTimer.unref();
      };
      if (limit) {
        arm();
        job.stopListening = onWaiting({
          start(at) {
            if (waits++ > 0) return; // already waiting: the first start counts
            waitStart = at;
            if (!job.hardStop && !job.finished) arm();
          },
          end() {
            if (waits === 0 || --waits > 0) return;
            if (job.hardStop || job.finished) return;
            const add = Math.min(Date.now() - waitStart, limit - givenBack);
            givenBack += add;
            limitEndsAt += add;
            arm();
          },
        });
      }
      run({ job, project, payload, progress, signal: job.controller.signal }).then(
        (result) => resolve({ ok: true, result }),
        (err) => resolve({ ok: false, err }),
      );
    });

    meter?.stop({ status: outcome.ok ? 'done' : 'failed' });
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
