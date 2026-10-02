// Recreate foundation: global job lock, pipeline budget/cleanup, workspace retention, routes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { exclusive } from '../src/jobs/manager.js';
import { registerEmitter, unregisterEmitter } from '../src/recreate/emit/index.js';
import { overallPct, recreateBudgetMs, RecreateError, roomForSecondBrowser, runRecreate, STAGES } from '../src/recreate/index.js';
import { analysisWarnings, parseRecreatePages, parseTargetDomain } from '../src/recreate/inputs.js';
import { pruneRecreates, recreateDir, recreateRoot } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';

const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projectIds = [];
function makeProject({ authorized = 1, stack = 'html', analyzedDaysAgo = 0, analysis = true } = {}) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'test', 'https://example.com/', ?, ?, ?, ?)`)
    .run(id, stack, authorized, now, now);
  if (analysis) {
    const analyzedAt = new Date(Date.now() - analyzedDaysAgo * 86400000).toISOString();
    db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
      .run(randomUUID(), id, analyzedAt, analyzedAt, JSON.stringify({ url: 'https://www.example.com/', analyzedAt }));
  }
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

let server;
let base;
const savedStages = { ...STAGES };
// Pipeline tests replace every stage: the real ones launch a browser and reach the network.
const stubStages = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/projects`;
});

after(async () => {
  Object.assign(STAGES, savedStages);
  server.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

test('the global lock runs jobs one at a time, in order', async () => {
  const log = [];
  const task = (name, ms) => async () => {
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
  };
  await Promise.all([exclusive(task('a', 30)), exclusive(task('b', 5)), exclusive(async () => { throw new Error('x'); }).catch(() => {}), exclusive(task('c', 1))]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('settings parsers and the budget', () => {
  assert.equal(parseRecreatePages(0), 0);
  assert.equal(parseRecreatePages('5'), 5);
  assert.equal(parseRecreatePages(21), null);
  assert.equal(parseRecreatePages(1.5), null);
  assert.deepEqual(parseTargetDomain('example.com/some/path'), { ok: true, value: 'https://example.com' });
  assert.deepEqual(parseTargetDomain('http://new.example.org'), { ok: true, value: 'http://new.example.org' });
  assert.deepEqual(parseTargetDomain(''), { ok: true, value: null });
  assert.deepEqual(parseTargetDomain(null), { ok: true, value: null });
  assert.equal(parseTargetDomain('ftp://example.com').ok, false);
  assert.equal(parseTargetDomain('https://user:pw@example.com').ok, false);
  assert.equal(parseTargetDomain('nodot').ok, false);
  assert.equal(recreateBudgetMs({}), 720000);
  assert.equal(recreateBudgetMs({ SAS_RECREATE_MINUTES: '3' }), 180000);
  assert.equal(recreateBudgetMs({ SAS_RECREATE_MINUTES: '0' }), 720000);
  assert.equal(overallPct('inspect', 0), 0);
  assert.equal(overallPct('responsive', 1), 100);
  // Running the sweep next to the steps that render pages: by free memory, or decided for the machine.
  assert.equal(roomForSecondBrowser({ SAS_RECREATE_OVERLAP: '1' }), true);
  assert.equal(roomForSecondBrowser({ SAS_RECREATE_OVERLAP: '0' }), false);
  assert.equal(typeof roomForSecondBrowser({}), 'boolean');
});

test('stale analyses produce a warning', () => {
  const fresh = { finishedAt: new Date().toISOString(), audit: { analyzedAt: new Date().toISOString() } };
  const old = { finishedAt: null, audit: { analyzedAt: new Date(Date.now() - 9 * 86400000).toISOString() } };
  assert.deepEqual(analysisWarnings(fresh), []);
  assert.match(analysisWarnings(old)[0], /9 days old/);
});

test('a successful run publishes the workspace with a report', async () => {
  const project = makeProject();
  const recreateId = randomUUID();
  const steps = [];
  const report = await runRecreate({
    project,
    recreateId,
    progress: (step, f) => f === 0 && steps.push(step),
    stages: { ...stubStages, generate: async (ctx) => ctx.report.pages.push({ path: '/' }) },
  });
  assert.deepEqual(steps, ['inspect', 'sweep', 'assets', 'generate', 'build', 'preview', 'responsive']);
  assert.equal(report.baseUrl, 'https://www.example.com');
  assert.deepEqual(report.pages, [{ path: '/' }]);
  const saved = JSON.parse(await readFile(`${recreateDir(project.id, recreateId)}/report.json`, 'utf8'));
  assert.equal(saved.recreateId, recreateId);
  assert.equal(await exists(`${recreateDir(project.id, recreateId)}.tmp`), false);
});

test('a failing step discards the workspace and runs cleanups', async () => {
  const project = makeProject();
  const recreateId = randomUUID();
  let disposed = false;
  await assert.rejects(
    runRecreate({
      project,
      recreateId,
      progress: () => {},
      stages: {
        ...stubStages,
        inspect: async (ctx) => ctx.defer(async () => { disposed = true; }),
        assets: async () => { throw new Error('boom'); },
      },
    }),
    /boom/,
  );
  assert.equal(disposed, true);
  assert.equal(await exists(recreateDir(project.id, recreateId)), false);
  assert.equal(await exists(`${recreateDir(project.id, recreateId)}.tmp`), false);
});

test('the time limit stops the job and aborts the running stage', async () => {
  const project = makeProject();
  const recreateId = randomUUID();
  let aborted = false;
  await assert.rejects(
    runRecreate({
      project,
      recreateId,
      progress: () => {},
      budgetMs: 150,
      stages: {
        ...stubStages,
        inspect: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => { aborted = true; resolve(); })),
      },
    }),
    (err) => err instanceof RecreateError && /time limit was reached during “Inspecting pages”/.test(err.message),
  );
  assert.equal(aborted, true);
  assert.equal(await exists(`${recreateDir(project.id, recreateId)}.tmp`), false);
});

test('without a completed analysis the pipeline refuses to start', async () => {
  const project = makeProject({ analysis: false });
  await assert.rejects(runRecreate({ project, recreateId: randomUUID(), progress: () => {} }), /Run Analyze first/);
});

test('retention keeps the latest 2 completed recreates and removes temporary folders', async () => {
  const project = makeProject();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const insert = db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at) VALUES (?, ?, 'done', 100, ?)`);
  ids.forEach((id, i) => insert.run(id, project.id, new Date(Date.now() + i * 1000).toISOString()));
  for (const id of ids) await mkdir(recreateDir(project.id, id), { recursive: true });
  await mkdir(`${recreateDir(project.id, randomUUID())}.tmp`, { recursive: true });
  const removed = await pruneRecreates(project.id);
  assert.equal(removed.length, 2);
  assert.deepEqual((await readdir(recreateRoot(project.id))).sort(), [ids[1], ids[2]].sort());
});

test('POST /recreate checks authorization, stack and a completed analysis', async () => {
  const post = (id) => fetch(`${base}/${id}/recreate`, { method: 'POST' });
  assert.equal((await post(randomUUID())).status, 404);
  assert.equal((await post(makeProject({ authorized: 0 }).id)).status, 403);
  // A stack that is listed but not built yet is refused.
  registerEmitter({ id: 'planned-x', label: 'Planned X', status: 'planned' });
  try {
    assert.equal((await post(makeProject({ stack: 'planned-x' }).id)).status, 400);
  } finally {
    unregisterEmitter('planned-x');
  }
  const noAnalysis = await post(makeProject({ analysis: false }).id);
  assert.equal(noAnalysis.status, 409);
  assert.match((await noAnalysis.json()).error, /Run Analyze first/);
});

test('POST /recreate runs a job, streams events and exposes the result', async () => {
  // Stub stages: route tests must not launch a browser or reach the network.
  for (const key of Object.keys(STAGES)) STAGES[key] = async () => {};
  const project = makeProject({ analyzedDaysAgo: 8 });
  const res = await fetch(`${base}/${project.id}/recreate`, { method: 'POST' });
  assert.equal(res.status, 202);
  const { recreateId, job, steps } = await res.json();
  assert.equal(steps.length, 7);
  assert.match(job.warnings[0], /8 days old/);

  const events = await (await fetch(`${base}/${project.id}/recreate/${recreateId}/events`)).text();
  assert.match(events, /event: done/);

  const latest = await (await fetch(`${base}/${project.id}/recreate`)).json();
  assert.equal(latest.last.status, 'done');
  assert.equal(latest.result.recreateId, recreateId);
  assert.match(latest.result.warnings[0], /8 days old/);
  Object.assign(STAGES, savedStages);
});

test('the sweep runs next to the steps after it and is awaited by the step that needs it', async () => {
  const project = makeProject();
  const log = [];
  const stage = (name, ms, extra) => async (ctx, local) => {
    log.push(`start ${name}`);
    await sleep(ms);
    await extra?.(ctx, local);
    log.push(`end ${name}`);
  };
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    canOverlap: () => true,
    stages: {
      ...stubStages,
      // Its own deadline and progress come as the second argument (the shared ones belong to the step in front).
      sweep: stage('sweep', 120, (ctx, local) => {
        assert.equal(typeof local.progress, 'function');
        assert.ok(local.stepDeadline > Date.now());
        ctx.sweep = { done: true };
      }),
      assets: stage('assets', 20),
      generate: stage('generate', 20),
      build: stage('build', 20),
      responsive: stage('responsive', 5, (ctx) => assert.deepEqual(ctx.sweep, { done: true })),
    },
  });
  assert.deepEqual(log, ['start sweep', 'start assets', 'end assets', 'start generate', 'end generate', 'start build', 'end build', 'end sweep', 'start responsive', 'end responsive']);
  // Every step is timed; the steps that overlapped add up to more than the job took.
  assert.deepEqual(Object.keys(report.timings).sort(), ['assets', 'build', 'generate', 'inspect', 'preview', 'responsive', 'sweep', 'total']);
  assert.ok(report.timings.sweep >= 110);
  assert.ok(report.timings.total < report.timings.sweep + report.timings.assets + report.timings.generate + report.timings.build);
});

test('short of memory, the sweep is finished before the next step that renders pages', async () => {
  const project = makeProject();
  const log = [];
  const stage = (name, ms) => async () => {
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
  };
  await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    canOverlap: () => false,
    stages: { ...stubStages, sweep: stage('sweep', 80), assets: stage('assets', 10), generate: stage('generate', 10) },
  });
  // It still overlaps the asset downloads (no browser), then generate waits for it.
  assert.deepEqual(log, ['start sweep', 'start assets', 'end assets', 'end sweep', 'start generate', 'end generate']);
});

test('a failing sweep is a warning; a failing step ends a sweep that is still running before the workspace goes', async () => {
  const project = makeProject();
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    stages: { ...stubStages, sweep: async () => { throw new Error('no browser'); } },
  });
  assert.ok(report.warnings.some((w) => /Capturing more widths.*failed \(no browser\)/.test(w)), report.warnings.join(' | '));

  const recreateId = randomUUID();
  let sweepEnded = false;
  await assert.rejects(
    runRecreate({
      project,
      recreateId,
      progress: () => {},
      canOverlap: () => true,
      stages: {
        ...stubStages,
        sweep: (ctx) => new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => { sweepEnded = true; reject(new Error('stopped')); })),
        generate: async () => { throw new Error('boom'); },
      },
    }),
    /boom/,
  );
  assert.equal(sweepEnded, true);
  assert.equal(await exists(`${recreateDir(project.id, recreateId)}.tmp`), false);
});
