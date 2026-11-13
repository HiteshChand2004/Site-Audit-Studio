// The live original shown under the app's own address (recreate/originalPreview.js through recreate/previewRoute.js), so
// Compare can show it live and scroll it together with the copy: a site that refuses to be framed is shown anyway, its
// own absolute addresses, fonts and data come through the preview, a redirect inside the site keeps the frame on the
// preview, nothing but the token's own site is fetched, and the app can scroll it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { chromium } from 'playwright';
import { extOf, originalPreview, relativizeSite } from '../src/recreate/originalPreview.js';
import { previewRouter, PREVIEW_PREFIX } from '../src/recreate/previewRoute.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('the site\'s own absolute addresses become root-relative where an address is written, and nowhere else', () => {
  const html = '<a href="https://www.site.test/about">x</a><img srcset="https://site.test/a.png 1x, https://site.test/b.png 2x">'
    + '<style>.x{background:url(https://site.test/bg.png)}</style><a href="https://site.test">home</a><p>Visit https://site.test/about today</p>'
    + '<a href="https://other.test/x">y</a><a href="https://site.test.evil/x">z</a>';
  const out = relativizeSite(html, 'site.test');
  assert.match(out, /href="\/about"/);
  assert.match(out, /srcset="\/a\.png 1x, \/b\.png 2x"/);
  assert.match(out, /url\(\/bg\.png\)/);
  assert.match(out, /href="\/">home/);
  assert.match(out, /Visit https:\/\/site\.test\/about today/, 'text that only mentions the address is left');
  assert.match(out, /https:\/\/other\.test\/x/);
  assert.match(out, /https:\/\/site\.test\.evil\/x/, 'another host that starts the same is not the site');
  assert.equal(extOf('text/html; charset=utf-8', '/x'), '.html');
  assert.equal(extOf('application/javascript', '/chunk'), '.js');
  assert.equal(extOf('', '/font.woff2'), '.woff2');
});

test('the live original is shown through the preview, live, and the app can scroll it', { timeout: 120000 }, async (t) => {
  // The original: refuses framing, writes its own absolute addresses, loads a font, fetches data, redirects /about.
  const asked = [];
  const site = createServer((req, res) => {
    asked.push(req.url);
    const origin = `http://localhost:${site.address().port}`;
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'set-cookie': 'sid=1' });
      return res.end(`<!doctype html><html><head><link rel="stylesheet" href="${origin}/site.css"></head>
        <body><section class="hero">Hero</section><div id="data"></div><div style="height:4000px"></div>
        <script>fetch('/api/data').then((r) => r.json()).then((d) => { document.getElementById('data').textContent = d.word; });</script></body></html>`);
    }
    if (req.url === '/site.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('.hero{height:100vh;background:rgb(1, 2, 3)}');
    }
    if (req.url === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"word":"live"}');
    }
    if (req.url === '/about') {
      res.writeHead(301, { location: '/about/' });
      return res.end();
    }
    if (req.url === '/about/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>About</title><p>About page</p>');
    }
    res.writeHead(404);
    res.end();
  });
  const sitePort = await listen(site);
  t.after(() => site.close());

  // The app: the preview router and a host page that frames the original the way Compare does.
  const app = express();
  let appOrigin = '';
  app.use(PREVIEW_PREFIX, (req, res, next) => previewRouter({ frameAncestors: [appOrigin] })(req, res, next));
  app.get('/host', (req, res) => res.type('html').send(`<!doctype html><script>window.__m=[];addEventListener('message',(e)=>__m.push(e.data));</script>
    <iframe id="f" sandbox="allow-scripts" style="width:1200px;height:700px" src="${req.query.src}"></iframe>`));
  const appServer = createServer(app);
  const appPort = await listen(appServer);
  appOrigin = `http://127.0.0.1:${appPort}`;
  t.after(() => appServer.close());

  const { url } = originalPreview('p1', `http://localhost:${sitePort}/`);
  assert.equal(originalPreview('p1', `http://localhost:${sitePort}/x`).url, url, 'one address per website');

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${appOrigin}/host?src=${encodeURIComponent(url)}`);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.waitForFunction(() => document.getElementById('data')?.textContent === 'live', null, { timeout: 15000 });
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.hero')).backgroundColor), 'rgb(1, 2, 3)', 'its stylesheet, written as an absolute address, came through');
  assert.equal(await frame.evaluate(() => document.querySelector('.hero').getBoundingClientRect().height), 700, 'a full-screen section is the frame\'s height');
  assert.equal(await frame.evaluate(() => self.origin), 'null', 'sealed: no origin of the app');

  const res = await page.request.get(`${appOrigin}${url}`);
  assert.equal(res.headers()['x-frame-options'], undefined, 'its framing refusal is not passed on');
  assert.equal(res.headers()['set-cookie'], undefined, 'nor its cookies');
  assert.match(res.headers()['content-security-policy'], /^sandbox allow-scripts; frame-ancestors /);

  // Scrolled by the app, and it says where it is.
  await page.evaluate(() => document.getElementById('f').contentWindow.postMessage({ sasPreview: 1, scrollTo: 1 }, '*'));
  await page.waitForFunction(() => window.__m.some((m) => m && m.scroll === 1), null, { timeout: 10000 });

  // The check before a request with headers of its own (Next.js page data) is allowed.
  const pre = await fetch(`${appOrigin}${url}about/`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'rsc, next-router-state-tree' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'rsc, next-router-state-tree');

  // A redirect inside the site stays on the preview.
  const about = await page.request.get(`${appOrigin}${url}about`, { maxRedirects: 0 });
  assert.equal(about.status(), 302);
  assert.equal(about.headers().location, `${url}about/`);

  // Only the token's own site: an address of another host in the path is a path of the site.
  await page.request.get(`${appOrigin}${url}http://example.com/`);
  assert.ok(asked.includes('/http://example.com/'), `asked of the site itself: ${asked.join(' ')}`);
});
