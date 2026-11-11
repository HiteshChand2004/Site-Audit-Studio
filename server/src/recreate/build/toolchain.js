// Runs a stack's build with the toolchain the server pins (server/toolchains/<id>/), not with whatever the
// machine has: the generated project gets a node_modules junction to the toolchain's, the build runs as a
// child process with a minimal environment and a time limit, and the junction is removed afterwards so
// only the project's own files are left. No package is downloaded and no install script runs. A build of code nobody
// reviewed (Build mode's agent) runs inside an OS sandbox as well (`sandbox`, buildmode/sandbox.js).
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { toolchainDir, toolchainStatus } from '../../toolchains/index.js';
import { RecreateError } from '../errors.js';

const TAIL = 3000;

const env = () => ({
  ...Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
  NODE_ENV: 'production',
  CI: '1',
  NO_COLOR: '1',
  NEXT_TELEMETRY_DISABLED: '1', // no network calls from the toolchain
  NEXT_IGNORE_INCORRECT_LOCKFILE: '1', // never patch a lockfile (the repository's own sits above the data folder)
  ASTRO_TELEMETRY_DISABLED: '1',
});

/**
 * One node process; resolves with its output, rejects with a RecreateError carrying the output's tail.
 * sandbox: { command, args, env } — the process runs as `command ...args node ...` with those variables added.
 */
function runNode(args, { cwd, label, timeoutMs, signal, sandbox = null }) {
  return new Promise((resolve, reject) => {
    const [command, argv] = sandbox ? [sandbox.command, [...sandbox.args, process.execPath, ...args]] : [process.execPath, args];
    const child = spawn(command, argv, { cwd, env: { ...env(), ...sandbox?.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (d) => {
      output = (output + d).slice(-TAIL * 3);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new RecreateError(`${label} could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code === 0) return resolve(output);
      const tail = output.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-TAIL);
      reject(new RecreateError(timedOut ? `${label} did not finish within ${Math.round(timeoutMs / 1000)}s.` : `${label} failed: ${tail || `exit code ${code}`}`));
    });
  });
}

/**
 * Runs `steps` (node scripts, relative to the project) with the toolchain's node_modules linked into `dir`.
 * @param {{ dir: string, toolchain: string, steps: { label: string, args: string[], keepOutput?: boolean }[], timeoutMs?: number, signal?: AbortSignal,
 *   sandbox?: { command: string, args: string[], env?: Record<string, string> } | null, ownModules?: boolean }} o
 *   args: node arguments; "vite" in args[0] is resolved to the toolchain's vite binary; ownModules: the project gets a
 *   node_modules folder of its own holding a link to each of the toolchain's packages, for a build that writes into
 *   node_modules (SvelteKit writes its generated tsconfig there), which must never write into the shared toolchain
 * @returns {Promise<{ steps: { label: string, ms: number }[] }>}
 */
export async function runToolchain({ dir, toolchain, steps, timeoutMs = 180000, signal, sandbox = null, ownModules = false }) {
  const tool = await toolchainStatus(toolchain);
  if (!tool.installed) throw new RecreateError(`The ${toolchain} toolchain is not installed. Run: ${tool.setup}`);
  const modules = path.join(dir, 'node_modules');
  const shared = path.join(toolchainDir(toolchain), 'node_modules');
  const deadline = Date.now() + timeoutMs;
  const done = [];
  if (ownModules) {
    await mkdir(modules);
    for (const entry of await readdir(shared)) {
      if (!entry.startsWith('.')) await symlink(path.join(shared, entry), path.join(modules, entry), 'junction');
    }
  } else await symlink(shared, modules, 'junction');
  try {
    for (const step of steps) {
      const started = Date.now();
      const args = step.args.map((a, i) => (i === 0 && a === 'vite' ? path.join(modules, 'vite', 'bin', 'vite.js') : a));
      const output = await runNode(args, { cwd: dir, label: step.label, timeoutMs: Math.max(1000, deadline - started), signal, sandbox });
      done.push({ label: step.label, ms: Date.now() - started, ...(step.keepOutput && { output: output.slice(-TAIL) }) });
    }
  } finally {
    // Remove the link itself (rmdir/unlink never follow it), never what it points to; an own folder with what the build
    // wrote in it (rm removes the links inside, never what they point to).
    if (ownModules) await rm(modules, { recursive: true, force: true });
    else await rmdir(modules).catch(() => unlink(modules)).catch(() => {});
  }
  const stillThere = await stat(path.join(toolchainDir(toolchain), 'node_modules', 'vite')).then(() => true, () => false);
  if (!stillThere && toolchain === 'react-vite') throw new RecreateError('The toolchain folder was damaged by the build; reinstall it with the setup command.');
  return { steps: done };
}
