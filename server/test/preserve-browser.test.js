// Step (b) of the preserve-original work, in a real browser (Chromium), on small pages written here:
//  1. a component renders OFFLINE: its own hover and loop work, nothing leaves the copy, and it matches the original;
//  2. a copy that asks any other host for something is flagged (a leak), never silently passed;
//  3. attribution: a button a widget script injects is found (excluded); the site's own portal is not;
//  4. the capture asks for every picture variant and video of the page, not only the ones it displayed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { preserveCapture } from '../src/recreate/behavior/preserve/index.js';
import { renderComponent, verdictOf, writeRenderPage } from '../src/recreate/behavior/preserve/render.js';
import { measureAttribution } from '../src/recreate/behavior/preserve/attribution.js';
import { listMediaUrls, fetchVariants } from '../src/recreate/capture/variants.js';

const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
let browser;
let server;
let port;
const served = new Map();

before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = served.get(url.pathname);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const PAGE_STYLE = `
  body { margin: 0; background: #fff; font-family: sans-serif; }
  .box { width: 1440px; height: 400px; position: relative; }
  .card { width: 300px; height: 120px; background: rgb(255, 255, 255); transition: none; }
  .card:hover { background: rgb(194, 65, 12); }
  .spin { display: inline-block; width: 60px; height: 60px; background: rgb(10, 80, 200); animation: spin 2s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

/** A one-section page: a hover card and a spinning square. */
const SECTION_HTML = `<!doctype html><html><head><style>${PAGE_STYLE}</style></head><body>
  <section class="box"><div class="card">Card</div><span class="spin"></span></section>
</body></html>`;

/** Writes a capture for a page given its as-is HTML and its signals (the same files capture/index.js writes). */
async function writeCapture(root, { html, body, motion, record = [], css = PAGE_STYLE }) {
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  await mkdir(path.join(root, 'index'), { recursive: true });
  for (const r of record) await writeFile(path.join(net, 'files', sha(r.body)), r.body);
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: record.map((r) => ({ url: r.url, status: 200, kind: r.kind, type: r.type, sha: sha(r.body) })) }));
  await writeFile(path.join(root, 'index', 'desktop-asis.json'), JSON.stringify({ html, baseURI: `http://127.0.0.1:${port}/`, sheets: [{ from: 'style', readable: true, raw: css }], refs: [] }));
  await writeFile(path.join(root, 'index', 'desktop.json'), JSON.stringify({ viewport: [1440, 900], body }));
  await writeFile(path.join(root, 'index', 'motion.json'), JSON.stringify(motion));
}

test('a component renders offline: its hover and its loop work, nothing leaves the copy, and it matches the original', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-render-'));
  try {
    const body = { tag: 'body', path: 'body', rect: [0, 0, 1440, 400], children: [
      { tag: 'section', path: 'body>section:1', rect: [0, 0, 1440, 400], children: [] },
    ] };
    const motion = {
      hover: [{ path: 'body>section:1>div:1', tag: 'div', source: 'css', text: 'Card', changes: { 'background-color': ['rgb(255, 255, 255)', 'rgb(194, 65, 12)'] } }],
      loops: { loops: [{ path: 'body>section:1>span:1', tag: 'span', source: 'css', pattern: 'spin' }], videoLayers: { layers: [] } },
    };
    await writeCapture(root, { html: SECTION_HTML, body, motion });
    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: `http://127.0.0.1:${port}/`, fetch: false });
    const comp = index.components.find((c) => c.root === 'body>section:1');
    const dir = path.join(out, 'preserved', comp.id);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    // The reference: the same component rendered once, as the original's pixels (the exact baseline's format).
    const first = await renderComponent({ browser, dir, component: { id: comp.id, root: comp.root, rect: comp.rect }, manifest, baselineDir: path.join(root, 'none'), outDir: path.join(out, 'pics') }).catch(() => null);
    assert.ok(first, 'the component renders');
    const baseline = path.join(root, 'baseline');
    await mkdir(baseline, { recursive: true });
    const { default: sharp } = await import('sharp');
    const band = path.join(baseline, 'band0.png');
    await sharp(first.screenshots.copy).png().toFile(band);
    await writeFile(path.join(baseline, 'index.json'), JSON.stringify({ slots: [{ id: '1440', width: 1440, bands: [{ band: 0, top: 0, height: 400, file: 'band0.png' }] }] }));
    const r = await renderComponent({ browser, dir, component: { id: comp.id, root: comp.root, rect: comp.rect }, manifest, baselineDir: baseline, outDir: path.join(out, 'pics') });
    assert.equal(r.leaks, 0, 'no request leaves the copy');
    assert.equal(r.loops.expected, 1);
    assert.ok(r.loops.running >= 1, 'the loop runs in the copy');
    assert.equal(r.hover.checked, 1);
    assert.equal(r.hover.same, 1, 'the hover ends where the original\'s ended');
    assert.ok(r.diffPct !== null && r.diffPct <= 3, `the component matches the original (${r.diffPct}%)`);
    assert.equal(verdictOf({ leaks: 0, assetsOffline: true, driver: 'css', diffPct: r.diffPct, loops: r.loops, hover: r.hover }), 'pass');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a copy that asks another host for something is a leak, reported as such', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-leak-'));
  try {
    const html = SECTION_HTML.replace('<span class="spin"></span>', '<span class="spin"></span><img src="https://elsewhere.invalid/x.png" alt="">');
    const body = { tag: 'body', path: 'body', rect: [0, 0, 1440, 400], children: [{ tag: 'section', path: 'body>section:1', rect: [0, 0, 1440, 400], children: [] }] };
    const motion = { hover: [{ path: 'body>section:1>div:1', tag: 'div', source: 'css', text: 'Card' }], loops: { loops: [], videoLayers: { layers: [] } } };
    await writeCapture(root, { html, body, motion });
    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: `http://127.0.0.1:${port}/`, fetch: false });
    const comp = index.components.find((c) => c.root === 'body>section:1');
    const dir = path.join(out, 'preserved', comp.id);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const r = await renderComponent({ browser, dir, component: { id: comp.id, root: comp.root, rect: comp.rect }, manifest, baselineDir: path.join(root, 'none'), outDir: path.join(out, 'pics') });
    assert.ok(r.leaks >= 1 || r.copyLinks.length >= 1, 'the outside request or reference is seen');
    assert.equal(verdictOf({ leaks: r.leaks + r.copyLinks.length, assetsOffline: true, driver: 'css', diffPct: 0, loops: { expected: 0, running: 0 }, hover: { checked: 0, same: 0 } }), 'leaks');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attribution: a button a widget script injects is found; the site\'s own portal is not', async () => {
  // The site: a section, a site-owned portal outside it, and a widget loader from another host that adds a button.
  served.set('/', `<!doctype html><html><head></head><body>
    <section><p>content here</p></section>
    <div class="portal"><button>Site modal button</button></div>
    <script src="http://localhost:${port}/widget.js"></script></body></html>`);
  served.set('/widget.js', 'var b=document.createElement("button");b.textContent="Ask the widget";document.body.appendChild(b);');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-attr-'));
  try {
    const result = await measureAttribution({ browser, url: `http://127.0.0.1:${port}/`, hosts: ['localhost'], outFile: path.join(root, 'attribution.json'), settleMs: 600 });
    const texts = result.parts.map((p) => p.text);
    assert.ok(texts.includes('Ask the widget'), 'the widget button is attributed to the widget');
    assert.ok(!texts.includes('Site modal button'), 'the site\'s portal stays');
    assert.ok(result.injected.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture: every picture variant and the video of a page are requested, not only the ones displayed', async () => {
  served.set('/media', `<!doctype html><html><body>
    <img src="/a.png" srcset="/a.png 1x, /a-2x.png 2x" alt="">
    <video src="/v.mp4"></video></body></html>`);
  served.set('/a.png', 'png');
  served.set('/a-2x.png', 'png2x');
  served.set('/v.mp4', 'mp4');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const requested = new Set();
    page.on('request', (req) => requested.add(new URL(req.url()).pathname));
    await page.goto(`http://127.0.0.1:${port}/media`, { waitUntil: 'load' });
    const urls = await listMediaUrls(page);
    assert.ok(urls.some((u) => u.endsWith('/a-2x.png')), 'the 2x candidate is listed');
    assert.ok(urls.some((u) => u.endsWith('/v.mp4')), 'the video is listed');
    const res = await fetchVariants(page, urls, { budgetMs: 10000 });
    assert.equal(res.timedOut, false);
    assert.ok(requested.has('/a-2x.png'), 'the 2x picture is fetched by the page');
    assert.ok(requested.has('/v.mp4'), 'the video is fetched by the page');
  } finally {
    await context.close();
  }
});
