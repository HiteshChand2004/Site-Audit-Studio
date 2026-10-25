// A Next.js copy drops Next's build folder (.next) once it is built and checked (behavior/preserve/stage.js, dropBuildFolder):
// what is kept and zipped is the source and out/. Without .next, `npm run dev` must still serve every page exactly as out/ has
// it, and `npm run build` (what "Package again" runs on a fresh conversion) must still write the same out/. No browser: HTTP only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILD_DIR, buildConverted, convertToNext, dropBuildFolder, EXPORT_DIR } from '../src/recreate/convert/next.js';
import { freePort } from '../src/recreate/behavior/preserve/serveStack.js';
import { toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const PAGES = {
  'index.html': '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="/css/site.css"></head><body><header><a href="/about/">About</a></header><main><h1>Home page</h1><p>Kept as it is.</p></main></body></html>',
  'about/index.html': '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="/css/site.css"></head><body><header><a href="/">Home</a></header><main><h1>About us</h1></main></body></html>',
};
const ROUTES = { '/': 'index.html', '/about/': 'about/index.html' };

let root;
let outDir;
let dev;
let devLog = '';
let devUrl;

const exported = (file) => readFile(path.join(outDir, EXPORT_DIR, file), 'utf8');
const exists = (p) => stat(p).then(() => true, () => false);

before(async () => {
  const tc = await toolchainStatus('next');
  if (!tc.installed) throw new Error('the next toolchain is not installed: npm run setup:toolchains -w server -- next');
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-next-no-build-folder-'));
  const copyDir = path.join(root, 'copy');
  for (const [rel, body] of Object.entries({ ...PAGES, 'css/site.css': 'body{margin:0;color:rgb(20,30,40)}h1{font-size:40px}' })) {
    await mkdir(path.dirname(path.join(copyDir, rel)), { recursive: true });
    await writeFile(path.join(copyDir, rel), body);
  }
  outDir = path.join(root, 'nextjs');
  const pages = Object.keys(PAGES).map((outPath) => ({ outPath, url: `https://site.example/${outPath.replace(/index\.html$/, '')}` }));
  await convertToNext({ copyDir, outDir, pages, pageUrl: 'https://site.example/' });
  await buildConverted(outDir, { timeoutMs: 6 * 60000 });
});

after(async () => {
  if (dev && dev.exitCode === null) {
    const gone = new Promise((r) => dev.once('exit', r));
    // The dev server starts workers of its own: end the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { windowsHide: true });
    else dev.kill();
    await gone;
  }
  if (outDir) await rmdir(path.join(outDir, 'node_modules')).catch(() => unlink(path.join(outDir, 'node_modules'))).catch(() => {});
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

test('the build folder goes, the source and out/ stay', async () => {
  assert.ok(await exists(path.join(outDir, BUILD_DIR)), 'next build wrote .next');
  const before = Object.fromEntries(await Promise.all(Object.values(ROUTES).map(async (f) => [f, await exported(f)])));
  await dropBuildFolder(outDir);
  assert.equal(await exists(path.join(outDir, BUILD_DIR)), false);
  for (const f of ['package.json', 'next.config.mjs', 'scripts/dev.mjs', 'scripts/after-build.mjs']) assert.ok(await exists(path.join(outDir, f)), f);
  for (const [f, html] of Object.entries(before)) assert.equal(await exported(f), html, `${f} unchanged`);
});

test('npm run dev without .next serves every page exactly as out/ ships it', { timeout: 5 * 60000 }, async () => {
  await symlink(path.join(toolchainDir('next'), 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
  const port = await freePort();
  devUrl = `http://127.0.0.1:${port}`;
  dev = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: outDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
  });
  dev.stdout.on('data', (d) => { devLog = (devLog + d).slice(-20000); });
  dev.stderr.on('data', (d) => { devLog = (devLog + d).slice(-20000); });
  const end = Date.now() + 3 * 60000;
  while (!(await fetch(`${devUrl}/css/site.css`).then((r) => r.ok, () => false))) {
    if (dev.exitCode !== null) throw new Error(`npm run dev stopped: ${devLog.slice(-2000)}`);
    if (Date.now() > end) throw new Error(`npm run dev did not answer: ${devLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const [route, file] of Object.entries(ROUTES)) {
    const r = await fetch(`${devUrl}${route}`);
    assert.equal(r.status, 200, route);
    assert.equal(await r.text(), await exported(file), `${route}: development = the shipped page`);
  }
});

test('npm run build without .next writes the same out/ again', { timeout: 8 * 60000 }, async () => {
  // The development server is stopped first: it holds .next, which `next build` replaces.
  if (dev && dev.exitCode === null) {
    const gone = new Promise((r) => dev.once('exit', r));
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { windowsHide: true });
    else dev.kill();
    await gone;
  }
  await rmdir(path.join(outDir, 'node_modules')).catch(() => unlink(path.join(outDir, 'node_modules'))).catch(() => {});
  const shipped = Object.fromEntries(await Promise.all(Object.values(ROUTES).map(async (f) => [f, await exported(f)])));
  await dropBuildFolder(outDir);
  await rm(path.join(outDir, EXPORT_DIR), { recursive: true, force: true });
  await buildConverted(outDir, { timeoutMs: 6 * 60000 });
  for (const [f, html] of Object.entries(shipped)) assert.equal(await exported(f), html, `${f}: rebuilt the same`);
});
