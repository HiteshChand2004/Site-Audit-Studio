// One page only (projects.page_url): the user picks a page of the site, and Analyze and Recreate work on that page and
// nothing else; the whole-site behaviour stays as it was when no page is chosen. Fixture site only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { db, projectDir } from '../src/db/index.js';
import projectsRouter from '../src/routes/projects.js';
import { runAnalysis } from '../src/audit/index.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { pageUrlOf, parsePageUrl } from '../src/recreate/inputs.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4223;
const origin = `http://localhost:${PORT}`;
let fixture;
let api;
let base;
const projectIds = [];

before(async () => {
  fixture = await startFixtureServer(PORT, { site: 'recreate' });
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  await new Promise((resolve) => { api = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${api.address().port}/api/projects`;
});
after(async () => {
  fixture.close();
  api.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

function makeProject(pageUrl = null) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, page_url, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, -1, ?, ?, ?)`)
    .run(id, `${origin}/`, pageUrl, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: pageUrl ?? `${origin}/`, analyzedAt: now }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const patch = (id, body) => fetch(`${base}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a page is an address on the project\'s own site: a path, a full address, never another site; empty = whole site', () => {
  const site = 'https://www.example.com/';
  assert.deepEqual(parsePageUrl('/pricing', site), { ok: true, value: 'https://www.example.com/pricing' });
  assert.deepEqual(parsePageUrl('https://example.com/about/#team', site), { ok: true, value: 'https://example.com/about/' });
  assert.deepEqual(parsePageUrl('example.com/a', site), { ok: true, value: 'https://example.com/a' });
  assert.equal(parsePageUrl('https://other.com/pricing', site).ok, false);
  assert.equal(parsePageUrl('javascript:alert(1)', site).ok, false);
  assert.deepEqual(parsePageUrl('', site), { ok: true, value: null });
  assert.deepEqual(parsePageUrl(null, site), { ok: true, value: null });
  assert.equal(pageUrlOf({ page_url: null }), null);
});

test('the setting is saved, refused for another site, cleared by "whole site" and by moving to another site', async () => {
  const { id } = makeProject();
  let res = await patch(id, { page_url: '/about.html' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).page_url, `${origin}/about.html`);
  res = await patch(id, { page_url: 'https://other.example/about' });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT page_url FROM projects WHERE id = ?').get(id).page_url, `${origin}/about.html`, 'a refused value changes nothing');
  res = await patch(id, { page_url: null });
  assert.equal((await res.json()).page_url, null);
  await patch(id, { page_url: '/about.html' });
  res = await patch(id, { url: 'https://another-site.example/' });
  assert.equal((await res.json()).page_url, null, 'a page of the old site is not a page of the new one');
});

test('the page picker lists the site\'s pages the app has seen, homepage first', async () => {
  const { id } = makeProject();
  const body = await (await fetch(`${base}/${id}/pages`)).json();
  assert.deepEqual(body.pages[0], { path: '/', url: `${origin}/` });
  assert.equal(body.pageUrl, null);
});

test('an analysis of one page reads that page only, and says so', async () => {
  const outDir = path.join(os.tmpdir(), `sas-single-${randomUUID()}`);
  try {
    const audit = await runAnalysis({
      project: { id: 'single', url: `${origin}/` },
      analysisId: 'single',
      url: `${origin}/about.html`,
      maxPages: 1,
      outDir,
      skip: ['screenshots', 'lighthouse-mobile', 'lighthouse-desktop'],
      progress: () => {},
    });
    assert.equal(audit.url, `${origin}/about.html`);
    assert.equal(audit.pagesCrawled, 1);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a copy of one page captures that page only, as its start page; the rest of the site leads to notice pages', async () => {
  const project = makeProject(`${origin}/about.html`);
  const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
  let seen = null;
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    stages: {
      ...stubs,
      inspect: async (ctx, local) => {
        seen = { singlePage: ctx.singlePage, pageLimit: ctx.pageLimit, allPages: ctx.allPages };
        await STAGES.inspect(ctx, local);
        seen.pages = ctx.pages.map((p) => ({ url: p.url, outPath: p.outPath, slug: p.slug }));
        seen.live = ctx.livePages.length;
      },
    },
  });
  assert.deepEqual({ ...seen, pages: undefined, live: undefined }, { singlePage: `${origin}/about.html`, pageLimit: 0, allPages: false, pages: undefined, live: undefined });
  assert.deepEqual(seen.pages, [{ url: `${origin}/about.html`, outPath: 'index.html', slug: 'index' }]);
  assert.ok(seen.live >= 1, 'the other pages are known, and their links get a notice page');
  assert.deepEqual(report.singlePage, { url: `${origin}/about.html`, path: '/about.html' });
});
