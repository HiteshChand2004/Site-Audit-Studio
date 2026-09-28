// In-memory Analyze job manager. One job per project, one analysis running at a time
// (Chromium + Lighthouse are memory-heavy); the rest wait in a queue. State is mirrored to
// the `analyses` table and pushed to SSE subscribers as events on the job id.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { overallPct, runAnalysis, STEPS } from './index.js';

const insertRow = db.prepare(
  `INSERT INTO analyses (id, project_id, status, progress, started_at) VALUES (?, ?, 'queued', 0, ?)`,
);
const progressRow = db.prepare('UPDATE analyses SET status = ?, step = ?, progress = ? WHERE id = ?');
const finishRow = db.prepare(
  'UPDATE analyses SET status = ?, progress = ?, error = ?, finished_at = ?, result_json = ? WHERE id = ?',
);

const RETAIN_MS = 60000;
const DB_WRITE_INTERVAL = 1000;

export class ConflictError extends Error {
  constructor(job) {
    super('An analysis is already running for this project.');
    this.job = job;
  }
}

const snapshot = (job) => ({
  id: job.id,
  projectId: job.projectId,
  status: job.status,
  step: job.step,
  pct: job.pct,
  message: job.message,
  error: job.error,
  startedAt: job.startedAt,
});

class JobManager extends EventEmitter {
  #jobs = new Map();
  #queue = [];
  #running = false;

  constructor() {
    super();
    this.setMaxListeners(0);
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

  start(project, { maxPages }) {
    const existing = this.active(project.id);
    if (existing) throw new ConflictError(existing);
    const job = {
      id: randomUUID(),
      projectId: project.id,
      status: 'queued',
      step: null,
      pct: 0,
      message: this.#running ? 'Waiting for another analysis to finish…' : 'Starting…',
      error: null,
      startedAt: new Date().toISOString(),
    };
    this.#jobs.set(job.id, job);
    insertRow.run(job.id, project.id, job.startedAt);
    this.#queue.push({ job, project, maxPages });
    this.#pump();
    return snapshot(job);
  }

  #emit(job, type) {
    this.emit(job.id, type, snapshot(job));
  }

  async #pump() {
    if (this.#running || !this.#queue.length) return;
    this.#running = true;
    const next = this.#queue.shift();
    try {
      await this.#run(next);
    } finally {
      this.#running = false;
      this.#pump();
    }
  }

  async #run({ job, project, maxPages }) {
    job.status = 'running';
    let lastWrite = 0;
    let lastStep = null;

    const progress = (step, fraction, message) => {
      job.step = step;
      job.pct = Math.max(job.pct, overallPct(step, fraction));
      if (message) job.message = message;
      else if (step !== lastStep) job.message = STEPS.find((s) => s.key === step)?.label ?? step;
      const now = Date.now();
      if (step !== lastStep || now - lastWrite > DB_WRITE_INTERVAL) {
        progressRow.run(job.status, step, job.pct, job.id);
        lastWrite = now;
      }
      lastStep = step;
      this.#emit(job, 'progress');
    };

    try {
      const audit = await runAnalysis({ project, analysisId: job.id, maxPages, progress });
      job.status = 'done';
      job.pct = 100;
      job.message = 'Analysis complete';
      finishRow.run('done', 100, null, new Date().toISOString(), JSON.stringify(audit), job.id);
      this.#emit(job, 'done');
    } catch (err) {
      console.error(`[analyze ${job.id}]`, err);
      job.status = 'failed';
      job.error = err.message || 'Analysis failed.';
      finishRow.run('failed', job.pct, job.error, new Date().toISOString(), null, job.id);
      this.#emit(job, 'failed');
    }
    setTimeout(() => this.#jobs.delete(job.id), RETAIN_MS).unref();
  }
}

export const jobs = new JobManager();
