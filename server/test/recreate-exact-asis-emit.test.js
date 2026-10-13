// Exact mode, original CSS step 2: the as-is capture written out as a page of the copy (ir/asis.js + the HTML emitter),
// and the proof that this is the point of it - the copy is drawn pixel for pixel like the original at widths nobody
// captured, because the site's own clamp(), vh and media queries came along instead of px values read at one width.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { assetKey } from '../src/recreate/assets/collect.js';
import { captureAsIs, recordSheetBodies } from '../src/recreate/capture/asis.js';
import { asisBody, asisCss, localizeCss, pageSheets, srcsetEntries } from '../src/recreate/ir/asis.js';
import { createAssetResolver, createLinkResolver } from '../src/recreate/ir/links.js';
import { emitPage } from '../src/recreate/emit/html.js';
import { checkContent } from '../src/recreate/verify/safety.js';

const PORT = 4216;
const COPY_PORT = 4217;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c2410c"/></svg>';

const FILES = {
  '/': ['text/html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>As is</title>
<link rel="stylesheet" href="/css/main.css">
<style media="(max-width: 700px)">.card { border-radius: 24px; }</style>
<style id="runtime"></style>
</head><body class="page">
<header class="top" data-state="ready"><a href="/about/">About</a> <a href="/gone/" onclick="track()">Gone</a> <a href="javascript:void(0)">X</a></header>
<section class="hero"><h1 class="title">Fluid heading that wraps when the window is narrow</h1></section>
<div class="grid"><div class="card">One</div><div class="card">Two</div><div class="card">Three</div></div>
<img class="pic" src="/img/a.svg" srcset="/img/a.svg 1x, /img/b.svg 2x" alt="">
<div class="bg" style="background-image: url('/img/a.svg')"></div>
<svg class="icon" viewBox="0 0 10 10" width="20" height="20"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>
<script>
  document.documentElement.classList.add('ready');
  document.getElementById('runtime').sheet.insertRule('.ready .card { box-shadow: 0 2px 0 rgb(0, 0, 0); }');
</script>
</body></html>`],
  '/css/main.css': ['text/css', `@import url("parts.css") screen and (min-width: 600px);
body { margin: 0; font: 16px/1.4 Arial, sans-serif; color: #222; }
.top { display: flex; gap: 12px; padding: 12px clamp(12px, 4vw, 48px); background: #f4f1ec; }
.hero { min-height: max(220px, 40vh); display: grid; place-items: center; background: url(../img/b.svg) right top / 60px no-repeat, #fff7ed; }
.title { font-size: clamp(22px, 5vw, 64px); margin: 0 5vw; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 2vw; padding: 3vw; }
.card { padding: 24px; background: #fff; border: 1px solid #ddd; }
.bg { height: 40px; width: 40px; }
@media (max-width: 899px) { .title { color: #c2410c; } }`],
  '/css/parts.css': ['text/css', '.card { font-weight: 700; }'],
  '/img/a.svg': ['image/svg+xml', SVG],
  '/img/b.svg': ['image/svg+xml', SVG.replace('#c2410c', '#1d4ed8')],
};

let server;
let copyServer;
let browser;
let workdir;
let asis;
let html;
let built;

before(async () => {
  server = createServer((req, res) => {
    const file = FILES[req.url];
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file[0] }).end(file[1]);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const recorder = recordSheetBodies(context);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  asis = (await captureAsIs(page, recorder)).data;
  await context.close();

  // The assets step, in miniature: every listed file downloaded under its own name.
  workdir = await mkdtemp(path.join(tmpdir(), 'sas-asis-'));
  await mkdir(path.join(workdir, 'assets'), { recursive: true });
  const map = {};
  for (const ref of asis.refs) {
    const name = new URL(ref.url).pathname.split('/').pop();
    const body = FILES[new URL(ref.url).pathname]?.[1];
    if (!body) continue;
    await writeFile(path.join(workdir, 'assets', name), body);
    map[assetKey(ref.url)] = name;
  }
  const assetResolve = createAssetResolver(map);
  const resolveLink = createLinkResolver({ pages: [{ url: `${ORIGIN}/`, outPath: 'index.html' }, { url: `${ORIGIN}/about/`, outPath: 'about/index.html' }], origin: ORIGIN });
  built = asisBody(asis, { pageUrl: `${ORIGIN}/`, assetResolve, resolveLink, exclude: new Set(['body>div:1>div:2']) });
  const sheets = pageSheets(asis, assetResolve);
  built.sheets = sheets;
  const irPage = {
    outPath: 'index.html',
    head: { title: 'As is', lang: 'en', canonical: `${ORIGIN}/`, meta: [], alternates: [], icons: [], jsonLd: [] },
    html: { class: built.htmlClass },
    body: built.body,
    asis: sheets.sheets.map((_, i) => `s${i}`),
  };
  const ir = { pages: [irPage], asis: { sheets: Object.fromEntries(sheets.sheets.map((t, i) => [`s${i}`, t])) } };
  html = emitPage(irPage, { css: asisCss(ir, { page: irPage, from: 'index.html' }) });
  await writeFile(path.join(workdir, 'index.html'), html);

  copyServer = createServer(async (req, res) => {
    const file = path.join(workdir, decodeURIComponent(req.url === '/' ? 'index.html' : req.url.slice(1)));
    const body = await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' }).end(body);
  });
  await new Promise((resolve) => { copyServer.listen(COPY_PORT, '127.0.0.1', resolve); });
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  copyServer?.close();
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

test('the sheets come out in cascade order, imports inlined under their condition, every url() local', () => {
  const [main, small, runtime] = built.sheets.sheets;
  assert.equal(built.sheets.sheets.length, 3);
  assert.match(main, /^@media screen and \(min-width: 600px\) \{\n\.card \{ font-weight: 700; \}\n\}/);
  assert.doesNotMatch(main, /@import/);
  assert.match(main, /url\("asset:b\.svg"\) right top/);
  assert.match(main, /clamp\(22px, 5vw, 64px\)/);
  assert.match(small, /^@media \(max-width: 700px\) \{\n\.card \{ border-radius: 24px; \}\n\}$/);
  assert.match(runtime, /\.ready \.card/);
  assert.equal(built.sheets.stats.missingUrls, 0);
});

test('the markup keeps the original classes and data, loses the site\'s code, and links stay inside the copy', () => {
  assert.equal(built.htmlClass, 'ready');
  assert.match(html, /<html lang="en" class="ready">/);
  assert.match(html, /<body class="page">/);
  assert.match(html, /<header class="top" data-state="ready"><a href="about\/">About<\/a> <a href="gone\/">Gone<\/a> <a href="#">X<\/a><\/header>/, 'a link whose href was code keeps looking like a link');
  assert.match(html, /<img class="pic" src="assets\/a\.svg" srcset="assets\/a\.svg 1x, assets\/b\.svg 2x" alt="">/);
  assert.match(html, /style="background-image: url\(&quot;assets\/a\.svg&quot;\)"/);
  assert.match(html, /<svg class="icon"/);
  assert.doesNotMatch(html, /<script|onclick|javascript:|127\.0\.0\.1:4216\/(img|css)/);
  assert.deepEqual(checkContent('html', html), [], 'the safety gate of every copy');
  assert.equal(built.stats.safety.handlers, 1);
  assert.equal(built.stats.excluded, 1, 'a part of the page that is not the site is found by the capture\'s own path');
  assert.doesNotMatch(html, /Two/);
});

test('pieces: srcset with commas and descriptors, a url() that was not downloaded never points at the original', () => {
  assert.deepEqual(srcsetEntries('a.png?w=1,2 1x, b.png 2x'), [{ url: 'a.png?w=1,2', d: '1x' }, { url: 'b.png', d: '2x' }]);
  const counts = { urls: 0, missing: 0 };
  assert.equal(localizeCss('a{background:url(x.png),url(data:image/png;base64,A)} b{filter:url(#f)}', 'https://s.test/', () => null, counts),
    'a{background:url("data:,"),url(data:image/png;base64,A)} b{filter:url(#f)}');
  assert.deepEqual(counts, { urls: 1, missing: 1 });
});

test('the copy is drawn exactly like the original at widths that were never captured', async () => {
  // Without the excluded card on both sides, so the only difference left is what the copy did itself.
  const hideExcluded = '.grid > .card:nth-child(2) { display: none !important; }';
  const original = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const copy = await browser.newContext({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
  const o = await original.newPage();
  const c = await copy.newPage();
  await o.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await o.addStyleTag({ content: hideExcluded });
  await c.goto(`http://127.0.0.1:${COPY_PORT}/`, { waitUntil: 'load' });
  const differing = [];
  for (const [width, height] of [[333, 700], [640, 900], [768, 1024], [1111, 500], [1680, 1050]]) {
    await o.setViewportSize({ width, height });
    await c.setViewportSize({ width, height });
    const [a, b] = await Promise.all([o.screenshot({ fullPage: true }), c.screenshot({ fullPage: true })]);
    if (!a.equals(b)) differing.push(width);
  }
  await original.close();
  await copy.close();
  assert.deepEqual(differing, [], 'widths where the copy is not pixel-identical');
});
