// @ts-check
// Which jobs are alive. Jobs live in the memory of the process that runs them, so a row that says "running" proves nothing by
// itself: the process may have crashed, or it may be another server still at work on the same database. The process that runs
// a job writes `heartbeat_at` every HEARTBEAT_MS while the job is queued or running (jobs/manager.js); a row whose heartbeat is
// older than STALE_MS belongs to a process that is gone and is marked failed (adoptStaleJobs). A fresh heartbeat is left alone,
// whatever the row says, so a job alive elsewhere is never failed from outside and its workspace never adopted.
//
// The numbers: a heartbeat is one tiny SQLite write (WAL, well under a millisecond), so 15 s costs nothing and keeps the row
// fresh through the event-loop stalls an overloaded machine shows (freezes of 5–10 s were measured; the interrupts watcher counts
// sleep from 30 s). STALE_MS is 8 missed beats: longer than any stall a live process has shown, short enough that a job of a
// crashed server is picked up within ~2–4 minutes of the next start (the startup pass, then the watch every STALE_MS).
// Nothing here is a lock: one server per data folder is config/dataLock.js. This is the safety net under it (a process that
// bypassed the lock, a lock taken over wrongly), and what tells a restart which rows are really orphaned.
import { db } from '../db/index.js';

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 120_000;
export const JOB_TABLES = /** @type {const} */ (['analyses', 'recreates', 'reaudits']);
/** @typedef {typeof JOB_TABLES[number]} JobTable */

/** The error a job of a process that is gone is given (the app's copy.js knows this case as "restart"). */
export const STOPPED_MESSAGE = 'The server restarted while this job was running. Run it again.';

/** The ids of the jobs THIS process runs (jobs/manager.js adds and removes them): never judged by their heartbeat. */
export const ownJobs = new Set();

const beat = Object.fromEntries(JOB_TABLES.map((t) => [t, db.prepare(`UPDATE ${t} SET heartbeat_at = ? WHERE id = ?`)]));
const open = Object.fromEntries(
  JOB_TABLES.map((t) => [t, db.prepare(`SELECT id, project_id, status, heartbeat_at FROM ${t} WHERE status IN ('queued', 'running')`)]),
);
// The heartbeat read is part of the condition: a process that beat between the read and this write keeps its job.
const fail = Object.fromEntries(
  JOB_TABLES.map((t) => [
    t,
    db.prepare(
      `UPDATE ${t} SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ? AND status IN ('queued', 'running') AND COALESCE(heartbeat_at, '') = ?`,
    ),
  ]),
);

export const isoAt = (/** @type {number} */ ms) => new Date(ms).toISOString();

/** Writes the heartbeat of a job this process runs. @param {JobTable} table @param {string} id */
export function heartbeat(table, id, now = Date.now()) {
  beat[table].run(isoAt(now), id);
}

/** @param {string | null} heartbeatAt @param {number} now */
export const isStale = (heartbeatAt, now) => !heartbeatAt || !(Date.parse(heartbeatAt) > now - STALE_MS);

/**
 * Every queued or running row of every job table that is not this process's, split into the stale (process gone) and the
 * alive (another process, heartbeat fresh).
 * @param {{ now?: number, own?: Set<string> }} [o]
 */
export function openJobs({ now = Date.now(), own = ownJobs } = {}) {
  const stale = [];
  const alive = [];
  for (const table of JOB_TABLES) {
    for (const row of open[table].all()) {
      if (own.has(String(row.id))) continue;
      const entry = { table, id: String(row.id), projectId: String(row.project_id), status: String(row.status), heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at) };
      (isStale(entry.heartbeatAt, now) ? stale : alive).push(entry);
    }
  }
  return { stale, alive };
}

/**
 * Marks the jobs of processes that are gone as failed and says which recreates they were (the caller continues those where
 * they stopped, recreate/jobs.js). Jobs alive in another process are counted and left exactly as they are.
 * @param {{ now?: number, own?: Set<string> }} [o]
 * @returns {{ marked: ReturnType<typeof openJobs>['stale'], alive: ReturnType<typeof openJobs>['alive'], recreates: { id: string, project_id: string }[] }}
 */
export function adoptStaleJobs({ now = Date.now(), own = ownJobs } = {}) {
  const { stale, alive } = openJobs({ now, own });
  const marked = [];
  for (const job of stale) {
    const { changes } = fail[job.table].run(STOPPED_MESSAGE, isoAt(now), job.id, job.heartbeatAt ?? '');
    if (changes) marked.push(job);
  }
  return {
    marked,
    alive,
    recreates: marked.filter((j) => j.table === 'recreates').map((j) => ({ id: j.id, project_id: j.projectId })),
  };
}
