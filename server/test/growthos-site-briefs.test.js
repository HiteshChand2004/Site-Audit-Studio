// Growth OS → Remastly website prompts (docs/GROWTHOS-INTEGRATION.md "Website prompt for Build mode", src/buildmode/briefs.js):
// one prompt for a whole website becomes a saved site of Build mode for that website's owner, described and waiting for them
// to press Continue. Through the real HTTP API with the key; nothing is planned or built.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../src/db/index.js';
import { applyMigrations } from '../src/db/apply.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { extRouter } from '../src/routes/ext.js';
import { getSite, listSites, saveSite } from '../src/buildmode/sites.js';
import { briefState, parseBrief, PROMPT_MAX } from '../src/buildmode/briefs.js';
import { seedProject } from './helpers/projects.js';

const KEY = 'test-key-0123456789abcdefghij';
let api;
let base;
let project;

before(async () => {
  applyMigrations(db, { migrations: MIGRATIONS.filter((m) => m.id === '2026-11-14-deploy-tables' || m.id === '2026-11-20-change-requests') });
  Object.assign(process.env, { SAS_GROWTHOS_KEY: KEY, SAS_PUBLIC_ORIGIN: 'http://remastly.test' });
  delete process.env.SAS_ACCOUNTS;
  project = seedProject(db, { name: 'PredCo', url: 'https://www.predco.example/' });
  const app = express();
  app.use('/api/ext/v1', extRouter);
  api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  base = `http://127.0.0.1:${api.address().port}`;
});

after(() => api?.close());

const call = async (method, p, body, key = KEY) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const PROMPT = 'Website: https://www.predco.example/ (Next.js). Task: targeted edits to the live site, one release.\n\nGoal: answer the buyer first.';
const request = (o = {}) => ({ requestId: 'growthos:predco:site-plan:2026-11-21T16:51:13.759Z', site: { url: 'https://predco.example' }, prompt: PROMPT, context: { venture: 'predco' }, ...o });

test('the key is needed, as for every Growth OS call', async () => {
  assert.equal((await call('POST', '/api/ext/v1/site-briefs', request(), null)).status, 401);
  assert.equal((await call('POST', '/api/ext/v1/site-briefs', request(), 'wrong-key-0123456789abcdefgh')).status, 401);
});

test('a prompt becomes a saved site of Build mode: an existing website, its live site, its technology kept, the prompt as the description', async () => {
  const r = await call('POST', '/api/ext/v1/site-briefs', request());
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'described');
  assert.equal(r.body.step, 'start');
  assert.equal(r.body.openUrl, `http://remastly.test/app/?buildSite=${r.body.id}`);
  const site = await getSite(r.body.id, null);
  assert.deepEqual(site.state.draft, { source: 'url', siteUrl: 'https://www.predco.example/', authorized: true, code: 'copy', githubUrl: '', githubRef: '', stack: '', stackName: '', description: PROMPT });
  assert.equal(site.state.plan, null, 'nothing is planned here');
  assert.equal(site.state.growthos.projectId, project.id);
  assert.equal(site.state.details.name, 'PredCo · from Growth OS', 'the list names it after the website, not the first line of the prompt');
  assert.equal((await listSites(null)).filter((s) => s.state.growthos).length, 1);
});

test('the same request again returns the same site (a retry never makes two)', async () => {
  const a = await call('POST', '/api/ext/v1/site-briefs', request());
  assert.equal(a.status, 200);
  assert.equal((await listSites(null)).filter((s) => s.state.growthos).length, 1);
  const b = await call('POST', '/api/ext/v1/site-briefs', request({ requestId: 'growthos:predco:site-plan:2026-11-22T09:00:00.000Z' }));
  assert.equal(b.status, 201);
  assert.notEqual(b.body.id, a.body.id, 'a new prompt is a new site');
});

test('status follows the site: described, then planned once the owner made the plan', async () => {
  const r = await call('POST', '/api/ext/v1/site-briefs', request({ requestId: 'growthos:predco:status' }));
  const site = await getSite(r.body.id, null);
  await saveSite(site.id, null, { ...site.state, step: 'review', plan: { brief: { summary: 'Targeted edits' } } });
  const s = await call('GET', `/api/ext/v1/site-briefs/${r.body.id}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.status, 'planned');
  assert.equal(s.body.requestId, 'growthos:predco:status');
});

test("the key cannot read the owner's own saved sites, nor a site that does not exist", async () => {
  const { createSite } = await import('../src/buildmode/sites.js');
  const own = await createSite({ ownerId: null, state: { v: 2, step: 'start', draft: { description: 'my own site' } } });
  assert.equal((await call('GET', `/api/ext/v1/site-briefs/${own.id}`)).status, 404);
  assert.equal((await call('GET', '/api/ext/v1/site-briefs/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('refused in plain words: unknown website, empty or too long prompt, no request id', async () => {
  const unknown = await call('POST', '/api/ext/v1/site-briefs', request({ site: { url: 'https://nobody.example' } }));
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /Add the website in Remastly first/);
  assert.equal((await call('POST', '/api/ext/v1/site-briefs', request({ prompt: '   ' }))).status, 400);
  const long = await call('POST', '/api/ext/v1/site-briefs', request({ prompt: 'x'.repeat(PROMPT_MAX + 1) }));
  assert.equal(long.status, 400);
  assert.match(long.body.error, /at most 8,000/);
  assert.equal((await call('POST', '/api/ext/v1/site-briefs', request({ requestId: '' }))).status, 400);
});

test('with accounts on, the site is saved for the website\'s owner (and only they see it in Build mode)', async () => {
  const { submitBrief } = await import('../src/buildmode/briefs.js');
  process.env.SAS_ACCOUNTS = '1';
  try {
    const owned = { id: 'p1', name: 'Acme', url: 'https://acme.example/', owner_id: 'u1' };
    const { site } = await submitBrief(request({ requestId: 'growthos:acme:1', site: { url: 'https://acme.example' } }), { find: () => owned });
    assert.equal(site.ownerId, 'u1');
    assert.ok((await listSites('u1')).some((s) => s.id === site.id));
    assert.ok(!(await listSites('u2')).some((s) => s.id === site.id));
    assert.equal(briefState(owned, parseBrief(request())).draft.siteUrl, 'https://acme.example/');
  } finally {
    delete process.env.SAS_ACCOUNTS;
  }
});
