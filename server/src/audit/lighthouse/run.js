import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { jobLoad, startWaiting } from '../../jobs/context.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

// One Lighthouse run at a time in this server, whatever runs beside it (Analyze, re-audit, the as-is check; jobs side by side,
// jobs/manager.js). Two runs at once take CPU from each other and the scores drop (measured 2026-10-30: phone Performance 88 → 78
// with two overlapping), so an original and its copy would no longer be compared fairly. Not a setting on purpose.
let tail = Promise.resolve();
const lane = { running: 0, waiting: 0 };

/** How busy the Lighthouse lane is right now. */
export const lighthouseLane = () => ({ ...lane });

/** Waits for the lane; resolves with the function that hands it on. A stop while waiting leaves the line and passes the turn on. */
function acquire(signal) {
  const before = tail;
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  tail = before.then(() => held);
  lane.waiting++;
  return new Promise((resolve, reject) => {
    let left = false;
    const onAbort = () => {
      if (left) return;
      left = true;
      lane.waiting--;
      reject(Object.assign(new Error('Stopped while waiting for Lighthouse.'), { stopped: true }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    before.then(() => {
      signal?.removeEventListener('abort', onAbort);
      if (left) return release();
      left = true;
      lane.waiting--;
      lane.running++;
      let given = false;
      resolve(() => {
        if (given) return;
        given = true;
        lane.running--;
        release();
      });
    });
  });
}

/**
 * Runs Lighthouse for one form factor in a forked worker, once it is this run's turn in the lane (one run at a time).
 * @param {string} url
 * @param {'mobile'|'desktop'} formFactor
 * @param {{ timeout?: number, outFile?: string, proxy?: string, cpuSlowdown?: number, signal?: AbortSignal,
 *   onAcquire?: (o: { waitedMs: number }) => void, worker?: string }} [opts]  proxy: egress proxy URL (SSRF guard);
 *   cpuSlowdown: simulated CPU slowdown instead of the form factor's default (a calibrated run); timeout: counted from the moment
 *   the run has its turn, never while it waits; onAcquire: told how long it waited (so the caller can give that time back);
 *   signal: a stop while waiting; worker: tests only
 * @returns {Promise<object>} the trimmed summary built by worker.js
 */
export async function runLighthouse(url, formFactor, { signal, onAcquire, ...opts } = {}) {
  const asked = Date.now();
  const endWait = startWaiting();
  let leave;
  try {
    leave = await acquire(signal);
  } finally {
    endWait();
  }
  try {
    // What else ran when this run got its turn (other jobs, never another Lighthouse: the lane), kept with its result.
    const contention = jobLoad();
    onAcquire?.({ waitedMs: Date.now() - asked });
    const summary = await runWorker(url, formFactor, opts);
    return contention && summary && typeof summary === 'object' ? { ...summary, contention } : summary;
  } finally {
    leave();
  }
}

function runWorker(url, formFactor, { timeout = 90000, outFile, proxy, cpuSlowdown, worker = WORKER } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: ['--disable-warning=ExperimentalWarning'],
    });
    let chromePid = null;
    let settled = false;
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      // Kill Chrome first; killing only the worker would leave it running.
      if (chromePid) {
        try {
          process.kill(chromePid);
        } catch {
          /* already gone */
        }
      }
      child.kill();
      finish(reject, new Error(`Lighthouse ${formFactor} timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.on('message', (msg) => {
      if (msg.type === 'chrome') chromePid = msg.pid;
      else if (msg.type === 'done') finish(resolve, msg.summary);
      else if (msg.type === 'error') finish(reject, new Error(`Lighthouse ${formFactor}: ${msg.message}`));
    });
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => {
      finish(reject, new Error(`Lighthouse ${formFactor} worker exited (code ${code}) ${stderr.trim().split('\n').pop() || ''}`.trim()));
    });

    child.send({ url, formFactor, chromePath: chromium.executablePath(), outFile, proxy, cpuSlowdown });
  });
}
