// Builds and runs one packaged stack of a lifted copy with its toolchain's packages (the same toolchains the other stacks
// are built with, linked into the project for the time of the build or the run and removed after). Nothing is installed.
import { spawn } from 'node:child_process';
import { symlink, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolchain } from '../../build/toolchain.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOOLCHAIN = { 'react-vite': 'react-vite', nextjs: 'next', mern: 'mern' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds the stack's project (React + Vite, Next.js); MERN has nothing to build. */
export async function buildStack(stack, dir, { timeoutMs } = {}) {
  if (stack === 'react-vite') {
    return runToolchain({ dir, toolchain: 'react-vite', timeoutMs: timeoutMs ?? 6 * 60000, steps: [{ label: 'vite build', args: ['vite', 'build'] }] });
  }
  if (stack === 'nextjs') {
    return runToolchain({ dir, toolchain: 'next', timeoutMs: timeoutMs ?? 8 * 60000, steps: [{ label: 'next build', args: ['node_modules/next/dist/bin/next', 'build'] }] });
  }
  return null;
}

/**
 * Runs the stack's own server on the port (vite preview, next start, the MERN server). Resolves with the address and a stop
 * function once the server answers; the link to the toolchain is removed when it stops.
 * @param {string} stack
 * @param {string} dir  the packed project
 * @param {number} port
 */
export async function startStack(stack, dir, port) {
  const modules = path.join(dir, 'node_modules');
  await symlink(path.join(SERVER, 'toolchains', TOOLCHAIN[stack], 'node_modules'), modules, 'junction');
  const args = {
    'react-vite': ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    nextjs: ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'],
    mern: ['server/src/index.js'],
  }[stack];
  if (!args) throw new Error(`no server for the ${stack} stack`);
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill();
    await sleep(500);
    await rmdir(modules).catch(() => unlink(modules)).catch(() => {});
  };
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${url}/`);
      if (res.status < 500) return { url, stop };
    } catch { /* not yet */ }
    await sleep(1000);
  }
  await stop();
  throw new Error(`the ${stack} server did not answer on ${url}: ${out.slice(-800)}`);
}
