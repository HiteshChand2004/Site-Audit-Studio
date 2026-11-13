// Progress inside the as-is "Building the new pages" step (user, 2026-11-13: a stop or a restart redid the whole step). A page's
// proven fixes are saved once its proof is over; a resumed job writes the page back as it was finished and looks at it no more.
// A saved part is used only by the same code and only for the same lifted page and first-pass fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { fixGate } from '../src/recreate/behavior/preserve/check.js';
import { openGenerateProgress } from '../src/recreate/behavior/preserve/generateProgress.js';

const SITE = 'https://www.example-original.dev/';
const ENGLISH = 'This page is about the work we do for our customers and the people who use what we make every day. '
  + 'We write about it here so that you can find out what it is, how it works and why it matters to the people who need it.';
const page = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><link rel="icon" href="data:,"><style>body{margin:0;font:18px sans-serif;background:#fff}</style></head>
<body><h1>${title}</h1><p>${ENGLISH}</p></body></html>`;
const pages = [{ outPath: 'index.html', url: SITE }, { outPath: 'about.html', url: `${SITE}about.html` }];

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

test('the progress store: a part is used only for the same code and the same lifted page', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await openGenerateProgress(dir, { resuming: false, code: 'release-1' });
  await a.saveLift(['index.html', 'about.html']);
  await a.savePage('index.html', 'sig-1', { fixes: [{ kind: 'head' }] }, '<html>fixed</html>');
  await a.savePerf('index.html', 'sig-1', { lcp: 1 });
  const b = await openGenerateProgress(dir, { resuming: true, code: 'release-1' });
  assert.ok(b.liftDone(['index.html', 'about.html']));
  assert.ok(!b.liftDone(['index.html']), 'other pages: the lift is not reused');
  assert.equal(String((await b.page('index.html', 'sig-1')).html), '<html>fixed</html>');
  assert.equal(await b.page('index.html', 'sig-2'), null, 'another lifted page: not reused');
  assert.deepEqual(await b.perf('index.html', 'sig-1'), { lcp: 1 });
  assert.deepEqual(b.reused, { lift: false, perf: 1, css: false, pages: 1 });
  const c = await openGenerateProgress(dir, { resuming: true, code: 'release-2' });
  assert.ok(!c.liftDone(['index.html', 'about.html']), 'another release: nothing is reused');
  assert.equal(await c.page('index.html', 'sig-1'), null);
  const fresh = await openGenerateProgress(dir, { resuming: false, code: 'release-2' });
  assert.equal(await fresh.perf('index.html', 'sig-1'), null, 'a job that does not continue another starts empty');
});

test('a resumed proof writes back each page as it was finished and looks at none of them again', { timeout: 10 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-progress-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lifted = path.join(root, 'lifted');
  await mkdir(lifted, { recursive: true });
  await writeFile(path.join(lifted, 'index.html'), page('Progress home page'));
  await writeFile(path.join(lifted, 'about.html'), page('Progress about page'));
  const progressDir = path.join(root, 'progress');

  // The job before the stop: both pages proven (real looks), each saved.
  const copy1 = path.join(root, 'copy1');
  await cp(lifted, copy1, { recursive: true });
  const looked1 = [];
  const lookGate1 = async (...args) => { looked1.push(args[3]); return fixGate(...args); };
  const p1 = await openGenerateProgress(progressDir, { resuming: false, code: 'same' });
  const r1 = await fixAndProve({ browser, copyDir: copy1, gateDir: `${copy1}-unfixed`, pages, siteUrl: SITE, newSiteUrl: null, speed: false, lookGate: lookGate1, progress: p1 });
  assert.ok(looked1.length >= 2, `both pages were looked at: ${JSON.stringify(looked1)}`);

  // The resumed job: the same lift, the same code. No look at all, the same pages, the same verdicts.
  const copy2 = path.join(root, 'copy2');
  await cp(lifted, copy2, { recursive: true });
  const looked2 = [];
  const lookGate2 = async (...args) => { looked2.push(args[3]); return fixGate(...args); };
  const p2 = await openGenerateProgress(progressDir, { resuming: true, code: 'same' });
  const r2 = await fixAndProve({ browser, copyDir: copy2, gateDir: `${copy2}-unfixed`, pages, siteUrl: SITE, newSiteUrl: null, speed: false, lookGate: lookGate2, progress: p2 });
  assert.deepEqual(looked2, [], 'nothing is looked at again');
  assert.equal(r2.resumed.pages, r1.pages.filter((p) => p.fixes.length || p.reverted).length);
  for (const f of ['index.html', 'about.html']) {
    assert.equal(await readFile(path.join(copy2, f), 'utf8'), await readFile(path.join(copy1, f), 'utf8'), `${f}: the page as it was finished`);
  }
  assert.deepEqual(r2.pages.map((p) => ({ path: p.path, fixes: p.fixes, reverted: p.reverted ?? null })), r1.pages.map((p) => ({ path: p.path, fixes: p.fixes, reverted: p.reverted ?? null })));

  // A changed lifted page is proven again; the unchanged one is still reused.
  const copy3 = path.join(root, 'copy3');
  await cp(lifted, copy3, { recursive: true });
  await writeFile(path.join(copy3, 'about.html'), page('Progress about page, edited'));
  const looked3 = [];
  const lookGate3 = async (...args) => { looked3.push(args[3]); return fixGate(...args); };
  const p3 = await openGenerateProgress(progressDir, { resuming: true, code: 'same' });
  await fixAndProve({ browser, copyDir: copy3, gateDir: `${copy3}-unfixed`, pages, siteUrl: SITE, newSiteUrl: null, speed: false, lookGate: lookGate3, progress: p3 });
  assert.ok(looked3.length >= 1 && looked3.every((x) => x === '/about.html'), `only the changed page is looked at: ${JSON.stringify(looked3)}`);
});
