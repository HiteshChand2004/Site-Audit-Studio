// "Make its GitHub App" (apps/appGithub.js, routes/apps.js): which settings an app reads for a GitHub App of its own, what its
// code does on GitHub (for the permissions offered), and the round trip against a stand-in GitHub over real HTTP — made from the
// manifest, installed, the installation proven by asking GitHub as the new app (a JWT its new key really signs), the settings
// filled and sealed, never a key in an answer, and GitHub's way back counting only in the browser that started it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db } from '../src/db/index.js';
import { seal, unseal } from '../src/deploy/secrets.js';
import { findApp } from '../src/apps/detect.js';
import { githubConfig } from '../src/apps/github.js';
import { appGithubManifest, checkedPermissions, githubRoles, githubUseOf, parseAppYml, valuesFor } from '../src/apps/appGithub.js';
import { appsRouter, githubReturnRouter } from '../src/routes/apps.js';
import { seedProject } from './helpers/projects.js';

const { privateKey: PEM, publicKey: PUB } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SETTINGS = ['DATABASE_URL', 'GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_OWNERS', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];

let dir;
let gh;
let api;
let base;
let project;

/** Writes files under `root`: { 'a/b.js': 'text' }. */
async function files(root, map) {
  for (const [rel, text] of Object.entries(map)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}
const stateFile = () => path.join(process.env.SAS_DATA_DIR, 'projects', project.id, 'app', 'state.json');
const sealedSettings = async () => {
  const state = JSON.parse(await readFile(stateFile(), 'utf8'));
  return state.settings ? JSON.parse(unseal(state.settings)) : {};
};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-appgh-'));
  gh = createServer((req, res) => {
    const send = (st, v) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/app-manifests/m1/conversions') {
      return send(201, { id: 99, slug: 'gardener-ab12', client_id: 'Iv1.cid', client_secret: 'csec', webhook_secret: 'whsec', pem: PEM, html_url: 'https://github.example/apps/gardener-ab12' });
    }
    const inst = u.pathname.match(/^\/app\/installations\/(\d+)$/);
    if (inst) {
      // Only the new app itself may ask: a JWT its key signed, naming it.
      const [h, p, sig] = (req.headers.authorization ?? '').replace(/^Bearer /, '').split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(PUB, Buffer.from(sig ?? '', 'base64url'));
      if (!ok || JSON.parse(Buffer.from(p, 'base64url').toString()).iss !== '99') return send(401, { message: 'bad jwt' });
      return inst[1] === '555' ? send(200, { id: 555, account: { login: 'PanScienceInnovation' } }) : send(404, { message: 'Not Found' });
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  githubConfig.web = githubConfig.api = `http://127.0.0.1:${gh.address().port}`;

  process.env.SAS_PUBLIC_ORIGIN = 'https://remastly.test';
  const app = express();
  app.use('/api/github', githubReturnRouter);
  app.use(express.json());
  app.use('/api/projects', appsRouter);
  api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${api.address().port}/api`;

  // gardener: its code reads a GitHub App's settings; GITHUB_OWNERS already has a value, which must stay.
  project = seedProject(db, { name: 'gardener', url: 'https://gardener.example.com/' });
  await files(path.dirname(stateFile()), {
    'state.json': JSON.stringify({
      status: 'ready', repo: { fullName: 'PanScienceInnovation/gardener', branch: 'main', installationId: 1 },
      app: { name: 'gardener', framework: 'node', settings: SETTINGS.map((name) => ({ name, example: null })), github: { from: 'code', permissions: { contents: 'write' }, events: ['push'], evidence: {} } },
      settings: seal(JSON.stringify({ GITHUB_OWNERS: 'Org-A' })),
    }),
  });
});
after(async () => {
  api?.close();
  gh?.close();
  delete process.env.SAS_PUBLIC_ORIGIN;
  await rm(dir, { recursive: true, force: true });
});

/** @param {string} method @param {string} p @param {{ body?: any, cookie?: string }} [o] */
async function call(method, p, { body, cookie } = {}) {
  const headers = { ...(body && { 'content-type': 'application/json' }), ...(cookie && { cookie }) };
  const res = await fetch(`${base}${p}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), cookie: res.headers.get('set-cookie')?.split(';')[0], text, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
const stateOf = (url) => new URL(url).searchParams.get('state');

test('which settings are the app’s own GitHub App’s: by name, only with an app ID and a key', () => {
  assert.equal(githubRoles(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']), null, 'an OAuth sign-in is not a GitHub App');
  assert.equal(githubRoles(['GITHUB_APP_ID']), null, 'no key Remastly could fill');
  const roles = githubRoles(SETTINGS);
  assert.deepEqual([roles.appId, roles.privateKey, roles.installationId, roles.owner, roles.webhookSecret], [['GITHUB_APP_ID'], ['GITHUB_PRIVATE_KEY'], ['GITHUB_INSTALLATION_ID'], ['GITHUB_OWNERS'], ['GITHUB_WEBHOOK_SECRET']]);
  // Probot's bare names count only next to APP_ID; a word that merely contains GH does not.
  assert.deepEqual(githubRoles(['APP_ID', 'PRIVATE_KEY', 'WEBHOOK_SECRET', 'HIGH_APP_ID']).appId, ['APP_ID']);
  assert.deepEqual(githubRoles(['GH_APP_ID', 'GH_PRIVATE_KEY_BASE64']).privateKeyBase64, ['GH_PRIVATE_KEY_BASE64']);
});

test('what the code does on GitHub: an app.yml wins, else its Octokit calls and requests, with where they were seen', async () => {
  const yml = parseAppYml('# app\ndefault_events:\n  - pull_request\n  - push # a comment\ndefault_permissions:\n  contents: read\n  pull_requests: write\nname: x\n');
  assert.deepEqual(yml, { permissions: { contents: 'read', pull_requests: 'write' }, events: ['pull_request', 'push'] });

  const root = path.join(dir, 'probe');
  await files(root, {
    'package.json': JSON.stringify({ name: 'gardener', scripts: { start: 'node src/index.js' } }),
    'src/index.js': [
      'const id = process.env.GITHUB_APP_ID; const key = process.env.GITHUB_PRIVATE_KEY;',
      'await octokit.rest.pulls.create({}); await octokit.rest.issues.listForRepo({});',
      'await octokit.request("GET /repos/{owner}/{repo}/contents/{path}"); await octokit.rest.repos.createCommitStatus({});',
      'app.on("pull_request.opened", f); webhooks.on(["issues.opened"], g);',
    ].join('\n'),
  });
  const use = (await findApp(root)).github;
  assert.equal(use.from, 'code');
  assert.deepEqual(use.permissions, { pull_requests: 'write', issues: 'read', contents: 'read', statuses: 'write' });
  assert.deepEqual(use.events, ['issues', 'pull_request']);
  assert.deepEqual(use.evidence.pull_requests, ['pulls.create in src/index.js']);

  await files(root, { 'app.yml': 'default_permissions:\n  checks: write\n  secrets: write\n' });
  assert.deepEqual(await githubUseOf(root, []), { from: 'app.yml', permissions: { checks: 'write' }, events: [], evidence: { all: ['app.yml'] } }, 'an area the card does not offer is left out');
  assert.equal((await findApp(path.join(dir, 'probe'), '')).github.from, 'app.yml');
});

test('the manifest and the values: permissions checked, a webhook only with an address, the owner never overwritten', () => {
  assert.deepEqual(checkedPermissions({ contents: 'write', workflows: 'read', administration: 'write', issues: 'nope' }), { metadata: 'read', contents: 'write' });
  const m = appGithubManifest({ origin: 'https://remastly.test', domain: 'gardener.example.com', name: 'gardener', permissions: { metadata: 'read' }, events: ['push'], webhookUrl: null });
  assert.match(m.name, /^gardener [0-9a-f]{4}$/);
  assert.deepEqual([m.public, m.default_events, m.hook_attributes.active, m.setup_url], [false, [], false, 'https://remastly.test/api/github/installed']);
  const roles = githubRoles(SETTINGS);
  assert.deepEqual(valuesFor(roles, { id: 99, pem: 'PEM', webhookSecret: 'w' }), { GITHUB_APP_ID: '99', GITHUB_PRIVATE_KEY: 'PEM', GITHUB_WEBHOOK_SECRET: 'w' });
  assert.deepEqual(valuesFor(roles, { installationId: 5, account: 'Org-B' }, ['GITHUB_OWNERS']), { GITHUB_INSTALLATION_ID: '5' });
});

test('made, installed and filled: only in the browser that started it, the installation proven with GitHub, no key in any answer', async () => {
  const id = project.id;
  // Shapes refused before anything leaves.
  assert.equal((await call('POST', `/projects/${id}/app/github-app`, { body: { org: 'not an org!' } })).status, 400);
  assert.equal((await call('POST', `/projects/${id}/app/github-app`, { body: { webhookUrl: 'http://gardener.example.com/hook' } })).status, 400);

  let r = await call('POST', `/projects/${id}/app/github-app`, { body: { org: 'PanScienceInnovation', permissions: { contents: 'write', pull_requests: 'write' }, events: ['push', 'not-an-event'], webhookUrl: 'https://gardener.example.com/api/github/webhooks', returnTo: 'https://remastly.test/app/#golive' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(new URL(r.body.action).pathname, '/organizations/PanScienceInnovation/settings/apps/new');
  const manifest = JSON.parse(r.body.manifest);
  assert.deepEqual([manifest.default_permissions, manifest.default_events, manifest.hook_attributes], [{ metadata: 'read', contents: 'write', pull_requests: 'write' }, ['push'], { url: 'https://gardener.example.com/api/github/webhooks', active: true }]);

  // GitHub's answer reaching another browser (no cookie) makes nothing.
  const other = await call('GET', `/github/created?code=m1&state=${stateOf(r.body.action)}`);
  assert.match(other.location, /github=error/);
  assert.equal((await call('GET', `/projects/${id}/app`)).body.app.githubApp, null);

  // In the browser that started it: made, its settings filled, and on to install it.
  r = await call('POST', `/projects/${id}/app/github-app`, { body: { returnTo: 'https://remastly.test/app/#golive' } });
  const created = await call('GET', `/github/created?code=m1&state=${stateOf(r.body.action)}`, { cookie: r.cookie });
  assert.equal(created.status, 302);
  const install = new URL(created.location);
  assert.equal(install.pathname, '/apps/gardener-ab12/installations/new');
  assert.deepEqual(await sealedSettings(), { GITHUB_OWNERS: 'Org-A', GITHUB_APP_ID: '99', GITHUB_PRIVATE_KEY: PEM, GITHUB_WEBHOOK_SECRET: 'whsec' });
  let card = await call('GET', `/projects/${id}/app`);
  assert.deepEqual(card.body.app.githubApp, { slug: 'gardener-ab12', htmlUrl: 'https://github.example/apps/gardener-ab12', account: null, installed: false, filled: ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'] });
  for (const secret of ['PRIVATE KEY', 'whsec', 'csec']) assert.ok(!card.text.includes(secret), `no ${secret} in the card`);

  // An installation number GitHub does not know for this app is refused; the trip is used up.
  const wrong = await call('GET', `/github/installed?installation_id=666&setup_action=install&state=${install.searchParams.get('state')}`, { cookie: created.cookie });
  assert.match(wrong.location, /github=error/);
  // Installed again from the card: the installation is filled; the owner already set stays.
  r = await call('POST', `/projects/${id}/app/github-app/install`, { body: { returnTo: 'https://remastly.test/app/#golive' } });
  const done = await call('GET', `/github/installed?installation_id=555&setup_action=install&state=${stateOf(r.body.url)}`, { cookie: r.cookie });
  assert.match(done.location, /^https:\/\/remastly\.test\/app\/\?github=app-made#golive$/);
  assert.equal((await sealedSettings()).GITHUB_INSTALLATION_ID, '555');
  assert.equal((await sealedSettings()).GITHUB_OWNERS, 'Org-A');
  card = await call('GET', `/projects/${id}/app`);
  assert.deepEqual([card.body.app.githubApp.installed, card.body.app.githubApp.account, card.body.app.missing], [true, 'PanScienceInnovation', ['DATABASE_URL']]);

  // Made once: a second one needs the first forgotten; forgetting keeps the settings it filled.
  assert.equal((await call('POST', `/projects/${id}/app/github-app`, { body: {} })).status, 409);
  r = await call('DELETE', `/projects/${id}/app/github-app`);
  assert.equal(r.body.app.githubApp, null);
  assert.equal((await sealedSettings()).GITHUB_APP_ID, '99');
});
