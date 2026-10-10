// Exact mode, phase A6: the comparison itself. A real original is measured at two slots, then a faithful copy and a
// broken one are rendered at the same slots and compared - pixels, boxes, heights, pictures of what differs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureExactPage } from '../src/recreate/capture/exact.js';
import { compareExact, fidelityExactDir, summarise } from '../src/recreate/verify/exact/compare.js';
import { slotFor } from '../src/recreate/verify/exact/slots.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4206;
const origin = `http://127.0.0.1:${PORT}`;

const body = (extra = '', cellHeight = 120) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Original</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px/1.5 system-ui; background: #fff; }
  .bar { height: 60px; background: #123; color: #fff; }
  .cell { height: ${cellHeight}px; background: #eef; }
  .note { padding: 12px; }
  @media (max-width: 700px) { .bar { height: 40px; } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spinner { width: 30px; height: 30px; background: #c33; animation: spin 1s linear infinite; }
</style></head><body>
  <div class="bar">Header</div>
  <div class="spinner"></div>
  <div class="cell">Panel one</div>
  <div class="note">Some words that fill a line or two of text on this page.</div>
  <div style="height: 1200px; background: linear-gradient(#fff, #f6f6f6)"></div>
  ${extra}
<script>var n = 0; setInterval(function tick() { n++; }, 200);</script>
</body></html>`;

let server;
let browser;
let work;
const slots = [slotFor(1280), slotFor(768)];
const page = { path: '/', slug: 'index', url: `${origin}/`, outPath: 'index.html' };

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body());
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  work = await mkdtemp(path.join(os.tmpdir(), 'sas-exactcmp-'));
  // The baseline: the original measured at both slots, exactly as the pipeline's step does it.
  await captureExactPage(browser, page, work, { slots });
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
  await rm(work, { recursive: true, force: true });
});

/** A copy served from its own folder, as dist/ is. */
async function copyAt(folder, html) {
  const root = path.join(work, folder);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), html);
  return root;
}

const baselineOf = async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(work, 'capture', 'index', 'exact', 'index.json'), 'utf8'));
  return { slots, pages: [manifest], noiseFloor: {} };
};

test('a copy that really is the same page matches at every size', async () => {
  const root = await copyAt('dist-same', body());
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.slots, 2);
  assert.equal(r.accepted, 2, JSON.stringify(r.pages[0].slots.map((s) => ({ id: s.id, diff: s.diffRaw, boxes: s.boxes, h: [s.heightOriginal, s.heightCopy] }))));
  for (const slot of r.pages[0].slots) {
    assert.equal(slot.heightOk, true);
    assert.ok(slot.diffRaw <= 0.5, `${slot.id}: ${slot.diffRaw}%`);
    assert.equal(slot.boxes.missing, 0);
    assert.equal(slot.boxes.extra, 0);
    assert.equal(slot.boxes.within, slot.boxes.paired);
    // Nothing to show for a size that matches: no map, no crops.
    assert.equal(slot.map, undefined);
    assert.equal(slot.crops, undefined);
  }
  assert.deepEqual(r.causes, {});
});

test('a copy missing an element is caught, named and pictured', async () => {
  const root = await copyAt('dist-missing', body().replace('<div class="note">Some words that fill a line or two of text on this page.</div>', ''));
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  assert.equal(r.accepted, 0);
  const slot = r.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(slot.boxes.missing, 1);
  assert.equal(slot.boxes.missingItems[0].key.startsWith('some words'), true);
  assert.equal(slot.heightOk, false, 'and the page is shorter for it');
  // A size that failed keeps a map of where and a magnified look at the worst places.
  assert.ok(slot.map, 'a map was written');
  assert.ok(slot.crops?.length >= 1, 'at least one crop');
  const files = await readdir(fidelityExactDir(work, 'index'));
  assert.ok(files.includes(slot.map));
  for (const c of slot.crops) {
    assert.ok(files.includes(c.file));
    assert.equal(c.zoom, 3);
  }
  assert.equal(r.causes['missing-element'], 2, 'once per slot');
  assert.ok(r.causes['page-height'] >= 1);
});

test('a copy whose box is a few pixels out is caught even though the page is the same height', async () => {
  // A panel 8 px taller: the page height changes by 8, the boxes below move, the pixels differ.
  const root = await copyAt('dist-shifted', body('', 128));
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  const slot = r.pages[0].slots.find((s) => s.id === '1280');
  assert.equal(slot.accepted, false);
  assert.equal(slot.boxes.missing, 0, 'nothing is missing - it moved');
  assert.ok(slot.boxes.within < slot.boxes.paired, 'something is out of place');
  const moved = slot.boxes.worst.some((w) => Math.abs(w.delta[1]) >= 7 || Math.abs(w.delta[3]) >= 7);
  assert.ok(moved, `nothing moved: ${JSON.stringify(slot.boxes.worst.map((w) => w.delta))}`);
  assert.ok(slot.diffRaw > 0);
});

test('the copy is held to loading nothing from anywhere else', async () => {
  const root = await copyAt('dist-external', body('<img src="http://127.0.0.1:9/outside.png" width="40" height="40" alt="">'));
  const r = await compareExact({ root, workspace: work, baseline: await baselineOf(), pages: [page], scripts: false });
  const slot = r.pages[0].slots.find((s) => s.id === '1280');
  // The request is blocked by the renderer, and recorded: a copy must carry its own files.
  assert.ok(slot.failedRequests?.length >= 1, JSON.stringify(slot.failedRequests));
  assert.match(slot.failedRequests[0].url, /outside\.png/);
});

test('a page the original was never measured at is said so, not skipped quietly', async () => {
  const root = await copyAt('dist-same', body());
  const r = await compareExact({
    root, workspace: work, baseline: await baselineOf(), scripts: false,
    pages: [page, { path: '/other', slug: 'other', outPath: 'other.html' }],
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /was not measured/);
});

test('the noise floor raises the bar a size has to clear', async () => {
  const root = await copyAt('dist-same', body());
  const base = await baselineOf();
  const strict = await compareExact({ root, workspace: work, baseline: base, pages: [page], scripts: false });
  const lenient = await compareExact({
    root, workspace: work, baseline: base, pages: [page], scripts: false, noise: { 1280: 2 },
  });
  assert.equal(strict.pages[0].slots.find((s) => s.id === '1280').limit, 0.5);
  assert.equal(lenient.pages[0].slots.find((s) => s.id === '1280').limit, 4, 'twice the noise');
});

test('summarise counts the sizes that matched and groups what is left by cause', () => {
  const s = summarise([{
    page: '/',
    slots: [
      { id: '1440', accepted: true, diffRaw: 0.1 },
      { id: '375', accepted: false, diffRaw: 3.2, heightOk: true, pixelsOk: false, boxes: { missing: 2, extra: 0, paired: 10, within: 8 }, frozen: { loopsOnlyOriginal: 1 } },
    ],
  }]);
  assert.equal(s.slots, 2);
  assert.equal(s.accepted, 1);
  assert.equal(s.pct, 50);
  assert.equal(s.diffWorst, 3.2);
  assert.equal(s.causes['missing-element'], 2);
  assert.equal(s.causes['box-out-of-place'], 2);
  assert.equal(s.causes.pixels, 1);
  assert.equal(s.causes['loop-missing'], 1);
  assert.equal(s.worst[0].slot, '375');
});
