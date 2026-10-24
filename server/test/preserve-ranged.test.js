// Files the original serves in pieces (behavior/preserve/ranged.js): a runtime reads a binary index with `?range=a-b[,c-d]`,
// expects status 200 and exactly those bytes, and does so only for a visitor (it tells an automated browser apart). The
// copy must hold the whole file and slice it itself, on a first visit (an inline script) and later (the service worker),
// whether the lift found a slice in the record or a completion pass saw the request. A file that does not hold its slice
// is left as any other address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { liftPage } from '../src/recreate/behavior/preserve/pageLift.js';
import { completeCopy, VISITOR_SHIM } from '../src/recreate/behavior/preserve/complete.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { rangesOf, sliceOf } from '../src/recreate/behavior/preserve/ranged.js';

const sha = (/** @type {string|Buffer} */ t) => createHash('sha256').update(t).digest('hex');
const SITE = 'https://site.test/';
// Three files of the original: an index and a chunk it slices by the query, and one it answers whole whatever the query.
const INDEX = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
const CHUNK = Buffer.from(Array.from({ length: 40 }, (_, i) => 200 - i));
const OTHER = Buffer.from('this host ignores the range query and answers the whole file');
const WHOLE = { '/data/index.bin': INDEX, '/data/chunk.bin': CHUNK, '/data/other.bin': OTHER };
// What the original answers for an address: the slice for the two sliced files, the whole file for the third.
const answerOf = (url) => {
  const u = new URL(url);
  const whole = WHOLE[u.pathname];
  if (!whole) return null;
  const ranges = rangesOf(url);
  if (ranges && u.pathname !== '/data/other.bin') return sliceOf(whole, ranges);
  return whole;
};
const fetchImpl = async (url, { dir }) => {
  const body = answerOf(url);
  if (!body) return { ok: false, reason: 'HTTP 404' };
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${sha(url).slice(0, 12)}.bin`);
  await writeFile(tmp, body);
  return { ok: true, tmp, mime: 'application/octet-stream', sha256: sha(body), bytes: body.length, head: Buffer.alloc(0), finalUrl: url, redirects: [] };
};
// The page's script: like a runtime, it reads its index in slices only when the browser is not automated, checks status
// and length, then reads a chunk, and reports. The third file is read with a range too (its host ignores the query).
const APP = `(async function(){
  if (navigator.webdriver) { window.__ranged = 'automated'; return; }
  async function part(p, q, n) {
    var r = await fetch(new URL(p, location.href).href + '?range=' + q);
    if (r.status !== 200) throw new Error('status ' + r.status + ' for ' + p);
    var b = new Uint8Array(await r.arrayBuffer());
    if (b.length !== n) throw new Error('length ' + b.length + ' for ' + p + ' (' + n + ' expected)');
    return b;
  }
  try {
    var a = await part('/data/index.bin', '0-3,8-11', 8);
    var c = await part('/data/chunk.bin', '2-5', 4);
    var o = await fetch('/data/other.bin?range=0-3');
    window.__ranged = { index: Array.from(a).join(','), chunk: Array.from(c).join(','), other: (await o.arrayBuffer()).byteLength };
  } catch (e) { window.__ranged = 'failed: ' + e.message; console.error(e.message); }
})();`;
const DOC = '<!doctype html><html><head><meta charset="utf-8"><title>Index</title></head><body><h1>Copy</h1><script src="https://site.test/app.js"></script></body></html>';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('rangesOf / sliceOf: the query shape, both ends included, one piece after another', () => {
  assert.deepEqual(rangesOf('https://x.test/i.bin?range=0-120'), [{ from: 0, to: 120 }]);
  assert.deepEqual(rangesOf('https://x.test/i.bin?range=4-7,20-21'), [{ from: 4, to: 7 }, { from: 20, to: 21 }]);
  assert.equal(rangesOf('https://x.test/i.bin?range=7-4'), null, 'an end before its start is no range');
  assert.equal(rangesOf('https://x.test/i.bin?range=a-b'), null);
  assert.equal(rangesOf('https://x.test/i.bin?page=2'), null);
  assert.equal(rangesOf('https://x.test/i.bin'), null);
  const whole = Buffer.from('0123456789abcdef');
  assert.equal(sliceOf(whole, rangesOf('https://x.test/i?range=0-3,8-11')).toString(), '012389ab');
  assert.equal(sliceOf(whole, [{ from: 10, to: 20 }]), null, 'past the end of the file');
});

test('a sliced file is kept whole (from the record and from a pass) and the copy slices it on a first visit and under the worker', { timeout: 5 * 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-ranged-'));
  let served = null;
  try {
    // The record: the document, the script, and ONE slice of the index (what the automated capture happened to see).
    const net = path.join(root, '.network');
    await mkdir(path.join(net, 'files'), { recursive: true });
    const slice = sliceOf(INDEX, [{ from: 20, to: 23 }]);
    for (const b of [DOC, APP]) await writeFile(path.join(net, 'files', sha(b)), b);
    await writeFile(path.join(net, 'files', sha(slice)), slice);
    await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [
      { url: SITE, status: 200, kind: 'document', type: 'text/html', sha: sha(DOC) },
      { url: 'https://site.test/app.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(APP) },
      { url: 'https://site.test/data/index.bin?range=20-23', status: 200, kind: 'data', type: 'application/octet-stream', sha: sha(slice) },
    ] }));
    const outDir = path.join(root, 'copy');
    const lift = await liftPage({ captureRoot: root, pageUrl: SITE, outDir, fetchImpl });
    assert.equal(lift.ranged.files.length, 1, 'the lift keeps the index whole');
    assert.equal(lift.ranged.files[0].url, 'https://site.test/data/index.bin');
    assert.equal(lift.ranged.files[0].bytes, INDEX.length);
    assert.deepEqual(lift.ranged.skipped, []);
    assert.ok((await readFile(path.join(outDir, lift.ranged.files[0].local))).equals(INDEX), 'the whole index is in the copy');

    // The completion pass opens the copy as a visitor: the script runs, asks for the chunk and the third file.
    const result = await completeCopy({ browser, outDir, pageUrl: SITE, hosts: ['site.test'], fetchImpl, passes: 2, files: lift.files, entries: ['index.html'] });
    const kept = result.ranged.files.map((f) => f.path).sort();
    assert.deepEqual(kept, ['/data/chunk.bin', '/data/index.bin'], 'the index from the record, the chunk from the pass');
    const chunk = result.ranged.files.find((f) => f.path === '/data/chunk.bin');
    assert.equal(chunk.from, 'pass');
    assert.equal(chunk.bytes, CHUNK.length);
    assert.equal(chunk.first, '2-5', 'the slice the page asked for first');
    assert.equal(result.ranged.skipped.length, 1, 'the file whose host ignores the query is not kept that way');
    assert.equal(result.ranged.skipped[0].path, '/data/other.bin');
    assert.match(result.ranged.skipped[0].reason, /does not hold the recorded slice/);
    assert.ok(result.sameOrigin.mapped.some((m) => m.path === '/data/other.bin?range=0-3'), 'it is answered as any other address instead');
    const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /sasRanged/, 'the first-visit slicing script is in the page');
    assert.ok(html.indexOf('window.URL=S') < html.indexOf('sasRanged'), 'after the URL shim');
    assert.ok(html.indexOf('sasRanged') < html.indexOf('app.js'), 'before the page\'s own script');
    const sw = await readFile(path.join(outDir, 'sw.js'), 'utf8');
    assert.match(sw, /"\/data\/chunk\.bin"/, 'the worker knows the sliced files');

    served = await serveCopy(outDir);
    const origin = served.url.replace(/\/$/, '');
    const visit = async (serviceWorkers) => {
      const context = await browser.newContext({ serviceWorkers });
      // A visitor's browser, not an automated one: the page's runtime does its work.
      await context.addInitScript(VISITOR_SHIM);
      const page = await context.newPage();
      const failed = [];
      const consoleErrors = [];
      page.on('response', (r) => { if (r.status() >= 400) failed.push(new URL(r.url()).pathname + new URL(r.url()).search); });
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__ranged !== undefined, null, { timeout: 15000 });
      let viaWorker = null;
      if (serviceWorkers === 'allow') {
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.__ranged !== undefined, null, { timeout: 15000 });
        viaWorker = await page.evaluate(() => !!navigator.serviceWorker.controller);
      }
      const got = await page.evaluate(() => window.__ranged);
      await context.close();
      return { got, failed, consoleErrors, viaWorker };
    };
    const first = await visit('block');
    assert.deepEqual(first.consoleErrors, [], 'a first visit: no console error');
    assert.deepEqual(first.failed, [], 'and no failed request');
    assert.deepEqual(first.got, { index: '0,1,2,3,8,9,10,11', chunk: '198,197,196,195', other: OTHER.length }, 'the slices are the original\'s bytes; the third file is answered whole as the original does');
    const second = await visit('allow');
    assert.equal(second.viaWorker, true, 'the second visit is under the worker');
    assert.deepEqual(second.consoleErrors, []);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.got, first.got, 'the worker slices the same way');
  } finally {
    if (served) await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }
});
