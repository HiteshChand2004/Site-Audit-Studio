// Resume an interrupted Recreate (recreate/checkpoint.js): a job that fails or is interrupted keeps its work and continues
// where it stopped. Fixture site only; the page capture is replaced by a counting stand-in (the real one is covered by the
// capture tests), so these tests check what is reused and what runs again.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { checkpointPath, MAX_AUTO_RESUMES, readCheckpoint } from '../src/recreate/checkpoint.js';
import { RecreateError, runRecreate, STAGES } from '../src/recreate/index.js';
import { autoResume, recreateJobs, resumeInterruptedRecreates } from '../src/recreate/jobs.js';
import { findResumable, pruneRecreates, recreateDir, tmpDir } from '../src/recreate/workspace.js';
import recreateRouter from '../src/routes/recreate.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4188;
// Every test ends within this (a job waiting on an event that never comes fails instead of hanging the run).
const TEST_TIMEOUT = 120000;
const origin = `http://localhost:${PORT}`;
const exists = (p) => access(p).then(() => true, () => false);
let server;
let api;
let base;
const projectIds = [];
const savedStages = { ...STAGES };

before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
  const app = express();
  app.use(express.json());
  app.use('/api/projects', recreateRouter);
  await new Promise((resolve) => { api = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${api.address().port}/api/projects`;
});
after(async () => {
  Object.assign(STAGES, savedStages);
  server.close();
  api.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

function makeProject(recreatePages = 3) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, ?, ?, ?)`).run(id, `${origin}/`, recreatePages, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const insertRow = (projectId, recreateId, status, ms = 0) =>
  db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at) VALUES (?, ?, ?, 0, ?)`).run(recreateId, projectId, status, new Date(Date.now() + ms).toISOString());

const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));

/** Counts every step and page; `failOnCapture` = the nth page capture throws (a crash in the middle of the capture). */
function harness({ failOnCapture = 0, failIn = null } = {}) {
  const n = { captures: [], sweep: 0, assets: 0, generate: 0, build: 0 };
  let captureCalls = 0;
  const capturePage = async (_browser, info, workspace) => {
    captureCalls++;
    // A crash that ends the job (a failure of one page alone is reported for that page and never stops the others).
    if (failOnCapture && captureCalls === failOnCapture) throw new RecreateError('simulated crash');
    n.captures.push(info.path);
    await mkdir(path.join(workspace, 'capture', info.slug), { recursive: true });
    await writeFile(path.join(workspace, 'capture', info.slug, 'desktop.json'), JSON.stringify({ url: info.url }));
    return { views: { desktop: { file: 'desktop.json', status: 200, scrollHeight: 1000, reveal: { pinned: 0 } } }, errors: [] };
  };
  const fail = (key) => { if (failIn === key) throw new Error(`${key} failed`); };
  const stages = {
    ...stubs,
    inspect: (ctx) => {
      ctx.capturePage = capturePage;
      ctx.capturePages = 1; // one page at a time: the crash hits a known page
      return savedStages.inspect(ctx);
    },
    sweep: async (ctx) => {
      n.sweep++;
      ctx.sweep = { widths: [320], pages: Object.fromEntries(ctx.pages.map((p) => [p.slug, { widths: {} }])), notCaptured: [] };
      ctx.report.sweep = { status: 'done', pages: ctx.pages.length };
    },
    assets: async (ctx) => {
      n.assets++;
      await mkdir(path.join(ctx.dir, 'assets'), { recursive: true });
      await writeFile(path.join(ctx.dir, 'assets', 'manifest.json'), JSON.stringify({ files: [], map: {} }));
      ctx.assets = { dir: path.join(ctx.dir, 'assets'), map: { 'x': 'images/x.png' }, files: [] };
      ctx.report.assets = { downloaded: 0 };
      ctx.report.manual.push({ kind: 'asset', title: 'big video' });
      fail('assets');
    },
    generate: async (ctx) => {
      n.generate++;
      assert.ok(ctx.pages.length > 0, 'pages known');
      assert.equal(ctx.assets?.map?.x, 'images/x.png', 'assets known');
      fail('generate');
    },
    build: async () => { n.build++; },
  };
  return { n, stages };
}

const run = (project, recreateId, stages, extra = {}) => runRecreate({ project, recreateId, progress: () => {}, stages, ...extra });

test('a Recreate that crashes during the capture keeps its work and the resume captures only the missing pages', { timeout: TEST_TIMEOUT }, async () => {
  const project = makeProject(3);
  // The uninterrupted run, for comparison.
  const clean = harness();
  const reference = await run(project, randomUUID(), clean.stages);
  assert.equal(clean.n.captures.length, 4);

  const first = harness({ failOnCapture: 3 });
  const stopped = randomUUID();
  insertRow(project.id, stopped, 'failed', 1000);
  await assert.rejects(run(project, stopped, first.stages), /simulated crash/);
  assert.equal(first.n.captures.length, 2);
  // Kept, with what was done.
  assert.equal(await exists(checkpointPath(tmpDir(project.id, stopped))), true);
  const cp = await readCheckpoint(tmpDir(project.id, stopped));
  assert.equal(cp.discovery.pages.length, 4);
  assert.equal(Object.keys(cp.pages).length, 2);
  assert.equal(cp.stopped.step, 'inspect');
  assert.equal(cp.stopped.reason, 'error');
  const found = await findResumable(project.id);
  assert.equal(found.recreateId, stopped);
  assert.deepEqual({ pagesDone: found.summary.pagesDone, pagesTotal: found.summary.pagesTotal, step: found.summary.step }, { pagesDone: 2, pagesTotal: 4, step: 'inspect' });

  const second = harness();
  const resumedId = randomUUID();
  const report = await run(project, resumedId, second.stages, { resumeFrom: { recreateId: stopped } });
  assert.deepEqual(second.n.captures, clean.n.captures.slice(2), 'only the missing pages, in the same order');
  assert.deepEqual(report.pages, reference.pages, 'the same pages as an uninterrupted run');
  assert.deepEqual(report.discovery, reference.discovery);
  assert.equal(report.resumed.length, 1);
  assert.equal(report.resumed[0].pagesReused, 2);
  assert.equal(report.resumed[0].fromStep, 'inspect');
  assert.equal(report.resumed[0].fromRecreateId, stopped);
  assert.ok(report.warnings.includes('Continued after an interruption (2 pages reused).'), report.warnings.join(' | '));
  // Published under the new id; the old workspace was taken over; no checkpoint left in a finished recreate.
  assert.equal(await exists(recreateDir(project.id, resumedId)), true);
  assert.equal(await exists(tmpDir(project.id, stopped)), false);
  assert.equal(await exists(path.join(recreateDir(project.id, resumedId), 'checkpoint.json')), false);
  for (const p of report.pages) assert.equal(await exists(path.join(recreateDir(project.id, resumedId), 'capture', p.slug, 'desktop.json')), true, p.slug);
});

test('a failure after the asset step resumes at generate: nothing captured, swept or downloaded again', { timeout: TEST_TIMEOUT }, async () => {
  const project = makeProject(2);
  const first = harness({ failIn: 'generate' });
  const stopped = randomUUID();
  insertRow(project.id, stopped, 'failed');
  await assert.rejects(run(project, stopped, first.stages), /generate failed/);
  assert.deepEqual([first.n.captures.length, first.n.sweep, first.n.assets, first.n.generate], [3, 1, 1, 1]);
  const cp = await readCheckpoint(tmpDir(project.id, stopped));
  assert.deepEqual(Object.keys(cp.steps).sort(), ['assets', 'inspect', 'sweep']);
  assert.equal((await findResumable(project.id)).summary.step, 'generate');

  const second = harness();
  const report = await run(project, randomUUID(), second.stages, { resumeFrom: { recreateId: stopped } });
  assert.deepEqual([second.n.captures.length, second.n.sweep, second.n.assets, second.n.generate, second.n.build], [0, 0, 0, 1, 1]);
  assert.equal(report.pages.length, 3);
  assert.deepEqual(report.assets, { downloaded: 0 });
  assert.equal(report.sweep.status, 'done');
  assert.equal(report.manual.filter((m) => m.title === 'big video').length, 1, 'restored items are not doubled');
  assert.deepEqual(report.resumed[0].stepsReused.sort(), ['assets', 'inspect', 'sweep']);
  assert.equal(report.resumed[0].fromStep, 'generate');
});

test('a Recreate interrupted by a server restart continues by itself when the server starts', { timeout: TEST_TIMEOUT }, async () => {
  const project = makeProject(2);
  const first = harness({ failOnCapture: 2 });
  const stopped = randomUUID();
  insertRow(project.id, stopped, 'running');
  await assert.rejects(run(project, stopped, first.stages), /simulated crash/);
  // The process died: nothing recorded the stop, and the database marked the row failed on start.
  const file = checkpointPath(tmpDir(project.id, stopped));
  const cp = JSON.parse(await readFile(file, 'utf8'));
  delete cp.stopped;
  await writeFile(file, JSON.stringify(cp));
  db.prepare(`UPDATE recreates SET status = 'failed', error = 'The server restarted while this job was running. Run it again.' WHERE id = ?`).run(stopped);

  const second = harness();
  Object.assign(STAGES, second.stages);
  try {
    const [job] = await resumeInterruptedRecreates([{ id: stopped, project_id: project.id }]);
    assert.ok(job, 'a job was started');
    // Finished already, or wait for its end.
    const done = await new Promise((resolve) => {
      recreateJobs.on(job.id, (type, snap) => (type === 'done' || type === 'failed') && resolve({ type, snap }));
      const now = recreateJobs.get(job.id);
      if (now?.status === 'done' || now?.status === 'failed') resolve({ type: now.status, snap: now });
    });
    assert.equal(done.type, 'done', done.snap.error);
    const row = db.prepare('SELECT status, result_json FROM recreates WHERE id = ?').get(job.id);
    const report = JSON.parse(row.result_json);
    assert.equal(report.resumed[0].reason, 'restart');
    assert.equal(report.resumed[0].auto, true);
    assert.equal(report.resumed[0].pagesReused, 1);
    assert.equal(second.n.captures.length, 2);
    assert.match(db.prepare('SELECT error FROM recreates WHERE id = ?').get(stopped).error, /continues where it stopped/);
    // At most a few times in a row: work already continued automatically MAX_AUTO_RESUMES times is left to the user.
    // (Another project: the finished job's cleanup prunes stray workspaces of its own project while this runs.)
    const other = makeProject(2);
    const tired = randomUUID();
    await mkdir(tmpDir(other.id, tired), { recursive: true });
    await writeFile(checkpointPath(tmpDir(other.id, tired)), JSON.stringify({ ...cp, autoResumes: MAX_AUTO_RESUMES }));
    assert.deepEqual(await resumeInterruptedRecreates([{ id: tired, project_id: other.id }]), []);
    // A time-limit stop continues by itself only when that attempt got further.
    await writeFile(checkpointPath(tmpDir(other.id, tired)), JSON.stringify({ ...cp, stopped: { reason: 'time-limit', progressed: false } }));
    assert.equal(await autoResume(other, tired, 'time-limit'), null);
  } finally {
    Object.assign(STAGES, savedStages);
  }
});

test('a newer successful recreate removes the kept work; until then retention keeps it', { timeout: TEST_TIMEOUT }, async () => {
  const project = makeProject(1);
  const stopped = randomUUID();
  insertRow(project.id, stopped, 'failed');
  await assert.rejects(run(project, stopped, harness({ failIn: 'generate' }).stages), /generate failed/);
  await pruneRecreates(project.id);
  assert.equal(await exists(tmpDir(project.id, stopped)), true, 'kept while it can be continued');
  const newer = randomUUID();
  insertRow(project.id, newer, 'done', 5000);
  await mkdir(recreateDir(project.id, newer), { recursive: true });
  assert.equal(await findResumable(project.id), null);
  await pruneRecreates(project.id);
  assert.equal(await exists(tmpDir(project.id, stopped)), false);
  assert.equal(await exists(recreateDir(project.id, newer)), true);
});

test('nothing to resume: clear errors', { timeout: TEST_TIMEOUT }, async () => {
  const project = makeProject(1);
  const res = await fetch(`${base}/${project.id}/recreate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume: true }) });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no stopped recreate to continue/);
  const latest = await (await fetch(`${base}/${project.id}/recreate`)).json();
  assert.equal(latest.resumable, null);
  await assert.rejects(run(project, randomUUID(), stubs, { resumeFrom: { recreateId: randomUUID() } }), (err) => err instanceof RecreateError && /no longer there/.test(err.message));
  // A failure before the pages were found keeps nothing.
  const id = randomUUID();
  await assert.rejects(run(project, id, { ...stubs, inspect: async () => { throw new Error('early'); } }), /early/);
  assert.equal(await exists(tmpDir(project.id, id)), false);
});

test('GET /recreate offers the stopped recreate and POST { resume: true } continues it', { timeout: TEST_TIMEOUT }, async () => {
  const project = makeProject(1);
  const stopped = randomUUID();
  insertRow(project.id, stopped, 'failed');
  await assert.rejects(run(project, stopped, harness({ failIn: 'generate' }).stages), /generate failed/);
  const latest = await (await fetch(`${base}/${project.id}/recreate`)).json();
  assert.equal(latest.resumable.recreateId, stopped);
  assert.equal(latest.resumable.pagesDone, 2);
  assert.equal(latest.resumable.step, 'generate');
  assert.equal(latest.resumable.reason, 'error');

  const second = harness();
  Object.assign(STAGES, second.stages);
  try {
    const res = await fetch(`${base}/${project.id}/recreate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume: true }) });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.resumeFrom.recreateId, stopped);
    const events = await (await fetch(`${base}/${project.id}/recreate/${body.recreateId}/events`)).text();
    assert.match(events, /event: done/);
    assert.equal(second.n.captures.length, 0);
    assert.equal(second.n.generate, 1);
    assert.equal((await (await fetch(`${base}/${project.id}/recreate`)).json()).resumable, null);
  } finally {
    Object.assign(STAGES, savedStages);
  }
});
