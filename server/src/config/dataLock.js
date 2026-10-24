// @ts-check
// One server per data folder. Two servers on one `app.db` would each run jobs the other knows nothing about, prune each other's
// recreate folders and fight over previews, so the server takes `<DATA_DIR>/server.lock` before it touches a job row, and a
// second server pointed at the same folder refuses to start and says who holds it. Only the server takes the lock (src/index.js
// holdDataLock): a script that opens the database to read it, the migration tools and the tests never do.
//
// The file names the holder: a random INSTANCE id made when this process started (what "ours" means when the lock is touched
// or released; a pid is not an identity: a container gets the same pid, often 1, after every restart), its pid, its host, and
// is touched every LOCK_REFRESH_MS while the server runs. Whether a lock another process left is still held:
//   - It names our own pid: it cannot be ours (we have not written one yet), so it was left by a process that is gone and got
//     the pid again (a restarted container), or by this process's earlier attempt. Taken over at once.
//   - Same host, another pid: held while that pid is alive. A process killed with no chance to clean up (power loss, kill -9,
//     TerminateProcess) leaves the file behind, its pid is gone, and the next start takes the lock over. A reused pid is the
//     one blind spot here; the refusal message names the pid, so the person can tell it is not a server, and says what to delete.
//   - Another host (a shared disk, or a container that was replaced and got a new hostname): no pid can be asked, so the file's
//     age decides — a lock not touched for LOCK_STALE_MS is a dead server's. A restarted container therefore waits at most
//     LOCK_STALE_MS for its predecessor's lock, and the message says so (a restart policy that starts it again gets through).
// Creation is atomic (`wx`: the file must not exist), so two servers starting at the same moment cannot both win.
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const LOCK_NAME = 'server.lock';
/** How often the holder touches the file; the same cadence as the job heartbeat (jobs/liveness.js HEARTBEAT_MS). */
export const LOCK_REFRESH_MS = 15_000;
/** A lock from another host not touched for this long is a dead server's (jobs/liveness.js STALE_MS: the same reasoning). */
export const LOCK_STALE_MS = 120_000;
/** This process, for the lock's purposes: unique per start, unlike its pid or its host. */
export const INSTANCE_ID = randomUUID();

/** @param {string} [dir] */
export const lockFile = (dir = DATA_DIR) => path.join(dir, LOCK_NAME);

/**
 * @typedef {{ instance: string, pid: number, host: string, startedAt: string, port?: number }} LockInfo
 * @typedef {{ ok: true, file: string, info: LockInfo, refresh: () => boolean, release: () => boolean }} Held
 * @typedef {{ ok: false, file: string, holder: LockInfo, message: string }} Refused
 */

/** The lock file's content, or null when it is unreadable or not what this module writes (then it is stale by definition). */
export function readLock(/** @type {string} */ file) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    return info && Number.isInteger(info.pid) && typeof info.host === 'string' ? /** @type {LockInfo} */ (info) : null;
  } catch {
    return null;
  }
}

/** Whether a process with this id exists on this machine (a permission error means it does, it is just not ours). */
export function processAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/** Milliseconds since the lock file was last touched, or null when it is gone. @param {string} file @param {number} now */
export function lockAge(file, now) {
  try {
    return now - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether the lock another process wrote is still held (see the rules at the top).
 * @param {LockInfo | null} info
 * @param {string} file
 * @param {{ now?: number, hostname?: string, pid?: number, instance?: string }} [o]
 */
export function lockHeld(info, file, { now = Date.now(), hostname = os.hostname(), pid = process.pid, instance = INSTANCE_ID } = {}) {
  if (!info) return false;
  if (info.instance === instance) return false; // our own, left from an earlier attempt in this process
  if (info.pid === pid) return false; // cannot be a live process: that pid is us (a restarted container got its pid again)
  if (info.host === hostname) return processAlive(info.pid);
  const age = lockAge(file, now);
  return age != null && age < LOCK_STALE_MS;
}

/**
 * The refusal, in words that say what to do.
 * @param {LockInfo} holder @param {string} dir @param {string} file
 * @param {{ now?: number, hostname?: string }} [o]
 */
export function refusalMessage(holder, dir, file, { now = Date.now(), hostname = os.hostname() } = {}) {
  const where = `process ${holder.pid} on ${holder.host}${holder.port ? `, port ${holder.port}` : ''}, started ${holder.startedAt}`;
  let text = `Another server is already using the data folder ${dir} (${where}). Stop it first, or give this server its own folder with SAS_DATA_DIR. `;
  if (holder.host !== hostname) {
    // No pid of another host can be asked: the lock stands until it has gone untouched for LOCK_STALE_MS.
    const left = Math.max(1, Math.ceil((LOCK_STALE_MS - (lockAge(file, now) ?? 0)) / 1000));
    text +=
      `That host is not this one, so whether its server still runs cannot be checked here: if it is gone (a container that was ` +
      `replaced, a machine that went down), its lock expires ${left} s from now (${LOCK_STALE_MS / 1000} s after it was last touched) ` +
      `and the next start gets through; to start now, delete ${file}.`;
  } else {
    text += `If no server is running there (the lock was left by a process that is gone), delete ${file} and start again.`;
  }
  return text;
}

/**
 * Takes the data folder's lock for this process, or says who holds it. Never throws for a held lock; throws for an unusable
 * folder (not writable).
 * @param {{ dir?: string, now?: number, hostname?: string, port?: number, instance?: string }} [o]
 * @returns {Held | Refused}
 */
export function acquireDataLock({ dir = DATA_DIR, now = Date.now(), hostname = os.hostname(), port, instance = INSTANCE_ID } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  /** @type {LockInfo} */
  const info = { instance, pid: process.pid, host: hostname, startedAt: new Date(now).toISOString(), ...(port && { port }) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeLock(file, info);
      return { ok: true, file, info, refresh: () => refresh(file, info), release: () => release(file, info) };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      const holder = readLock(file);
      if (holder && lockHeld(holder, file, { now, hostname, instance })) {
        return { ok: false, file, holder, message: refusalMessage(holder, dir, file, { now, hostname }) };
      }
      // Left by a process that is gone (or not a lock file at all): remove it and try once more.
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take ${file}: another process keeps creating it.`);
}

/** Creates the file, which must not exist yet (EEXIST otherwise). @param {string} file @param {LockInfo} info */
function writeLock(file, info) {
  const fd = openSync(file, 'wx');
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
}

/** Whether the file on disk is this instance's lock (the instance id decides, never the pid). @param {string} file @param {LockInfo} info */
const ours = (file, info) => readLock(file)?.instance === info.instance;

/**
 * Touches the lock so another host can see the server is alive. A lock someone deleted is written again; one that another
 * instance holds now (someone deleted ours and a second server started) is left alone, and false says so.
 * @param {string} file @param {LockInfo} info
 */
function refresh(file, info) {
  const current = readLock(file);
  if (current && current.instance !== info.instance) return false;
  if (!current) {
    try {
      writeLock(file, info);
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      return ours(file, info); // written by someone in between: ours only if it is ours
    }
  }
  const now = new Date();
  utimesSync(file, now, now);
  return true;
}

/** Removes the lock, but only while it is still this instance's (never another server's that took over after a wrong deletion). */
function release(file, info) {
  if (!ours(file, info)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * What the server does at startup: takes the lock or exits with the reason; keeps it fresh; gives it back when the process
 * ends normally (process.exit from the shutdown handlers included). A crash leaves the file, which the rules above recover.
 * @param {{ port?: number }} [o]
 * @returns {Held}
 */
export function holdDataLock({ port } = {}) {
  const lock = acquireDataLock({ port });
  if (!lock.ok) {
    console.error(`Not starting: ${lock.message}`);
    process.exit(1);
  }
  let lost = false;
  const timer = setInterval(() => {
    try {
      const kept = lock.refresh();
      if (!kept && !lost) console.warn(`Another server holds the data folder's lock now (${lock.file} was deleted and taken): two servers may be running on one data folder.`);
      lost = !kept;
    } catch (err) {
      console.warn(`The data folder's lock could not be refreshed: ${/** @type {Error} */ (err).message}`);
    }
  }, LOCK_REFRESH_MS);
  timer.unref();
  process.once('exit', () => {
    clearInterval(timer);
    try {
      lock.release();
    } catch {
      // the folder may be gone with the process's temp data; nothing to release
    }
  });
  return lock;
}
