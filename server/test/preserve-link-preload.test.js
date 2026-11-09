// Preloads the original host sends as a `Link` response header (Next.js sends its fonts that way): the network record keeps
// the document's header, and the lift writes those preloads into the copy's head as tags, so a copy served by a static host
// (no such header) still fetches its fonts at once instead of after the stylesheet. Nothing is drawn differently: the copy
// with the tags is pixel-identical to the copy without them and to the original, at 375 and 1440 px.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createRecordStore, tapContext } from '../src/audit/sharedCache.js';
import { headerPreloads, liftPage } from '../src/recreate/behavior/preserve/pageLift.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(HERE, 'fixtures', 'recreate-site', 'fonts', 'mono.woff2');
const LINK = '</fonts/mono.woff2>; rel=preload; as=font; crossorigin=""; type="font/woff2", <https://cdn.example.test>; rel=preconnect';
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fonts</title>
<link rel="stylesheet" href="/site.css"></head><body><main><h1>Fonts at the first byte</h1><p>Body text in the same face.</p></main></body></html>`;
const CSS = `@font-face { font-family: Mono; src: url(/fonts/mono.woff2) format("woff2"); font-display: swap; }
body { margin: 0; padding: 32px; font-family: Mono, monospace; background: #fff; color: #111; } h1 { font-size: 40px; }`;

let browser;
let site;
let tmp;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sas-link-preload-'));
  const font = await readFile(FONT);
  site = createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', link: LINK }).end(PAGE);
    if (p === '/site.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end(CSS);
    if (p === '/fonts/mono.woff2') return void res.writeHead(200, { 'content-type': 'font/woff2' }).end(font);
    res.writeHead(404).end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => site.close(r));
  await rm(tmp, { recursive: true, force: true });
});

const origin = () => `http://127.0.0.1:${site.address().port}`;

test('headerPreloads: preload and modulepreload with their attributes; preconnect and others left out', () => {
  assert.deepEqual(headerPreloads(LINK), [{ href: '/fonts/mono.woff2', rel: 'preload', attrs: { as: 'font', crossorigin: '', type: 'font/woff2' } }]);
  assert.deepEqual(headerPreloads('</a.js>; rel=modulepreload, </b.css>; rel="preload"; as=style; nopush'), [
    { href: '/a.js', rel: 'modulepreload', attrs: {} },
    { href: '/b.css', rel: 'preload', attrs: { as: 'style' } },
  ]);
  assert.deepEqual(headerPreloads(''), []);
  assert.deepEqual(headerPreloads(undefined), []);
});

async function shot(url, width) {
  const context = await browser.newContext({ viewport: { width, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await page.screenshot({ fullPage: true });
  } finally {
    await context.close();
  }
}

test('the record keeps the header, the lift writes it as tags, the font is fetched by the tag and the look is unchanged', async () => {
  // Capture: what capture/index.js does for a page (a tapped context writing the network record).
  const captureRoot = path.join(tmp, 'capture');
  const store = createRecordStore(path.join(captureRoot, '.network'));
  const context = await browser.newContext();
  tapContext(context, { store, page: '/' });
  const page = await context.newPage();
  await page.goto(`${origin()}/`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await context.close();
  await store.save();
  const index = JSON.parse(await readFile(path.join(captureRoot, '.network', 'index.json'), 'utf8'));
  assert.equal(index.entries.find((e) => e.kind === 'document').link, LINK, 'the document keeps its Link header');

  const outDir = path.join(tmp, 'copy');
  const lifted = await liftPage({ captureRoot, pageUrl: `${origin()}/`, outDir, fetch: false });
  assert.equal(lifted.headerPreloads, 1);
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, /<meta charset="utf-8"><link rel="preload" href="\/fonts\/mono\.woff2" as="font" crossorigin="" type="font\/woff2">/, 'right after the charset, local address');
  assert.equal((html.match(/mono\.woff2/g) ?? []).length, 1, 'one tag, the preconnect left out');
  const copied = lifted.files.find((f) => f.local === '/fonts/mono.woff2');
  assert.ok(copied, 'the font file is in the copy');
  assert.equal(copied.kind, 'font', 'a font preload is never handled as script text');
  assert.deepEqual(await readFile(path.join(outDir, 'fonts', 'mono.woff2')), await readFile(FONT), 'byte for byte');

  // The same copy without the written tag: what it was before.
  const plainDir = path.join(tmp, 'plain');
  await liftPage({ captureRoot, pageUrl: `${origin()}/`, outDir: plainDir, fetch: false });
  await writeFile(path.join(plainDir, 'index.html'), html.replace(/<link rel="preload"[^>]*>/, ''), 'utf8');

  const withTags = await serveCopy(outDir);
  const without = await serveCopy(plainDir);
  try {
    // In the copy the font is requested by the tag (a "link" initiator), as the header did on the original.
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(withTags.url, { waitUntil: 'load' });
    const initiator = await p.evaluate(() => performance.getEntriesByType('resource').find((e) => /mono\.woff2/.test(e.name))?.initiatorType);
    await ctx.close();
    assert.equal(initiator, 'link');
    for (const width of [375, 1440]) {
      const a = await shot(withTags.url, width);
      assert.ok(a.equals(await shot(without.url, width)), `same pixels with and without the tag at ${width}`);
      assert.ok(a.equals(await shot(`${origin()}/`, width)), `same pixels as the original at ${width}`);
    }
  } finally {
    await withTags.close();
    await without.close();
  }
});
