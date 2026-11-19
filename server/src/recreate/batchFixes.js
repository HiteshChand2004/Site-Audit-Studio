// @ts-check
// "Apply the latest fixes" to every site of one account at once (user, 2026-11-19). Each site gets exactly the job its own button
// starts (POST …/recreate reuseAsIs: today's fixes on the saved lift, no capture, then the re-audit), started the ordinary way —
// never `system` — so the per-account limit, the server's slots and Lighthouse's one-at-a-time rule all still hold. The batch
// keeps as many sites going as the account has room for, less one slot left free for the person's own work (KEEP_FREE).
// It lives in memory: a server restart forgets the waiting sites (the running jobs resume by themselves, recreate/jobs.js).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { ConflictError, JobLimitError, activeJobsOfUser } from '../jobs/manager.js';
import { jobsPerUser } from '../jobs/limits.js';
import { analysisWarnings, latestAnalysis } from './inputs.js';
import { recreateJobs } from './jobs.js';
import { recreateDir } from './workspace.js';
import { isReadyStack } from './emit/index.js';
import { ASIS_DIR, ASIS_STACKS, readLifted } from './behavior/preserve/stage.js';

export const KEEP_FREE = 1;
export const TICK_MS = 5000;

/** How many more sites may start now: the account's limit, less its running or waiting jobs, less the slot kept free (none when the limit is 1). */
export const freeSlots = (limit, active) => Math.max(0, limit - active - (limit > 1 ? KEEP_FREE : 0));

const doneCopies = db.prepare(`SELECT id, result_json FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 20`);
const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const jobRow = db.prepare('SELECT status, error FROM recreates WHERE id = ?');

/** The job the site's own "Apply the latest fixes" button would start, by the route's rules, or why it cannot. */
export async function reuseAsIsJob(project) {
  if (!project.authorized) return { skip: 'not confirmed as authorized' };
  if (!isReadyStack(project.stack)) return { skip: 'its technology cannot be copied yet' };
  const analysis = latestAnalysis(project.id);
  if (!analysis) return { skip: 'never checked' };
  const row = doneCopies.all(project.id).find((r) => existsSync(path.join(recreateDir(project.id, r.id), ASIS_DIR, 'copy')));
  const lifted = row ? await readLifted(recreateDir(project.id, row.id)) : null;
  if (!row || !lifted) return { skip: 'no as-is copy to fix again' };
  const report = row.result_json ? JSON.parse(row.result_json) : null;
  const stack = report?.asIs?.stack ?? report?.stack ?? project.stack ?? 'html';
  if (!ASIS_STACKS.includes(stack)) return { skip: `its copy is packaged as ${stack}` };
  return { payload: { preserve: true, asIs: { stack, pages: lifted.pages.map((p) => p.url), from: row.id } }, warnings: analysisWarnings(analysis) };
}

/** One account's batch. `deps` only for tests. */
export function createBatch({ ownerId, projects, deps = {} }) {
  const d = {
    start: (p, payload, o) => recreateJobs.start(p, payload, o),
    running: (s) => recreateJobs.active(s.projectId)?.id === s.jobId,
    statusOf: (jobId) => jobRow.get(jobId) ?? null,
    activeCount: () => activeJobsOfUser(ownerId).filter((j) => !j.system).length,
    limit: () => jobsPerUser(),
    project: (id) => selectProject.get(id) ?? null,
    jobFor: reuseAsIsJob,
    tickMs: TICK_MS,
    ...deps,
  };
  const batch = { ownerId, startedAt: new Date().toISOString(), finishedAt: null, stopped: false,
    sites: projects.map((p) => ({ projectId: p.id, name: p.name, state: 'waiting', jobId: null, reason: null })) };
  let busy = false;
  const tick = async () => {
    if (busy || batch.finishedAt) return;
    busy = true;
    try {
      for (const s of batch.sites) {
        if (s.state !== 'running' || d.running(s)) continue;
        const row = d.statusOf(s.jobId);
        s.state = row?.status === 'done' ? 'done' : 'failed';
        s.reason = row?.status === 'done' ? null : (row?.error ?? 'the job ended without finishing');
      }
      let free = batch.stopped ? 0 : freeSlots(d.limit(), d.activeCount());
      for (const s of batch.sites) {
        if (free <= 0) break;
        if (s.state !== 'waiting') continue;
        const project = d.project(s.projectId);
        if (!project) { Object.assign(s, { state: 'skipped', reason: 'the site was removed' }); continue; }
        const plan = await d.jobFor(project);
        if (plan.skip) { Object.assign(s, { state: 'skipped', reason: plan.skip }); continue; }
        try {
          s.jobId = d.start(project, plan.payload, { warnings: plan.warnings }).id;
          s.state = 'running';
          free--;
        } catch (err) {
          if (err instanceof JobLimitError) break; // the account filled up meanwhile: next tick
          if (err instanceof ConflictError) continue; // this site already has a copy running: tried again next tick
          Object.assign(s, { state: 'failed', reason: err.message });
        }
      }
      const left = batch.sites.some((s) => s.state === 'running' || (!batch.stopped && s.state === 'waiting'));
      if (!left) { batch.finishedAt = new Date().toISOString(); clearInterval(timer); }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { tick().catch((err) => console.error('[batch-fixes]', err)); }, d.tickMs);
  timer.unref?.();
  return {
    batch,
    tick,
    /** Starts no more sites; running jobs finish on their own. */
    stop: () => {
      batch.stopped = true;
      for (const s of batch.sites) if (s.state === 'waiting') Object.assign(s, { state: 'not-started', reason: 'stopped' });
      return tick();
    },
  };
}

/** One batch per account (null = the local user). */
export const batches = new Map();
