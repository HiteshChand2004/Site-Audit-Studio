// @ts-check
// One server per data folder. Two servers on one `app.db` would each run jobs the other knows nothing about, prune each other's
// recreate folders and fight over previews, so the server takes `<DATA_DIR>/server.lock` before it touches a job row, and a
// second server pointed at the same folder refuses to start and says who holds it. Only the server takes the lock (src/index.js
// holdDataLock): a script that opens the database to read it, the migration tools and the tests never do.
//
// Recovery after a crash: the file names the process (pid, host) and is touched every LOCK_REFRESH_MS while the server runs.
//   - Same host: the lock is held while that pid is alive. A process killed with no chance to clean up (power loss, kill -9,
//     TerminateProcess) leaves the file behind, its pid is gone, and the next start takes the lock over. The one case the check
//     cannot see is a reused pid: the refusal message names the pid, so the person can tell it is not a server, and says what
//     to delete.
//   - Another host (a shared disk): no pid can be asked, so the file's age decides — a lock not touched for LOCK_STALE_MS is a
//     dead server's.
// Creation is atomic (`wx`: the file must not exist), so two servers starting at the same moment cannot both win.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const LOCK_NAME = 'server.lock';
/** How often the holder touches the file; the same cadence as the job heartbeat (jobs/liveness.js HEARTBEAT_MS). */
export const LOCK_REFRESH_MS = 15_000;
/** A lock from another host not touched for this long is a dead server's (jobs/liveness.js STALE_MS: the same reasoning). */
export const LOCK_STALE_MS = 120_000;

/** @param {string} [dir] */
export const lockFile = (dir = DATA_DIR) => path.join(dir, LOCK_NAME);

/**
 * @typedef {{ pid: number, host: string, startedAt: string, port?: number }} LockInfo
 * @typedef {{ ok: true, file: string, info: LockInfo, refresh: () => void, release: () => void }} Held
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

/**
 * Whether the lock another process wrote is still held (see the rules at the top).
 * @param {LockInfo | null} info
 * @param {string} file
 * @param {{ now?: number, hostname?: string, pid?: number }} [o]
 */
export function lockHeld(info, file, { now = Date.now(), hostname = os.hostname(), pid = process.pid } = {}) {
  if (!info) return false;
  if (info.pid === pid && info.host === hostname) return false; // our own, left from an earlier attempt in this process
  if (info.host === hostname) return processAlive(info.pid);
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return false; // gone meanwhile
  }
  return now - mtime < LOCK_STALE_MS;
}

/** The refusal, in words that say what to do. @param {LockInfo} holder @param {string} dir @param {string} file */
export function refusalMessage(holder, dir, file) {
  const where = `process ${holder.pid} on ${holder.host}${holder.port ? `, port ${holder.port}` : ''}, started ${holder.startedAt}`;
  return (
    `Another server is already using the data folder ${dir} (${where}). Stop it first, or give this server its own folder with ` +
    `SAS_DATA_DIR. If no server is running there (the lock was left by a process that is gone), delete ${file} and start again.`
  );
}

/**
 * Takes the data folder's lock for this process, or says who holds it. Never throws for a held lock; throws for an unusable
 * folder (not writable).
 * @param {{ dir?: string, now?: number, hostname?: string, port?: number }} [o]
 * @returns {Held | Refused}
 */
export function acquireDataLock({ dir = DATA_DIR, now = Date.now(), hostname = os.hostname(), port } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  /** @type {LockInfo} */
  const info = { pid: process.pid, host: hostname, startedAt: new Date(now).toISOString(), ...(port && { port }) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return { ok: true, file, info, refresh: () => refresh(file, info), release: () => release(file, info) };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      const holder = readLock(file);
      if (holder && lockHeld(holder, file, { now, hostname })) return { ok: false, file, holder, message: refusalMessage(holder, dir, file) };
      // Left by a process that is gone (or not a lock file at all): remove it and try once more.
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take ${file}: another process keeps creating it.`);
}

/** Touches the lock so another host can see the server is alive; a lock someone deleted is written again. */
function refresh(/** @type {string} */ file, /** @type {LockInfo} */ info) {
  const now = new Date();
  try {
    utimesSync(file, now, now);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
    const fd = openSync(file, 'wx');
    try {
      writeSync(fd, JSON.stringify(info));
    } finally {
      closeSync(fd);
    }
  }
}

/** Removes the lock, but only while it is still this process's (never another server's that took over after a wrong deletion). */
function release(/** @type {string} */ file, /** @type {LockInfo} */ info) {
  const current = readLock(file);
  if (current && (current.pid !== info.pid || current.host !== info.host)) return;
  rmSync(file, { force: true });
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
  const timer = setInterval(() => {
    try {
      lock.refresh();
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
