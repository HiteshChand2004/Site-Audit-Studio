// Re-audit (Phase 5): the Analyze pipeline on a recreated site's dist/, served on a throwaway loopback
// port that only this run may reach; the fix checklist comparing it with the original analysis; job,
// routes, retention. The "original" site is a local folder analyzed for real (Lighthouse left out:
// it is the unchanged Analyze step). No request leaves this machine.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { runAnalysis } from '../src/audit/index.js';
import { DATA_DIR, db, projectDir } from '../src/db/index.js';
import { overallPct, pagePath, runReaudit, STEPS } from '../src/reaudit/index.js';
import { JOB_OPTIONS } from '../src/reaudit/jobs.js';
import { previewHeaders, servePreview } from '../src/recreate/preview.js';
import { recreateDir } from '../src/recreate/workspace.js';
import reauditRouter from '../src/routes/reaudit.js';
import { createNetPolicy } from '../src/security/netGuard.js';

// The re-audit must reach its own server without the dev flag; other loopback ports stay blocked.
delete process.env.SAS_ALLOW_LOCALHOST;

const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST_SKIP = ['screenshots', 'lighthouse-mobile', 'lighthouse-desktop'];
const BASE_URL = 'https://example.com';

const page = (title, body, { description = `${title} of the test site, used by the re-audit and checklist tests.`, head = '' } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${description ? `<meta name="description" content="${description}">` : ''}${head}
<link rel="stylesheet" href="/css/site.css"></head><body><main>${body}</main></body></html>`;

// The original site: a missing description and an image without alt on the homepage, a broken link,
// and /extra/ (not recreated) without a title.
const ORIGINAL = {
  'index.html': page('Home of the test site', `<h1>Home</h1>
    <p><a href="/about/">About</a> <a href="/extra/">Extra</a> <a href="/gone">Gone</a></p>
    <img src="/img/dot.svg" width="10" height="10">`, { description: '' }),
  'about/index.html': page('About page', '<h1>About</h1><p><a href="/">Home</a></p>'),
  'hidden/index.html': page('Hidden page', '<h1>Hidden</h1><p>Only in the sitemap of the original.</p>'),
  'extra/index.html': page('', '<h1>Extra</h1><p>Not recreated.</p>'),
};

// The recreated build: description and alt fixed, the broken link unlinked; a new broken internal link,
// a link to another local server (blocked by the SSRF policy), and sitemap.xml/robots.txt for BASE_URL.
// /extra/ was not recreated, so it links to the original (ORIGIN, which is closed by then: never external).
const RECREATED = {
  'index.html': page('Home of the test site', `<h1>Home</h1>
    <p><a href="about/">About</a> <a href="ORIGIN/extra/">Extra</a> Gone <a href="missing.html">Missing</a> <a href="http://127.0.0.1:9/elsewhere">Other local server</a></p>
    <img src="/img/dot.svg" width="10" height="10" alt="Dot">`),
  'about/index.html': page('About page', '<h1>About</h1><p><a href="../">Home</a></p>'),
  // Linked from nowhere: only the seed URLs reach it.
  'hidden/index.html': page('Hidden page', '<h1>Hidden</h1><p>Only in the recreate report.</p>'),
  'sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${BASE_URL}/</loc></url></urlset>\n`,
  'robots.txt': `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n`,
};

async function writeSite(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  await mkdir(path.join(dir, 'css'), { recursive: true });
  await writeFile(path.join(dir, 'css', 'site.css'), 'body{font-family:sans-serif}');
  await mkdir(path.join(dir, 'img'), { recursive: true });
  await writeFile(path.join(dir, 'img', 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
}

const projectIds = [];
function makeProject({ authorized = 1 } = {}) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at) VALUES (?, 'test', 'https://example.com/', 'html', ?, ?, ?)`)
    .run(id, authorized, now, now);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

let originalRoot;

/** A real, completed analysis of the original site (served locally for the duration of the run). */
async function makeAnalysis(project) {
  const served = await servePreview(originalRoot);
  const analysisId = randomUUID();
  try {
    const audit = await runAnalysis({
      project,
      analysisId,
      url: `${served.origin}/`,
      maxPages: 10,
      seedUrls: [`${served.origin}/hidden/`],
      skip: FAST_SKIP,
      netPolicy: createNetPolicy({ internalPorts: [served.port] }),
      progress: () => {},
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
      .run(analysisId, project.id, now, now, JSON.stringify(audit));
    return { analysisId, origin: served.origin, audit };
  } finally {
    await served.close();
  }
}

/** A completed recreate row with a dist/ build of RECREATED. */
async function makeRecreate(project, { analysis = null, startedAt = new Date().toISOString(), build = true } = {}) {
  const recreateId = randomUUID();
  const origin = analysis?.origin ?? 'http://127.0.0.1:1';
  const report = {
    recreateId,
    analysisId: analysis?.analysisId ?? 'analysis-1',
    baseUrl: BASE_URL,
    pages: ['index.html', 'about/index.html', 'hidden/index.html'].map((outPath) => ({ url: `${origin}/${pagePath(outPath)}`, outPath })),
    fixes: [
      { id: 'img-alt', title: 'Alt text added to images', status: 'fixed', count: 1, open: 0, items: [] },
      { id: 'broken-links', title: 'Broken links unlinked', status: 'fixed', count: 1, open: 0, items: [] },
    ],
    autoGenerated: [{ page: '/', field: 'description', value: 'Home of the test site.', source: 'first paragraph' }],
    manual: [{ kind: 'form', title: 'Form on / needs a backend', detail: 'Connect a form backend.' }],
  };
  db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(recreateId, project.id, startedAt, startedAt, JSON.stringify(report));
  if (build) {
    const files = Object.fromEntries(Object.entries(RECREATED).map(([f, c]) => [f, c.replaceAll('ORIGIN/', `${origin}/`)]));
    await writeSite(path.join(recreateDir(project.id, recreateId), 'dist'), files);
  }
  return recreateId;
}

let server;
let base;
const savedSkip = JOB_OPTIONS.skip;

before(async () => {
  JOB_OPTIONS.skip = FAST_SKIP;
  originalRoot = path.join(DATA_DIR, 'original-site');
  await writeSite(originalRoot, ORIGINAL);
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

test('steps: serve first, no screenshots, compare last, progress reaches 100', () => {
  assert.equal(STEPS[0].key, 'serve');
  assert.equal(STEPS.at(-1).key, 'compare');
  assert.ok(!STEPS.some((s) => s.key === 'screenshots'));
  assert.ok(STEPS.some((s) => s.key === 'lighthouse-mobile'));
  assert.equal(overallPct('compare', 1), 100);
  assert.equal(overallPct('serve', 0), 0);
  assert.equal(pagePath('index.html'), '');
  assert.equal(pagePath('about/index.html'), 'about/');
  assert.equal(pagePath('about.html'), 'about.html');
});

test('runReaudit audits the recreated build on its own port and builds the checklist', { timeout: 180000 }, async () => {
  const project = makeProject();
  const analysis = await makeAnalysis(project);
  // The original analysis saw every issue, /extra/ included.
  assert.ok(analysis.audit.seo.some((s) => s.key === 'seo.title-tag' && s.status !== 'pass'), JSON.stringify(analysis.audit.seo));
  const recreateId = await makeRecreate(project, { analysis });
  const steps = new Set();
  const result = await runReaudit({ project, reauditId: 'r1', recreateId, skip: FAST_SKIP, progress: (s) => steps.add(s) });

  assert.equal(result.recreateId, recreateId);
  assert.equal(result.analysisId, analysis.analysisId);
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
  // The sitemap robots.txt names at the future home is read from the build, not fetched from there.
  assert.equal(audit.crawl.sitemap.status, 'pass', JSON.stringify(audit.crawl));
  assert.equal(audit.crawl.robots.status, 'pass', JSON.stringify(audit.crawl));
  assert.ok(!audit.errors.some((e) => e.step === 'screenshots'), JSON.stringify(audit.errors));
  assert.ok(!steps.has('screenshots'));
  for (const s of ['serve', 'crawl', 'report', 'compare']) assert.ok(steps.has(s), s);

  // Raw results go next to the recreate, not into the project's analyses.
  const dir = path.join(recreateDir(project.id, recreateId), 'reaudit', 'r1');
  assert.ok(await exists(path.join(dir, 'crawl.json')));
  assert.ok(await exists(path.join(dir, 'axe.json')));
  assert.equal(JSON.parse(await readFile(path.join(dir, 'crawl.json'), 'utf8')).renderedTextLength > 0, true);
  assert.deepEqual(await readdir(path.join(projectDir(project.id), 'audit')), [analysis.analysisId]);
  // The throwaway server is closed afterwards.
  await assert.rejects(fetch(`${result.origin}/`));

  // ---- the checklist ----
  const c = result.checklist;
  const item = (key) => c.items.find((i) => i.key === key);
  assert.equal(c.scope.mode, 'pages');
  assert.deepEqual(c.scope.pages.map((p) => p.path), ['/', '/about/', '/hidden/']);
  assert.deepEqual(c.scope.outOfScope, ['/extra/']);
  // Fixed by the recreate, with its evidence; an auto-generated value asks for a review. Multi-problem
  // checks are compared part by part.
  assert.equal(item('seo.meta-description.missing').status, 'fixed', JSON.stringify(item('seo.meta-description.missing')));
  assert.equal(item('seo.meta-description.missing').review, true);
  assert.equal(item('seo.meta-description.missing').before.count, 1);
  assert.equal(item('seo.meta-description.missing').title, 'Meta description: missing');
  assert.equal(item('seo.meta-description.length').status, 'pass');
  assert.equal(item('seo.meta-description'), undefined);
  assert.equal(item('seo.image-alt-text').status, 'fixed');
  assert.equal(item('seo.image-alt-text').evidence[0].fix, 'img-alt');
  assert.equal(item('axe.image-alt').status, 'fixed', JSON.stringify(c.items.filter((i) => i.category === 'accessibility')));
  // The missing title of /extra/ is out of scope: it is neither fixed nor open.
  assert.equal(item('seo.title-tag.missing').status, 'pass', JSON.stringify(item('seo.title-tag.missing')));
  // Links: the old broken link is gone, the new one is a regression mapped back to the original site.
  assert.equal(item('links.broken').status, 'fixed', JSON.stringify(item('links.broken')));
  assert.deepEqual(item('links.broken').links.fixed.map((l) => l.url), [`${analysis.origin}/gone`]);
  assert.equal(item('links.broken-new').status, 'regressed');
  assert.deepEqual(item('links.broken-new').links.new.map((l) => l.url), [`${analysis.origin}/missing.html`]);
  // sitemap.xml and robots.txt: missing before, generated now.
  assert.equal(item('crawl.sitemap').status, 'fixed');
  assert.equal(item('crawl.robots').status, 'fixed');
  // HTTPS cannot be measured on the preview.
  assert.equal(item('seo.https').status, 'na');
  assert.match(item('seo.https').note, /deploy/);
  // Manual items are listed, never fixed.
  assert.equal(item('manual.form-on-needs-a-backend').status, 'manual');
  // Lighthouse did not run on either side here: no rows, no scores.
  assert.ok(!c.items.some((i) => i.key.startsWith('lighthouse.')));
  assert.deepEqual(c.scores, { before: { mobile: null, desktop: null }, after: { mobile: null, desktop: null } });
  // The summary counts every row once.
  assert.equal(Object.entries(c.summary).filter(([k]) => k !== 'total').reduce((n, [, v]) => n + v, 0), c.items.length);
  assert.ok(c.summary.fixed >= 5 && c.summary.regressed >= 1 && c.summary.manual === 1 && c.summary.na >= 1, JSON.stringify(c.summary));
  assert.ok(c.categories.some((x) => x.id === 'seo'));
});

test('the preview CSP allows fetches to itself only when asked (re-audit server)', () => {
  assert.ok(!/connect-src/.test(previewHeaders()['Content-Security-Policy']));
  const csp = previewHeaders(undefined, { connectSelf: true })['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'; connect-src 'self';/);
  assert.ok(!/script-src/.test(csp));
});

test('runReaudit fails clearly without a completed recreate, its build or its analysis', async () => {
  const project = makeProject();
  await assert.rejects(runReaudit({ project, reauditId: 'x', recreateId: randomUUID(), progress: () => {} }), /no longer available/);
  const noBuild = await makeRecreate(project, { build: false });
  await assert.rejects(runReaudit({ project, reauditId: 'y', recreateId: noBuild, progress: () => {} }), /no production build/);
  const noAnalysis = await makeRecreate(project);
  await assert.rejects(runReaudit({ project, reauditId: 'z', recreateId: noAnalysis, progress: () => {} }), /analysis this recreate was built from/);
});

async function waitForDone(projectId) {
  for (let i = 0; i < 1200; i++) {
    const body = await (await fetch(`${base}/${projectId}/reaudit`)).json();
    if (body.last && ['done', 'failed'].includes(body.last.status)) return body;
    await sleep(100);
  }
  throw new Error('The re-audit did not finish.');
}

test('routes: validation, one job per project, result, stale flag, retention', { timeout: 180000 }, async () => {
  assert.equal((await fetch(`${base}/${randomUUID()}/reaudit`, { method: 'POST' })).status, 404);
  const unauthorized = makeProject({ authorized: 0 });
  assert.equal((await fetch(`${base}/${unauthorized.id}/reaudit`, { method: 'POST' })).status, 403);
  const project = makeProject();
  const noRecreate = await fetch(`${base}/${project.id}/reaudit`, { method: 'POST' });
  assert.equal(noRecreate.status, 409);
  assert.match((await noRecreate.json()).error, /Run Recreate first/);
  assert.deepEqual(await (await fetch(`${base}/${project.id}/reaudit`)).json(), { last: null, result: null, stale: false });

  const analysis = await makeAnalysis(project);
  const recreateId = await makeRecreate(project, { analysis, startedAt: new Date(Date.now() - 60000).toISOString() });
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
  assert.equal(body.last.analysisId, analysis.analysisId);
  assert.equal(body.result.reauditId, started.reauditId);
  assert.equal(body.result.audit.pagesCrawled, 3);
  assert.equal(body.result.checklist.scope.mode, 'pages');
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
