// Completing a lifted page (behavior/preserve/complete.js), from a small page written here: its script builds an asset
// address at run time from pieces of text (the lift cannot see it), and the capture never loaded that asset. The completion
// downloads it through the guarded fetch and the service worker serves it. In a browser, with every request to the
// original aborted, the image loads and nothing reaches the original.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftPage } from '../src/recreate/behavior/preserve/pageLift.js';
import { completeCopy } from '../src/recreate/behavior/preserve/complete.js';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const SITE = 'https://site.test/';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('a runtime-built asset address is downloaded by the completion and served by the copy, with nothing left on the original', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-complete-'));
  try {
    const net = path.join(root, '.network');
    await mkdir(path.join(net, 'files'), { recursive: true });
    const APP = "var u = ['https:', '', 'site.test', 'assets', 'pic.svg'].join('/'); var i = document.createElement('img'); i.id = 'pic'; i.src = u; document.body.appendChild(i);";
    const DOC = '<!doctype html><html><head></head><body><script src="https://site.test/app.js"></script></body></html>';
    for (const b of [DOC, APP]) await writeFile(path.join(net, 'files', sha(b)), b);
    await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [
      { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(DOC) },
      { url: 'https://site.test/app.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(APP) },
    ] }));
    const out = path.join(root, 'copy');
    await liftPage({ captureRoot: root, pageUrl: SITE, outDir: out, fetch: false });
    const fetchImpl = async (url, { dir }) => {
      const tmp = path.join(dir, 'pic.tmp');
      await writeFile(tmp, SVG);
      return { ok: true, tmp, sha256: sha(SVG), bytes: SVG.length, mime: 'image/svg+xml', finalUrl: url, redirects: [] };
    };
    const done = await completeCopy({ browser, outDir: out, pageUrl: SITE, hosts: ['site.test'], fetchImpl });
    assert.equal(done.manifest['https://site.test/assets/pic.svg'], '/assets/pic.svg', 'the runtime address is in the manifest');
    assert.ok(done.passes <= 3);

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
      await page.waitForTimeout(1500);
      // The first visit is before the worker is in control: measure what the worker serves, from its first reload on.
      await page.evaluate(() => navigator.serviceWorker.ready);
      toOriginal.length = 0;
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(800);
      const loaded = await page.evaluate(() => document.getElementById('pic')?.complete && document.getElementById('pic').naturalWidth > 0);
      assert.equal(loaded, true, 'the runtime-built image loads from the copy');
      assert.deepEqual(toOriginal, [], "no request reaches the original: " + JSON.stringify(toOriginal));
    } finally {
      await context.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
