// Recreate "All pages": discovery of the whole site, limits that follow the page count, stalled pages tried again.
// Fixture site only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { db, projectDir } from '../src/db/index.js';
import { capturePage } from '../src/recreate/capture/index.js';
import { discoverPages } from '../src/recreate/discover.js';
import { BASE_PAGES, runRecreate, STAGES, STEPS } from '../src/recreate/index.js';
import { ALL_PAGES, isAllPages, pageLimitOf, SITE_PAGE_CAP } from '../src/recreate/inputs.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4192;
const origin = `http://localhost:${PORT}`;
let server;
const projectIds = [];

before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
});
after(async () => {
  server.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

function makeProject(recreatePages = ALL_PAGES) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, ?, ?, ?)`).run(id, `${origin}/`, recreatePages, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
const perPage = Object.fromEntries(STEPS.map((s) => [s.key, s.perPage ?? 0]));

test('"All pages" is the setting of new projects and means every page up to the safety cap', () => {
  assert.equal(isAllPages(ALL_PAGES), true);
  assert.equal(isAllPages(5), false);
  assert.equal(pageLimitOf(ALL_PAGES), SITE_PAGE_CAP - 1);
  assert.equal(pageLimitOf(7), 7);
});

test('discovery in "All pages" mode selects every page the site has; a limit selects fewer', async () => {
  const all = await withNetPolicy(userPolicy(), () => discoverPages({ url: `${origin}/`, limit: pageLimitOf(ALL_PAGES), all: true }));
  const two = await withNetPolicy(userPolicy(), () => discoverPages({ url: `${origin}/`, limit: 1 }));
  assert.equal(two.pages.length, 2);
  assert.ok(all.pages.length > two.pages.length, `${all.pages.length} pages`);
  assert.deepEqual(all.beyondLimit, [], 'nothing left out');
  assert.equal(all.pages[0].path, '/');
});

test('the limits follow the page count: the job, the running capture and every later step get more time per page', async () => {
  const project = makeProject();
  const seen = {};
  await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    stages: {
      ...stubs,
      inspect: async (ctx) => {
        const step = ctx.stepDeadline;
        const job = ctx.jobDeadline;
        ctx.scaleToPages(BASE_PAGES + 10);
        seen.inspect = ctx.stepDeadline - step;
        seen.job = ctx.jobDeadline - job;
        ctx.scaleToPages(BASE_PAGES + 10); // the same count again adds nothing
        seen.again = ctx.stepDeadline - step;
      },
      generate: async (ctx) => {
        seen.generate = ctx.stepDeadline - Date.now();
      },
    },
  });
  assert.equal(seen.inspect, 10 * perPage.inspect);
  assert.equal(seen.again, 10 * perPage.inspect);
  assert.equal(seen.job, 10 * STEPS.reduce((n, s) => n + (s.perPage ?? 0), 0));
  const generateMax = STEPS.find((s) => s.key === 'generate').max;
  assert.ok(seen.generate > generateMax + 10 * perPage.generate - 5000, `generate got ${seen.generate} ms`);
});

test('a fixed SAS_RECREATE_MINUTES keeps the total, but the steps still scale inside it', async () => {
  const project = makeProject();
  let jobAdded = null;
  await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    autoBudget: false,
    stages: {
      ...stubs,
      inspect: async (ctx) => {
        const job = ctx.jobDeadline;
        ctx.scaleToPages(BASE_PAGES + 4);
        jobAdded = ctx.jobDeadline - job;
      },
    },
  });
  assert.equal(jobAdded, 0);
});

test('a page that stalls is tried once more at the end of the step, in a fresh browser, and kept', async () => {
  const project = makeProject(1);
  const calls = [];
  const lines = [];
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    stages: {
      ...stubs,
      inspect: (ctx) => {
        ctx.pageCapMin = 1500; // a short cap for the test (4 minutes by default)
        const log = ctx.interrupts.log;
        ctx.interrupts = { ...ctx.interrupts, log: (l) => (lines.push(l), log(l)) };
        let first = true;
        ctx.capturePage = (browser, info, ...rest) => {
          calls.push(info.path);
          if (info.path === '/about.html' && first) {
            first = false;
            return new Promise(() => {}); // stalls the first time
          }
          return capturePage(browser, info, ...rest);
        };
        return STAGES.inspect(ctx);
      },
    },
  });
  assert.deepEqual(calls, ['/', '/about.html', '/about.html']);
  assert.deepEqual(report.pages.map((p) => p.path), ['/', '/about.html']);
  assert.ok(lines.some((l) => /\/about\.html stalled the first time → captured again in a fresh browser/.test(l)), lines.join('\n'));
});
