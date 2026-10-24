// Completion must see what a page asks for LATER and what it asks for only once its addresses resolve. Found on a builder
// site: its runtime asks the CDN for a search index ~10 s after load, built from a base the host rewrite had folded into a
// root-relative path. The completion pass (a) had no URL shim yet, so that runtime failed and asked for nothing, and (b) ended
// ~7 s after load, before the timer fired. The copy shipped without the file: a 404 and a console error on every visit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { completeCopy, FAST_TIMER_CAP_MS, PASS_MAX_MS, QUIET_MS } from '../src/recreate/behavior/preserve/complete.js';
import { rewriteHosts } from '../src/recreate/behavior/preserve/hostRewrite.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const SITE = 'site.test';
const CDN = 'cdn.test';
/** The index the runtime asks for: a chunk address built from the (rewritten) module base, 10 s after load, with a range. */
const INDEX = '/cms/wcnK/JQG-indexes-default-0.framercms?range=0-168';
const LATE_MS = 10000;

test('completion sees a file a runtime asks for 10 s after load from an address built on a rewritten base, and the shipped copy answers it', { timeout: 10 * 60000 }, async () => {
  assert.ok(LATE_MS > FAST_TIMER_CAP_MS * 3 && LATE_MS < PASS_MAX_MS, 'the delay is one a fixed wait misses and the fast clock reaches');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-complete-late-'));
  const outDir = path.join(root, 'copy');
  await mkdir(path.join(outDir, 'modules'), { recursive: true });
  // As the original ships it: the module builds the index address from its own absolute base on the CDN; the host rewrite
  // folds that base into a root-relative path, which `new URL` refuses without the shim.
  const moduleCode = `const base = 'https://${CDN}/modules/wcnK/JQG.js';\n`
    + 'function ask() {\n'
    + '  let href;\n'
    + "  try { href = new URL('./JQG-indexes-default-0.framercms', base).href.replace('/modules/', '/cms/') + '?range=0-168'; }\n"
    + "  catch (e) { window.__late = 'failed: ' + e.message; return; }\n"
    + "  fetch(href).then((r) => r.ok ? r.text() : 'HTTP ' + r.status).then((t) => { window.__late = t; });\n"
    + '}\n'
    + `setTimeout(ask, ${LATE_MS});\n`;
  await writeFile(path.join(outDir, 'modules', 'main.js'), rewriteHosts(moduleCode, [SITE, CDN]).text, 'utf8');
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + '<body><h1>Copy</h1><script type="module" src="/modules/main.js"></script></body></html>', 'utf8');

  // The original: the site answers the index address with a 404 page, its CDN with the file. Nothing goes to the network.
  const asked = [];
  const fetchImpl = async (url, { dir }) => {
    asked.push(url);
    const u = new URL(url);
    if (u.pathname + u.search !== INDEX) return { ok: false, reason: 'HTTP 404' };
    await mkdir(dir, { recursive: true });
    if (u.hostname === SITE) {
      const tmp = path.join(dir, 'not-found.html');
      await writeFile(tmp, '<!doctype html><title>Not found</title>', 'utf8');
      return { ok: true, tmp, mime: 'text/html; charset=utf-8', sha256: 'p', bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
    }
    const tmp = path.join(dir, 'index.framercms');
    await writeFile(tmp, 'index-bytes', 'utf8');
    return { ok: true, tmp, mime: 'application/octet-stream', sha256: 'i', bytes: 1, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
  };

  const browser = await chromium.launch();
  let served = null;
  try {
    const t0 = Date.now();
    const result = await completeCopy({ browser, outDir, pageUrl: `https://${SITE}/`, hosts: [SITE, CDN], fetchImpl, passes: 2, files: [], entries: ['index.html'] });
    const took = Date.now() - t0;
    assert.ok(took < 2 * 2 * PASS_MAX_MS, `the passes end on quiet, not on the cap (took ${took} ms)`);
    // (fetchReferenced, after the passes, may ask for other addresses the code names; only the index is this test's concern.)
    assert.deepEqual(asked.filter((u) => new URL(u).pathname + new URL(u).search === INDEX).map((u) => new URL(u).hostname), [SITE, CDN], 'the index was asked of the site, then of the CDN, once each');
    const mapped = result.sameOrigin.mapped.find((m) => m.path === INDEX);
    assert.ok(mapped, 'the late address is mapped');
    assert.equal(mapped.host, CDN, 'to the CDN host\'s answer');
    assert.equal(result.sameOrigin.sameAsOriginal.length, 0, 'nothing is left as "same as the original"');
    const sw = await readFile(path.join(outDir, 'sw.js'), 'utf8');
    assert.ok(sw.includes('JQG-indexes-default-0.framercms?range=0-168'), 'the worker maps the address');

    // The shipped copy, first visit, real clock: the index is asked for 10 s after load and answered from the copy.
    served = await serveCopy(outDir);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const failed = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) failed.push(new URL(r.url()).pathname + new URL(r.url()).search); });
    await page.goto(served.url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__late !== undefined, null, { timeout: LATE_MS + 15000 });
    const late = await page.evaluate(() => window.__late);
    await context.close();
    assert.equal(late, 'index-bytes', 'the shipped page gets the CDN\'s file for the late address');
    assert.deepEqual(failed, [], 'no request of the shipped copy fails');
    assert.deepEqual(consoleErrors, [], 'no console error');
  } finally {
    await browser.close();
    if (served) await served.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a page that asks for nothing ends its pass soon after the scroll: the quiet rule, not the cap, decides', { timeout: 5 * 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-complete-quiet-'));
  const outDir = path.join(root, 'copy');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Quiet</title></head><body><p>nothing to ask for</p></body></html>', 'utf8');
  const browser = await chromium.launch();
  try {
    const t0 = Date.now();
    const result = await completeCopy({ browser, outDir, pageUrl: `https://${SITE}/`, hosts: [SITE], fetchImpl: async () => ({ ok: false, reason: 'HTTP 404' }), passes: 1, files: [], entries: ['index.html'] });
    const took = Date.now() - t0;
    // One pass, two sizes: load + 1.5 s + the scroll (~4.2 s) + QUIET_MS each, well under the cap.
    assert.ok(took < 2 * (PASS_MAX_MS / 2), `two sizes of a quiet page took ${took} ms`);
    assert.ok(took > 2 * QUIET_MS, 'and each size waited for the quiet window');
    assert.equal(result.passes, 1);
    assert.deepEqual(result.sameOrigin.mapped, []);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
