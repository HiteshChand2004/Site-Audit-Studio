// An app's page asks its own server for its settings (/api/config) before it draws anything; the original answers with JSON.
// Completion keeps that answer like a file (asked again as data), so the copy draws the same screen instead of "the app isn't
// ready". A web page in place of the data is still refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { completeCopy } from '../src/recreate/behavior/preserve/complete.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const SETTINGS = '{"auth_mode":"local","auth_enabled":true}';

test('completion: JSON the page asks its own server for is kept from the original; a page in its place is not', { timeout: 10 * 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-app-data-'));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><p id="s">loading</p>'
    + '<script>fetch("/api/config").then((r) => r.json()).then((c) => { document.getElementById("s").textContent = "sign in (" + c.auth_mode + ")"; })'
    + '.catch(() => { document.getElementById("s").textContent = "The app isn\'t ready"; });'
    + 'fetch("/api/page").catch(() => {});</script></body></html>', 'utf8');

  // The downloader as it is: JSON is no file (refused, naming its type) unless asked for as data; a page is never data.
  const asked = [];
  const fetchImpl = async (url, { dir, kind }) => {
    asked.push(`${new URL(url).pathname} ${kind}`);
    const p = new URL(url).pathname;
    if (p === '/api/page') return { ok: false, reason: 'not-an-asset', mime: 'text/html' };
    if (p !== '/api/config') return { ok: false, reason: 'http-404' };
    if (kind !== 'data') return { ok: false, reason: 'not-an-asset', mime: 'application/json' };
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, 'config.json');
    await writeFile(tmp, SETTINGS, 'utf8');
    return { ok: true, tmp, mime: 'application/json', sha256: 'c', bytes: SETTINGS.length, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
  };

  const browser = await chromium.launch();
  let served = null;
  try {
    const result = await completeCopy({ browser, outDir, pageUrl: 'https://app.test/', hosts: ['app.test'], fetchImpl, passes: 2, files: [], entries: ['index.html'] });
    assert.deepEqual(result.sameOrigin.mapped.map((m) => m.path), ['/api/config'], 'the settings are kept');
    assert.deepEqual(result.sameOrigin.sameAsOriginal.map((m) => m.path), ['/api/page'], 'a page in place of data is not');
    assert.ok(!asked.includes('/api/page data'), 'a page is never asked for again as data');

    // A first visit, no worker yet: the app reads its settings from the copy and draws its screen.
    served = await serveCopy(outDir);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${served.url.replace(/\/$/, '')}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('s').textContent !== 'loading', null, { timeout: 10000 });
    assert.equal(await page.textContent('#s'), 'sign in (local)');
    await context.close();
  } finally {
    await browser.close();
    if (served) await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }
});
