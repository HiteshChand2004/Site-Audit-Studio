// Go live → "Run my app on Remastly" (apps/): what an app's code needs, read without running it; Remastly's GitHub app made
// and used against a stand-in GitHub over real HTTP (its private key really signs, the stand-in really checks); and the routes'
// rules: GitHub's way back only counts in the browser that started it, and only installations a person reached are theirs.
// The box itself needs Docker and is tried end to end by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import * as tar from 'tar';
import { db } from '../src/db/index.js';
import { applyMigrations } from '../src/db/apply.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { AppError, appPaths, findApp, nodeMajor, parseEnvText, pickNode, repoRoot } from '../src/apps/detect.js';
import { appJwt, convertManifest, downloadRepository, githubConfig, installationsOf, repositoriesOf } from '../src/apps/github.js';
import { appsRouter, githubReturnRouter, githubRouter } from '../src/routes/apps.js';
import { seedProject } from './helpers/projects.js';

let dir;
let gh;
let api;
let base;
const { privateKey: PEM, publicKey: PUB } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SHA = 'a'.repeat(40);
const seen = [];

/** Writes files under `root`: { 'a/b.js': 'text' }. */
async function files(root, map) {
  for (const [rel, text] of Object.entries(map)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

// A Next.js app as a team keeps it: a lockfile, an example settings file, route handlers, a page that reads a secret.
const NEXT_APP = {
  'package.json': JSON.stringify({ name: 'shop', engines: { node: '>=18' }, dependencies: { next: '15.0.0', react: '19.0.0' }, scripts: { build: 'next build', start: 'next start -p 4001' } }),
  'package-lock.json': '{}',
  '.env.example': 'GITHUB_CLIENT_ID=your-client-id\nDATABASE_URL=\n# a comment\nNODE_ENV=production\n',
  'app/api/me/route.ts': 'export async function GET() { return Response.json({ id: process.env.GITHUB_CLIENT_ID }); }',
  'app/(auth)/auth/login/route.ts': 'export async function GET() { const s = process.env["GITHUB_CLIENT_SECRET"]; return new Response(s); }',
  'app/dashboard/page.tsx': 'const { SESSION_KEY, PORT } = process.env; export default function P() { return null; }',
  'node_modules/x/index.js': 'process.env.NOT_READ',
};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-apps-'));
  // The repository GitHub hands out, as its archive holds it: one top folder named after it.
  await files(path.join(dir, 'tarsrc', `riya-shop-${SHA.slice(0, 7)}`), NEXT_APP);
  const tarball = path.join(dir, 'shop.tar.gz');
  await tar.c({ gzip: true, file: tarball, cwd: path.join(dir, 'tarsrc') }, [`riya-shop-${SHA.slice(0, 7)}`]);
  const { readFile } = await import('node:fs/promises');
  const archive = await readFile(tarball);

  gh = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (st, v) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      const auth = req.headers.authorization ?? '';
      const u = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: u.pathname, auth, body });
      if (req.method === 'POST' && u.pathname === '/app-manifests/c1/conversions') {
        return send(201, { id: 7, slug: 'remastly-test', client_id: 'cid', client_secret: 'csec', pem: PEM, html_url: 'https://github.example/apps/remastly-test' });
      }
      if (req.method === 'POST' && u.pathname === '/login/oauth/access_token') {
        const j = JSON.parse(body);
        if (j.client_secret !== 'csec') return send(401, { message: 'bad client' });
        return send(200, j.code === 'riya-code' ? { access_token: 'riya-token' } : j.code === 'sam-code' ? { access_token: 'sam-token' } : { error: 'bad_verification_code' });
      }
      const user = { 'Bearer riya-token': 'riya', 'Bearer sam-token': 'sam' }[auth];
      if (u.pathname === '/user') return user ? send(200, { login: user }) : send(401, { message: 'no' });
      if (u.pathname === '/user/installations') return send(200, { installations: user === 'riya' ? [{ id: 11, account: { login: 'riya' } }] : [] });
      const tok = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (tok) {
        // The app's sign-in must be a JWT its private key signed, naming the app.
        const [h, p, sig] = auth.replace(/^Bearer /, '').split('.');
        const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(PUB, Buffer.from(sig ?? '', 'base64url'));
        if (!ok || JSON.parse(Buffer.from(p, 'base64url').toString()).iss !== '7') return send(401, { message: 'bad jwt' });
        return send(201, { token: `inst-${tok[1]}` });
      }
      if (auth !== 'Bearer inst-11') return send(404, { message: 'Not Found' });
      if (u.pathname === '/installation/repositories') return send(200, { repositories: [{ full_name: 'riya/shop', default_branch: 'main', private: true }] });
      if (u.pathname === '/repos/riya/shop/commits/main') return send(200, { sha: SHA });
      if (u.pathname === `/repos/riya/shop/tarball/${SHA}`) return res.writeHead(302, { location: '/codeload/shop.tar.gz' }).end();
      return send(404, { message: 'Not Found' });
    });
  });
  // The archive itself, where GitHub's address leads (no sign-in needed there, as on codeload).
  const handler = gh.listeners('request')[0];
  gh.removeAllListeners('request');
  gh.on('request', (req, res) => (req.url === '/codeload/shop.tar.gz' ? res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': archive.length }).end(archive) : handler(req, res)));
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  githubConfig.web = githubConfig.api = `http://127.0.0.1:${gh.address().port}`;

  applyMigrations(db, { migrations: MIGRATIONS.filter((m) => m.id === '2026-11-14-deploy-tables') });
  process.env.SAS_PUBLIC_ORIGIN = 'https://remastly.test';
  const app = express();
  app.use('/api/github', githubReturnRouter);
  app.use(express.json());
  // A signed-in person: `x-test-user` = their id, `x-test-role` = their role.
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) /** @type {any} */ (req).user = { id: req.headers['x-test-user'], role: req.headers['x-test-role'] ?? 'member' };
    next();
  });
  app.use('/api/projects', appsRouter);
  app.use('/api/github', githubRouter);
  api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${api.address().port}/api`;
});
after(async () => {
  api?.close();
  gh?.close();
  delete process.env.SAS_PUBLIC_ORIGIN;
  await rm(dir, { recursive: true, force: true });
});

test('a Next.js app: how it is installed, built and started, its port, the settings its code reads, the paths that are its own', async () => {
  const root = path.join(dir, 'next');
  await files(root, NEXT_APP);
  const app = await findApp(root);
  assert.deepEqual([app.framework, app.node, app.pm, app.install, app.build, app.start, app.port], ['next', 20, 'npm', 'npm ci', 'npm run build', 'npm run start', 4001]);
  assert.deepEqual(app.settings.map((s) => [s.name, s.from]), [['DATABASE_URL', 'example'], ['GITHUB_CLIENT_ID', 'both'], ['GITHUB_CLIENT_SECRET', 'code'], ['SESSION_KEY', 'code']]);
  assert.equal(app.settings.find((s) => s.name === 'GITHUB_CLIENT_ID').example, 'your-client-id');
  // /auth is a route group's folder; /dashboard has a page only, so the copy may keep its page.
  assert.deepEqual(app.paths, ['/api/*', '/auth/*']);
  assert.deepEqual(app.warnings, ['The app asks for Node.js 18; it runs on Node.js 20, the nearest one Remastly offers.']);
});

test('other apps: pnpm and Express, no start, not Node.js; and the small readers', async () => {
  const pnpm = path.join(dir, 'pnpm');
  await files(pnpm, { 'package.json': JSON.stringify({ dependencies: { express: '5' }, scripts: { start: 'node server.js' } }), 'pnpm-lock.yaml': '' });
  const a = await findApp(pnpm);
  assert.deepEqual([a.framework, a.install, a.build, a.start, a.port, a.node], ['node', 'corepack pnpm install --frozen-lockfile', null, 'corepack pnpm run start', 3000, 22]);
  assert.deepEqual(await appPaths(pnpm, 'node'), ['/api/*', '/auth/*']);

  const none = path.join(dir, 'nostart');
  await files(none, { 'package.json': JSON.stringify({ dependencies: {} }) });
  await assert.rejects(findApp(none), (e) => e instanceof AppError && /no "start" script/.test(e.message));
  const py = path.join(dir, 'py');
  await files(py, { 'requirements.txt': 'flask' });
  await assert.rejects(findApp(py), /found no Node\.js app[^]*requirements\.txt at the top/);

  assert.deepEqual([nodeMajor('v22.3.0'), nodeMajor('>=18 <21'), nodeMajor(''), pickNode(18), pickNode(26), pickNode(null)], [22, 18, null, 20, 24, 22]);
  assert.deepEqual(parseEnvText('export A=1\nB="two words" # not a comment inside\nC=three # a comment\nKEY="-----BEGIN\nline\n-----END"\n# D=4\nE=\'x=y\''),
    { A: '1', B: 'two words', C: 'three', KEY: '-----BEGIN\nline\n-----END', E: 'x=y' });
  assert.equal(await repoRoot(path.join(dir, 'tarsrc')), path.join(dir, 'tarsrc', `riya-shop-${SHA.slice(0, 7)}`));
});

test('an app in a folder: a workspace installed from the top, a folder of its own installed there, and the choice of folder', async () => {
  const ws = path.join(dir, 'workspace');
  await files(ws, {
    'package.json': JSON.stringify({ name: 'gardener', private: true, workspaces: ['apps/*'], scripts: { dev: 'turbo dev' } }),
    'package-lock.json': '{}',
    '.env.example': 'SESSION_SECRET=\n',
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '15' }, scripts: { build: 'next build', start: 'next start' } }),
    'apps/web/app/auth/login/route.ts': 'export const GET = () => new Response(process.env.GITHUB_CLIENT_ID);',
    'apps/api/package.json': JSON.stringify({ name: 'api', scripts: { start: 'node index.js -p 5000' } }),
    'backend/requirements.txt': 'fastapi',
  });
  const web = await findApp(ws);
  assert.deepEqual([web.folder, web.install, web.build, web.start], ['apps/web', 'npm ci', 'cd "apps/web" && npm run build', 'cd "apps/web" && npm run start'], 'installed once at the top, built and started in its folder');
  assert.deepEqual(web.folders, [{ folder: 'apps/web', name: 'web', framework: 'next' }, { folder: 'apps/api', name: 'api', framework: 'node' }]);
  assert.deepEqual(web.settings.map((x) => x.name), ['GITHUB_CLIENT_ID', 'SESSION_SECRET'], 'its own code, and the example at the top');
  assert.deepEqual(web.paths, ['/api/*', '/auth/*']);
  const apiApp = await findApp(ws, 'apps/api');
  assert.deepEqual([apiApp.framework, apiApp.start, apiApp.port], ['node', 'cd "apps/api" && npm run start', 5000]);
  await assert.rejects(findApp(ws, '../etc'), /not a folder of this repository/);

  const split = path.join(dir, 'split');
  await files(split, {
    'package.json': JSON.stringify({ name: 'root', scripts: { lint: 'eslint .' } }),
    'frontend/package.json': JSON.stringify({ dependencies: { next: '15' }, scripts: { build: 'next build', start: 'next start' } }),
    'frontend/pnpm-lock.yaml': '',
    'server/requirements.txt': 'flask',
  });
  const front = await findApp(split);
  assert.deepEqual([front.folder, front.install, front.start], ['frontend', 'cd "frontend" && corepack pnpm install --frozen-lockfile', 'cd "frontend" && corepack pnpm run start'], 'a folder of its own');

  const none = path.join(dir, 'none');
  await files(none, { 'package.json': JSON.stringify({ scripts: { lint: 'x' } }), 'api/pyproject.toml': '' });
  await assert.rejects(findApp(none), /package\.json at the top with no "start" script, pyproject\.toml in api\//);
});

test('GitHub: the app made from its manifest, a person\'s installations, a token for one repository to read, its code', async () => {
  const app = await convertManifest('c1');
  assert.deepEqual([app.id, app.slug, app.clientId], [7, 'remastly-test', 'cid']);
  assert.equal(appJwt(app).split('.').length, 3);
  assert.deepEqual(await installationsOf(app, 'riya-code'), { login: 'riya', installations: [{ id: 11, account: 'riya' }] });
  await assert.rejects(installationsOf(app, 'old-code'), /expired/);
  assert.deepEqual(await repositoriesOf(app, 11), [{ fullName: 'riya/shop', branch: 'main', private: true }]);

  const file = path.join(dir, 'dl.tar.gz');
  assert.deepEqual(await downloadRepository(app, { installationId: 11, fullName: 'riya/shop', branch: 'main' }, file), { commit: SHA });
  const asked = seen.filter((s) => s.path === '/app/installations/11/access_tokens').at(-1);
  assert.deepEqual(JSON.parse(asked.body), { permissions: { contents: 'read', metadata: 'read' }, repositories: ['shop'] }, 'reading only, one repository');
  await assert.rejects(downloadRepository(app, { installationId: 11, fullName: '../etc', branch: 'main' }, file), /not a repository name/);
});

test('the routes: GitHub set up once by the owner, connected per person in their own browser, their own installations only', async () => {
  const call = async (method, p, { body, user, role, cookie } = {}) => {
    const headers = { ...(body && { 'content-type': 'application/json' }), ...(user && { 'x-test-user': user }), ...(role && { 'x-test-role': role }), ...(cookie && { cookie }) };
    const res = await fetch(`${base}${p}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), cookie: res.headers.get('set-cookie')?.split(';')[0], body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  const owner = { user: 'owner-1', role: 'owner' };
  const riya = { user: 'riya-1' };
  const sam = { user: 'sam-1' };

  // Only the owner sets GitHub up.
  assert.equal((await call('POST', '/github/setup', { body: {}, ...riya })).status, 403);
  let r = await call('POST', '/github/setup', { body: { returnTo: 'https://remastly.test/app/' }, ...owner });
  const manifest = JSON.parse(r.body.manifest);
  assert.deepEqual([manifest.redirect_url, manifest.callback_urls, manifest.default_permissions], ['https://remastly.test/api/github/created', ['https://remastly.test/api/github/callback'], { contents: 'read', metadata: 'read' }]);
  const setupState = new URL(r.body.action).searchParams.get('state');
  // GitHub's answer reaching another browser (no cookie) makes nothing.
  r = await call('GET', `/github/created?code=c1&state=${setupState}`);
  assert.match(r.location, /github=error/);
  assert.equal((await call('GET', '/github', riya)).body.ready, false);
  // In the owner's browser: made. (A new trip: the first was used up.)
  r = await call('POST', '/github/setup', { body: {}, ...owner });
  const created = await call('GET', `/github/created?code=c1&state=${new URL(r.body.action).searchParams.get('state')}`, { cookie: r.cookie });
  assert.match(created.location, /^https:\/\/remastly\.test\/app\/\?github=ready/);
  assert.deepEqual((await call('GET', '/github', riya)).body.app, { slug: 'remastly-test' }, 'a person sees the app, not its page on GitHub');

  // Riya connects in her browser.
  r = await call('POST', '/github/connect', { body: { returnTo: 'https://remastly.test/app/#golive' }, ...riya });
  const riyaState = new URL(r.body.url).searchParams.get('state');
  // Sam sends Riya's sign-in through his own trip's link: it only counts in the browser that started it.
  const samTrip = await call('POST', '/github/connect', { body: {}, ...sam });
  const samState = new URL(samTrip.body.url).searchParams.get('state');
  r = await call('GET', `/github/callback?code=riya-code&state=${samState}`, { cookie: 'sas_github=someone-else' });
  assert.match(r.location, /github=error/);
  assert.equal((await call('GET', '/github', sam)).body.connected, null, 'Riya\'s GitHub was not attached to Sam');
  r = await call('GET', `/github/callback?code=riya-code&state=${riyaState}`, { cookie: `sas_github=${riyaState}` });
  assert.match(r.location, /github=connected/);
  assert.deepEqual((await call('GET', '/github', riya)).body.connected, { login: 'riya', installations: [{ id: 11, account: 'riya' }] });
  assert.deepEqual((await call('GET', '/github/repos', riya)).body.repos, [{ fullName: 'riya/shop', branch: 'main', private: true, installationId: 11, account: 'riya' }]);

  // The website's app: her installation only; read now, nothing runs; settings never come back.
  const project = seedProject(db, { name: 'shop', url: 'https://shop.example.com/' });
  r = await call('POST', `/projects/${project.id}/app/repo`, { body: { installationId: 99, fullName: 'riya/shop', branch: 'main' }, ...riya });
  assert.equal(r.status, 403);
  // Sam (connected, no installations) cannot use Riya's installation number either.
  const samConnect = await call('POST', '/github/connect', { body: {}, ...sam });
  const s2 = new URL(samConnect.body.url).searchParams.get('state');
  await call('GET', `/github/callback?code=sam-code&state=${s2}`, { cookie: `sas_github=${s2}` });
  assert.equal((await call('POST', `/projects/${project.id}/app/repo`, { body: { installationId: 11, fullName: 'riya/shop', branch: 'main' }, ...sam })).status, 403);

  r = await call('POST', `/projects/${project.id}/app/repo`, { body: { installationId: 11, fullName: 'riya/shop', branch: 'main' }, ...riya });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.app.status, r.body.app.repo.commit, r.body.app.app.framework], ['ready', SHA, 'next']);
  assert.deepEqual(r.body.app.missing, ['DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_KEY']);
  r = await call('PUT', `/projects/${project.id}/app/settings`, { body: { text: 'GITHUB_CLIENT_ID=abc\nGITHUB_CLIENT_SECRET=very-secret-value\nPORT=9999' }, ...riya });
  assert.deepEqual([r.body.app.settingsSet, r.body.app.missing], [['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'], ['DATABASE_URL', 'SESSION_KEY']], 'PORT is the box\'s own');
  assert.ok(!JSON.stringify(r.body).includes('very-secret-value'), 'a value never comes back');
  r = await call('PUT', `/projects/${project.id}/app/settings`, { body: { values: { GITHUB_CLIENT_ID: '' } }, ...riya });
  assert.deepEqual(r.body.app.settingsSet, ['GITHUB_CLIENT_SECRET']);
  // A pasted line with nothing after "=" is a value not filled in: skipped and named back, never a removal.
  r = await call('PUT', `/projects/${project.id}/app/settings`, { body: { text: 'GITHUB_CLIENT_SECRET=\nRAZORPAY_KEY_ID=rzp', values: { SESSION_KEY: 's1' } }, ...riya });
  assert.deepEqual(r.body.saved, { saved: ['RAZORPAY_KEY_ID', 'SESSION_KEY'], empty: ['GITHUB_CLIENT_SECRET'] });
  assert.deepEqual(r.body.app.settingsSet, ['GITHUB_CLIENT_SECRET', 'RAZORPAY_KEY_ID', 'SESSION_KEY'], 'the empty line removed nothing');
  assert.deepEqual(r.body.app.unused, ['RAZORPAY_KEY_ID'], 'a setting the code never reads is named');
  // The app's last output naming a missing setting says why it stopped.
  const stateFile = path.join(process.env.SAS_DATA_DIR, 'projects', project.id, 'app', 'state.json');
  const kept = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...kept, status: 'failed', log: 'Error: Missing required configuration: DATABASE_URL\n  at start' }));
  r = await call('GET', `/projects/${project.id}/app`, riya);
  assert.deepEqual(r.body.app.stoppedFor, ['DATABASE_URL']);
  await writeFile(stateFile, JSON.stringify(kept));
  // Nothing of the download stays behind.
  assert.deepEqual(await readdir(path.join(process.env.SAS_DATA_DIR, 'projects', project.id, 'app')), ['state.json']);
  assert.equal((await call('DELETE', `/projects/${project.id}/app`, riya)).body.app.status, 'empty');
});
