// "Go live" step 1: connect Netlify and deploy a finished copy (deploy/, routes/deploy.js). Netlify is a stand-in on this computer
// that answers like its API (hostingConfig.netlifyApi), so the real HTTP path, the zip and the polling all run; no account needed.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { db } from '../src/db/index.js';
import { applyMigrations } from '../src/db/apply.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { hostingConfig } from '../src/deploy/netlify.js';
import { DEPLOY_LIMITS } from '../src/deploy/run.js';
import { planDeploy } from '../src/deploy/bundle.js';
import { deployReadiness } from '../src/deploy/readiness.js';
import { forgetKey, keyFile, seal, unseal } from '../src/deploy/secrets.js';
import { failInterrupted, insertDeployment, getDeployment } from '../src/deploy/store.js';
import { deployRouter, hostingRouter } from '../src/routes/deploy.js';
import { seedProject } from './helpers/projects.js';

const GOOD = 'nfp_good_token_0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function zipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'zip end record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out.sort();
}

// ---- the stand-in Netlify ----
const fake = { requests: [], sites: new Map(), deploys: new Map(), uploads: [], failNextDeploy: false };
const netlify = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/v1/, '');
    fake.requests.push({ method: req.method, path: p, auth: req.headers.authorization });
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== `Bearer ${GOOD}`) return send(401, { code: 401, message: 'Access Denied' });
    let m;
    if (req.method === 'GET' && p === '/user') return send(200, { id: 'u1', full_name: 'Site Owner', email: 'owner@example.test' });
    if (req.method === 'POST' && p === '/sites') {
      const id = randomUUID();
      const site = { id, name: `brave-otter-${fake.sites.size + 1}`, ssl_url: `https://brave-otter-${fake.sites.size + 1}.netlify.app`, admin_url: `https://app.netlify.com/sites/brave-otter-${fake.sites.size + 1}` };
      fake.sites.set(id, site);
      return send(201, site);
    }
    if (req.method === 'GET' && (m = p.match(/^\/sites\/([^/]+)$/))) return fake.sites.has(m[1]) ? send(200, fake.sites.get(m[1])) : send(404, { message: 'Not Found' });
    if (req.method === 'POST' && (m = p.match(/^\/sites\/([^/]+)\/deploys$/))) {
      if (!fake.sites.has(m[1])) return send(404, { message: 'Not Found' });
      fake.uploads.push({ siteId: m[1], type: req.headers['content-type'], length: Number(req.headers['content-length']), received: body.length, entries: zipEntries(body) });
      const id = randomUUID();
      const failing = fake.failNextDeploy;
      fake.failNextDeploy = false;
      fake.deploys.set(id, { id, polls: 0, failing, site: fake.sites.get(m[1]) });
      return send(200, { id, state: 'uploaded', deploy_ssl_url: `https://${id.slice(0, 8)}--x.netlify.app` });
    }
    if (req.method === 'GET' && (m = p.match(/^\/deploys\/([^/]+)$/))) {
      const d = fake.deploys.get(m[1]);
      if (!d) return send(404, { message: 'Not Found' });
      d.polls += 1;
      const state = d.polls < 2 ? 'processing' : d.failing ? 'error' : 'ready';
      return send(200, { id: d.id, state, ssl_url: d.site.ssl_url, deploy_ssl_url: `https://${d.id.slice(0, 8)}--x.netlify.app`, error_message: d.failing ? 'Bad _redirects rule on line 1' : null });
    }
    send(404, { message: 'Not Found' });
  });
});

let api;
let base;
before(async () => {
  await new Promise((r) => netlify.listen(0, '127.0.0.1', r));
  hostingConfig.netlifyApi = `http://127.0.0.1:${netlify.address().port}/api/v1`;
  DEPLOY_LIMITS.pollMs = 20;
  const app = express();
  app.use(express.json());
  app.use('/api/projects', deployRouter);
  app.use('/api/hosting', hostingRouter);
  api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${api.address().port}/api`;
});
after(() => { api?.close(); netlify.close(); });

const call = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

/** A finished plain-HTML as-is copy on disk + its rows; `reaudit` = the finished comparison's result (null = none). */
async function finishedCopy({ projectId, report: extra = {}, reaudit = null, files = {} } = {}) {
  const recreateId = randomUUID();
  const dir = recreateDir(projectId, recreateId);
  const site = { 'index.html': '<!doctype html><title>Home</title><h1>Home</h1>', 'about/index.html': '<!doctype html><title>About</title>', _headers: '/*\n  X-Content-Type-Options: nosniff\n', 'README.md': '# Plain HTML copy\n', 'css/site.css': 'h1{color:#123}', ...files };
  for (const [rel, text] of Object.entries(site)) {
    await mkdir(path.dirname(path.join(dir, 'stacks', 'html', rel)), { recursive: true });
    await writeFile(path.join(dir, 'stacks', 'html', rel), text);
  }
  const report = {
    stack: 'html', mode: 'as-is', safety: { safe: true },
    pages: [{ url: 'https://acme.test/', outPath: 'index.html' }, { url: 'https://acme.test/about/', outPath: 'about/index.html' }],
    asIs: { stack: 'html', address: { used: null } },
    outputs: { html: { status: 'ready', mode: 'as-is', dir: 'stacks/html', dist: '' } },
    ...extra,
  };
  const at = new Date().toISOString();
  db.prepare("INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)").run(recreateId, projectId, at, at, JSON.stringify(report));
  if (reaudit) db.prepare("INSERT INTO reaudits (id, project_id, recreate_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, ?, 'done', 100, ?, ?, ?)").run(randomUUID(), projectId, recreateId, at, at, JSON.stringify(reaudit));
  return { recreateId, dir };
}

async function waitDone(projectId) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', `/projects/${projectId}/deploy`);
    const last = body.deployments?.[0];
    if (last && (last.status === 'ready' || last.status === 'failed') && !body.running) return last;
    await sleep(25);
  }
  throw new Error('deploy did not finish');
}

test('a token is sealed: readable with its key only, a changed one is refused, the key file is private', async () => {
  const sealed = seal(GOOD);
  assert.ok(!sealed.includes(GOOD));
  assert.equal(unseal(sealed), GOOD);
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => unseal(parts.join('.')));
  assert.equal((await stat(keyFile())).mode & 0o777, 0o600);
  process.env.SAS_SECRET_KEY = 'ab'.repeat(32);
  forgetKey();
  assert.throws(() => unseal(sealed), 'another key cannot read it');
  delete process.env.SAS_SECRET_KEY;
  forgetKey();
  assert.equal(unseal(sealed), GOOD);
});

test('before the database is migrated the deploy routes say what to run, and nothing else breaks', async () => {
  const project = seedProject(db);
  const r = await call('GET', `/projects/${project.id}/deploy`);
  assert.equal(r.status, 503);
  assert.equal(r.body.needsMigration, true);
  assert.match(r.body.error, /db:migrate/);
  assert.equal((await call('GET', '/hosting')).status, 503);
  applyMigrations(db, { migrations: MIGRATIONS.filter((m) => m.id === '2026-11-14-deploy-tables') });
  assert.equal((await call('GET', '/hosting')).status, 200);
});

test('connecting Netlify checks the token with Netlify and never hands it back', async () => {
  let r = await call('PUT', '/hosting/netlify', { token: 'short' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/hosting/netlify', { token: 'nfp_wrong_token_0123456789abcdef' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /did not accept the access token/);
  r = await call('PUT', '/hosting/netlify', { token: GOOD });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.connection.provider, r.body.connection.accountName, r.body.connection.accountEmail], ['netlify', 'Site Owner', 'owner@example.test']);
  const listed = await call('GET', '/hosting');
  assert.ok(!JSON.stringify(listed.body).includes(GOOD));
  const row = db.prepare("SELECT token_sealed FROM hosting_connections WHERE provider = 'netlify'").get();
  assert.ok(!row.token_sealed.includes(GOOD), 'stored sealed, not in plain text');
});

test('a copy goes live once the owner accepts what it lacks; the next deploy updates the same site', async () => {
  const project = seedProject(db, { name: 'acme' });
  const reaudit = { checklist: { items: [{ status: 'fixed' }, { status: 'regressed', title: 'Contrast' }] } };
  await finishedCopy({ projectId: project.id, reaudit });

  let r = await call('GET', `/projects/${project.id}/deploy`);
  assert.equal(r.status, 200);
  assert.equal(r.body.stack, 'html');
  assert.equal(r.body.readiness.ok, true);
  assert.deepEqual(r.body.readiness.warnings.map((w) => w.id).sort(), ['address', 'worse']);
  assert.equal(r.body.connection.provider, 'netlify');

  r = await call('POST', `/projects/${project.id}/deploy`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.needsAccept, true);
  r = await call('POST', `/projects/${project.id}/deploy`, { accept: ['address'] });
  assert.deepEqual(r.body.warnings.map((w) => w.id), ['worse'], 'every warning needs its own yes');

  const before = fake.requests.length;
  r = await call('POST', `/projects/${project.id}/deploy`, { accept: ['address', 'worse'] });
  assert.equal(r.status, 202);
  const first = await waitDone(project.id);
  assert.equal(first.status, 'ready', first.error);
  assert.match(first.url, /^https:\/\/brave-otter-\d+\.netlify\.app$/);
  assert.equal(first.files, 4);
  const upload = fake.uploads.at(-1);
  assert.equal(upload.type, 'application/zip');
  assert.equal(upload.length, upload.received);
  assert.deepEqual(upload.entries, ['_headers', 'about/index.html', 'css/site.css', 'index.html'], 'the site at the zip root, no README');
  assert.ok(fake.requests.slice(before).every((q) => q.auth === `Bearer ${GOOD}`));

  const sitesBefore = fake.sites.size;
  r = await call('POST', `/projects/${project.id}/deploy`, { accept: ['address', 'worse'] });
  assert.equal(r.status, 202);
  const second = await waitDone(project.id);
  assert.equal(second.status, 'ready');
  assert.equal(fake.sites.size, sitesBefore, 'no second site');
  assert.equal(second.url, first.url);
  assert.equal(fake.uploads.at(-1).siteId, fake.uploads.at(-2).siteId);
});

test('Netlify failing to publish ends the deploy with its reason; a site deleted in Netlify is made again', async () => {
  const project = seedProject(db, { name: 'beta', targetDomain: 'https://beta.test' });
  await finishedCopy({ projectId: project.id, report: { asIs: { stack: 'html', address: { used: 'https://beta.test' } } }, reaudit: { checklist: { items: [] } } });
  fake.failNextDeploy = true;
  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202, 'nothing to accept');
  const failed = await waitDone(project.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /could not publish the site: Bad _redirects rule/);

  fake.sites.clear();
  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
  const ok = await waitDone(project.id);
  assert.equal(ok.status, 'ready', ok.error);
  assert.equal(fake.sites.size, 1);
});

test('what cannot go live is refused before anything is sent', async () => {
  const unsafe = seedProject(db);
  await finishedCopy({ projectId: unsafe.id, report: { safety: { safe: false } } });
  let r = await call('POST', `/projects/${unsafe.id}/deploy`, { accept: ['address', 'not-compared'] });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.blockers.map((b) => b.id), ['unsafe']);

  const mern = seedProject(db, { stack: 'mern' });
  await finishedCopy({ projectId: mern.id, report: { stack: 'mern', outputs: { mern: { status: 'ready', mode: 'as-is', dir: 'stacks/html', dist: '' } } } });
  r = await call('POST', `/projects/${mern.id}/deploy`, { stack: 'mern', accept: ['address', 'not-compared'] });
  assert.deepEqual(r.body.blockers.map((b) => b.id), ['needs-server']);

  const none = seedProject(db);
  r = await call('GET', `/projects/${none.id}/deploy`);
  assert.deepEqual(r.body.readiness.blockers.map((b) => b.id), ['no-copy']);
});

test('a packaged Next.js copy ships its own /_next files where the pages ask for them', async () => {
  const project = seedProject(db, { stack: 'nextjs' });
  const { dir } = await finishedCopy({ projectId: project.id, files: { 'next-assets/static/chunks/main.js': 'console.log(1)' } });
  const report = { pages: [{ outPath: 'index.html' }], outputs: { nextjs: { status: 'ready', mode: 'as-is', dir: 'stacks/html', dist: '' } } };
  const plan = await planDeploy({ dir, report, stack: 'nextjs' });
  assert.equal(plan.movedNextAssets, true);
  assert.ok(plan.entries.some((e) => e.name === '_next/static/chunks/main.js'));
  assert.ok(!plan.entries.some((e) => e.name.startsWith('next-assets/')));
  assert.equal(await readFile(plan.entries.find((e) => e.name === '_next/static/chunks/main.js').file, 'utf8'), 'console.log(1)');
});

test('"got worse" is counted as Results counts it: rows with a known reason are not the copy being worse', () => {
  const report = { safety: { safe: true }, asIs: { address: { used: 'https://new.test' } }, outputs: { html: { status: 'ready' } } };
  const items = [
    { status: 'regressed', title: 'Contrast' },
    { status: 'regressed', title: 'Speed', group: 'measurement' },
    { status: 'regressed', title: 'Sitemap', group: 'needs-info' },
    { status: 'fixed', title: 'Alt text' },
  ];
  const r = deployReadiness({ project: {}, report, stack: 'html', reaudit: { checklist: { items } } });
  assert.deepEqual(r.warnings.map((w) => w.text), ['1 check got worse than the original. See "Got worse" in Results.']);
  const none = deployReadiness({ project: {}, report, stack: 'html', reaudit: { checklist: { items: items.slice(1) } } });
  assert.deepEqual(none.warnings, [], 'only explained rows: nothing to confirm');
});

test('a deploy a stopped server left running is marked failed, not followed forever', () => {
  const project = seedProject(db);
  const d = insertDeployment({ projectId: project.id, recreateId: randomUUID(), stack: 'html', provider: 'netlify', ownerKey: 'local' });
  failInterrupted(new Set());
  const after = getDeployment(d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /restarted/);
});
