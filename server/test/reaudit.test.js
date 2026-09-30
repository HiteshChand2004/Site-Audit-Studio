// Re-audit foundation (Phase 5.1): the Analyze pipeline on a recreated site's dist/, served on a
// throwaway loopback port that only this run may reach; job, routes, retention.
// Lighthouse is left out here (it is the unchanged Analyze step); everything else runs for real.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import { overallPct, pagePath, runReaudit, STEPS } from '../src/reaudit/index.js';
import { JOB_OPTIONS } from '../src/reaudit/jobs.js';
import { recreateDir } from '../src/recreate/workspace.js';
import reauditRouter from '../src/routes/reaudit.js';

// The re-audit must reach its own server without the dev flag; other loopback ports stay blocked.
delete process.env.SAS_ALLOW_LOCALHOST;

const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST_SKIP = ['screenshots', 'lighthouse-mobile', 'lighthouse-desktop'];

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="${title} of the recreated test site, used by the re-audit tests.">
<link rel="stylesheet" href="/css/site.css"></head><body><main>${body}</main></body></html>`;

const PAGES = {
  'index.html': page('Home page', `<h1>Home</h1>
    <p><a href="about/">About</a> <a href="missing.html">Gone</a> <a href="http://127.0.0.1:9/elsewhere">Other local server</a></p>
    <img src="/img/dot.svg" width="10" height="10">`),
  'about/index.html': page('About page', '<h1>About</h1><p><a href="../">Home</a></p>'),
  // Linked from nowhere: only the seed URLs reach it.
  'hidden/index.html': page('Hidden page', '<h1>Hidden</h1><p>Only in the recreate report.</p>'),
};

const projectIds = [];
function makeProject({ authorized = 1 } = {}) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'test', 'https://example.com/', 'html', ?, ?, ?)`)
    .run(id, authorized, now, now);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

/** A completed recreate row with a dist/ build of PAGES. */
async function makeRecreate(project, { startedAt = new Date().toISOString(), build = true } = {}) {
  const recreateId = randomUUID();
  const report = { recreateId, analysisId: 'analysis-1', pages: Object.keys(PAGES).map((outPath) => ({ outPath })) };
  db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(recreateId, project.id, startedAt, startedAt, JSON.stringify(report));
  if (build) {
    const dist = path.join(recreateDir(project.id, recreateId), 'dist');
    for (const [file, html] of Object.entries(PAGES)) {
      await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
      await writeFile(path.join(dist, file), html);
    }
    await mkdir(path.join(dist, 'css'), { recursive: true });
    await writeFile(path.join(dist, 'css', 'site.css'), 'body{font-family:sans-serif}');
    await mkdir(path.join(dist, 'img'), { recursive: true });
    await writeFile(path.join(dist, 'img', 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
  }
  return recreateId;
}

let server;
let base;
const savedSkip = JOB_OPTIONS.skip;

before(async () => {
  JOB_OPTIONS.skip = FAST_SKIP;
  const app = express();
  app.use(express.json());
  app.use('/api/projects', reauditRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/projects`;
});

after(async () => {
  JOB_OPTIONS.skip = savedSkip;
  server.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

test('steps: serve first, no screenshots, progress reaches 100', () => {
  assert.equal(STEPS[0].key, 'serve');
  assert.ok(!STEPS.some((s) => s.key === 'screenshots'));
  assert.ok(STEPS.some((s) => s.key === 'lighthouse-mobile'));
  assert.equal(overallPct('report', 1), 100);
  assert.equal(overallPct('serve', 0), 0);
  assert.equal(pagePath('index.html'), '');
  assert.equal(pagePath('about/index.html'), 'about/');
  assert.equal(pagePath('about.html'), 'about.html');
});

test('runReaudit audits the recreated build on its own throwaway port', { timeout: 120000 }, async () => {
  const project = makeProject();
  const recreateId = await makeRecreate(project);
  const steps = new Set();
  const result = await runReaudit({ project, reauditId: 'r1', recreateId, skip: FAST_SKIP, progress: (s) => steps.add(s) });

  assert.equal(result.recreateId, recreateId);
  assert.equal(result.analysisId, 'analysis-1');
  assert.match(result.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(result.pages, ['', 'about/', 'hidden/']);
  const { audit } = result;
  assert.equal(audit.isDummy, false);
  assert.equal(audit.url, `${result.origin}/`);
  assert.equal(audit.recreate, undefined);
  assert.equal(audit.screenshots, null);

  // Every recreated page is audited, including the one nothing links to.
  assert.equal(audit.pagesCrawled, 3);
  // The broken internal link is found; another loopback port stays blocked by the SSRF policy.
  assert.ok(audit.brokenLinks.broken.some((l) => l.url.endsWith('/missing.html')), JSON.stringify(audit.brokenLinks));
  assert.ok(audit.brokenLinks.unverified.some((l) => l.url.startsWith('http://127.0.0.1:9/')), JSON.stringify(audit.brokenLinks));
  // axe ran on the homepage (the image has no alt).
  assert.ok(audit.accessibility.some((a) => a.id === 'image-alt'), JSON.stringify(audit.accessibility));
  // Left-out steps are not errors; Lighthouse was left out only by this test.
  assert.ok(!audit.errors.some((e) => e.step === 'screenshots'), JSON.stringify(audit.errors));
  assert.ok(!steps.has('screenshots'));
  assert.ok(steps.has('serve') && steps.has('crawl') && steps.has('report'));

  // Raw results go next to the recreate, not into the project's analyses.
  const dir = path.join(recreateDir(project.id, recreateId), 'reaudit', 'r1');
  assert.ok(await exists(path.join(dir, 'crawl.json')));
  assert.ok(await exists(path.join(dir, 'axe.json')));
  assert.ok(!(await exists(path.join(projectDir(project.id), 'audit'))));

  // The throwaway server is closed afterwards.
  await assert.rejects(fetch(`${result.origin}/`));
});

test('runReaudit fails clearly without a completed recreate or its build', async () => {
  const project = makeProject();
  await assert.rejects(runReaudit({ project, reauditId: 'x', recreateId: randomUUID(), progress: () => {} }), /no longer available/);
  const recreateId = await makeRecreate(project, { build: false });
  await assert.rejects(runReaudit({ project, reauditId: 'y', recreateId, progress: () => {} }), /no production build/);
});

async function waitForDone(projectId) {
  for (let i = 0; i < 600; i++) {
    const body = await (await fetch(`${base}/${projectId}/reaudit`)).json();
    if (body.last && ['done', 'failed'].includes(body.last.status)) return body;
    await sleep(100);
  }
  throw new Error('The re-audit did not finish.');
}

test('routes: validation, one job per project, result, stale flag, retention', { timeout: 120000 }, async () => {
  assert.equal((await fetch(`${base}/${randomUUID()}/reaudit`, { method: 'POST' })).status, 404);
  const unauthorized = makeProject({ authorized: 0 });
  assert.equal((await fetch(`${base}/${unauthorized.id}/reaudit`, { method: 'POST' })).status, 403);
  const project = makeProject();
  const noRecreate = await fetch(`${base}/${project.id}/reaudit`, { method: 'POST' });
  assert.equal(noRecreate.status, 409);
  assert.match((await noRecreate.json()).error, /Run Recreate first/);
  assert.deepEqual(await (await fetch(`${base}/${project.id}/reaudit`)).json(), { last: null, result: null, stale: false });

  const recreateId = await makeRecreate(project, { startedAt: new Date(Date.now() - 60000).toISOString() });
  // A leftover folder from an earlier run is removed after the job.
  const leftover = path.join(recreateDir(project.id, recreateId), 'reaudit', 'old-run');
  await mkdir(leftover, { recursive: true });

  const res = await fetch(`${base}/${project.id}/reaudit`, { method: 'POST' });
  assert.equal(res.status, 202);
  const started = await res.json();
  assert.equal(started.job.recreateId, recreateId);
  assert.equal(started.steps[0].key, 'serve');
  const again = await fetch(`${base}/${project.id}/reaudit`, { method: 'POST' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).reauditId, started.reauditId);
  assert.equal((await (await fetch(`${base}/${project.id}/reaudit/current`)).json()).job.id, started.reauditId);

  const body = await waitForDone(project.id);
  assert.equal(body.last.status, 'done', body.last.error);
  assert.equal(body.last.recreateId, recreateId);
  assert.equal(body.last.analysisId, 'analysis-1');
  assert.equal(body.result.reauditId, started.reauditId);
  assert.equal(body.result.audit.pagesCrawled, 3);
  assert.equal(body.stale, false);
  // Retention runs in the job's after hook, just after the row is marked done.
  const reauditRoot = path.join(recreateDir(project.id, recreateId), 'reaudit');
  for (let i = 0; i < 50 && (await readdir(reauditRoot)).length > 1; i++) await sleep(100);
  assert.deepEqual(await readdir(reauditRoot), [started.reauditId]);

  // SSE of a finished job is answered from its row.
  const events = await (await fetch(`${base}/${project.id}/reaudit/${started.reauditId}/events`)).text();
  assert.match(events, /event: done/);

  // A newer recreate makes the result stale until it is re-audited.
  await makeRecreate(project, { build: false });
  assert.equal((await (await fetch(`${base}/${project.id}/reaudit`)).json()).stale, true);
});
