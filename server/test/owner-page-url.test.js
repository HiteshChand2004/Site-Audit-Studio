// Checking one page instead of the whole website is the owner's (accounts/roles.js): anyone else may not set page_url (403), and
// their Analyze checks the whole website whatever page an older setting saved, which stays stored. The owner, and nobody signed
// in (accounts off), keep setting and using it. Analyze's job is caught at jobs.start, so nothing is fetched or rendered.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../src/db/index.js';
import projectsRouter from '../src/routes/projects.js';
import analyzeRouter from '../src/routes/analyze.js';
import { jobs } from '../src/audit/jobs.js';
import { seedProject } from './helpers/projects.js';

const projectId = randomUUID();
const PAGE = 'https://example.com/pricing';
let server;
let base;
let role = null;
// What Analyze asked the job manager for, instead of running it.
const started = [];
const realStart = jobs.start;

before(async () => {
  seedProject(db, { id: projectId, name: 'owner-page-url', url: 'https://example.com/', authorized: 1, maxPages: 25, pageUrl: PAGE });
  jobs.start = (project, payload) => {
    started.push(payload);
    return { id: randomUUID(), status: 'queued', projectId: project.id };
  };
  const app = express();
  app.use(express.json());
  // The gate's stand-in: `role` = a signed-in user of that role, null = accounts off (no req.user).
  app.use((req, _res, next) => {
    if (role) req.user = { id: 'u1', role };
    next();
  });
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', analyzeRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/projects/${projectId}`;
});

after(() => {
  jobs.start = realStart;
  server.close();
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
});

const send = (method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const savedPage = () => db.prepare('SELECT page_url FROM projects WHERE id = ?').get(projectId).page_url;
const analyze = async () => {
  const res = await send('POST', '/analyze', {});
  assert.equal(res.status, 202);
  return started.at(-1);
};

test('an ordinary user cannot set page_url: 403 in plain words, and nothing is written', async () => {
  role = 'user';
  for (const value of ['/about', PAGE, null]) {
    const res = await send('PATCH', '', { page_url: value });
    assert.equal(res.status, 403, JSON.stringify(value));
    const data = await res.json();
    assert.equal(data.error, 'Only the owner can choose to check one page. Everyone else checks the whole website.');
    assert.equal(data.forbidden, 'owner');
    assert.equal(data.auth, undefined, 'not a sign-in problem');
  }
  assert.equal(savedPage(), PAGE, 'the saved page is neither changed nor cleared');
  // Everything else a PATCH may carry is unchanged for them.
  assert.equal((await send('PATCH', '', { max_pages: 30 })).status, 200);
});

test("an ordinary user's Analyze checks the whole website, whatever page was saved", async () => {
  role = 'user';
  assert.deepEqual(await analyze(), { maxPages: 30 });
  assert.equal(savedPage(), PAGE, 'the stored page stays as it was (no data is changed)');
});

test('the owner, and nobody signed in (accounts off), still set and use one page', async () => {
  for (const who of ['owner', null]) {
    role = who;
    const label = who ?? 'accounts off';
    assert.deepEqual(await analyze(), { maxPages: 1, url: PAGE }, `${label}: the saved page is the one checked`);
    const set = await send('PATCH', '', { page_url: '/about' });
    assert.equal(set.status, 200, label);
    assert.equal(savedPage(), 'https://example.com/about');
    assert.deepEqual(await analyze(), { maxPages: 1, url: 'https://example.com/about' }, `${label}: the new page is used`);
    assert.equal((await send('PATCH', '', { page_url: null })).status, 200, `${label}: back to the whole website`);
    assert.deepEqual(await analyze(), { maxPages: 30 }, `${label}: the whole website`);
    assert.equal((await send('PATCH', '', { page_url: PAGE })).status, 200);
  }
});
