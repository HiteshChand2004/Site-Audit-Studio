// Development runner: starts the API and restarts it only when source code really changed, and
// never in the middle of an Analyze or Recreate job.
//
// It replaces `node --watch`, which restarted the server (killing running jobs) with nothing edited:
// it reacts to any change notification on any imported file, node_modules included, and on Windows
// (NTFS) reading a file that was not used for a while updates its last-access time, which counts as
// a change. This runner watches only src/ and .env and compares file contents:
//   - only regular files count: the recursive watcher also reports folders (their access time
//     changes when they are listed), and reading a folder fails;
//   - a file that cannot be read for a moment (locked by an antivirus or indexer) is retried and
//     never counts as changed; a deleted file does;
//   - a watcher error is logged and the watcher recreated, never ending the runner;
//   - before a restart it asks the API (GET /api/health → busy) whether a job is running and waits
//     until none is, so an edit never kills a job.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const ENV = path.join(ROOT, '.env');
const ARGS = ['--disable-warning=ExperimentalWarning', '--env-file-if-exists=.env', 'src/index.js'];
const DEBOUNCE_MS = 200;
const READ_RETRIES = 5;
const READ_RETRY_MS = 150;
const BUSY_POLL_MS = 3000;
const log = (message) => console.log(`[dev] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The port the API listens on: PORT from the environment or .env, else 4000. */
async function apiPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  const env = await readFile(ENV, 'utf8').catch(() => '');
  return Number(env.match(/^\s*PORT\s*=\s*(\d+)/m)?.[1]) || 4000;
}

/**
 * The content hash of a regular file; null when it does not exist; undefined when it is not a file
 * (a folder) or could not be read even after retries (then it is not a change).
 */
async function hashOf(file) {
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      const info = await stat(file);
      if (!info.isFile()) return undefined;
      return createHash('sha1').update(await readFile(file)).digest('hex');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      await sleep(READ_RETRY_MS);
    }
  }
  log(`Could not read ${path.relative(ROOT, file)}; ignoring this notification.`);
  return undefined;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}

const hashes = new Map(); // tracked file → content hash

// Files whose content really changed since the last check (a notification alone is not a change).
async function changedFiles(files) {
  const changed = [];
  for (const file of files) {
    const h = await hashOf(file);
    if (h === undefined) continue; // a folder, or unreadable for now
    if (h === null) {
      if (hashes.delete(file)) changed.push(file); // a tracked file was deleted
      continue;
    }
    if (hashes.get(file) !== h) {
      hashes.set(file, h);
      changed.push(file);
    }
  }
  return changed;
}

/** True while the API reports a running or queued job; false when it does not answer. */
async function apiBusy() {
  try {
    const res = await fetch(`http://127.0.0.1:${await apiPort()}/api/health`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).busy === true;
  } catch {
    return false;
  }
}

let child = null;
let restarting = false;
let pendingChanges = new Set();
function start() {
  child = spawn(process.execPath, ARGS, { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (restarting) return;
    child = null;
    log(`Server exited (${signal ?? `code ${code}`}); waiting for a source change to start it again.`);
  });
}

async function restart(changed) {
  changed.forEach((f) => pendingChanges.add(f));
  if (restarting) return;
  restarting = true;
  try {
    if (child && (await apiBusy())) {
      log('A job is running: the restart waits until it has finished.');
      while (child && (await apiBusy())) await sleep(BUSY_POLL_MS);
    }
    const files = [...pendingChanges].map((f) => path.relative(ROOT, f));
    pendingChanges = new Set();
    log(`Restarting: ${files.join(', ')} changed.`);
    if (child && child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  } finally {
    restarting = false;
  }
  start();
}

let pending = new Set();
let timer = null;
const queue = (file) => {
  pending.add(file);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const files = [...pending];
    pending = new Set();
    try {
      const changed = await changedFiles(files);
      if (changed.length) await restart(changed);
    } catch (err) {
      log(`Change check failed: ${err.message}`);
    }
  }, DEBOUNCE_MS);
};

/** A watcher that logs its errors and is created again instead of ending the runner. */
function keepWatching(target, options, onChange) {
  const open = () => {
    try {
      const watcher = watch(target, options, onChange);
      watcher.on('error', (err) => {
        log(`Watcher error on ${path.relative(ROOT, target) || '.'} (${err.code ?? err.message}); watching again.`);
        watcher.close();
        setTimeout(open, 1000);
      });
    } catch (err) {
      log(`Cannot watch ${path.relative(ROOT, target) || '.'} (${err.code ?? err.message}); retrying.`);
      setTimeout(open, 2000);
    }
  };
  open();
}

for (const file of await listFiles(SRC)) hashes.set(file, await hashOf(file));
const envHash = await hashOf(ENV);
if (envHash) hashes.set(ENV, envHash);
keepWatching(SRC, { recursive: true }, (_event, name) => name && queue(path.join(SRC, name)));
keepWatching(ROOT, {}, (_event, name) => name === '.env' && queue(ENV));
process.on('uncaughtException', (err) => log(`Runner error: ${err.message}`));
process.on('unhandledRejection', (err) => log(`Runner error: ${err?.message ?? err}`));
start();

const stop = () => {
  child?.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
