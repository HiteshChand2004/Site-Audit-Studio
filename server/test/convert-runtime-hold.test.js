// The stack's runtime held against every page in a browser (recreate/convert/runtimeHold.js): a converted React + Vite copy
// of two pages is built, then one built page is made to differ from what its component renders (what a page React cannot
// hydrate looks like: the server's text and the browser's disagree). The check must ship that page without React — listed in
// scripts/no-runtime.json, its exported file set aside, and written so by the project's own build again — and keep React on
// the other page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildConvertedReact, CLIENT_BASE, convertToReact, REACT_EXPORT_DIR } from '../src/recreate/convert/react.js';
import { holdRuntime } from '../src/recreate/convert/runtimeHold.js';
import { toolchainStatus } from '../src/toolchains/index.js';

const ORIGIN = 'https://www.example-original.dev';
const page = (title, text) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><header><a href="/">Home</a> <a href="/other.html">Other</a></header><main><h1>${title}</h1><p id="text">${text}</p></main></body></html>\n`;

let root;
let outDir;
let pages;
let browser;
let held;

before(async () => {
  const tc = await toolchainStatus('react-vite');
  if (!tc.installed) throw new Error('the react-vite toolchain is not installed: npm run setup:toolchains -w server -- react-vite');
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-runtime-hold-'));
  const copyDir = path.join(root, 'copy');
  await mkdir(copyDir, { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), page('Home', 'The home page.'), 'utf8');
  await writeFile(path.join(copyDir, 'other.html'), page('Other', 'Written by the component.'), 'utf8');
  pages = ['index.html', 'other.html'].map((outPath) => ({ outPath, url: `${ORIGIN}/${outPath === 'index.html' ? '' : outPath}` }));
  outDir = path.join(root, 'react-vite');
  await convertToReact({ copyDir, outDir, pages, pageUrl: `${ORIGIN}/` });
  await buildConvertedReact(outDir);
  // The built page and its component now disagree: React cannot hydrate it as the server wrote it.
  const other = path.join(outDir, REACT_EXPORT_DIR, 'other.html');
  await writeFile(other, (await readFile(other, 'utf8')).replace('Written by the component.', 'Not what the component writes.'), 'utf8');
  browser = await chromium.launch({ headless: true });
  held = await holdRuntime({ browser, stack: 'react-vite', outDir, pages });
});

after(async () => {
  await browser?.close().catch(() => {});
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('the page React cannot hold ships without it; the other keeps React', { timeout: 10 * 60000 }, async () => {
  assert.equal(held.checked, 2, JSON.stringify(held));
  assert.deepEqual(held.dropped.map((d) => d.page), ['/other.html'], JSON.stringify(held));
  assert.equal(held.held, 1);
  assert.match(held.dropped[0].why, /hydration|drawn again/, held.dropped[0].why);
  assert.deepEqual(JSON.parse(await readFile(path.join(outDir, 'scripts', 'no-runtime.json'), 'utf8')), ['/other.html']);
  const dist = path.join(outDir, REACT_EXPORT_DIR);
  const home = await readFile(path.join(dist, 'index.html'), 'utf8');
  const other = await readFile(path.join(dist, 'other.html'), 'utf8');
  assert.ok(home.includes(`/${CLIENT_BASE}/`), 'the home page keeps React');
  assert.ok(!other.includes(`/${CLIENT_BASE}/`) && !other.includes('data-sas-boot'), `the page without React: ${other.slice(0, 300)}`);
  assert.ok(other.includes('Not what the component writes.'), 'the page itself is unchanged');
});

test('a page listed once is not checked again; the home page still holds', { timeout: 5 * 60000 }, async () => {
  const again = await holdRuntime({ browser, stack: 'react-vite', outDir, pages });
  // The listed page is not checked again; the home page still holds.
  assert.equal(again.checked, 1, JSON.stringify(again));
  assert.deepEqual(again.dropped, []);
});

test('the project\'s own build writes the listed page without React again', { timeout: 8 * 60000 }, async () => {
  await buildConvertedReact(outDir);
  const other = await readFile(path.join(outDir, REACT_EXPORT_DIR, 'other.html'), 'utf8');
  const home = await readFile(path.join(outDir, REACT_EXPORT_DIR, 'index.html'), 'utf8');
  assert.ok(!other.includes(`/${CLIENT_BASE}/`), 'rebuilt without React');
  assert.ok(other.includes('Written by the component.'), 'rebuilt from its component');
  assert.ok(home.includes(`/${CLIENT_BASE}/`), 'the home page rebuilt with React');
});
