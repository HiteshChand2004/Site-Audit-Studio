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
// A chunk a runtime builds from a rewritten CDN base (framer: /modules/… → /cms/…): the site's host answers it with a 404
// page, the CDN host with the file. Every original host is folded into the copy's root, so completion asks each of them.
const CDN_CHUNK = '/cms/wcnK/JQGUGunJL-chunk-default-0.framercms?range=0-168';

test('completion: a same-origin file the copy lacks is answered from the original (the site, else one of its CDN hosts); the first visit has no console error', { timeout: 10 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-same-origin-'));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + `<body><h1>Copy</h1><script>var i=new Image();i.src='${OPTIMISED}';document.body.append(i);</script>`
    + `<script>fetch('${CDN_CHUNK}').then((r) => r.ok ? r.text() : 'HTTP ' + r.status).then((t) => { window.__chunk = t; });</script>`
    + `<script src="${MISSING}"></script></body></html>`, 'utf8');
  const logo = path.join(root, 'logo-source.png');
  await sharp({ create: { width: 96, height: 32, channels: 3, background: { r: 30, g: 90, b: 200 } } }).png().toFile(logo);

  // The original: the optimised logo is its answer; the missing file is missing there too. Nothing is fetched from the network.
  const asked = [];
  const fetchImpl = async (url, { dir }) => {
    asked.push(url);
    const u = new URL(url);
    if (u.hostname === 'cdn.test' && u.pathname + u.search === CDN_CHUNK) {
      const tmp = path.join(dir, 'chunk.js');
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, 'chunk-bytes', 'utf8');
      return { ok: true, tmp, mime: 'application/javascript', sha256: 'c', bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
    }
    if (u.hostname === 'site.test' && u.pathname.startsWith('/cms/')) return { ok: true, tmp: logo, mime: 'text/html; charset=utf-8', sha256: 'p', bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
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
      browser, outDir, pageUrl: 'https://site.test/', hosts: ['site.test', 'cdn.test'], fetchImpl, passes: 2, files: [], entries: ['index.html'],
    });
    assert.ok(asked.some((u) => u.includes('/_next/image')), 'the original was asked for the optimised logo, once');
    assert.equal(result.sameOrigin.mapped.length, 2, 'the optimised address and the CDN chunk are mapped');
    const optimised = result.sameOrigin.mapped.find((m) => m.path === OPTIMISED);
    assert.equal(optimised.bare, true, 'its bare path answers a first visit too');
    assert.equal(optimised.host, undefined, 'answered by the site itself');
    const chunk = result.sameOrigin.mapped.find((m) => m.path === CDN_CHUNK);
    assert.equal(chunk?.host, 'cdn.test', 'the chunk came from the CDN host after the site answered with a page');
    assert.deepEqual(asked.filter((u) => u.includes('/cms/')).map((u) => new URL(u).hostname), ['site.test', 'cdn.test'], 'the site first, then the CDN, each once');
    assert.equal(result.sameOrigin.sameAsOriginal.length, 1, 'the file every original host lacks is reported as the same as the original');
    assert.equal(result.sameOrigin.sameAsOriginal[0].path, MISSING);
    assert.match(result.sameOrigin.sameAsOriginal[0].reason, /site.test: HTTP 404; cdn.test: HTTP 404/, 'the reason names every host asked');
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
    const chunkRan = await page.evaluate(() => window.__chunk);
    await context.close();
    assert.deepEqual(failed.filter((p) => p.startsWith('/_next/image') || p.startsWith('/cms/')), [], 'the optimised address and the CDN chunk answer on a first visit');
    assert.equal(chunkRan, 'chunk-bytes', 'the chunk fetched from the copy is the file of the CDN host');
    assert.deepEqual(failed, [MISSING], 'only the file the original also lacks is still an error, and it is the same as the original');
    assert.equal(consoleErrors.length, 1, 'one console error: the one the original shows too');
  } finally {
    await browser.close();
    if (served) await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }
});

const SMALL = '/_next/image?url=%2Flogo.png&w=96&q=75';
const LARGE = '/_next/image?url=%2Flogo.png&w=256&q=75';

test('two sizes of one image: each size is its own file; a cold visit never gets the other size; a warm visit gets each exactly', { timeout: 10 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-two-sizes-'));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + `<body><h1>Copy</h1><script>['${SMALL}','${LARGE}'].forEach(function(s){var i=new Image();i.src=s;document.body.append(i);});</script></body></html>`, 'utf8');
  const sources = { 96: path.join(root, 'small.png'), 256: path.join(root, 'large.png') };
  await sharp({ create: { width: 96, height: 32, channels: 3, background: { r: 30, g: 90, b: 200 } } }).png().toFile(sources[96]);
  await sharp({ create: { width: 256, height: 80, channels: 3, background: { r: 200, g: 60, b: 30 } } }).png().toFile(sources[256]);
  const fetchImpl = async (url, { dir }) => {
    const u = new URL(url);
    const w = u.searchParams.get('w');
    if (u.pathname !== '/_next/image' || u.searchParams.get('url') !== '/logo.png' || !sources[w]) return { ok: false, reason: 'HTTP 404' };
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `size-${w}.png`);
    await writeFile(tmp, await readFile(sources[w]));
    return { ok: true, tmp, mime: 'image/png', sha256: w, bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
  };
  const expected = { [SMALL]: await readFile(sources[96]), [LARGE]: await readFile(sources[256]) };

  const browser = await chromium.launch();
  let served = null;
  try {
    const result = await completeCopy({ browser, outDir, pageUrl: 'https://site.test/', hosts: ['site.test'], fetchImpl, passes: 2, files: [], entries: ['index.html'] });
    assert.equal(result.sameOrigin.mapped.length, 2, 'both sizes are mapped');
    assert.equal(result.sameOrigin.ambiguous.length, 1, 'the shared path is reported as having two addresses');
    assert.equal(result.sameOrigin.mapped.some((m) => m.bare), false, 'no address keeps the bare file');
    await assert.rejects(readFile(path.join(outDir, '_next', 'image')), 'the bare file is gone');
    const sw = await readFile(path.join(outDir, 'sw.js'), 'utf8');
    assert.ok(sw.includes(SMALL) && sw.includes(LARGE), 'the worker maps each size');

    served = await serveCopy(outDir);
    const base = served.url.replace(/\/$/, '');
    // A cold visit (no worker): whatever comes back is the right bytes for that size, or a 404 — never the other size.
    const cold = await browser.newContext();
    const coldPage = await cold.newPage();
    const seen = [];
    coldPage.on('response', async (r) => {
      const p = new URL(r.url());
      if (!p.pathname.startsWith('/_next/image')) return;
      seen.push({ key: p.pathname + p.search, status: r.status(), body: r.status() === 200 ? await r.body() : null });
    });
    await coldPage.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
    await coldPage.waitForTimeout(800);
    await cold.close();
    assert.equal(seen.length, 2, 'both sizes were asked');
    for (const s of seen) {
      if (s.status === 200) assert.ok(Buffer.compare(s.body, expected[s.key]) === 0, `a cold visit gets the right bytes for ${s.key}`);
    }
    // A warm visit: the worker is installed, a second load answers each size exactly.
    const warm = await browser.newContext();
    const warmPage = await warm.newPage();
    await warmPage.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
    await warmPage.evaluate(() => navigator.serviceWorker.ready);
    await warmPage.waitForTimeout(500);
    await warmPage.reload({ waitUntil: 'load' });
    for (const key of [SMALL, LARGE]) {
      const bytes = await warmPage.evaluate(async (k) => {
        const r = await fetch(k);
        return Array.from(new Uint8Array(await r.arrayBuffer()));
      }, key);
      assert.ok(Buffer.compare(Buffer.from(bytes), expected[key]) === 0, `a warm visit gets the exact file for ${key}`);
    }
    await warm.close();
  } finally {
    await browser.close();
    if (served) await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }
});
