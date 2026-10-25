// Every downloaded project ships a package-lock.json for each of its packages (the top, client/, server/), cut from the lockfile
// of the toolchain it was built with (toolchains/lockfile.js), so `npm ci` installs exactly the packages we built and checked
// with. No browser, no network, no npm: the projects are written by the real writers (conversion, as-is packaging, the clean
// emitters) and the lockfiles held against the toolchain's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convertToMern } from '../src/recreate/convert/mern.js';
import { convertToNext } from '../src/recreate/convert/next.js';
import { convertToReact } from '../src/recreate/convert/react.js';
import { packLifted } from '../src/recreate/behavior/preserve/pack.js';
import { getEmitter } from '../src/recreate/emit/index.js';
import { describePackage, runAndHost } from '../src/copy/deploy.js';
import { cutLockfile, PACKAGE_ROOTS, STACK_TOOLCHAIN, writeLockfiles } from '../src/toolchains/lockfile.js';
import { LOCKFILE, toolchainDir } from '../src/toolchains/index.js';

const work = await mkdtemp(path.join(os.tmpdir(), 'sas-download-locks-'));
after(() => rm(work, { recursive: true, force: true }));
const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);
const exists = (p) => stat(p).then(() => true, () => false);

/** Where npm finds `name` from the package at `loc` (its own node_modules, then each parent's, then the top). */
function resolveIn(packages, loc, name) {
  for (let at = loc; ; at = at.includes('/node_modules/') ? at.slice(0, at.lastIndexOf('/node_modules/')) : '') {
    const where = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[where]) return where;
    if (!at) return null;
  }
}

/**
 * A project's lockfiles: one per package with packages; its root = the package.json; every entry the toolchain's own at the same
 * place (same version, same integrity); every dependency of every entry found in the lockfile.
 */
async function assertLocked(dir, stack, label) {
  const source = await readJson(path.join(toolchainDir(STACK_TOOLCHAIN[stack]), LOCKFILE));
  let count = 0;
  for (const root of PACKAGE_ROOTS) {
    const pkg = await readJson(path.join(dir, root, 'package.json'));
    if (!pkg || !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) continue;
    const lock = await readJson(path.join(dir, root, LOCKFILE));
    assert.ok(lock, `${label}: ${root || '.'}/${LOCKFILE} is written`);
    count++;
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(lock.packages[''].dependencies ?? {}, pkg.dependencies ?? {}, `${label} ${root}: the lockfile's dependencies are the package's`);
    assert.deepEqual(lock.packages[''].devDependencies ?? {}, pkg.devDependencies ?? {}, `${label} ${root}: devDependencies`);
    for (const [loc, entry] of Object.entries(lock.packages)) {
      if (!loc) continue;
      const theirs = source.packages[loc];
      assert.ok(theirs, `${label} ${root}: ${loc} is the toolchain's`);
      assert.equal(entry.version, theirs.version, `${label} ${root}: ${loc} at the toolchain's version`);
      assert.equal(entry.integrity, theirs.integrity, `${label} ${root}: ${loc} with the toolchain's integrity`);
      for (const name of Object.keys({ ...entry.dependencies })) {
        assert.ok(resolveIn(lock.packages, loc, name), `${label} ${root}: ${name}, needed by ${loc}, is in the lockfile`);
      }
    }
    // Direct packages at the version package.json pins.
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.equal(lock.packages[`node_modules/${name}`]?.version, v, `${label}: ${name}`);
  }
  assert.ok(count, `${label}: at least one package was locked`);
  return count;
}

/** A finished as-is copy of two pages. */
async function copyOf(name) {
  const copyDir = path.join(work, name, 'copy');
  const files = {
    'index.html': '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="/css/site.css"></head><body><main><h1>Home</h1><form method="post" action="/contact"><input name="email" type="email"><button>Send</button></form></main></body></html>',
    'about/index.html': '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="/css/site.css"></head><body><main><h1>About</h1></main></body></html>',
    'css/site.css': 'body{margin:0}',
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(copyDir, rel)), { recursive: true });
    await writeFile(path.join(copyDir, rel), body);
  }
  const pages = ['index.html', 'about/index.html'].map((outPath) => ({ outPath, url: `https://site.example/${outPath.replace(/index\.html$/, '')}` }));
  return { copyDir, pages };
}

/** DEPLOY.md's run lines for the project folder. */
async function installLines(dir) {
  const files = [];
  const walk = async (rel) => {
    for (const e of await import('node:fs/promises').then((fs) => fs.readdir(path.join(dir, rel), { withFileTypes: true }))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules') await walk(r); } else files.push(r);
    }
  };
  await walk('');
  const { readFileSync } = await import('node:fs');
  return runAndHost(describePackage({ files, read: (rel) => readFileSync(path.join(dir, rel), 'utf8') })).run.join('\n');
}

const CONVERT = { 'react-vite': convertToReact, nextjs: convertToNext, mern: convertToMern };

for (const stack of ['react-vite', 'nextjs', 'mern']) {
  test(`${stack}: the converted project ships a lockfile per package, cut from the toolchain, and says npm ci`, async () => {
    const { copyDir, pages } = await copyOf(`convert-${stack}`);
    const outDir = path.join(work, `convert-${stack}`, 'project');
    await CONVERT[stack]({ copyDir, outDir, pages, pageUrl: 'https://site.example/' });
    const written = await writeLockfiles(outDir, { stack });
    assert.ok(written.every((w) => w.toolchain === STACK_TOOLCHAIN[stack]), JSON.stringify(written));
    const count = await assertLocked(outDir, stack, `converted ${stack}`);
    if (stack === 'mern') assert.equal(count, 2, 'the server (top) and the client');
    const run = await installLines(outDir);
    assert.doesNotMatch(run, /npm install/);
    assert.match(run, /npm ci/);
    const readme = await readFile(path.join(outDir, stack === 'mern' ? 'client/README.md' : 'README.md'), 'utf8').catch(() => '');
    assert.doesNotMatch(readme, /^npm install$/m);
    const pkg = await readJson(path.join(outDir, 'package.json'));
    if (pkg.scripts?.['install:all']) assert.doesNotMatch(pkg.scripts['install:all'], /npm install/);
  });

  test(`${stack}: the as-is packaged project and the clean project ship their lockfiles too`, async () => {
    const { copyDir } = await copyOf(`pack-${stack}`);
    const packed = path.join(work, `pack-${stack}`, 'project');
    await packLifted({ stack, copyDir, outDir: packed, pageUrl: 'https://site.example/' });
    await writeLockfiles(packed, { stack });
    await assertLocked(packed, stack, `packed ${stack}`);
    assert.match(await readFile(path.join(packed, 'README.md'), 'utf8'), /npm ci/);

    const clean = path.join(work, `clean-${stack}`);
    const ir = {
      version: 1, baseUrl: 'https://site.example', files: [], fontFaces: [], keyframes: [], tokens: {}, rules: [], breakpoints: { tablet: 1023.98, mobile: 767.98 },
      pages: [{ outPath: 'index.html', head: { lang: 'en', title: 'Home', description: 'A page', meta: [], alternates: [], icons: [], preload: [], jsonLd: [] }, html: {}, body: { t: 'body', children: [{ t: 'h1', children: [{ text: 'Hi' }] }] } }],
    };
    for (const [rel, text] of getEmitter(stack).emit(ir, {}).files) {
      await mkdir(path.dirname(path.join(clean, rel)), { recursive: true });
      await writeFile(path.join(clean, rel), text);
    }
    await writeLockfiles(clean, { stack });
    const count = await assertLocked(clean, stack, `clean ${stack}`);
    if (stack === 'mern') assert.equal(count, 2, 'client/ and server/');
    const pkg = await readJson(path.join(clean, 'package.json'));
    if (pkg.scripts?.['install:all']) assert.match(pkg.scripts['install:all'], /^npm ci /);
  });
}

test('flags as npm writes them: dev-only, optional-only, peer-only; a package reached both ways keeps neither', () => {
  const source = { packages: {
    '': {},
    'node_modules/a': { version: '1.0.0', dependencies: { shared: '^1.0.0' }, optionalDependencies: { opt: '1.0.0' } },
    'node_modules/tool': { version: '2.0.0', dependencies: { shared: '^1.0.0', devonly: '1.0.0' }, peerDependencies: { a: '*' } },
    'node_modules/shared': { version: '1.2.0' },
    'node_modules/devonly': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
    'node_modules/devonly/node_modules/shared': { version: '2.0.0' },
    'node_modules/opt': { version: '1.0.0', os: ['linux'] },
    'node_modules/unused': { version: '9.9.9' },
  } };
  const lock = cutLockfile({ name: 'p', version: '0.0.0', dependencies: { a: '1.0.0' }, devDependencies: { tool: '2.0.0' } }, source);
  const p = lock.packages;
  assert.equal(p['node_modules/unused'], undefined, 'what the project does not need is left out');
  assert.equal(p['node_modules/shared'].dev, undefined, 'reached from a dependency and a dev dependency: not dev');
  assert.equal(p['node_modules/tool'].dev, true);
  assert.equal(p['node_modules/devonly'].dev, true);
  assert.equal(p['node_modules/devonly/node_modules/shared'].dev, true, 'the nested copy is found from its own package');
  assert.equal(p['node_modules/opt'].optional, true);
  assert.equal(p['node_modules/a'].peer, undefined, 'a direct dependency is no peer');
  assert.deepEqual(p[''].devDependencies, { tool: '2.0.0' });
});

test('a package that is not pinned exactly, or not in the toolchain at that version, is refused', async () => {
  const source = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } };
  assert.throws(() => cutLockfile({ name: 'p', version: '0.0.0', dependencies: { a: '^1.0.0' } }, source), /pinned to one version/);
  assert.throws(() => cutLockfile({ name: 'p', version: '0.0.0', dependencies: { a: '1.0.1' } }, source), /not in the toolchain's lockfile \(it has 1\.0\.0\)/);
  assert.throws(() => cutLockfile({ name: 'p', version: '0.0.0', dependencies: { b: '1.0.0' } }, source), /b@1\.0\.0 is not in/);
  const dir = path.join(work, 'unlockable');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', dependencies: { 'left-pad': '1.3.0' } }));
  await assert.rejects(writeLockfiles(dir), /No toolchain lockfile holds the packages/);
  assert.equal(await exists(path.join(dir, LOCKFILE)), false, 'nothing half-right is written');
});
