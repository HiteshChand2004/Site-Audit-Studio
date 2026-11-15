// "Go live" step 1: connect Netlify and deploy a finished copy (deploy/, routes/deploy.js). Netlify is a stand-in on this computer
// that answers like its API (hostingConfig.netlifyApi), so the real HTTP path, the zip and the polling all run; no account needed.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
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
import { checkRecords, dnsConfig, domainPlan, NETLIFY_LB, parseDomain } from '../src/deploy/domain.js';
import { parsePaths, parseTarget, redirectsFor, suggestedPaths } from '../src/deploy/passThrough.js';
import { entriesCsv, parseFormBody } from '../src/forms/entries.js';
import { formsPublicRouter } from '../src/routes/formsPublic.js';
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

/** One file of a zip, as text (stored or deflated). */
function zipText(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return '';
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
      const site = { id, name: `brave-otter-${fake.sites.size + 1}`, default_domain: `brave-otter-${fake.sites.size + 1}.netlify.app`, ssl_url: `https://brave-otter-${fake.sites.size + 1}.netlify.app`, admin_url: `https://app.netlify.com/sites/brave-otter-${fake.sites.size + 1}` };
      fake.sites.set(id, site);
      return send(201, site);
    }
    if (req.method === 'GET' && (m = p.match(/^\/sites\/([^/]+)$/))) return fake.sites.has(m[1]) ? send(200, fake.sites.get(m[1])) : send(404, { message: 'Not Found' });
    if (req.method === 'PATCH' && (m = p.match(/^\/sites\/([^/]+)$/))) {
      const site = fake.sites.get(m[1]);
      if (!site) return send(404, { message: 'Not Found' });
      const json = JSON.parse(body.toString() || '{}');
      const taken = [...fake.sites.values()].some((x) => x !== site && json.custom_domain && x.custom_domain === json.custom_domain);
      if (taken) return send(422, { errors: { custom_domain: ['custom_domain has already been taken'] } });
      Object.assign(site, { custom_domain: json.custom_domain, domain_aliases: json.domain_aliases, ssl: false });
      return send(200, site);
    }
    if (req.method === 'POST' && (m = p.match(/^\/sites\/([^/]+)\/deploys\/([^/]+)\/restore$/))) {
      if (!fake.sites.has(m[1]) || !fake.deploys.has(m[2])) return send(404, { message: 'Not Found' });
      fake.restored = { siteId: m[1], deployId: m[2] };
      return send(200, { id: m[2], state: 'ready', ssl_url: fake.sites.get(m[1]).ssl_url });
    }
    if (req.method === 'POST' && (m = p.match(/^\/sites\/([^/]+)\/ssl$/))) {
      fake.sslAsked = (fake.sslAsked ?? 0) + 1;
      return fake.sites.has(m[1]) ? send(200, { state: 'issued' }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/sites\/([^/]+)\/deploys$/))) {
      if (!fake.sites.has(m[1])) return send(404, { message: 'Not Found' });
      fake.lastZip = body;
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
  app.use('/api/forms', formsPublicRouter);
  app.use(express.json());
  // A signed-in person for the Remastly hosting tests: `x-test-role` = their role (none = accounts off, the local owner).
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role) /** @type {any} */ (req).user = { id: `person-${role}`, role };
    next();
  });
  app.use('/api/projects', deployRouter);
  app.use('/api/hosting', hostingRouter);
  api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${api.address().port}/api`;
});
after(() => { api?.close(); netlify.close(); });

const call = async (method, p, body, role = null) => {
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(role ? { 'x-test-role': role } : {}) };
  const res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

async function waitDone(projectId, role = null) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', `/projects/${projectId}/deploy`, undefined, role);
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

// ---- Step 1: Remastly hosting ----

test('Remastly hosting: only the owner sets it up, with a token Netlify accepts; others see only that it is ready', async () => {
  let r = await call('PUT', '/hosting/remastly', { token: GOOD }, 'user');
  assert.equal(r.status, 403);
  assert.equal(r.body.forbidden, 'owner');
  r = await call('PUT', '/hosting/remastly', { token: 'nfp_wrong_token_0123456789abcdef' }, 'owner');
  assert.equal(r.status, 400);
  r = await call('PUT', '/hosting/remastly', { token: GOOD }, 'owner');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.remastly, { ready: true, canManage: true, account: { ...r.body.remastly.account, provider: 'netlify', accountName: 'Site Owner' } });
  const asUser = await call('GET', '/hosting', undefined, 'user');
  assert.deepEqual(asUser.body.remastly, { ready: true, canManage: false, account: null });
  assert.deepEqual(asUser.body.connections, [], 'Remastly hosting is not the person\'s own connection');
  assert.ok(!JSON.stringify(asUser.body).includes(GOOD));
  assert.equal((await call('DELETE', '/hosting/remastly', undefined, 'user')).status, 403);
});

test('Remastly hosting: a person with no hosting account of their own goes live on it, and keeps one site per website', async () => {
  const project = seedProject(db, { name: 'gamma', targetDomain: 'https://gamma.test' });
  await finishedCopy({ projectId: project.id, report: { asIs: { stack: 'html', address: { used: 'https://gamma.test' } } }, reaudit: { checklist: { items: [] } } });
  let r = await call('GET', `/projects/${project.id}/deploy`, undefined, 'user');
  assert.equal(r.body.connection, null);
  assert.equal(r.body.remastly.ready, true);

  const sitesBefore = fake.sites.size;
  r = await call('POST', `/projects/${project.id}/deploy`, {}, 'user');
  assert.equal(r.status, 202, r.body.error);
  const first = await waitDone(project.id, 'user');
  assert.equal(first.status, 'ready', first.error);
  assert.equal(first.hosting, 'remastly');
  assert.equal(first.adminUrl, null, 'the link into Remastly\'s own Netlify account is the owner\'s only');
  assert.equal(fake.sites.size, sitesBefore + 1);
  const owner = await call('GET', `/projects/${project.id}/deploy`, undefined, 'owner');
  assert.match(owner.body.deployments[0].adminUrl, /^https:\/\/app\.netlify\.com\/sites\//);

  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {}, 'user')).status, 202);
  const second = await waitDone(project.id, 'user');
  assert.equal(second.status, 'ready');
  assert.equal(fake.sites.size, sitesBefore + 1, 'the same Remastly site is updated');
  assert.equal(second.url, first.url);

  r = await call('POST', `/projects/${project.id}/deploy`, { target: 'own' }, 'user');
  assert.equal(r.status, 400);
  assert.equal(r.body.needsConnection, true, 'their own account was chosen and is not connected');
});

test('Remastly hosting: once it is removed, a deploy without an account of one\'s own asks to connect one', async () => {
  assert.equal((await call('DELETE', '/hosting/remastly', undefined, 'owner')).status, 200);
  const project = seedProject(db, { name: 'delta', targetDomain: 'https://delta.test' });
  await finishedCopy({ projectId: project.id, report: { asIs: { stack: 'html', address: { used: 'https://delta.test' } } }, reaudit: { checklist: { items: [] } } });
  let r = await call('POST', `/projects/${project.id}/deploy`, {}, 'user');
  assert.equal(r.status, 400);
  assert.equal(r.body.needsConnection, true);
  r = await call('POST', `/projects/${project.id}/deploy`, { target: 'remastly' }, 'user');
  assert.equal(r.status, 400);
  assert.equal(r.body.needsRemastly, true);
});

// ---- Step 2: the owner's own domain ----

test('a domain is read as the owner types it, and refused with a reason when it cannot be used', () => {
  assert.deepEqual(parseDomain('https://WWW.Acme-Shop.com/about'), { ok: true, host: 'www.acme-shop.com', apex: 'acme-shop.com', kind: 'www' });
  assert.deepEqual(parseDomain('acme.co.in'), { ok: true, host: 'acme.co.in', apex: 'acme.co.in', kind: 'apex' });
  assert.deepEqual(parseDomain('shop.acme.co.in'), { ok: true, host: 'shop.acme.co.in', apex: 'acme.co.in', kind: 'sub' });
  for (const bad of ['', 'acme', 'co.in', 'brave-otter-1.netlify.app', '127.0.0.1', 'acme.test', 'user:pw@acme.com', 'acme.com:8080', 'a_b.com']) {
    assert.equal(parseDomain(bad).ok, false, bad);
  }
});

test('the records: a bare domain points to Netlify\'s address, a www or other name to the site\'s own name', () => {
  const site = 'brave-otter-9.netlify.app';
  const apex = domainPlan(/** @type {any} */ (parseDomain('acme.com')), site);
  assert.deepEqual(apex.records.map((r) => [r.type, r.name, r.value, r.required]), [['A', '@', NETLIFY_LB, true], ['CNAME', 'www', site, false]]);
  assert.deepEqual([apex.primary, apex.aliases], ['acme.com', ['www.acme.com']]);
  const www = domainPlan(/** @type {any} */ (parseDomain('www.acme.com')), site);
  assert.deepEqual(www.records.map((r) => [r.type, r.name, r.required]), [['CNAME', 'www', true], ['A', '@', false]]);
  const sub = domainPlan(/** @type {any} */ (parseDomain('shop.acme.co.in')), site);
  assert.deepEqual(sub.records.map((r) => [r.type, r.name, r.host]), [['CNAME', 'shop', 'shop.acme.co.in']]);
});

/** A DNS that answers from a table: { host: { a: [...], cname: [...] } }. */
const fakeDns = (table) => ({
  resolve4: async (h) => { if (table[h]?.a) return table[h].a; throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); },
  resolveCname: async (h) => { if (table[h]?.cname) return table[h].cname; throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' }); },
});

test('the check: right only when the name points to the site; an old address left beside it is not right', async () => {
  const site = 'brave-otter-9.netlify.app';
  const records = domainPlan(/** @type {any} */ (parseDomain('www.acme.com')), site).records;
  let checked = await checkRecords(records, { resolver: fakeDns({ 'www.acme.com': { cname: [`${site}.`] }, 'acme.com': { a: [NETLIFY_LB, '13.232.143.64'] } }) });
  assert.deepEqual(checked.map((r) => [r.host, r.ok]), [['www.acme.com', true], ['acme.com', false]]);
  assert.deepEqual(checked[1].found, [NETLIFY_LB, '13.232.143.64'], 'what it points to now is shown');
  // A DNS company that flattens the CNAME answers with the site's own addresses.
  checked = await checkRecords(records, { resolver: fakeDns({ 'www.acme.com': { a: ['3.3.3.3'] }, [site]: { a: ['3.3.3.3'] }, 'acme.com': { a: [NETLIFY_LB] } }) });
  assert.deepEqual(checked.map((r) => r.ok), [true, true]);
  checked = await checkRecords(records, { resolver: fakeDns({}) });
  assert.deepEqual(checked.map((r) => [r.ok, r.found]), [[false, []], [false, []]]);
});

test('Go live: the domain is put on the live site, its records are checked, and it can be taken off', async () => {
  const project = seedProject(db, { name: 'epsilon', url: 'https://www.epsilon-shop.com/' });
  let r = await call('GET', `/projects/${project.id}/domain`);
  assert.equal(r.status, 409);
  assert.equal(r.body.notLive, true);

  await finishedCopy({ projectId: project.id, report: { asIs: { stack: 'html', address: { used: 'https://www.epsilon-shop.com' } } }, reaudit: { checklist: { items: [] } } });
  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
  const live = await waitDone(project.id);
  assert.equal(live.status, 'ready', live.error);
  const site = [...fake.sites.values()].find((x) => x.ssl_url === live.url);

  r = await call('GET', `/projects/${project.id}/domain`);
  assert.equal(r.body.domain, null);
  assert.equal(r.body.suggestion, 'www.epsilon-shop.com', 'the original\'s own name is offered');

  assert.equal((await call('PUT', `/projects/${project.id}/domain`, { domain: 'not a domain' })).status, 400);
  const saved = dnsConfig.resolver;
  dnsConfig.resolver = fakeDns({});
  try {
    r = await call('PUT', `/projects/${project.id}/domain`, { domain: 'www.epsilon-shop.com' });
    assert.equal(r.status, 200, r.body.error);
    assert.equal(site.custom_domain, 'www.epsilon-shop.com');
    assert.deepEqual(site.domain_aliases, ['epsilon-shop.com']);
    assert.equal(r.body.connected, false);
    assert.deepEqual(r.body.records.map((x) => [x.type, x.name, x.value, x.ok]), [['CNAME', 'www', site.default_domain, false], ['A', '@', NETLIFY_LB, false]]);

    // The owner adds the CNAME: connected, and Netlify is asked to turn the padlock on.
    dnsConfig.resolver = fakeDns({ 'www.epsilon-shop.com': { cname: [site.default_domain] } });
    const asked = fake.sslAsked ?? 0;
    r = await call('GET', `/projects/${project.id}/domain`);
    assert.equal(r.body.connected, true);
    assert.equal(fake.sslAsked, asked + 1);

    // Another website cannot take a domain one already has (Netlify refuses, its reason is shown).
    const other = seedProject(db, { name: 'zeta' });
    await finishedCopy({ projectId: other.id, report: { asIs: { stack: 'html', address: { used: 'https://zeta.example.com' } } }, reaudit: { checklist: { items: [] } } });
    assert.equal((await call('POST', `/projects/${other.id}/deploy`, {})).status, 202);
    assert.equal((await waitDone(other.id)).status, 'ready');
    r = await call('PUT', `/projects/${other.id}/domain`, { domain: 'www.epsilon-shop.com' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /already been taken/);

    r = await call('DELETE', `/projects/${project.id}/domain`);
    assert.equal(r.status, 200);
    assert.equal(r.body.domain, null);
    assert.equal(site.custom_domain, null);
  } finally {
    dnsConfig.resolver = saved;
  }
});

// ---- Step 3: logins and data passed to the old app ----

test('the old app\'s address must be reachable and not the copy\'s own domain; paths must be the app\'s only', () => {
  assert.deepEqual(parseTarget('app.acme.com/login'), { ok: true, value: 'https://app.acme.com', insecure: false });
  assert.equal(parseTarget('http://13.232.143.64').insecure, true);
  for (const bad of ['', 'localhost:3000', 'http://192.168.1.4', 'https://10.0.0.2', 'brave-otter-1.netlify.app']) assert.equal(parseTarget(bad).ok, false, bad);
  assert.match(parseTarget('https://www.acme.com', ['acme.com']).error, /app\.acme\.com/);
  assert.deepEqual(parsePaths('/api/*, login\n/api/*'), { ok: true, value: ['/api/*', '/login'] });
  for (const bad of [[], ['/'], ['/*'], ['/a b'], ['/x/../y'], ['/api/*/more']]) assert.equal(parsePaths(bad).ok, false, JSON.stringify(bad));
  assert.equal(redirectsFor({ target: 'https://app.acme.com', paths: ['/api/*', '/login'] }),
    '/api/*  https://app.acme.com/api/:splat  200!\n/login  https://app.acme.com/login  200!');
});

test('app paths the copy asked its own address for are suggested; missing pages are not', () => {
  const report = { asIs: { checks: { pages: [
    { offline: { failed: ['404 /api/chatbot/w/cfg/1', '404 /api/v1/news?x=1', '404 /pricing', '500 /auth/session'] } },
    { offline: { failed: ['404 /use-cases/'] } },
  ] } } };
  assert.deepEqual(suggestedPaths(report), [{ path: '/api/*', seen: '/api/chatbot/w/cfg/1' }, { path: '/auth/*', seen: '/auth/session' }]);
  assert.deepEqual(suggestedPaths({}), []);
});

test('Go live: the paths go first in the deployed _redirects, before the copy\'s own rules; until then the copy is flagged', async () => {
  const project = seedProject(db, { name: 'eta', url: 'https://www.eta-app.com/' });
  await finishedCopy({
    projectId: project.id,
    files: { _redirects: '/old-page  /new-page  301\n' },
    report: { asIs: { stack: 'html', address: { used: 'https://www.eta-app.com' }, checks: { pages: [{ path: '/', offline: { external: [], failed: ['404 /api/me'] } }] } } },
    reaudit: { checklist: { items: [] } },
  });
  let r = await call('GET', `/projects/${project.id}/deploy`);
  const flag = r.body.readiness.warnings.find((w) => w.id === 'app-calls');
  assert.ok(flag, 'the copy\'s own /api call is pointed out');
  assert.match(flag.text, /\/api\/me/);
  r = await call('GET', `/projects/${project.id}/pass-through`);
  assert.deepEqual([r.body.passThrough, r.body.suggestions], [null, [{ path: '/api/*', seen: '/api/me' }]]);

  assert.equal((await call('PUT', `/projects/${project.id}/pass-through`, { target: 'www.eta-app.com', paths: ['/api/*'] })).status, 400, 'not the domain the copy goes on');
  r = await call('PUT', `/projects/${project.id}/pass-through`, { target: 'https://app.eta-app.com', paths: ['/api/*', '/login'] });
  assert.equal(r.status, 200, r.body.error);
  r = await call('GET', `/projects/${project.id}/deploy`);
  assert.equal(r.body.readiness.warnings.some((w) => w.id === 'app-calls'), false, 'passed on: nothing left to point out');

  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
  assert.equal((await waitDone(project.id)).status, 'ready');
  assert.ok(fake.uploads.at(-1).entries.includes('_redirects'));
  const text = zipText(fake.lastZip, '_redirects');
  assert.ok(text.includes('/api/*  https://app.eta-app.com/api/:splat  200!'), 'the rule is in the zip');
  assert.ok(text.indexOf('https://app.eta-app.com/login') < text.indexOf('/old-page  /new-page  301'), 'before the copy\'s own rules');

  r = await call('DELETE', `/projects/${project.id}/pass-through`);
  assert.equal(r.body.passThrough, null);
});

// ---- Step 4: go back ----

test('Go back: an earlier deploy is put back as the live one, and recorded as the newest', async () => {
  const project = seedProject(db, { name: 'theta', targetDomain: 'https://theta.test' });
  await finishedCopy({ projectId: project.id, report: { asIs: { stack: 'html', address: { used: 'https://theta.test' } } }, reaudit: { checklist: { items: [] } } });
  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
  const first = await waitDone(project.id);
  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
  const second = await waitDone(project.id);
  assert.equal(second.status, 'ready');

  let r = await call('POST', `/projects/${project.id}/deploy/${randomUUID()}/restore`);
  assert.equal(r.status, 409, 'not a deploy of this website');
  r = await call('POST', `/projects/${project.id}/deploy/${first.id}/restore`);
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.deployment.status, 'ready');
  assert.equal(r.body.deployment.restoredFrom, true);
  const firstRow = db.prepare('SELECT site_id, deploy_id FROM deployments WHERE id = ?').get(first.id);
  assert.deepEqual(fake.restored, { siteId: firstRow.site_id, deployId: firstRow.deploy_id });
  r = await call('GET', `/projects/${project.id}/deploy`);
  assert.equal(r.body.deployments[0].id, r.body.deployments[0].restoredFrom ? r.body.deployments[0].id : null, 'the put-back version is the newest, live one');

  // A deploy that failed has nothing to put back.
  fake.failNextDeploy = true;
  assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
  const failed = await waitDone(project.id);
  assert.equal(failed.status, 'failed');
  assert.equal((await call('POST', `/projects/${project.id}/deploy/${failed.id}/restore`)).status, 409);
});

// ---- Form entries saved by Remastly ----

test('a form post is read as the copy\'s form guard sends it (multipart); any other body is refused', async () => {
  const fd = new FormData();
  fd.append('name', 'Asha Rao');
  fd.append('message', 'Line one\r\nLine two, with "quotes"');
  fd.append('topics', 'a');
  fd.append('topics', 'b');
  fd.append('cv', new Blob(['%PDF-1.4 x'], { type: 'application/pdf' }), 'cv.pdf');
  const req = new Request('http://x/', { method: 'POST', body: fd });
  const body = Buffer.from(await req.arrayBuffer());
  const parsed = parseFormBody(body, req.headers.get('content-type'));
  assert.deepEqual(parsed.fields, [['name', 'Asha Rao'], ['message', 'Line one\r\nLine two, with "quotes"'], ['topics', 'a'], ['topics', 'b']]);
  assert.deepEqual(parsed.files, [{ field: 'cv', name: 'cv.pdf', size: 10 }], 'a file is named, never kept');
  assert.equal(parseFormBody(Buffer.from('a=1'), 'application/x-www-form-urlencoded'), null);
  assert.equal(parseFormBody(Buffer.from('{"a":"1"}'), 'application/json'), null);
  assert.equal(parseFormBody(Buffer.from('no boundary'), 'multipart/form-data'), null);
});

test('the CSV has one column per field, and a cell a spreadsheet would run as a formula is shown as text', () => {
  const csv = entriesCsv([
    { at: '2026-11-15T10:00:00Z', page: 'acme.com/contact', fields: [['email', 'b@x.io'], ['note', '=HYPERLINK("x")']] },
    { at: '2026-11-14T10:00:00Z', page: 'acme.com/', fields: [['name', 'A, B'], ['email', 'a@x.io']], files: [{ name: 'cv.pdf' }] },
  ]);
  assert.equal(csv, 'Received,Page,name,email,note,Files\r\n'
    + '2026-11-15T10:00:00Z,acme.com/contact,,b@x.io,"\'=HYPERLINK(""x"")",\r\n'
    + '2026-11-14T10:00:00Z,acme.com/,"A, B",a@x.io,,cv.pdf\r\n');
});

test('Form entries: a live site\'s forms are saved by Remastly, its owner lists and downloads them, a wrong key saves nothing', async () => {
  process.env.SAS_FORMS_ORIGIN = 'https://remastly.example.test';
  try {
    const project = seedProject(db, { name: 'iota', url: 'https://www.iota-shop.com/' });
    await finishedCopy({
      projectId: project.id,
      files: { 'sas-forms.json': '{\n  "endpoint": "",\n  "originalHosts": ["iota-shop.com"]\n}\n' },
      report: { asIs: { stack: 'html', address: { used: 'https://www.iota-shop.com' }, formRoutes: [{ page: '/', action: '', goesTo: 'not-connected' }] } },
      reaudit: { checklist: { items: [] } },
    });
    let r = await call('GET', `/projects/${project.id}/deploy`);
    assert.ok(r.body.readiness.warnings.some((w) => w.id === 'forms'), 'before: the form sends nothing');
    r = await call('GET', `/projects/${project.id}/forms`);
    assert.deepEqual([r.body.enabled, r.body.connected, r.body.forms, r.body.count], [false, false, 1, 0]);

    r = await call('PUT', `/projects/${project.id}/forms`, { enabled: true });
    assert.deepEqual([r.body.enabled, r.body.connected, r.body.reachable, r.body.email], [true, true, true, true]);
    r = await call('GET', `/projects/${project.id}/deploy`);
    assert.equal(r.body.readiness.warnings.some((w) => w.id === 'forms'), false, 'after: saved by Remastly, nothing to confirm');

    // The deploy writes this website's address into the copy's sas-forms.json.
    assert.equal((await call('POST', `/projects/${project.id}/deploy`, {})).status, 202);
    assert.equal((await waitDone(project.id)).status, 'ready');
    const config = JSON.parse(zipText(fake.lastZip, 'sas-forms.json'));
    assert.match(config.endpoint, new RegExp(`^https://remastly\\.example\\.test/api/forms/${project.id}\\.[A-Za-z0-9_-]{16,}$`));
    assert.deepEqual(config.originalHosts, ['iota-shop.com'], 'the rest of the settings is kept');
    const key = config.endpoint.split('/api/forms/')[1];

    // A visitor sends the form, as the copy's guard does: FormData from the site's own domain.
    const fd = new FormData();
    fd.append('email', 'visitor@example.com');
    fd.append('message', 'Hello');
    let res = await fetch(`${base}/forms/${key}`, { method: 'POST', body: fd, headers: { origin: 'https://www.iota-shop.com', referer: 'https://www.iota-shop.com/contact?utm=x' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'the guard can read that it worked');
    assert.deepEqual(await res.json(), { ok: true });

    // Wrong secret, an empty form.
    res = await fetch(`${base}/forms/${project.id}.${'x'.repeat(24)}`, { method: 'POST', body: fd });
    assert.equal(res.status, 404);
    res = await fetch(`${base}/forms/${key}`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 400);

    r = await call('GET', `/projects/${project.id}/forms`);
    assert.equal(r.body.count, 1);
    const entry = r.body.entries[0];
    assert.equal(entry.page, 'www.iota-shop.com/contact', 'the page, without its query');
    assert.deepEqual(entry.fields, [['email', 'visitor@example.com'], ['message', 'Hello']]);

    const csv = await fetch(`${base}/projects/${project.id}/forms/entries.csv`);
    assert.match(csv.headers.get('content-disposition'), /iota-shop\.com-form-entries\.csv/);
    assert.match(await csv.text(), /visitor@example\.com,Hello/);

    r = await call('DELETE', `/projects/${project.id}/forms/entries/${entry.id}`);
    assert.equal(r.body.count, 0);

    // Saving turned off: the address stops taking entries.
    await call('PUT', `/projects/${project.id}/forms`, { enabled: false });
    res = await fetch(`${base}/forms/${key}`, { method: 'POST', body: fd });
    assert.equal(res.status, 404);
    // On again: the same address as before, so a site already live keeps working.
    await call('PUT', `/projects/${project.id}/forms`, { enabled: true });
    res = await fetch(`${base}/forms/${key}`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.SAS_FORMS_ORIGIN;
  }
});

test('Form entries: one visitor cannot flood a website', async () => {
  process.env.SAS_FORMS_ORIGIN = 'https://remastly.example.test';
  try {
    const project = seedProject(db, { name: 'kappa' });
    await call('PUT', `/projects/${project.id}/forms`, { enabled: true, email: false });
    const { readFormSettings } = await import('../src/forms/entries.js');
    const key = `${project.id}.${(await readFormSettings(project.id)).secret}`;
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const fd = new FormData();
      fd.append('n', String(i));
      statuses.push((await fetch(`${base}/forms/${key}`, { method: 'POST', body: fd })).status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
  } finally {
    delete process.env.SAS_FORMS_ORIGIN;
  }
});

test('Form entries: a Remastly on this computer only (localhost) does not connect live sites\' forms to itself', async () => {
  const project = seedProject(db, { name: 'lambda' });
  const r = await call('PUT', `/projects/${project.id}/forms`, { enabled: true });
  assert.deepEqual([r.body.enabled, r.body.reachable, r.body.connected], [true, false, false]);
});
