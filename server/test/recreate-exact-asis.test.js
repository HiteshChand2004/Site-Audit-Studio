// Exact mode, original CSS step 1: the page as the browser ended up with it and the site's own stylesheets as written
// (capture/asis.js). One page uses every way a sheet can arrive - a linked sheet with an @import, a <style> as written,
// a <style> a script filled with insertRule, a constructed sheet, a shadow root's own <style> - plus scripts, a
// <noscript> pixel, a srcset and a background only a media query shows.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { asisRefs, captureAsIs, cssRefs, recordSheetBodies, srcsetUrls } from '../src/recreate/capture/asis.js';
import { collectAssets } from '../src/recreate/assets/collect.js';

const PORT = 4215;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const FILES = {
  '/': ['text/html', `<!doctype html><html lang="en" class="root-class"><head><meta charset="utf-8"><title>As is</title>
<link rel="stylesheet" href="/a.css">
<link rel="modulepreload" href="/app.js">
<style>.written { color: rgb(0, 0, 200); }</style>
<style id="cssinjs"></style>
<script type="application/ld+json">{"@type":"Organization","name":"X"}</script>
</head><body>
<div class="hero">Hero</div>
<p class="written">Written</p><p class="inserted">Inserted</p><p class="adopted">Adopted</p>
<img src="/img/one.png" srcset="/img/one.png 1x, /img/two.png 2x" alt="">
<div style="background-image: url('/img/inline.png')">Inline</div>
<a href="/files/brochure.pdf">Brochure</a>
<x-card></x-card>
<noscript><img src="/pixel.gif" alt=""></noscript>
<script>
  document.getElementById('cssinjs').sheet.insertRule('.inserted { color: rgb(200, 0, 0); }');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.adopted { color: rgb(0, 150, 0); }');
  document.adoptedStyleSheets = [sheet];
  customElements.define('x-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<style>p { margin: 0; }</style><p>Shadow</p>'; }
  });
</script>
</body></html>`],
  '/a.css': ['text/css', `@import "/b.css";
/* kept as written */
.hero { background: url(img/bg.png) no-repeat; height: clamp(200px, 40vh, 600px); }
@media (max-width: 600px) { .hero { background-image: url("img/small.png"); } }
@font-face { font-family: Brand; src: url(fonts/brand.woff2) format("woff2"), url(fonts/brand.woff) format("woff"); }`],
  '/b.css': ['text/css', '.imported { color: rgb(1, 2, 3); }'],
  '/app.js': ['text/javascript', ''],
};

let server;
let browser;
let read;
before(async () => {
  server = createServer((req, res) => {
    const file = FILES[req.url];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file[0] }).end(file[1]);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const recorder = recordSheetBodies(context);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  read = await captureAsIs(page, recorder);
  // The page is left as it was: the sheet markers are gone from the live document.
  read.liveMarkers = await page.evaluate(() => document.querySelectorAll('[data-sas-sheet]').length);
  await context.close();
});
after(async () => {
  await browser?.close().catch(() => {});
  server.close();
});

test('every stylesheet is kept in cascade order, as written where the browser still agrees with the text', () => {
  const { sheets } = read.data;
  const [a, b, written, inserted, adopted] = sheets;
  assert.equal(sheets.length, 5, JSON.stringify(sheets.map((s) => s.from)));
  assert.equal(a.from, 'link');
  assert.match(a.raw, /^@import "\/b\.css";\n\/\* kept as written \*\//, 'the network body, comments and all');
  assert.match(a.raw, /clamp\(200px, 40vh, 600px\)/, 'the rule behind the px value, not the px value');
  assert.equal(b.from, 'import');
  assert.equal(b.parent, 0);
  assert.equal(b.raw, '.imported { color: rgb(1, 2, 3); }');
  assert.equal(written.from, 'style');
  assert.equal(written.text, '.written { color: rgb(0, 0, 200); }');
  assert.equal(inserted.from, 'style');
  assert.equal(inserted.text, undefined, 'an empty <style> filled by script is not taken at its word');
  assert.match(inserted.cssom, /\.inserted \{ color: rgb\(200, 0, 0\); \}/);
  assert.equal(adopted.from, 'adopted');
  assert.match(adopted.cssom, /\.adopted/);
  assert.equal(read.summary.fromNetwork, 2);
  assert.equal(read.summary.cssom, 2);
});

test('the markup keeps every sheet owner in place, the shadow root, the root attributes - and none of the site\'s code', () => {
  const { html } = read.data;
  assert.match(html, /^<!DOCTYPE html><html lang="en" class="root-class">/);
  assert.match(html, /<link rel="stylesheet" href="\/a\.css" data-sas-sheet="0">/);
  assert.match(html, /<style data-sas-sheet="2">\.written/);
  assert.match(html, /<style id="cssinjs" data-sas-sheet="3"><\/style>/);
  assert.match(html, /<template shadowrootmode="open"><style>p \{ margin: 0; \}<\/style><p>Shadow<\/p><\/template>/);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/, 'no script but structured data');
  assert.match(html, /application\/ld\+json/);
  assert.doesNotMatch(html, /noscript|pixel\.gif|modulepreload/);
  assert.deepEqual(read.data.removed, { scripts: 1, noscript: 1, handlers: 0 });
  assert.equal(read.liveMarkers, 0);
  assert.equal(read.summary.shadowRoots, 1);
});

test('every file the page and its sheets point at is listed, including what only a media query or a 2x screen loads', () => {
  const byUrl = new Map(read.data.refs.map((r) => [r.url.replace(ORIGIN, ''), r]));
  for (const url of ['/img/one.png', '/img/two.png', '/img/inline.png', '/img/bg.png', '/img/small.png']) assert.equal(byUrl.get(url)?.kind, 'image', url);
  assert.equal(byUrl.get('/fonts/brand.woff2')?.kind, 'font');
  assert.equal(byUrl.get('/fonts/brand.woff')?.kind, 'font');
  assert.equal(byUrl.get('/files/brochure.pdf')?.kind, 'document');
  assert.ok(!byUrl.has('/pixel.gif'), 'what only <noscript> showed is not needed');
  assert.ok(!byUrl.has('/b.css') && !byUrl.has('/a.css'), 'sheets are kept as text, not as files');
});

test('the pieces on their own: srcset, url() in and out of @font-face, a <base>, and the assets step taking the list', () => {
  assert.deepEqual(srcsetUrls('a.png 1x, b,c.png 2x,  d.png 640w'), ['a.png', 'b,c.png', 'd.png']);
  assert.deepEqual(cssRefs('@font-face{src:url(f.woff2)} .x{background:url("data:image/png;base64,AA"),url(#m),url(v.mp4)}', 'https://s.test/css/'),
    [{ url: 'https://s.test/css/f.woff2', kind: 'font', from: 'asis-font-face' }, { url: 'https://s.test/css/v.mp4', kind: 'media', from: 'asis-css' }]);
  const refs = asisRefs({ html: '<html><head><base href="/sub/"></head><body><img src="p.png"><use href="#icon"></use></body></html>', baseURI: 'https://s.test/', sheets: [] });
  assert.deepEqual(refs.map((r) => r.url), ['https://s.test/sub/p.png']);
  const { assets } = collectAssets([], { urls: read.data.refs.map((r) => ({ ...r, slug: 'home' })) });
  assert.ok(assets.some((a) => a.url.endsWith('/img/small.png')));
  assert.ok(assets.some((a) => a.url.endsWith('/fonts/brand.woff') && a.kind === 'font'), 'every source of a face, not just the one this browser chose');
});

test('in an exact capture a snapshot of one part keeps its markup in that state; an ordinary capture does not', async () => {
  const { snapshotPage } = await import('../src/recreate/capture/snapshot.js');
  const { markAsIs } = await import('../src/recreate/capture/asis.js');
  const read = async (exact) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    if (exact) await markAsIs(context);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    const res = await page.evaluate(snapshotPage, { rootPath: 'body>div:1' });
    await context.close();
    return res.body;
  };
  const exact = await read(true);
  assert.match(exact.asisHtml, /^<div class="hero">Hero<\/div>$/);
  assert.equal((await read(false)).asisHtml, undefined);
});
