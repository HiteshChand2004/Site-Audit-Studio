// The page-level lift (behavior/preserve/pageLift.js), from a small page written here: a Next.js-style document with its
// hydration data, a runtime chunk that hydrates it, a CSS animation and a hover rule, a tracker that must be removed,
// and an icon the capture never recorded (downloaded at build time). In a browser, with every other request aborted:
// the chunk runs, the page hydrates, the animation runs, the hover changes the colour, and nothing leaves the copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftPage } from '../src/recreate/behavior/preserve/pageLift.js';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const SITE = 'https://site.test/';
let browser;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

const DOCUMENT = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Lift fixture</title>
<link rel="stylesheet" href="https://site.test/_next/static/css/app.css">
<link rel="icon" href="https://site.test/icon.svg">
</head><body>
<script>self.__next_f = self.__next_f || []; self.__next_f.push([1, "hydration data"]);</script>
<main><div id="card" class="card">Card</div><span class="spin" id="spinner"></span></main>
<script src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
<script src="https://site.test/_next/static/chunks/app.js"></script>
</body></html>`;

const CSS = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spin { display: inline-block; width: 40px; height: 40px; background: rgb(10, 80, 200); animation: spin 1s linear infinite; }
.card { width: 200px; height: 80px; background: rgb(255, 255, 255); }
.card:hover { background: rgb(194, 65, 12); }`;

const CHUNK = `window.__runtimeRan = true; document.getElementById('card').setAttribute('data-hydrated', '1');`;

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>';

/** Writes the record of that page (what capture/index.js writes) and returns its folder. */
async function writeRecord(root) {
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  const bodies = { doc: DOCUMENT, css: CSS, chunk: CHUNK, tracker: '// tracker' };
  for (const b of Object.values(bodies)) await writeFile(path.join(net, 'files', sha(b)), b);
  const entries = [
    { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(bodies.doc) },
    { url: 'https://site.test/_next/static/css/app.css', status: 200, kind: 'style', type: 'text/css', sha: sha(bodies.css) },
    { url: 'https://site.test/_next/static/chunks/app.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(bodies.chunk) },
    { url: 'https://www.googletagmanager.com/gtag/js?id=G-TEST', status: 200, kind: 'script', type: 'text/javascript', sha: sha(bodies.tracker) },
  ];
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries }));
  return root;
}

test('the page lifted from the record runs offline: chunk, hydration, animation and hover, no request leaves the copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-lift-'));
  try {
    await writeRecord(root);
    const out = path.join(root, 'copy');
    // The icon is not in the record: the build-time download stands in for it (a stub here, the real one in production).
    const fetchImpl = async (url, { dir }) => {
      const tmp = path.join(dir, 'icon.tmp');
      await writeFile(tmp, ICON);
      return { ok: true, tmp, sha256: sha(ICON), bytes: ICON.length, mime: 'image/svg+xml', finalUrl: url, redirects: [] };
    };
    const lift = await liftPage({ captureRoot: root, pageUrl: SITE, outDir: out, fetchImpl });
    assert.ok(lift.removed.some((r) => r.url.includes('googletagmanager')), 'the tracker is removed by rule');
    assert.ok(lift.files.some((f) => f.local === '/icon.svg' && f.reason.includes('downloaded')), 'the icon is downloaded at build time');
    assert.equal(lift.blockers.length, 0, 'nothing the page uses is left out');

    const server = await serveFolder(out);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const leaks = [];
    try {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(server.url)) return route.continue();
        leaks.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message)));
      await page.goto(`${server.url}index.html`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({
        ran: Boolean(window.__runtimeRan),
        hydrated: document.getElementById('card').getAttribute('data-hydrated'),
        animations: document.getAnimations().filter((a) => a.playState === 'running').length,
        icon: document.querySelector('link[rel="icon"]')?.getAttribute('href'),
      }));
      assert.equal(state.ran, true, 'the runtime chunk ran');
      assert.equal(state.hydrated, '1', 'the chunk hydrated the page');
      assert.ok(state.animations >= 1, 'the CSS animation runs');
      assert.equal(state.icon, '/icon.svg', 'the icon points at the local copy');
      const hover = await page.evaluate(async () => {
        const card = document.getElementById('card');
        const before = getComputedStyle(card).backgroundColor;
        const r = card.getBoundingClientRect();
        return { before, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(hover.x, hover.y);
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => getComputedStyle(document.getElementById('card')).backgroundColor);
      assert.notEqual(after, hover.before, 'the hover changes the colour');
      assert.equal(after.replace(/\s/g, ''), 'rgb(194,65,12)');
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(leaks, [], 'no request leaves the copy');
    } finally {
      await context.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('font sources: a face keeps only the files the record holds; a family with none recorded is downloaded; nothing stays on the original', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-fonts-'));
  try {
    const net = path.join(root, '.network');
    await mkdir(path.join(net, 'files'), { recursive: true });
    const CSS_FONTS = `@font-face { font-family: "Good"; src: url(https://site.test/fonts/good.woff2) format("woff2"), url(https://cdn.test/missing.woff) format("woff"); }
@font-face { font-family: "Lost"; src: url(https://cdn.test/lost.woff2) format("woff2"); }
@font-face { font-family: "Fallback"; src: local("Arial"), url(https://cdn.test/gone.woff) format("woff"); }`;
    const FONT = 'WOFF2-GOOD';
    const bodies = { doc: '<!doctype html><html><head><link rel="stylesheet" href="https://site.test/app.css"></head><body><p style="font-family: Good">Text</p></body></html>', css: CSS_FONTS, font: FONT };
    for (const b of Object.values(bodies)) await writeFile(path.join(net, 'files', sha(b)), b);
    await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [
      { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(bodies.doc) },
      { url: 'https://site.test/app.css', status: 200, kind: 'style', type: 'text/css', sha: sha(bodies.css) },
      { url: 'https://site.test/fonts/good.woff2', status: 200, kind: 'font', type: 'font/woff2', sha: sha(bodies.font) },
    ] }));
    const out = path.join(root, 'copy');
    const fetchImpl = async (url, { dir }) => {
      if (!url.endsWith('lost.woff2')) return { ok: false, reason: 'http-404', finalUrl: url };
      const tmp = path.join(dir, 'lost.tmp');
      await writeFile(tmp, 'WOFF2-LOST');
      return { ok: true, tmp, sha256: sha('WOFF2-LOST'), bytes: 10, mime: 'font/woff2', finalUrl: url, redirects: [] };
    };
    const lift = await liftPage({ captureRoot: root, pageUrl: SITE, outDir: out, fetchImpl });
    const css = await readFile(path.join(out, 'app.css'), 'utf8');
    assert.doesNotMatch(css, /cdn\.test|site\.test/, 'no address of the original is left in the stylesheet');
    assert.match(css, /font-family: "Good"; src: url\("\/fonts\/good\.woff2"\) format\("woff2"\);/, 'the recorded source is kept, the unrecorded one is dropped');
    assert.match(css, /font-family: "Lost"; src: url\("\/lost\.woff2"\) format\("woff2"\);/, 'a family with no recorded file gets its downloaded file');
    assert.ok(lift.dropped.some((d) => d.url.endsWith('missing.woff') && d.family === 'Good'), 'the dropped source is reported');
    assert.match(css, /font-family: "Fallback"; src: local\("Arial"\);/, 'a system font (local()) stays as written');
    assert.equal(lift.blockers.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inline styles: a font source in a <style> block and a url() in a style attribute are judged the same way', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-inline-'));
  try {
    const net = path.join(root, '.network');
    await mkdir(path.join(net, 'files'), { recursive: true });
    const IMG = 'PNG-BG';
    const DOC = `<!doctype html><html><head><style>@font-face { font-family: "Inl"; src: url(https://cdn.test/inl.woff2) format("woff2"); }</style></head>`
      + `<body><p style="background-image: url(https://site.test/bg.png); font-family: Inl">Text</p></body></html>`;
    for (const b of [DOC, IMG]) await writeFile(path.join(net, 'files', sha(b)), b);
    await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [
      { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(DOC) },
      { url: 'https://site.test/bg.png', status: 200, kind: 'image', type: 'image/png', sha: sha(IMG) },
    ] }));
    const out = path.join(root, 'copy');
    const lift = await liftPage({ captureRoot: root, pageUrl: SITE, outDir: out, fetch: false });
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /cdn\.test|site\.test/, 'no address of the original is left in the document');
    assert.match(html, /background-image: url\((&quot;|")\/bg\.png(&quot;|")\)/, 'the recorded image in the style attribute is the local copy');
    assert.ok(lift.dropped.some((d) => d.url.endsWith('inl.woff2')), 'the unrecorded font source in the style block is dropped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
