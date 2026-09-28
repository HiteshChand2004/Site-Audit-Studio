import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

/**
 * Runs Lighthouse for one form factor in a forked worker.
 * @param {string} url
 * @param {'mobile'|'desktop'} formFactor
 * @param {{ timeout?: number, outFile?: string }} [opts]
 * @returns {Promise<object>} the trimmed summary built by worker.js
 */
export function runLighthouse(url, formFactor, { timeout = 90000, outFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], {
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

    child.send({ url, formFactor, chromePath: chromium.executablePath(), outFile });
  });
}
