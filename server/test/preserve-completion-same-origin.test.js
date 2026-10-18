// A page's runtime asks its own server for a file the copy does not hold (an image optimiser's address, /_next/image?url=…,
// built from the original's logo). Completion asks the original once, keeps the answer and maps the address, so a first visit
// has no console error. A file the original does not have either stays a 404, reported as "same as original".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { completeCopy } from '../src/recreate/behavior/preserve/complete.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const OPTIMISED = '/_next/image?url=%2Flogo.png&w=96&q=75';
const MISSING = '/gone/missing.js';

test('completion: a same-origin file the copy lacks is answered from the original; the first visit has no console error', { timeout: 10 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-same-origin-'));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + `<body><h1>Copy</h1><script>var i=new Image();i.src='${OPTIMISED}';document.body.append(i);</script>`
    + `<script src="${MISSING}"></script></body></html>`, 'utf8');
  const logo = path.join(root, 'logo-source.png');
  await sharp({ create: { width: 96, height: 32, channels: 3, background: { r: 30, g: 90, b: 200 } } }).png().toFile(logo);

  // The original: the optimised logo is its answer; the missing file is missing there too. Nothing is fetched from the network.
  const asked = [];
  const fetchImpl = async (url, { dir }) => {
    asked.push(url);
    const u = new URL(url);
    if (u.pathname === '/_next/image' && u.searchParams.get('url') === '/logo.png') {
      const tmp = path.join(dir, 'optimised.png');
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, await readFile(logo));
      return { ok: true, tmp, mime: 'image/png', sha256: 'x', bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
    }
    return { ok: false, reason: 'HTTP 404' };
  };

  const browser = await chromium.launch();
  let served = null;
  try {
    const result = await completeCopy({
      browser, outDir, pageUrl: 'https://site.test/', hosts: ['site.test'], fetchImpl, passes: 2, files: [], entries: ['index.html'],
    });
    assert.ok(asked.some((u) => u.includes('/_next/image')), 'the original was asked for the optimised logo, once');
    assert.equal(result.sameOrigin.mapped.length, 1, 'the optimised address is mapped');
    assert.equal(result.sameOrigin.mapped[0].bare, true, 'its bare path answers a first visit too');
    assert.equal(result.sameOrigin.sameAsOriginal.length, 1, 'the file the original lacks is reported as the same as the original');
    assert.equal(result.sameOrigin.sameAsOriginal[0].path, MISSING);
    const sw = await readFile(path.join(outDir, 'sw.js'), 'utf8');
    assert.match(sw, /_next\/image\?url=%2Flogo\.png&w=96&q=75/, 'the worker maps the address');

    // A first visit: a fresh browser context, so no worker is installed yet.
    served = await serveCopy(outDir);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const failed = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) failed.push(new URL(r.url()).pathname + new URL(r.url()).search); });
    await page.goto(`${served.url.replace(/\/$/, '')}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1000);
    await context.close();
    assert.deepEqual(failed.filter((p) => p.startsWith('/_next/image')), [], 'the optimised address answers on a first visit');
    assert.deepEqual(failed, [MISSING], 'only the file the original also lacks is still an error, and it is the same as the original');
    assert.equal(consoleErrors.length, 1, 'one console error: the one the original shows too');
  } finally {
    await browser.close();
    if (served) await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }
});
