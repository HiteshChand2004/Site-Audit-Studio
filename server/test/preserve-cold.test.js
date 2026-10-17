// The first visit of a lifted copy, with no service worker yet (a fresh browser profile): a runtime that builds its address
// from a host fragment ("/<host>/assets/") and a stylesheet that names the original's host must make no request to the
// original. The lift rewrites those host names to the copy's own paths; the worker is only the backstop after that.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftPage } from '../src/recreate/behavior/preserve/pageLift.js';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const SITE = 'https://site.test/';
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('a cold first visit (no service worker yet) makes no request to the original host', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-cold-'));
  try {
    const net = path.join(root, '.network');
    await mkdir(path.join(net, 'files'), { recursive: true });
    const APP = 'var base = "/site.test/assets/"; var img = document.createElement("img"); img.id = "pic"; img.src = base + "pic.svg"; document.body.appendChild(img); window.__ran = true;';
    const CSS = '.bg { background-image: url(https://site.test/bg.png); }';
    const DOC = '<!doctype html><html><head><link rel="stylesheet" href="https://site.test/app.css"></head><body><div class="bg">x</div><script src="https://site.test/app.js"></script></body></html>';
    for (const b of [DOC, APP, CSS]) await writeFile(path.join(net, 'files', sha(b)), b);
    await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [
      { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(DOC) },
      { url: 'https://site.test/app.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(APP) },
      { url: 'https://site.test/app.css', status: 200, kind: 'style', type: 'text/css', sha: sha(CSS) },
    ] }));
    const out = path.join(root, 'copy');
    await liftPage({ captureRoot: root, pageUrl: SITE, outDir: out, fetch: false });
    const server = await serveFolder(out);
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const toOriginal = [];
    try {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(server.url)) return route.continue();
        if (url.includes('site.test')) toOriginal.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${server.url}index.html`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__ran === true), true, 'the runtime ran');
      assert.deepEqual(toOriginal, [], 'no request reached the original on the cold visit: ' + JSON.stringify(toOriginal));
    } finally {
      await context.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
