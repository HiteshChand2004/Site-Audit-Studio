// The cache of static sub-resources shared by the browser contexts of one job (audit/sharedCache.js).
// Everything is local: two servers on 127.0.0.1 (the site, and an address the network policy does not allow).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { runAnalysis } from '../src/audit/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { createSharedCache, isShareable, isStorable, sharedCacheEnabled } from '../src/audit/sharedCache.js';
import { startEgressProxy } from '../src/security/egressProxy.js';
import { createNetPolicy } from '../src/security/netGuard.js';

const exists = (p) => access(p).then(() => true, () => false);
const cacheFolders = async () => (await readdir(os.tmpdir())).filter((n) => n.startsWith('sas-cache-'));

let site;
let other;
let origin;
let otherOrigin;
let png;
const hits = new Map();
const otherHits = [];
const count = (p) => hits.get(p) ?? 0;

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

before(async () => {
  png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#3366cc' } }).png().toBuffer();
  other = await listen((req, res) => {
    otherHits.push(req.url);
    res.setHeader('content-type', 'image/png');
    res.end(png);
  });
  otherOrigin = `http://127.0.0.1:${other.address().port}`;
  site = await listen((req, res) => {
    const p = req.url.split('?')[0];
    hits.set(p, count(p) + 1);
    const send = (type, body, headers = {}) => {
      res.writeHead(200, { 'content-type': type, ...headers });
      res.end(body);
    };
    if (p === '/') {
      return send('text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cache</title>
<link rel="stylesheet" href="/style.css"><script src="/app.js"></script></head><body>
<h1 id="t">Shared cache</h1>
<img id="plain" src="/img.png" alt=""><img id="moved" src="/moved.png" alt=""><img id="cookie" src="/cookie.png" alt="">
<img id="nostore" src="/nostore.png" alt=""><img id="byua" src="/by-ua.png" alt=""><img id="gone" src="/gone.png" alt="">
<img id="blocked" src="${otherOrigin}/secret.png" alt="">
<script>fetch('/api').then((r) => r.json()).then((d) => { document.body.dataset.api = d.n; });</script></body></html>`);
    }
    // Compressed on the wire: the stored body is the decoded one.
    if (p === '/style.css') return send('text/css', gzipSync('#t { color: rgb(1, 2, 3); }'), { 'content-encoding': 'gzip', 'cache-control': 'max-age=60' });
    if (p === '/app.js') return send('text/javascript', 'document.documentElement.dataset.script = "ran";', { vary: 'Accept-Encoding' });
    if (p === '/img.png' || p === '/target.png') return send('image/png', png);
    if (p === '/moved.png') {
      res.writeHead(302, { location: '/target.png' });
      return res.end();
    }
    if (p === '/slow') return send('text/html', '<!doctype html><title>Slow</title><img id="slow" src="/slow.png" alt="">');
    if (p === '/slow.png') return void setTimeout(() => send('image/png', png), 1200);
    if (p === '/cookie.png') return send('image/png', png, { 'set-cookie': 'seen=1; Path=/' });
    if (p === '/nostore.png') return send('image/png', png, { 'cache-control': 'no-store' });
    if (p === '/by-ua.png') return send('image/png', png, { vary: 'User-Agent' });
    if (p === '/api') return send('application/json', JSON.stringify({ n: count('/api') }));
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  origin = `http://127.0.0.1:${site.address().port}`;
});

after(async () => {
  await new Promise((resolve) => site.close(resolve));
  await new Promise((resolve) => other.close(resolve));
});

test('what may be shared: static GET requests that answered 200 and do not depend on the visitor', () => {
  const request = (o = {}) => ({
    method: () => o.method ?? 'GET',
    resourceType: () => o.type ?? 'image',
    url: () => o.url ?? 'https://example.com/a.png',
    headers: () => o.headers ?? {},
    isNavigationRequest: () => o.navigation ?? false,
  });
  assert.equal(isShareable(request()), true);
  for (const type of ['stylesheet', 'script', 'font']) assert.equal(isShareable(request({ type })), true);
  for (const type of ['document', 'xhr', 'fetch', 'media', 'websocket', 'other']) assert.equal(isShareable(request({ type })), false, type);
  assert.equal(isShareable(request({ method: 'POST' })), false);
  assert.equal(isShareable(request({ headers: { range: 'bytes=0-' } })), false);
  assert.equal(isShareable(request({ url: 'data:image/png;base64,AAAA' })), false);
  assert.equal(isShareable(request({ navigation: true })), false);

  assert.equal(isStorable(200, {}), true);
  assert.equal(isStorable(200, { vary: 'Accept-Encoding, Origin', 'cache-control': 'no-cache, max-age=0' }), true);
  for (const status of [204, 206, 301, 302, 304, 403, 404, 500]) assert.equal(isStorable(status, {}), false, String(status));
  assert.equal(isStorable(200, { 'set-cookie': 'a=1' }), false);
  assert.equal(isStorable(200, { 'cache-control': 'private, no-store' }), false);
  assert.equal(isStorable(200, { vary: 'User-Agent' }), false);
  assert.equal(isStorable(200, { vary: 'Accept, DPR' }), false);
  assert.equal(isStorable(200, { vary: '*' }), false);

  assert.equal(sharedCacheEnabled({}), true);
  assert.equal(sharedCacheEnabled({ SAS_SHARED_CACHE: '0' }), false);
});

test('contexts of one job load a static file once; everything else still comes from the network', async () => {
  const proxy = await startEgressProxy(createNetPolicy({ internalPorts: [site.address().port] }));
  const browser = await launchBrowser({ proxy: proxy.url });
  const cache = createSharedCache();
  const before = await cacheFolders();
  const visit = async (userAgent) => {
    const context = await browser.newContext({ serviceWorkers: 'block', ...(userAgent && { userAgent }) });
    await cache.attach(context);
    const seen = [];
    context.on('response', (res) => seen.push([new URL(res.url()).pathname, res.status(), res.headers()['content-type']]));
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.api);
    const state = await page.evaluate(() => ({
      color: getComputedStyle(document.getElementById('t')).color,
      script: document.documentElement.dataset.script,
      api: document.body.dataset.api,
      images: Object.fromEntries([...document.images].map((i) => [i.id, i.naturalWidth])),
    }));
    await context.close();
    return { state, seen };
  };
  try {
    // Two at the same moment (the views of a page), then two later ones (the next widths), one with another user agent.
    const results = [...(await Promise.all([visit(), visit()])), await visit(), await visit('Mozilla/5.0 (Linux; Android 14) Mobile')];
    for (const { state, seen } of results) {
      // The page is the same in every context: the compressed stylesheet applies, the script ran, the images decoded.
      assert.equal(state.color, 'rgb(1, 2, 3)');
      assert.equal(state.script, 'ran');
      assert.deepEqual(state.images, { plain: 40, moved: 40, cookie: 40, nostore: 40, byua: 40, gone: 0, blocked: 0 });
      // What the capture records about a response is still there for a file that came from the cache.
      assert.ok(seen.some(([p, status, type]) => p === '/style.css' && status === 200 && type === 'text/css'), JSON.stringify(seen));
      assert.ok(seen.some(([p, status]) => p === '/gone.png' && status === 404));
    }
    // Each context made its own API call (never shared).
    assert.deepEqual(results.map((r) => r.state.api).sort(), ['1', '2', '3', '4']);
    assert.equal(count('/'), 4);
    assert.equal(count('/api'), 4);

    // Shared: fetched once for four contexts, even by the two that asked at the same time.
    assert.equal(count('/style.css'), 1);
    assert.equal(count('/app.js'), 1);
    assert.equal(count('/img.png'), 1);
    // A redirect is followed by each browser itself, and so is the file it leads to (the browser does not ask the cache for it).
    assert.ok(count('/moved.png') >= 4, `moved ${count('/moved.png')}`);
    assert.equal(count('/target.png'), 4);
    // Not shared: a cookie, no-store, a response that depends on the user agent, an error. Every context asked the server.
    for (const p of ['/cookie.png', '/nostore.png', '/by-ua.png', '/gone.png']) assert.ok(count(p) >= 4, `${p} ${count(p)}`);

    // The cache fetches through the browser's egress proxy: an address the policy does not allow is never reached.
    assert.deepEqual(otherHits, []);
    assert.ok(proxy.blocked().some((b) => b.includes(String(other.address().port)) || b.includes('127.0.0.1')), JSON.stringify(proxy.blocked()));

    const stats = cache.stats();
    assert.equal(stats.stored, 3); // style.css, app.js, img.png
    assert.equal(stats.served, 9); // three more contexts each
    assert.ok(stats.servedBytes > 0 && stats.storedBytes > 0);
    const created = (await cacheFolders()).filter((n) => !before.includes(n));
    assert.equal(created.length, 1);
    await cache.close();
    assert.equal(await exists(`${os.tmpdir()}/${created[0]}`), false);
  } finally {
    await cache.close();
    await browser.close();
    await proxy.close();
  }
});

test('a file over the size limit is loaded by every context and not kept', async () => {
  const proxy = await startEgressProxy(createNetPolicy({ internalPorts: [site.address().port] }));
  const browser = await launchBrowser({ proxy: proxy.url });
  const cache = createSharedCache({ maxEntryBytes: 10 });
  const start = count('/img.png');
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext();
      await cache.attach(context);
      const page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      assert.equal(await page.evaluate(() => document.getElementById('plain').naturalWidth), 40);
      await context.close();
    }
    assert.equal(count('/img.png') - start, 2);
    assert.equal(cache.stats().stored, 0);
  } finally {
    await cache.close();
    await browser.close();
    await proxy.close();
  }
});

test('a context does not wait long for a file another context is still loading', async () => {
  const proxy = await startEgressProxy(createNetPolicy({ internalPorts: [site.address().port] }));
  const browser = await launchBrowser({ proxy: proxy.url });
  const cache = createSharedCache({ waitMs: 200 });
  const open = async () => {
    const context = await browser.newContext();
    await cache.attach(context);
    const page = await context.newPage();
    await page.goto(`${origin}/slow`, { waitUntil: 'load' });
    const width = await page.evaluate(() => document.getElementById('slow').naturalWidth);
    await context.close();
    return width;
  };
  try {
    // Both ask at once: the second one gives up waiting after 200 ms and loads the file itself.
    assert.deepEqual(await Promise.all([open(), open()]), [40, 40]);
    assert.equal(count('/slow.png'), 2);
    // Once it is there, the next context gets it from the cache.
    assert.equal(await open(), 40);
    assert.equal(count('/slow.png'), 2);
    assert.equal(cache.stats().served, 1);
  } finally {
    await cache.close();
    await browser.close();
    await proxy.close();
  }
});

test('an analysis loads the homepage in four browser contexts and its static files once', async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'sas-cache-test-'));
  const before = { home: count('/'), css: count('/style.css'), js: count('/app.js'), img: count('/img.png'), api: count('/api') };
  const folders = await cacheFolders();
  try {
    const audit = await runAnalysis({
      project: { id: 'cache', url: `${origin}/`, name: 'cache' },
      analysisId: 'a1',
      maxPages: 1,
      outDir,
      skip: ['lighthouse-mobile', 'lighthouse-desktop'],
      netPolicy: createNetPolicy({ internalPorts: [site.address().port] }),
      progress: () => {},
    });
    assert.deepEqual(audit.errors, [], JSON.stringify(audit.errors));
    for (const view of ['desktop', 'tablet', 'mobile']) assert.ok(await exists(path.join(outDir, 'screens', `${view}-full.webp`)), view);
    assert.ok(await exists(path.join(outDir, 'axe.json')));
    // The render and the three screenshot views each opened the page and made their own API call…
    assert.ok(count('/') - before.home >= 4, `home ${count('/') - before.home}`);
    assert.equal(count('/api') - before.api, 4);
    // …and the stylesheet, the script and the image were downloaded once for all of them.
    assert.equal(count('/style.css') - before.css, 1);
    assert.equal(count('/app.js') - before.js, 1);
    assert.equal(count('/img.png') - before.img, 1);
    // The address the policy does not allow was never reached, and the cache's folder is gone.
    assert.deepEqual(otherHits, []);
    assert.deepEqual((await cacheFolders()).filter((n) => !folders.includes(n) && n !== path.basename(outDir)), []);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
