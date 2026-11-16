// @ts-check
// The docker command, as the boxes use it. Secrets are passed as environment variables of the command (`-e NAME` takes
// the value from there), never as arguments, which any user of the server can read in the process list.
import { spawn } from 'node:child_process';

const DOCKER = process.env.SAS_DOCKER || 'docker';

export class DockerError extends Error {
  /** @type {string} */
  tail = '';
}

/**
 * Runs docker; its output, or a DockerError with what it said.
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, input?: NodeJS.ReadableStream, timeoutMs?: number }} [o]
 * @returns {Promise<string>}
 */
export function docker(args, { env = {}, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER, args, { env: { ...process.env, ...env }, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { if (out.length < 1_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 20_000) err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (input && child.stdin) {
      input.on('error', (e) => child.stdin?.destroy(e));
      child.stdin.on('error', () => {}); // docker stopped reading: its exit code says why
      input.pipe(child.stdin);
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DockerError(/** @type {any} */ (e).code === 'ENOENT' ? 'Docker is not installed on this server.' : e.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const error = new DockerError(signal ? `docker ${args[0]} took too long and was stopped.` : (err.trim().split('\n').pop() || `docker ${args[0]} failed (${code}).`));
      // What the command printed last (an app's install or build says there why it failed).
      error.tail = `${out}\n${err}`.trim().split('\n').slice(-40).join('\n');
      reject(error);
    });
  });
}

/** Whether this server can run boxes: docker is installed and answers. Asked again at most once a minute. */
let known = { at: 0, ok: false };
export async function dockerAvailable() {
  if (Date.now() - known.at < 60_000) return known.ok;
  const ok = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 }).then(() => true, () => false);
  known = { at: Date.now(), ok };
  return ok;
}
