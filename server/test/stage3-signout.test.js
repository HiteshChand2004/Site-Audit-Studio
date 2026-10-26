// Signing out (and every other way a session ends) lands the browser on the sign-in page and it STAYS there: no redirect back to
// the app, no reload loop. A real Chromium against the real API (accounts on), the app as built (vite build, served under
// /app/) and the one-address proxy (scripts/local-proxy.mjs). The marketing site is a fixed stand-in page here, so what is
// measured is the app's and the proxy's behaviour, not a dev server's.
// The 2026-10-23 report ("sign out → the page reloads by itself forever") was the marketing site's long-running dev server
// reloading every page it served (HMR "hash mismatch" every ~150 ms, with or without the app); these are the app's cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { createLocalProxy } from '../../scripts/local-proxy.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.resolve(SERVER, '..', 'client');
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const STAY_MS = 3000;

/** The app as built, served under /app/ like the dev server does (unknown paths → index.html). */
async function serveBuild(t, dist) {
  const port = await freePort();
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
  const s = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/app\/?/, '');
    let file = path.join(dist, rel);
    if (!file.startsWith(dist) || !rel || !(await stat(file).then((x) => x.isFile(), () => false))) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  });
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }));
  return { host: '127.0.0.1', port };
}

/** The marketing site's stand-in: every page is a plain page that does nothing by itself. */
async function standInSite(t) {
  const port = await freePort();
  const s = createServer((req, res) => {
    if (req.url?.startsWith('/icon')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Sign in</title><h1>marketing ${req.url}</h1>`);
  });
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }));
  return { host: '127.0.0.1', port };
}

async function setup(t) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sas-signout-'));
  const dist = path.join(work, 'dist');
  await promisify(execFile)(process.execPath, [path.join(CLIENT, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: CLIENT });
  const dataDir = path.join(work, 'data');
  await import('node:fs/promises').then((fs) => fs.mkdir(dataDir));
  const dbFile = path.join(dataDir, 'app.db');
  const d = new DatabaseSync(dbFile);
  applySchema(d);
  applyMigrations(d, { ownerEmail: 'owner@example.com' });
  const now = new Date().toISOString();
  d.prepare("INSERT INTO users (id, email, name, password_hash, role, email_verified_at, created_at, updated_at) VALUES ('u1', 'me@example.com', 'Me Test', ?, 'user', ?, ?, ?)").run(await hashPassword('password123'), now, now, now);
  d.close();

  const apiPort = await freePort();
  const proxyPort = await freePort();
  const origin = `http://localhost:${proxyPort}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir, PORT: String(apiPort), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_ACCOUNTS: '1', SAS_PUBLIC_ORIGIN: origin, APP_ORIGIN: origin, SAS_DEV_NO_VERIFY: '', SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', NODE_ENV: '', SAS_COOKIE_SECURE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  for (let i = 0; i < 150 && !/API ready/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /API ready/, out);

  const proxy = createLocalProxy({ api: { host: '127.0.0.1', port: apiPort }, app: await serveBuild(t, dist), site: await standInSite(t) });
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((r) => { proxy.closeAllConnections?.(); proxy.close(r); });
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(work, { recursive: true, force: true, maxRetries: 5 });
  });
  return { browser, origin, dbFile };
}

/** A page that records every main-frame navigation. */
async function watched(ctx) {
  const page = await ctx.newPage();
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(new URL(f.url()).pathname + new URL(f.url()).search); });
  return { page, navs };
}

async function signIn(page, origin) {
  await page.goto(`${origin}/auth?mode=signin`);
  const status = await page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'me@example.com', password: 'password123' }) })).status);
  assert.equal(status, 200);
}

/** Waits until the page is on `path`, then asserts nothing navigates for STAY_MS. */
async function landsAndStays(page, navs, pathPrefix, label) {
  await page.waitForURL((u) => (u.pathname + u.search).startsWith(pathPrefix), { timeout: 10000 });
  const at = navs.length;
  await page.waitForTimeout(STAY_MS);
  assert.deepEqual(navs.slice(at), [], `${label}: no further navigation after landing on ${pathPrefix} (saw ${JSON.stringify(navs)})`);
  assert.ok((await page.title()) === 'Sign in', `${label}: on the sign-in page`);
}

/** A real action that talks to the server: add a website through the app's own form. */
async function addAWebsite(page) {
  await page.getByRole('button', { name: /Add a website/ }).first().click();
  await page.fill('input[placeholder="https://example.com"]', 'https://example.com/');
  await page.check('dialog input[type="checkbox"]');
  await page.click('dialog button[type="submit"]');
}

const sessionCookie = async (ctx) => (await ctx.cookies()).find((c) => c.name === 'sas_session');

test('sign out from the profile menu lands on the sign-in page and stays there; the session is gone', { timeout: 180000 }, async (t) => {
  const { browser, origin } = await setup(t);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, navs } = await watched(ctx);
  await signIn(page, origin);
  await page.goto(`${origin}/app/`);
  await page.locator('button[aria-haspopup="menu"]').click();
  navs.length = 0;
  await page.click('[role="menuitem"]:has-text("Sign out")');
  await landsAndStays(page, navs, '/auth?mode=signin', 'sign out');
  assert.deepEqual(navs, ['/auth?mode=signin'], 'exactly one navigation');
  assert.equal(await sessionCookie(ctx), undefined, 'the cookie is cleared');
  // And the app is closed again: one redirect to sign in, then still.
  navs.length = 0;
  await page.goto(`${origin}/app/`);
  await landsAndStays(page, navs, '/auth?mode=signin&next=%2Fapp%2F', 'after sign out, /app/');

  // From the collapsed sidebar too.
  await signIn(page, origin);
  await page.goto(`${origin}/app/`);
  await page.keyboard.press('Control+b');
  await page.locator('button[aria-haspopup="menu"]').click();
  navs.length = 0;
  await page.click('[role="menuitem"]:has-text("Sign out")');
  await landsAndStays(page, navs, '/auth?mode=signin', 'sign out from the rail');
});

test('no session, an expired session, and signing out in another tab all land on sign-in once and stay', { timeout: 180000 }, async (t) => {
  const { browser, origin, dbFile } = await setup(t);

  // Never signed in.
  const fresh = await browser.newContext();
  const a = await watched(fresh);
  await a.page.goto(`${origin}/app/`);
  await landsAndStays(a.page, a.navs, '/auth?mode=signin&next=%2Fapp%2F', 'no session');
  assert.equal(a.navs.length, 1, `one navigation (${JSON.stringify(a.navs)})`);

  // A session that expired (not signed out): the cookie is still in the browser.
  const ctx = await browser.newContext();
  const b = await watched(ctx);
  await signIn(b.page, origin);
  await b.page.goto(`${origin}/app/`);
  await b.page.locator('button[aria-haspopup="menu"]').waitFor();
  const d = new DatabaseSync(dbFile);
  d.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  d.close();
  assert.ok(await sessionCookie(ctx), 'the browser still holds the cookie');
  await b.page.waitForTimeout(3200); // past the proxy's 3 s memory of a good verdict
  b.navs.length = 0;
  await b.page.goto(`${origin}/app/`);
  await landsAndStays(b.page, b.navs, '/auth?mode=signin&next=%2Fapp%2F', 'expired session, page load');
  // …and from inside a running app: its next API call hears 401 and sends it to sign in, once.
  await signIn(b.page, origin);
  await b.page.goto(`${origin}/app/`);
  await b.page.locator('button[aria-haspopup="menu"]').waitFor();
  const d2 = new DatabaseSync(dbFile);
  d2.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  d2.close();
  b.navs.length = 0;
  await addAWebsite(b.page); // an idle app makes no request; the first thing that talks to the server finds out
  await landsAndStays(b.page, b.navs, '/auth?mode=signin', 'expired session, app running');

  // Two tabs: signed out in one, the other's next request ends up on sign in, and stays.
  const shared = await browser.newContext();
  const one = await watched(shared);
  const two = await watched(shared);
  await signIn(one.page, origin);
  await one.page.goto(`${origin}/app/`);
  await two.page.goto(`${origin}/app/`);
  await two.page.locator('button[aria-haspopup="menu"]').waitFor();
  await one.page.locator('button[aria-haspopup="menu"]').click();
  await one.page.click('[role="menuitem"]:has-text("Sign out")');
  await landsAndStays(one.page, one.navs, '/auth?mode=signin', 'tab that signed out');
  two.navs.length = 0;
  await addAWebsite(two.page);
  await landsAndStays(two.page, two.navs, '/auth?mode=signin', 'the other tab');
  assert.ok(two.navs.length <= 1, `the other tab navigated once (${JSON.stringify(two.navs)})`);
});
