// The preview sandbox, proven in a browser against the real API (accounts on) behind one address, as the product is hosted:
// 1. THE RISK: a copy of a site served on a path of the app's address and framed as the app framed copies until 2026-10-24
//    (sandbox="allow-same-origin allow-scripts") IS the app's origin — the copied site's own script reads the signed-in user's
//    account and projects from the API with the user's cookie, and the app's storage.
// 2. THE FIX: the same copy through recreate/previewRoute.js (every document sent with `Content-Security-Policy: sandbox
//    allow-scripts`) in a frame with sandbox="allow-scripts": the script runs, the copy's own files load (stylesheet, script,
//    data, from root-relative addresses moved under the preview — in the markup by the server, at run time by the shim of
//    recreate/previewShim.js: fetch, XMLHttpRequest, new URL, a script or image the page adds, a module imported by address),
//    the page sees its own address, and nothing of the app is reachable — no cookie goes with its requests, the API refuses
//    what still arrives (security/foreignOrigin.js), the app's storage and cookies are not readable (private empty stand-ins
//    answer, so the site's script does not stop), there is no service worker. What the script could not load is reported to
//    the app as counts. Opened in a tab of its own, the preview is sandboxed just the same (the header, not the frame, decides).
// One browser; run alone with SAS_TEST_BROWSER_CONCURRENCY=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { typeExtOf, TYPES } from '../src/recreate/verify/server.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** What a copied site's script tries once it runs: the app's API as the user, the app's storage and cookies, a service worker. */
const PROBE = `(async () => {
  const r = {};
  const attempt = async (name, url, init) => {
    try { const res = await fetch(url, init); r[name] = { status: res.status, text: (await res.text()).slice(0, 300) }; }
    catch (e) { r[name] = { error: String(e && e.message || e) }; }
  };
  await attempt('me', '/api/auth/me');
  await attempt('projects', '/api/projects', { credentials: 'include' });
  await attempt('own', 'data.json');
  try { r.cookie = document.cookie; } catch (e) { r.cookie = 'error:' + e.name; }
  try { r.storage = localStorage.getItem('app-secret'); } catch (e) { r.storage = 'error:' + e.name; }
  // Addresses the site's own script builds at run time, as a real site's bundle does.
  await attempt('rootFetch', '/data.json');
  await attempt('originFetch', location.origin + '/data.json');
  await attempt('relFetch', 'data.json');
  try { r.urlCtor = new URL('/data.json', location.href).pathname; } catch (e) { r.urlCtor = 'error:' + e.name; }
  r.xhr = await new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', '/data.json'); x.onloadend = () => res(x.status); x.send(); } catch (e) { res('error:' + e.name); } });
  r.late = await new Promise((res) => { const s = document.createElement('script'); s.src = '/late.js'; s.onload = () => res(window.__late === true); s.onerror = () => res(false); document.head.appendChild(s); });
  r.img = await new Promise((res) => { const d = document.createElement('div'); d.innerHTML = '<img src="/dot.png">'; document.body.appendChild(d); const i = d.firstChild; i.onload = () => res(i.naturalWidth); i.onerror = () => res('error'); if (i.complete && i.naturalWidth) res(i.naturalWidth); });
  r.mod = await import('/mod.js').then((x) => x.ok, (e) => 'error:' + e.name);
  r.dynImport = await import('/mo' + 'd.js').then((x) => x.ok, (e) => 'error:' + e.name);
  try { const st = document.createElement('style'); document.head.appendChild(st); st.sheet.insertRule('body{cursor:url(/dot.png),auto}', 0); r.cssom = getComputedStyle(document.body).cursor; } catch (e) { r.cssom = 'error:' + e.name; }
  try { r.swProp = typeof navigator.serviceWorker; } catch (e) { r.swProp = 'error:' + e.name; }
  try { const d = document.createElement('div'); d.style.backgroundImage = 'url(/dot.png)'; r.styleProp = d.style.backgroundImage; } catch (e) { r.styleProp = 'error:' + e.name; }
  r.pathname = location.pathname;
  try { localStorage.setItem('k', 'v'); r.storeRound = localStorage.getItem('k'); } catch (e) { r.storeRound = 'error:' + e.name; }
  try { document.cookie = 'a=1'; r.cookieRound = document.cookie; } catch (e) { r.cookieRound = 'error:' + e.name; }
  await attempt('missing', '/missing.json');
  try { const reg = await navigator.serviceWorker.register('sw.js'); r.sw = 'registered:' + new URL(reg.scope).pathname; await reg.unregister(); }
  catch (e) { r.sw = 'error:' + e.name; }
  history.pushState(null, '', '/about');
  r.pushed = location.pathname;
  r.origin = self.origin; // the document's origin ("null" when opaque; location.origin is the address's)
  r.bg = getComputedStyle(document.body).backgroundColor;
  r.appjs = window.__appjs === true;
  parent.postMessage({ probe: r }, '*');
})();`;

/** The copied site: a page with a root-relative stylesheet, script and data file, and the probe above as its own script. */
async function copyFolder() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-sandbox-copy-'));
  await mkdir(path.join(root, 'about'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>copied site</title>
<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script></head><body><h1>Copied</h1><p>A page of the copied site, with enough words on it to count as drawn.</p><a href="/about/">about</a>
<script>${PROBE}</script></body></html>`, 'utf8');
  await writeFile(path.join(root, 'about', 'index.html'), '<!doctype html><title>about</title>', 'utf8');
  await writeFile(path.join(root, 'styles.css'), 'body{background:rgb(1, 2, 3)}', 'utf8');
  await writeFile(path.join(root, 'app.js'), 'window.__appjs = true;', 'utf8');
  await writeFile(path.join(root, 'data.json'), '{"own":true}', 'utf8');
  await writeFile(path.join(root, 'sw.js'), "self.addEventListener('install', () => self.skipWaiting());", 'utf8');
  await writeFile(path.join(root, 'late.js'), 'window.__late = true;', 'utf8');
  await writeFile(path.join(root, 'mod.js'), 'import "/dep.js"; export const ok = window.__dep === true;', 'utf8');
  await writeFile(path.join(root, 'dep.js'), 'window.__dep = true;', 'utf8');
  await writeFile(path.join(root, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  // A page whose script draws nothing and asks for a file the copy does not have.
  await mkdir(path.join(root, 'blank'), { recursive: true });
  await writeFile(path.join(root, 'blank', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script>fetch("/missing.json").catch(() => {});</script></body></html>', 'utf8');
  return root;
}

/**
 * The product's one address: /api and /preview to the real API process; /old/<x>/ the copy as a path-hosted static folder
 * without any of the new headers (how a copy served by path looked before); /host a page that frames a given address.
 */
function front({ apiPort, copyRoot }) {
  const proxy = (req, res) => {
    const headers = { ...req.headers };
    const up = http.request({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/preview')) return proxy(req, res);
    if (url.pathname === '/host') {
      const sandbox = url.searchParams.get('sandbox') ?? '';
      const src = url.searchParams.get('src') ?? '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>app</title><script>window.__results=[];localStorage.setItem('app-secret','42');addEventListener('message',(e)=>__results.push(e.data));</script>
<iframe id="f" sandbox="${sandbox}" src="${src}" width="600" height="400"></iframe>`);
    }
    if (url.pathname.startsWith('/old/c/')) {
      const rel = url.pathname.slice('/old/c/'.length) || 'index.html';
      const file = path.join(copyRoot, rel.endsWith('/') ? `${rel}index.html` : rel);
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[typeExtOf(file)] ?? 'application/octet-stream' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('SITE');
  });
}

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-sandbox-'));
  const d = new DatabaseSync(path.join(dataDir, 'app.db'));
  applySchema(d);
  applyMigrations(d, { ownerEmail: 'owner@example.com' });
  d.close();
  const apiPort = await freePort();
  const frontPort = await freePort();
  const origin = `http://localhost:${frontPort}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dataDir, PORT: String(apiPort), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_ACCOUNTS: '1', SAS_DEV_NO_VERIFY: '1', SAS_PUBLIC_ORIGIN: origin, APP_ORIGIN: origin,
      SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', NODE_ENV: '', SAS_COOKIE_SECURE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const copyRoot = await copyFolder();
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(copyRoot, { recursive: true, force: true });
  });
  for (let i = 0; i < 150 && !/API ready/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /API ready/, out);
  const server = front({ apiPort, copyRoot });
  await new Promise((r) => server.listen(frontPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

  const call = (method, p, { cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: frontPort, method, path: p,
      headers: { host: `localhost:${frontPort}`, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json', origin } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

  // A signed-in user with one as-is copy on record (the rows the API reads; the folder the preview serves).
  const up = await call('POST', '/api/auth/signup', { body: { email: 'me@example.com', password: 'password123' } });
  assert.equal(up.status, 201, up.text);
  const cookie = up.headers['set-cookie'][0].split(';')[0];
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get('me@example.com');
  const projectId = randomUUID();
  const recreateId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, -1, ?, ?, ?)')
    .run(projectId, 'copied site', 'https://copied.example/', 'html', user.id, now, now);
  db.prepare("INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)")
    .run(recreateId, projectId, now, now, JSON.stringify({ asIs: { stack: 'html' }, pages: [{ outPath: 'index.html' }] }));
  db.close();
  const asIsDir = path.join(dataDir, 'projects', projectId, 'recreate', recreateId, 'as-is', 'copy');
  await mkdir(path.dirname(asIsDir), { recursive: true });
  await rm(asIsDir, { recursive: true, force: true });
  await mkdir(asIsDir, { recursive: true });
  for (const f of ['index.html', 'styles.css', 'app.js', 'data.json', 'sw.js', 'late.js', 'mod.js', 'dep.js', 'dot.png']) await writeFile(path.join(asIsDir, f), await readFile(path.join(copyRoot, f)));
  for (const d of ['about', 'blank']) {
    await mkdir(path.join(asIsDir, d), { recursive: true });
    await writeFile(path.join(asIsDir, d, 'index.html'), await readFile(path.join(copyRoot, d, 'index.html')));
  }

  // A second project with a build of ours (a plain copy: no script; the strict policy on top of the sandbox).
  const plainId = randomUUID();
  const plainRecreate = randomUUID();
  const db2 = new DatabaseSync(path.join(dataDir, 'app.db'));
  db2.prepare('INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, -1, ?, ?, ?)')
    .run(plainId, 'plain copy', 'https://plain.example/', 'html', user.id, now, now);
  db2.prepare("INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at) VALUES (?, ?, 'done', 100, ?, ?)").run(plainRecreate, plainId, now, now);
  db2.close();
  const dist = path.join(dataDir, 'projects', plainId, 'recreate', plainRecreate, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><img id="dot" src="/dot.png"><p>plain</p></body></html>', 'utf8');
  await writeFile(path.join(dist, 'styles.css'), 'body{background:rgb(4, 5, 6)}', 'utf8');
  await writeFile(path.join(dist, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

  return { origin, frontPort, call, cookie, projectId, recreateId, plainId };
}

/** Opens the host page framing `src` and returns what the copied site's script managed to do. */
async function probe(browser, origin, { sandbox, src }) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${origin}/host?sandbox=${encodeURIComponent(sandbox)}&src=${encodeURIComponent(src)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__results.some((m) => m && m.probe), null, { timeout: 15000 });
    return await page.evaluate(() => window.__results.find((m) => m.probe).probe);
  } finally {
    await ctx.close();
  }
}

test('the risk, then the fix: a copied site\'s script cannot reach the app, its cookies, storage or API from the preview', { timeout: 180000 }, async (t) => {
  const s = await setup(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  // The browser signs in the way the app does: the session cookie on the one address.
  const signIn = async (ctx) => ctx.addCookies([{ name: s.cookie.split('=')[0], value: s.cookie.split('=')[1], url: s.origin }]);
  const probeAs = async (o) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    try {
      const page = await ctx.newPage();
      const responses = [];
      page.on('response', (r) => responses.push([r.url(), r.status(), r.headers()['content-security-policy'] ?? null]));
      await page.goto(`${s.origin}/host?sandbox=${encodeURIComponent(o.sandbox)}&src=${encodeURIComponent(o.src)}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__results.some((m) => m && m.probe), null, { timeout: 15000 });
      const result = await page.evaluate(() => window.__results.find((m) => m.probe).probe);
      result.responses = responses;
      if (o.report) {
        await page.waitForFunction(() => window.__results.some((m) => m && m.sasPreview === 1 && m.done), null, { timeout: 15000 });
        result.report = await page.evaluate(() => window.__results.filter((m) => m && m.sasPreview === 1 && m.done).pop());
      }
      return result;
    } finally {
      await ctx.close();
    }
  };

  // 1. The risk: a copy on a path of the app's address, framed as before.
  const before = await probeAs({ sandbox: 'allow-same-origin allow-scripts', src: '/old/c/' });
  assert.equal(before.origin, s.origin, 'the copied site IS the app\'s origin');
  assert.equal(before.me.status, 200, `the API answers the copied site's script as the signed-in user: ${JSON.stringify(before.me)}`);
  assert.match(before.me.text, /me@example\.com/);
  assert.equal(before.projects.status, 200);
  assert.match(before.projects.text, /copied site/, 'and lists the user\'s projects');
  assert.equal(before.storage, '42', 'and the app\'s own storage is readable');
  assert.match(before.sw, /^registered:\/old\/c\//, `a service worker was registered on the app's origin: ${before.sw}`);
  assert.equal(before.pathname, '/old/c/', 'and the site saw the folder it was put in, not its own address');

  // 2. The fix: the same copy through the preview route, framed without allow-same-origin.
  const started = await s.call('POST', `/api/projects/${s.projectId}/recreate/${s.recreateId}/asis-preview`, { cookie: s.cookie, body: {} });
  assert.equal(started.status, 200, started.text);
  const previewUrl = JSON.parse(started.text).url;
  assert.match(previewUrl, /^\/preview\/[A-Za-z0-9_-]{24}\/$/);
  const token = previewUrl.split('/')[2];
  const after = await probeAs({ sandbox: 'allow-scripts', src: previewUrl, report: true });
  assert.equal(after.origin, 'null', `the copied site has no origin of its own: ${JSON.stringify(after)}`);
  assert.notEqual(after.me.status, 200, `the API does not answer as the user: ${JSON.stringify(after.me)}`);
  assert.doesNotMatch(JSON.stringify(after.me), /me@example\.com/);
  assert.notEqual(after.projects.status, 200, JSON.stringify(after.projects));
  assert.doesNotMatch(JSON.stringify(after.projects), /copied site/);
  assert.equal(after.cookie, '', 'no cookie of the app is readable (a private empty jar answers, so the site\'s script does not stop)');
  assert.equal(after.storage, null, 'the app\'s storage is not readable (a private empty stand-in answers)');
  assert.equal(after.sw, 'error:SecurityError', `no service worker: ${after.sw}`);
  // And the copy itself works: its stylesheet, script and data, from root-relative addresses moved under the preview.
  assert.equal(after.bg, 'rgb(1, 2, 3)', 'its stylesheet applied');
  assert.equal(after.appjs, true, 'its script ran');
  assert.deepEqual(after.own, { status: 200, text: '{"own":true}' }, 'its own data fetched');
  // Addresses its script built at run time reach the copy's own files, whichever way they were built.
  const own = { status: 200, text: '{"own":true}' };
  assert.deepEqual(after.rootFetch, own, 'fetch("/x")');
  assert.deepEqual(after.originFetch, own, 'fetch(location.origin + "/x")');
  assert.deepEqual(after.relFetch, own, 'fetch("x")');
  assert.match(after.urlCtor, /^\/preview\/[A-Za-z0-9_-]{24}\/data\.json$/, 'new URL("/x", location.href)');
  assert.equal(after.xhr, 200, 'XMLHttpRequest');
  assert.equal(after.late, true, 'a script element the page adds with src="/x"');
  assert.equal(after.img, 1, 'an image written as markup with src="/x"');
  assert.equal(after.mod, true, 'import("/mod.js") whose module imports "/dep.js" by address');
  assert.equal(after.dynImport, true, 'import() of an address built at run time (the import map, no hook can reach it)');
  assert.match(after.cssom, /url\("http:\/\/localhost:\d+\/preview\/[A-Za-z0-9_-]{24}\/dot\.png"\)/, 'a rule inserted through the CSSOM');
  assert.equal(after.swProp, 'object', 'navigator.serviceWorker can be read (a stand-in that refuses to register)');
  assert.match(after.styleProp, /^url\("http:\/\/localhost:\d+\/preview\/[A-Za-z0-9_-]{24}\/dot\.png"\)$/, 'a style property set one at a time (style.backgroundImage = "url(/x)")');
  // The site sees the address it was written for, and can move within it.
  assert.equal(after.pathname, '/', 'location.pathname is the page\'s own path');
  assert.equal(after.pushed, '/about', 'history.pushState works as on its own host');
  assert.equal(after.storeRound, 'v', 'its own storage writes and reads (in memory, private to the frame)');
  assert.equal(after.cookieRound, 'a=1', 'its own cookie writes and reads (in memory, private to the frame)');
  assert.equal(after.missing.status, 404, 'a file the copy does not have is a 404 of the preview, never of the app');
  // What the app is told: counts only, with the preview's token, after the page has loaded.
  assert.equal(after.report.token, token);
  assert.equal(after.report.blank, false, 'the page drew');
  assert.ok(after.report.failed >= 1, `the missing file counted: ${JSON.stringify(after.report)}`);
  assert.ok(after.report.moved > 0, 'addresses were moved');
  assert.deepEqual(Object.keys(after.report).sort(), ['blank', 'done', 'errors', 'failed', 'moved', 'sasPreview', 'token'], 'nothing else leaves the frame');
  // A page whose script draws nothing: reported as blank, with what it could not load.
  const blank = await probeBlank(`${previewUrl}blank/`);
  assert.equal(blank.blank, true);
  assert.equal(blank.failed, 1);

  async function probeBlank(src) {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${s.origin}/host?sandbox=allow-scripts&src=${encodeURIComponent(src)}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__results.some((m) => m && m.sasPreview === 1 && m.done), null, { timeout: 15000 });
      return await page.evaluate(() => window.__results.filter((m) => m && m.sasPreview === 1 && m.done).pop());
    } finally {
      await ctx.close();
    }
  }

  // 3. The header decides, not the frame: the preview opened in a tab of its own is sandboxed too.
  const ctx = await browser.newContext();
  await signIn(ctx);
  try {
    const page = await ctx.newPage();
    const res = await page.goto(`${s.origin}${previewUrl}`, { waitUntil: 'load' });
    assert.match(res.headers()['content-security-policy'], /^sandbox allow-scripts; frame-ancestors /);
    assert.equal(await page.evaluate(() => self.origin), 'null');
    const me = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.status).catch((e) => `error:${e.name}`));
    assert.notEqual(me, 200, `top-level: ${me}`);
  } finally {
    await ctx.close();
  }

  // 4. A build of ours: no script at all in its frame (sandbox=""), and its stylesheet and image still load under the strict
  //    policy, which names the visitor's origin instead of 'self' (an opaque origin has none).
  const plain = await s.call('POST', `/api/projects/${s.plainId}/preview`, { cookie: s.cookie, body: {} });
  assert.equal(plain.status, 200, plain.text);
  const plainUrl = JSON.parse(plain.text).preview.url;
  const ctx2 = await browser.newContext();
  await signIn(ctx2);
  try {
    const page = await ctx2.newPage();
    await page.goto(`${s.origin}/host?sandbox=&src=${encodeURIComponent(plainUrl)}`, { waitUntil: 'load' });
    const frame = page.frames().find((f) => f !== page.mainFrame());
    await frame.waitForLoadState('load');
    await frame.waitForFunction(() => document.getElementById('dot')?.complete, null, { timeout: 10000 });
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(4, 5, 6)', 'its stylesheet applied under the strict policy');
    assert.equal(await frame.evaluate(() => document.getElementById('dot').naturalWidth), 1, 'its image loaded');
    assert.equal(await frame.evaluate(() => self.origin), 'null');
  } finally {
    await ctx2.close();
  }
  assert.doesNotMatch((await s.call('GET', plainUrl)).text, /<script/, 'a page that runs no script gets no shim either');

  // 5. The API's own half, without a browser: a request that says it is foreign is refused even with the real cookie.
  assert.equal((await s.call('GET', '/api/projects', { cookie: s.cookie })).status, 200, 'the app\'s own request');
  assert.equal((await s.call('GET', '/api/projects', { cookie: s.cookie, headers: { origin: 'null' } })).status, 403, 'Origin: null');
  assert.equal((await s.call('GET', '/api/projects', { cookie: s.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site');
  assert.equal((await s.call('GET', '/api/health', { headers: { origin: 'null' } })).status, 403, 'health too: nothing of /api answers a foreign origin');
  // A preview address nobody issued is nothing.
  assert.equal((await s.call('GET', '/preview/AAAAAAAAAAAAAAAAAAAAAAAA/')).status, 404);
});
