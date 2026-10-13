// Exact mode, original CSS: a page whose script renders different markup at different widths (a phone version of a
// heading swapped in as the window narrows - what server-rendered builder sites do once they hydrate). One as-is
// document per view; where they differ every version is kept and shown only at its views' widths.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { captureAsIs, recordSheetBodies } from '../src/recreate/capture/asis.js';
import { asisBody, asisCss, mergeViewBodies, pageSheets, variantCss } from '../src/recreate/ir/asis.js';
import { emitPage } from '../src/recreate/emit/html.js';

const PORT = 4219;
const COPY_PORT = 4220;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Views</title>
<style>body { margin: 0; font: 16px/1.4 Arial, sans-serif; } h1 { margin: 24px; font-size: 40px; } .phone h1 { text-align: start; font-size: 28px; } .wide h1 { text-align: center; } p { margin: 24px; }</style>
</head><body><main><div class="slot"></div><p>Same everywhere</p></main>
<script>
  const slot = document.querySelector('.slot');
  const render = () => {
    const phone = innerWidth < 600;
    slot.className = 'slot ' + (phone ? 'phone' : 'wide');
    slot.innerHTML = phone ? '<h1>Hi, phone</h1>' : '<h1>Hi, wide screen</h1>';
  };
  render();
  addEventListener('resize', render);
</script></body></html>`;

let server;
let copyServer;
let browser;
let html;
let merged;

before(async () => {
  server = createServer((req, res) => res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' }).end(req.url === '/' ? PAGE : ''));
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  const reads = [];
  for (const [view, width] of [['desktop', 1280], ['mobile', 375]]) {
    const context = await browser.newContext({ viewport: { width, height: 700 } });
    const recorder = recordSheetBodies(context);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    reads.push([view, (await captureAsIs(page, recorder)).data]);
    await context.close();
  }
  const opts = { pageUrl: `${ORIGIN}/`, assetResolve: () => null, resolveLink: () => null };
  merged = mergeViewBodies(reads.map(([view, asis]) => [view, asisBody(asis, opts).body]));
  const sheets = [...pageSheets(reads[0][1], () => null).sheets, variantCss(merged.variants, ['desktop', 'mobile'], { mobile: 599.98 })];
  const irPage = {
    outPath: 'index.html',
    head: { title: 'Views', lang: 'en', canonical: `${ORIGIN}/`, meta: [], alternates: [], icons: [], jsonLd: [] },
    html: { class: null },
    body: merged.body,
    asis: sheets.map((_, i) => `s${i}`),
  };
  const ir = { pages: [irPage], asis: { sheets: Object.fromEntries(sheets.map((t, i) => [`s${i}`, t])) } };
  html = emitPage(irPage, { css: asisCss(ir, { page: irPage, from: 'index.html' }) });
  copyServer = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((resolve) => { copyServer.listen(COPY_PORT, '127.0.0.1', resolve); });
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  copyServer?.close();
});

test('only the part that differs is kept twice; what every view shares is written once', () => {
  assert.equal(merged.variants.size, 2);
  assert.equal((html.match(/Same everywhere/g) ?? []).length, 1);
  assert.match(html, /<div class="slot wide" data-sas-v="v1"><h1>Hi, wide screen<\/h1><\/div><div class="slot phone" data-sas-v="v2"><h1>Hi, phone<\/h1><\/div>/);
  assert.match(html, /@media \(width <= 599\.98px\) \{\n {2}\[data-sas-v="v1"\] \{ display: none !important; \}/);
  assert.match(html, /@media \(width > 599\.98px\) \{\n {2}\[data-sas-v="v2"\] \{ display: none !important; \}/);
});

test('the copy is drawn like the original on both sides of the switch, with no script of the original', async () => {
  const differing = [];
  for (const width of [333, 480, 700, 1111]) {
    const o = await browser.newContext({ viewport: { width, height: 600 } });
    const c = await browser.newContext({ viewport: { width, height: 600 }, javaScriptEnabled: false });
    const op = await o.newPage();
    const cp = await c.newPage();
    await op.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await cp.goto(`http://127.0.0.1:${COPY_PORT}/`, { waitUntil: 'load' });
    const [a, b] = await Promise.all([op.screenshot({ fullPage: true }), cp.screenshot({ fullPage: true })]);
    if (!a.equals(b)) differing.push(width);
    await o.close();
    await c.close();
  }
  assert.deepEqual(differing, []);
});
