// The download leaves out only the project's own installed packages and build output (node_modules, .ssr, .next, dist, out
// directly inside the project, its client/ or its server/, where that folder has a package.json), never a file of the original
// that sits at such a path: an original may serve /node_modules/… or /dist/…, and the copy keeps its files where the original
// served them (public/, site-files/, client/public/, client/dist/ of a lifted MERN copy, or the folder of a plain HTML copy).
// Every stack, through the real zip planner. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packagesOf, planZip, projectOwnFile } from '../src/recreate/export/zip.js';

const PKG = '{ "name": "x", "private": true, "scripts": { "build": "x" } }';

/** Each stack's project: [path, kept?]. A kept path is the original's file; the others are the project's own. */
const PROJECTS = {
  html: { mode: 'as-is', files: [
    ['index.html', true], ['node_modules/bootstrap/dist/css/bootstrap.min.css', true], ['dist/app.css', true], ['out/legacy.js', true],
  ] },
  'react-vite': { mode: 'as-is', converted: true, files: [
    ['package.json', true], ['src/routes.js', true], ['public/styles.css', true],
    ['public/node_modules/lib/a.js', true], ['public/dist/b.css', true], ['public/vendor/node_modules/c/d.js', true],
    ['node_modules/react/index.js', false], ['dist/index.html', false],
  ] },
  nextjs: { mode: 'as-is', converted: true, files: [
    ['package.json', true], ['pages/index.jsx', true], ['public/node_modules/lib/a.js', true], ['site-files/node_modules/x/y.js', true],
    ['site-files/out/z.css', true], ['node_modules/next/index.js', false], ['out/index.html', false],
  ] },
  'mern converted': { stack: 'mern', mode: 'as-is', converted: true, files: [
    ['package.json', true], ['server/src/app.js', true], ['server/forms.json', true], ['client/package.json', true], ['client/src/routes.js', true],
    ['client/public/node_modules/lib/a.js', true], ['client/public/dist/b.css', true],
    ['node_modules/express/index.js', false], ['client/node_modules/react/index.js', false], ['client/dist/index.html', false],
  ] },
  'mern lifted': { stack: 'mern', mode: 'as-is', files: [
    ['package.json', true], ['server/src/index.js', true], ['client/dist/index.html', true], ['client/dist/node_modules/lib/a.js', true],
    ['client/dist/dist/b.css', true], ['node_modules/express/index.js', false], ['server/node_modules/x/y.js', true],
  ] },
  'react-vite clean': { stack: 'react-vite', files: [
    ['package.json', true], ['src/main.jsx', true], ['public/node_modules/lib/a.js', true], ['node_modules/react/index.js', false], ['dist/index.html', false],
  ] },
};

test('the rule: a folder of the project\'s own packages, never one of the original\'s files', () => {
  const both = packagesOf(['package.json', 'client/package.json', 'public/node_modules/p/package.json']);
  assert.deepEqual([...both].sort(), ['', 'client'], 'only the project, client/ and server/ are its packages');
  assert.equal(projectOwnFile('node_modules/a/b.js', both), true);
  assert.equal(projectOwnFile('client/node_modules/a/b.js', both), true);
  assert.equal(projectOwnFile('client/dist/index.html', both), true);
  assert.equal(projectOwnFile('server/node_modules/a/b.js', both), false, 'server/ has no package.json here');
  assert.equal(projectOwnFile('public/node_modules/p/dist/x.js', both), false);
  assert.equal(projectOwnFile('node_modules', both), false, 'a file named node_modules is a file');
  assert.equal(projectOwnFile('node_modules/x.css', new Set()), false, 'no package.json: a plain copy\'s own folder');
});

test('every stack\'s download keeps the original\'s files under node_modules / dist paths and leaves out the project\'s own', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-zip-own-'));
  try {
    for (const [name, p] of Object.entries(PROJECTS)) {
      const stack = p.stack ?? name;
      const dir = path.join(root, name.replace(/\W+/g, '-'));
      const project = path.join(dir, 'stacks', stack);
      for (const [rel] of p.files) {
        await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
        await writeFile(path.join(project, rel), rel.endsWith('package.json') ? PKG : `/* ${rel} */`, 'utf8');
      }
      const report = {
        baseUrl: 'https://new.example', stack, safety: { safe: true },
        outputs: { [stack]: { status: 'ready', dir: path.join('stacks', stack), ...(p.mode && { mode: p.mode }) } },
        ...(p.mode && { asIs: { stack, ...(p.converted && { convert: { mode: 'converted', forms: [], fallbacks: [], wiredForms: 0 } }) } }),
      };
      const plan = await planZip({ dir, report, stack });
      const top = plan.name.replace(/\.zip$/, '');
      const names = new Set(plan.entries.map((e) => e.name.slice(top.length + 1)));
      for (const [rel, kept] of p.files) assert.equal(names.has(rel), kept, `${name}: ${rel} ${kept ? 'is the original\'s file: kept' : 'is the project\'s own: left out'}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
