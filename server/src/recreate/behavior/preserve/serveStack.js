// Builds and runs one packaged stack of a lifted copy with its toolchain's packages (the same toolchains the other stacks
// are built with, linked into the project for the time of the build or the run and removed after). Nothing is installed.
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { symlink, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runToolchain } from '../../build/toolchain.js';
import { toolchainDir } from '../../../config/paths.js';


const TOOLCHAIN = { 'react-vite': 'react-vite', nextjs: 'next', mern: 'mern' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Attempts at a fresh port when the one picked was taken before the stack's server bound it (another job, another program). */
const PORT_ATTEMPTS = 3;

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

/** A port free on 127.0.0.1 right now (the system picks it). */
export const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/**
 * Runs the stack's own server (vite preview, next start, the MERN server) on a port of its own, picked free for this run, so
 * jobs side by side never meet on one (SAS_MAX_JOBS above 1). Resolves with the address and a stop function once the server
 * answers while it is still running: an answer on a port whose server is not ours (ours exited, someone else holds the port)
 * is never taken for the copy; a fresh port is tried instead. The link to the toolchain is removed when it stops.
 * @param {string} stack
 * @param {string} dir  the packed project
 * @param {{ port?: number }} [o]  a fixed port (tests); default: a free one
 * @returns {Promise<{ url: string, port: number, stop: () => Promise<void> }>}
 */
export async function startStack(stack, dir, { port } = {}) {
  let last = null;
  for (let attempt = 0; attempt < (port ? 1 : PORT_ATTEMPTS); attempt++) {
    try {
      return await startOnPort(stack, dir, port ?? await freePort());
    } catch (err) {
      last = err;
      if (!err.portLost) throw err;
    }
  }
  throw last;
}

/** Something already accepts connections on the port (another job's server, another program). */
const portAnswers = (port) => new Promise((resolve) => {
  const socket = connect({ port, host: '127.0.0.1' });
  const done = (v) => { socket.destroy(); resolve(v); };
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.setTimeout(1000, () => done(false));
});
/** How long our server must still be running after its first answer for that answer to count as its own. */
const SETTLE_MS = 750;

/** One try of startStack on one port. An error with `portLost`: the server could not keep the port; another one may work. */
async function startOnPort(stack, dir, port) {
  // A server that is not ours would answer the readiness check below before ours has even started.
  if (await portAnswers(port)) {
    const err = new Error(`port ${port} is already in use: the ${stack} server was not started there`);
    err.portLost = true;
    throw err;
  }
  const modules = path.join(dir, 'node_modules');
  await symlink(path.join(toolchainDir(TOOLCHAIN[stack]), 'node_modules'), modules, 'junction');
  const args = {
    'react-vite': ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    nextjs: ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'],
    mern: ['server/src/index.js'],
  }[stack];
  if (!args) {
    await rmdir(modules).catch(() => unlink(modules)).catch(() => {});
    throw new Error(`no server for the ${stack} stack`);
  }
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
      // Only an answer while our server runs is ours: it must still be running a moment later (one that lost the port exits).
      if (res.status < 500 && child.exitCode === null) {
        await sleep(SETTLE_MS);
        if (child.exitCode === null) return { url, port, stop };
        break;
      }
    } catch { /* not yet */ }
    await sleep(1000);
  }
  await stop();
  const err = new Error(`the ${stack} server did not answer on ${url}: ${out.slice(-800)}`);
  // It ended by itself because the port was taken: worth another port.
  err.portLost = child.exitCode !== null && /EADDRINUSE|address already in use|port \d+ is (already )?in use/i.test(out);
  throw err;
}
