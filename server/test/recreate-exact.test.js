// Exact mode, phase 0: the setting, a run with no time limit, stopping a run that may take hours, the "as is" profile
// (the fixes that change pixels on purpose are left out) and downloads that survive a flaky network.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { withTimeout } from '../src/audit/util.js';
import { extendableTimeout } from '../src/recreate/interrupts.js';
import { isExactMode, parseExactMode } from '../src/recreate/inputs.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { downloadAsset } from '../src/recreate/assets/download.js';
import { applyTreeFixes } from '../src/recreate/fixers/index.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import projectsRouter from '../src/routes/projects.js';
import recreateRouter from '../src/routes/recreate.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
process.env.SAS_KEEP_AWAKE = '0';
process.env.SAS_NETWORK_WATCH = '0';

const PORT = 4202;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projectIds = [];
function makeProject({ exactMode = 0 } = {}) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  seedProject(db, { id, name: 'test', url: 'https://example.com/', stack: 'html', authorized: 1, recreatePages: -1, exactMode, analysis: true });
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

// Every stage replaced: the real ones launch a browser and reach the network.
const savedStages = { ...STAGES };
const stubStages = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));

let app;
let server;
let base;
// A server that fails the way a flaky network does: twice unavailable, then the file; and one that drops a transfer
// half way but lets it be continued (Range).
let flaky;
let flakyBase;
const BODY = Buffer.alloc(200 * 1024, 7);
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');
let flakyHits = 0;
let brokenHits = 0;

before(async () => {
  app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', recreateRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/projects`;

  flaky = createServer((req, res) => {
    if (req.url === '/flaky.png') {
      flakyHits++;
      if (flakyHits <= 2) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('busy');
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(BODY.length), 'Accept-Ranges': 'bytes' });
      return res.end(BODY);
    }
    if (req.url === '/broken.png') {
      brokenHits++;
      const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
      if (range) {
        const from = Number(range[1]);
        res.writeHead(206, {
          'Content-Type': 'image/png',
          'Content-Range': `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
          'Content-Length': String(BODY.length - from),
          'Accept-Ranges': 'bytes',
        });
        return res.end(BODY.subarray(from));
      }
      // The first attempt: headers promise the whole file, then the connection dies part way through.
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(BODY.length), 'Accept-Ranges': 'bytes' });
      res.write(BODY.subarray(0, 120 * 1024));
      return setTimeout(() => res.socket?.destroy(), 20);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => { flaky.listen(PORT, '127.0.0.1', resolve); });
  flakyBase = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  Object.assign(STAGES, savedStages);
  server.close();
  flaky.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

test('the exact-mode setting: what a body may say, and what the project then is', () => {
  for (const yes of [true, 1, '1', 'true']) assert.equal(parseExactMode(yes), 1);
  for (const no of [false, 0, '0', 'false']) assert.equal(parseExactMode(no), 0);
  for (const junk of ['yes', 2, null, undefined, {}]) assert.equal(parseExactMode(junk), null);
  assert.equal(isExactMode({ exact_mode: 1 }), true);
  assert.equal(isExactMode({ exact_mode: 0 }), false);
  assert.equal(isExactMode(null), false);
});

test('PATCH stores exact mode and gives it back as a boolean; a value that is neither is refused', async () => {
  const project = makeProject();
  const on = await fetch(`${base}/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exact_mode: true }),
  });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).exact_mode, true);
  assert.equal(db.prepare('SELECT exact_mode FROM projects WHERE id = ?').get(project.id).exact_mode, 1);

  const off = await fetch(`${base}/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exact_mode: false }),
  });
  assert.equal((await off.json()).exact_mode, false);

  const bad = await fetch(`${base}/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exact_mode: 'maybe' }),
  });
  assert.equal(bad.status, 400);
  // The other settings are untouched by a refused one.
  assert.equal(db.prepare('SELECT recreate_pages FROM projects WHERE id = ?').get(project.id).recreate_pages, -1);
});

test('POST /recreate takes an exact copy for one run, and refuses two ways of starting at once', async () => {
  Object.assign(STAGES, stubStages);
  const project = makeProject();
  const res = await fetch(`${base}/${project.id}/recreate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exact: true }),
  });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).exact, true);
  await sleep(150);

  const both = await fetch(`${base}/${project.id}/recreate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume: true, reuseCapture: true }),
  });
  assert.equal(both.status, 400);

  const junk = await fetch(`${base}/${project.id}/recreate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exact: 'maybe' }),
  });
  assert.equal(junk.status, 400);
  Object.assign(STAGES, savedStages);
});

test('POST /recreate/stop says so when nothing is running', async () => {
  const project = makeProject();
  const res = await fetch(`${base}/${project.id}/recreate/stop`, { method: 'POST' });
  assert.equal(res.status, 409);
});

test('no limit means no limit: a timer that is never armed, and deadlines that never arrive', async () => {
  // A limit of Infinity cannot be held by setTimeout (Node clamps it to 1 ms and fires at once), so nothing is armed.
  let fired = false;
  const timer = extendableTimeout(Infinity, () => { fired = true; });
  await sleep(60);
  timer.clear();
  assert.equal(fired, false);
  assert.equal(await withTimeout(Promise.resolve('through'), Infinity, 'anything'), 'through');
});

test('an exact run: the pipeline carries the mode, and no step has a limit', async () => {
  const project = makeProject({ exactMode: 1 });
  const seen = [];
  const stages = {
    ...stubStages,
    inspect: async (ctx, local) => {
      seen.push({
        exact: ctx.exact,
        unlimited: ctx.unlimited,
        pageCapMin: ctx.pageCapMin,
        allPages: ctx.allPages,
        pageLimit: ctx.pageLimit,
        step: local.stepDeadline,
        job: ctx.jobDeadline,
        shown: ctx.report.exact,
      });
    },
  };
  await runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages, exact: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].exact, true);
  assert.equal(seen[0].unlimited, true);
  assert.equal(seen[0].step, Infinity, 'a step of an exact run has no limit');
  assert.equal(seen[0].job, Infinity, 'the job has no limit either');
  // A page that stalls is still abandoned, just given much longer first.
  assert.equal(seen[0].pageCapMin, 10 * 60000);
  assert.deepEqual(seen[0].shown, { mode: 'exact', asIs: null });
  // An exact copy is of the whole site, whatever the project's page setting says.
  assert.equal(seen[0].allPages, true);
  assert.ok(seen[0].pageLimit > 100);
});

test('a normal run is unchanged: its steps and its job keep their limits', async () => {
  const project = makeProject();
  let seen = null;
  const stages = { ...stubStages, inspect: async (ctx, local) => { seen = { ...ctx, step: local.stepDeadline }; } };
  await runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages });
  assert.equal(seen.exact, false);
  assert.equal(seen.unlimited, false);
  assert.equal(seen.pageCapMin, undefined);
  assert.ok(Number.isFinite(seen.step), 'a normal step still has a limit');
  assert.ok(Number.isFinite(seen.jobDeadline));
  assert.equal(seen.report.exact, null);
});

test('stopping: the step in front ends at once, and the failure says it was stopped', async () => {
  const project = makeProject();
  const controller = new AbortController();
  let started = false;
  const stages = {
    ...stubStages,
    // A step that would never finish by itself: only the stop can end it.
    inspect: async () => { started = true; await new Promise(() => {}); },
  };
  const run = runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages, unlimited: true, signal: controller.signal });
  while (!started) await sleep(10);
  controller.abort();
  const err = await run.then(() => null, (e) => e);
  assert.ok(err, 'the run ends');
  assert.equal(err.stopped, true);
  assert.match(err.message, /stopped/i);
});

test('stopping between two steps: the next one does not start', async () => {
  const project = makeProject();
  const controller = new AbortController();
  const ran = [];
  const stages = {
    ...stubStages,
    // The stop lands while no step is running, which a listener on an already-aborted signal would never report.
    inspect: async () => { ran.push('inspect'); controller.abort(); },
    assets: async () => { ran.push('assets'); },
  };
  const err = await runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages, signal: controller.signal })
    .then(() => null, (e) => e);
  assert.equal(err?.stopped, true);
  assert.deepEqual(ran, ['inspect'], 'the step after the stop never ran');
});

test('stopping before the job starts: nothing is opened', async () => {
  const project = makeProject();
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  const stages = { ...stubStages, inspect: async () => { ran = true; } };
  const err = await runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages, signal: controller.signal })
    .then(() => null, (e) => e);
  assert.equal(err?.stopped, true);
  assert.equal(ran, false);
});

test('as is: the fixes that change pixels on purpose are left out, the ones that do not still run', () => {
  const view = (style) => ({ rect: [0, 0, 400, 60], style });
  const el = (tag, children = [], { style = {}, attrs = {} } = {}) => ({ tag, attrs, views: { desktop: view(style) }, children });
  const txt = (text) => ({ text });
  // Grey on white: a real contrast failure. Plus an image with no alt text, which is not a pixel.
  const page = () => ({
    info: { path: '/', outPath: 'index.html', url: 'https://example.com/' },
    root: el('body', [
      el('p', [txt('Hard to read on white')], { style: { color: 'rgb(190, 190, 190)', 'background-color': 'rgb(255, 255, 255)' } }),
      el('img', [], { attrs: { src: 'assets/images/team-photo.png' } }),
    ], { style: { 'background-color': 'rgb(255, 255, 255)' } }),
    head: { title: 'Home', description: 'A page of the test site that is long enough to pass as a description.', meta: [] },
    headAuto: [],
  });
  const site = (tree) => ({
    pages: [tree],
    origin: 'https://example.com',
    resolveLink: () => null,
    siteName: { value: 'Example' },
  });
  const audit = { brokenLinks: { broken: [] }, techStack: [] };

  const normal = applyTreeFixes(site(page()), { audit });
  const asIs = applyTreeFixes(site(page()), { audit, asIs: true });

  assert.ok(normal.contrast.fixed.length > 0, 'the normal copy corrects the colour');
  assert.equal(asIs.contrast.fixed.length, 0, 'the exact copy copies the colour');
  assert.equal(asIs.contrast.open.length, 0);
  assert.equal(asIs.layouts, 0);
  assert.equal(asIs.sprites, 0);
  assert.equal(asIs.links.length, 0);
  // Alt text costs no pixel, so it is added in both.
  assert.equal(asIs.alt.fixed.length + asIs.alt.decorative.length, normal.alt.fixed.length + normal.alt.decorative.length);
});

test('a download survives a server that is briefly unavailable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-exact-'));
  try {
    flakyHits = 0;
    const r = await withNetPolicy(userPolicy(), () => downloadAsset(`${flakyBase}/flaky.png`, {
      dir, kind: 'image', maxBytes: 15 * 1024 * 1024, timeout: 10000, attempts: 3, idleMs: 5000,
    }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.bytes, BODY.length);
    assert.equal(r.sha256, BODY_SHA);
    assert.equal(r.attempts, 3, 'it needed all three attempts');
    assert.equal(flakyHits, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transfer that breaks off is continued where it stopped, not started again', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-exact-'));
  try {
    brokenHits = 0;
    const r = await withNetPolicy(userPolicy(), () => downloadAsset(`${flakyBase}/broken.png`, {
      dir, kind: 'image', maxBytes: 15 * 1024 * 1024, timeout: 10000, attempts: 3, idleMs: 5000,
    }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.resumed, true);
    assert.equal(r.bytes, BODY.length, 'the whole file is there');
    assert.equal(r.sha256, BODY_SHA, 'and it is the same bytes as the original');
    assert.equal(brokenHits, 2, 'the second request asked only for the rest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one attempt is still one attempt: a 404 is an answer, not something to retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-exact-'));
  try {
    const r = await withNetPolicy(userPolicy(), () => downloadAsset(`${flakyBase}/missing.png`, {
      dir, kind: 'image', maxBytes: 1024, timeout: 5000, attempts: 3,
    }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http-404');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
