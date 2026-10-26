// @ts-check
// Which jobs are alive. Jobs live in the memory of the process that runs them, so a row that says "running" proves nothing by
// itself: the process may have crashed, or it may be another server still at work on the same database. The process that runs
// a job writes `heartbeat_at` every HEARTBEAT_MS while the job is queued or running (jobs/manager.js); a row whose heartbeat is
// older than STALE_MS belongs to a process that is gone: a running one is marked failed, a queued one that still has its payload
// goes back in line with the next server (manager.js requeueJobs, claimed here so two servers never both take it). A fresh
// heartbeat is left alone, whatever the row says, so a job alive elsewhere is never failed from outside and its workspace never
// adopted.
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
  JOB_TABLES.map((t) => [
    t,
    db.prepare(`SELECT id, project_id, status, started_at, heartbeat_at, payload_json FROM ${t} WHERE status IN ('queued', 'running') ORDER BY started_at`),
  ]),
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
// Taking a dead server's queued row over: the same conditional write, with a fresh heartbeat instead of a failure.
const claim = Object.fromEntries(
  JOB_TABLES.map((t) => [t, db.prepare(`UPDATE ${t} SET heartbeat_at = ? WHERE id = ? AND status = 'queued' AND COALESCE(heartbeat_at, '') = ?`)]),
);

export const isoAt = (/** @type {number} */ ms) => new Date(ms).toISOString();

/** Writes the heartbeat of a job this process runs. @param {JobTable} table @param {string} id */
export function heartbeat(table, id, now = Date.now()) {
  beat[table].run(isoAt(now), id);
}

/**
 * Makes a dead server's queued row this process's (its heartbeat becomes ours). False when another process took it first or
 * the row is no longer queued.
 * @param {JobTable} table @param {string} id @param {string | null} heartbeatAt  the value read
 */
export function claimQueued(table, id, heartbeatAt, now = Date.now()) {
  return claim[table].run(isoAt(now), id, heartbeatAt ?? '').changes === 1;
}

/** @param {string | null} heartbeatAt @param {number} now */
export const isStale = (heartbeatAt, now) => !heartbeatAt || !(Date.parse(heartbeatAt) > now - STALE_MS);

/**
 * @typedef {{ table: JobTable, id: string, projectId: string, status: string, startedAt: string, heartbeatAt: string | null, payloadJson: string | null }} OpenJob
 */

/**
 * Every queued or running row of every job table that is not this process's, split into the stale (process gone) and the
 * alive (another process, heartbeat fresh).
 * @param {{ now?: number, own?: Set<string> }} [o]
 * @returns {{ stale: OpenJob[], alive: OpenJob[] }}
 */
export function openJobs({ now = Date.now(), own = ownJobs } = {}) {
  const stale = [];
  const alive = [];
  for (const table of JOB_TABLES) {
    for (const row of open[table].all()) {
      if (own.has(String(row.id))) continue;
      const entry = {
        table,
        id: String(row.id),
        projectId: String(row.project_id),
        status: String(row.status),
        startedAt: String(row.started_at),
        heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
        payloadJson: row.payload_json == null ? null : String(row.payload_json),
      };
      (isStale(entry.heartbeatAt, now) ? stale : alive).push(entry);
    }
  }
  return { stale, alive };
}

/**
 * Sorts out the jobs of processes that are gone: a running one is marked failed (the caller continues the recreates among them
 * where they stopped, recreate/jobs.js); a queued one that kept its payload is handed back as `requeue` for the managers to put
 * in line again (manager.js requeueJobs, which claims each row); a queued one without a payload (an older server wrote it) is
 * marked failed too. Jobs alive in another process are counted and left exactly as they are.
 * @param {{ now?: number, own?: Set<string> }} [o]
 * @returns {{ marked: OpenJob[], alive: OpenJob[], requeue: OpenJob[], recreates: { id: string, project_id: string }[] }}
 */
export function adoptStaleJobs({ now = Date.now(), own = ownJobs } = {}) {
  const { stale, alive } = openJobs({ now, own });
  const marked = [];
  const requeue = [];
  for (const job of stale) {
    if (job.status === 'queued' && job.payloadJson) {
      requeue.push(job);
      continue;
    }
    const { changes } = fail[job.table].run(STOPPED_MESSAGE, isoAt(now), job.id, job.heartbeatAt ?? '');
    if (changes) marked.push(job);
  }
  return {
    marked,
    alive,
    requeue,
    recreates: marked.filter((j) => j.table === 'recreates' && j.status === 'running').map((j) => ({ id: j.id, project_id: j.projectId })),
  };
}

/** Marks a stale queued row no manager could take back (no manager of its kind in this process). @param {OpenJob} job */
export function failUnclaimed(job, now = Date.now()) {
  return fail[job.table].run(STOPPED_MESSAGE, isoAt(now), job.id, job.heartbeatAt ?? '').changes === 1;
}
