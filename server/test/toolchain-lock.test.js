// The build toolchains are locked (server/toolchains/<id>/package-lock.json) and "installed" means installed as locked
// (toolchains/index.js lockedInstall). No browser, no network: a made-up node_modules in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOCKFILE, lockedInstall, toolchainDir } from '../src/toolchains/index.js';

const other = process.platform === 'win32' ? 'linux' : 'win32';

/** A folder with package.json, a lockfile and node_modules holding `installed` ({ 'node_modules/x': '1.0.0' }). */
async function folder({ pkg, packages, installed }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-lock-'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(dir, LOCKFILE), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: pkg.dependencies }, ...packages } }));
  for (const [where, version] of Object.entries(installed)) {
    await mkdir(path.join(dir, ...where.split('/')), { recursive: true });
    await writeFile(path.join(dir, ...where.split('/'), 'package.json'), JSON.stringify({ version }));
  }
  return dir;
}

const pkg = { dependencies: { vite: '6.3.5' }, overrides: { rollup: '4.40.2' } };
const packages = {
  'node_modules/vite': { version: '6.3.5' },
  'node_modules/rollup': { version: '4.40.2' },
  'node_modules/vite/node_modules/postcss': { version: '8.5.29' },
  'node_modules/fsevents': { version: '2.3.3', optional: true, os: ['darwin'] },
  'node_modules/@x/native-here': { version: '1.0.0', optional: true, os: [process.platform] },
  'node_modules/@x/native-other': { version: '1.0.0', optional: true, os: [other] },
  'node_modules/@x/wasm': { version: '1.0.0', optional: true },
};
const exact = {
  'node_modules/vite': '6.3.5', 'node_modules/rollup': '4.40.2', 'node_modules/vite/node_modules/postcss': '8.5.29',
  'node_modules/@x/native-here': '1.0.0',
};

test('installed as locked: every package at its place and version; optional builds for other systems may be absent', async () => {
  const dir = await folder({ pkg, packages, installed: exact });
  try {
    const s = await lockedInstall(dir, pkg);
    assert.deepEqual(s.missing, []);
    assert.equal(s.installed, true);
    assert.deepEqual(s.versions, { vite: '6.3.5' }, 'versions lists the direct packages');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a package underneath at another version, a missing one, or this system\'s native build missing: not installed', async () => {
  for (const [change, expect] of [
    [{ 'node_modules/vite/node_modules/postcss': '8.5.30' }, /postcss@8\.5\.29 \(installed 8\.5\.30\)/],
    [{ 'node_modules/rollup': null }, /rollup@4\.40\.2/],
    [{ 'node_modules/@x/native-here': null }, /@x\/native-here@1\.0\.0/],
  ]) {
    const installed = { ...exact, ...change };
    for (const [k, v] of Object.entries(change)) if (v === null) delete installed[k];
    const dir = await folder({ pkg, packages, installed });
    try {
      const s = await lockedInstall(dir, pkg);
      assert.equal(s.installed, false);
      assert.match(s.missing.join(' | '), expect);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('no lockfile, or a lockfile that no longer matches package.json or its pins: not installed', async () => {
  const dir = await folder({ pkg, packages, installed: exact });
  try {
    const newer = { dependencies: { vite: '6.4.0' }, overrides: { rollup: '4.41.0' } };
    const s = await lockedInstall(dir, newer);
    assert.equal(s.installed, false);
    assert.match(s.missing.join(' | '), /out of date for vite@6\.4\.0/);
    assert.match(s.missing.join(' | '), /out of date for rollup@4\.41\.0/);
    await rm(path.join(dir, LOCKFILE));
    assert.deepEqual((await lockedInstall(dir, pkg)).missing, [LOCKFILE]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('each toolchain in git has a lockfile matching its package.json, its pins kept, every package with a pinned version', async () => {
  for (const id of ['react-vite', 'next', 'mern']) {
    const dir = toolchainDir(id);
    const p = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(dir, LOCKFILE), 'utf8'));
    assert.deepEqual(lock.packages[''].dependencies, p.dependencies, `${id}: lockfile root = package.json`);
    for (const [where, entry] of Object.entries(lock.packages)) {
      if (!where) continue;
      assert.match(entry.version ?? '', /^\d+\.\d+\.\d+/, `${id}: ${where} has an exact version`);
      assert.match(entry.integrity ?? '', /^sha512-/, `${id}: ${where} has an integrity hash`);
      const name = where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (p.overrides?.[name]) assert.equal(entry.version, p.overrides[name], `${id}: ${where} at its pin`);
    }
  }
});
