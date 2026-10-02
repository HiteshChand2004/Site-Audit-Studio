// Speed and robustness of the pipelines: how much runs at once (by free memory), time kept for the steps that must still
// run, progress of steps that overlap, and an analysis of a page whose third-party resources never answer.
// Everything is local: the slow site is a server on 127.0.0.1.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIGHTHOUSE_RESERVE_MS, runAnalysis, stepBudget, STEPS } from '../src/audit/index.js';
import { parallelism } from '../src/audit/resources.js';
import { launchBrowser } from '../src/audit/render.js';
import { captureScreenshots } from '../src/audit/screenshots.js';
import { progressTracker } from '../src/jobs/manager.js';
import { createNetPolicy } from '../src/security/netGuard.js';

const exists = (p) => access(p).then(() => true, () => false);

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="A page used to test slow third-party resources in the audit pipeline.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

let server;
let origin;
let dir;
const sockets = new Set();

before(async () => {
  // The homepage embeds an image and a frame that never answer (a dead tracker, a hanging embed): its load event never fires.
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/hang')) return;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/') {
      return res.end(page('Slow third party', '<p>Hello</p><a href="/about.html">About</a><img src="/hang.png" alt="tracker" width="10" height="10"><iframe src="/hang-embed" title="embed" width="200" height="100"></iframe>'));
    }
    if (req.url === '/about.html') return res.end(page('About', '<p>About us</p><a href="/">Home</a>'));
    res.statusCode = 404;
    res.end('not found');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-perf-'));
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('parallel work is chosen from the free memory', () => {
  assert.equal(parallelism({ free: 8000, perUnitMB: 350, max: 3 }), 3);
  assert.equal(parallelism({ free: 1600, perUnitMB: 350, max: 4, keepFreeMB: 800 }), 2);
  // About 1 GB available is enough for four pages at once; only a machine that has really run out is cut back.
  assert.equal(parallelism({ free: 1000, max: 4 }), 4);
  assert.equal(parallelism({ free: 620, max: 4 }), 2);
  assert.equal(parallelism({ free: 200, max: 4 }), 1);
  assert.equal(parallelism({ free: Infinity, max: 3 }), 3);
  // Short of memory: one at a time, never zero (unless the caller asks whether anything fits at all).
  assert.equal(parallelism({ free: 300, perUnitMB: 350, max: 4 }), 1);
  assert.equal(parallelism({ free: 300, perUnitMB: 350, max: 4, min: 2 }), 2);
  assert.equal(parallelism({ free: 300, perUnitMB: 1000, max: 1, min: 0 }), 0);
  assert.equal(parallelism({ free: NaN }), 1);
  const now = parallelism({ max: 4 });
  assert.ok(now >= 1 && now <= 4);
});

test('a step never uses the time kept for the steps after it', () => {
  // Plenty of time: the step's own limit.
  assert.equal(stepBudget({ max: 75000, now: 0, deadline: 360000, reserve: 120000 }), 75000);
  // Little time: what is left after the reserve, so Lighthouse still runs.
  assert.equal(stepBudget({ max: 75000, now: 200000, deadline: 360000, reserve: 120000 }), 40000);
  assert.ok(stepBudget({ max: 75000, now: 250000, deadline: 360000, reserve: 120000 }) < 5000);
  // The last steps have no reserve.
  assert.equal(stepBudget({ max: 120000, now: 300000, deadline: 360000 }), 60000);
  // The limits of the steps before Lighthouse fit in the budget in front of the reserve, even one after the other.
  const max = (key) => STEPS.find((s) => s.key === key).max;
  assert.ok(max('render') + max('crawl') + max('links') <= 6 * 60000 - LIGHTHOUSE_RESERVE_MS);
});

test('progress of overlapping steps: the bar adds up and the step shown is the earliest one still running', () => {
  const steps = [
    { key: 'a', weight: 10 },
    { key: 'b', weight: 30 },
    { key: 'c', weight: 20 },
    { key: 'd', weight: 40 },
  ];
  const track = progressTracker(steps);
  assert.deepEqual(track('a', 1), { step: 'a', pct: 10 });
  // b and c run side by side.
  assert.deepEqual(track('b', 0), { step: 'b', pct: 10 });
  assert.deepEqual(track('c', 0.5), { step: 'b', pct: 20 });
  assert.deepEqual(track('c', 1), { step: 'b', pct: 30 });
  assert.deepEqual(track('b', 0.5), { step: 'b', pct: 45 });
  // A step never goes back.
  assert.deepEqual(track('b', 0.2), { step: 'b', pct: 45 });
  assert.deepEqual(track('b', 1), { step: 'b', pct: 60 });
  assert.deepEqual(track('d', 0), { step: 'd', pct: 60 });
  assert.deepEqual(track('d', 1), { step: 'd', pct: 100 });
  // Steps without weights: the caller's own percentage, one step at a time.
  const plain = progressTracker([{ key: 'x' }, { key: 'y' }], (step, f) => (step === 'x' ? 50 * f : 50 + 50 * f));
  assert.deepEqual(plain('x', 0.5), { step: 'x', pct: 25 });
  assert.deepEqual(plain('y', 1), { step: 'x', pct: 100 });
});

test('an analysis is complete when third-party resources of the page never answer', async () => {
  const outDir = path.join(dir, 'analysis');
  const started = Date.now();
  const running = new Map();
  let overlapped = false;
  const audit = await runAnalysis({
    project: { id: 'perf', url: `${origin}/`, name: 'perf' },
    analysisId: 'a1',
    maxPages: 5,
    outDir,
    skip: ['lighthouse-mobile', 'lighthouse-desktop'],
    netPolicy: createNetPolicy({ internalPorts: [server.address().port] }),
    progress: (step, fraction) => {
      if (fraction < 1) running.set(step, true);
      else running.delete(step);
      if (running.has('render') && running.has('screenshots')) overlapped = true;
    },
  });
  const seconds = (Date.now() - started) / 1000;
  // The document is there at once; the load event that never comes only gets a bounded wait.
  assert.deepEqual(audit.errors, [], JSON.stringify(audit.errors));
  assert.ok(seconds < 75, `took ${seconds}s`);
  assert.ok(overlapped, 'render and screenshots run side by side');
  assert.equal(audit.pagesCrawled, 2);
  for (const view of ['desktop', 'tablet', 'mobile']) {
    assert.ok(audit.screenshots?.views?.[view], `${view} screenshot`);
    assert.ok(await exists(path.join(outDir, 'screens', `${view}-full.webp`)));
  }
  // The accessibility scan ran on the rendered page.
  assert.ok(await exists(path.join(outDir, 'axe.json')));
});

test('screenshots: the views taken in time are kept when the step runs out of it', async () => {
  const browser = await launchBrowser();
  try {
    // One view at a time and a deadline that only the first view can meet.
    const shots = await captureScreenshots(browser, `${origin}/about.html`, path.join(dir, 'late'), { parallel: 1, deadline: Date.now() + 100 });
    assert.equal(Object.keys(shots.views).length, 0);
    assert.equal(shots.errors.length, 3);
    assert.match(shots.errors[0].message, /time limit/);

    const some = await captureScreenshots(browser, `${origin}/about.html`, path.join(dir, 'some'), { parallel: 1, deadline: Date.now() + 60000 });
    assert.deepEqual(Object.keys(some.views), ['desktop', 'tablet', 'mobile']);
    assert.deepEqual(some.errors, []);
  } finally {
    await browser.close();
  }
});
