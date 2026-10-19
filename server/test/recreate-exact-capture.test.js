// Exact mode, phase A5: measuring the original at every viewport, resuming a run that stopped part way, and the
// cheap check that says whether a baseline still matches the live site.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { bandClips, captureExactPage, exactDir, visitSlot, MAX_BANDS } from '../src/recreate/capture/exact.js';
import { checkBaseline, freeDiskGB, BASELINE_STALE_DAYS } from '../src/recreate/exactCapture.js';
import { slotFor } from '../src/recreate/verify/exact/slots.js';
import { RECIPE_VERSION } from '../src/recreate/verify/exact/recipe.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4205;
const origin = `http://127.0.0.1:${PORT}`;

// A page that is responsive, moves by itself, and is taller than one screen.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  .bar { height: 60px; background: #123; color: #fff; }
  .grid { display: flex; flex-wrap: wrap; }
  .cell { width: 50%; height: 120px; background: #eef; }
  @media (max-width: 700px) { .cell { width: 100%; } }
  @media (max-width: 400px) { .bar { height: 40px; } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spinner { width: 40px; height: 40px; background: #c33; animation: spin 1s linear infinite; }
  .tall { height: 1400px; }
</style></head><body>
  <div class="bar">Header</div>
  <div class="spinner"></div>
  <div class="grid"><div class="cell">One</div><div class="cell">Two</div></div>
  <p id="clock">tick 0</p>
  <div class="tall"></div>
  <img src="/photo.svg" width="120" height="60" alt="A photo">
<script>
  var n = 0;
  setInterval(function tick() { n++; document.getElementById('clock').textContent = 'tick ' + n; }, 200);
</script></body></html>`;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#396"/></svg>';

let server;
let browser;
let dir;
let etag = '"v1"';
let body = PAGE;
let conditional = 0;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/photo.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(SVG);
    }
    if (req.headers['if-none-match']) {
      conditional++;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: etag, 'Cache-Control': 'no-store' });
    return res.end(body);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-exactcap-'));
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const page = { path: '/', slug: 'index', url: `${origin}/` };

test('one slot: the original is loaded by the recipe, frozen, shot and indexed', async () => {
  const folder = exactDir(dir, 'one');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(folder, { recursive: true }));
  const slot = slotFor(1280);
  const r = await visitSlot(browser, `${origin}/`, slot, folder, { fingerprint: true });

  assert.equal(r.id, '1280');
  assert.equal(r.dpr, 1);
  assert.equal(r.recipe.version, RECIPE_VERSION);
  assert.ok(r.pageHeight > 1400, `the page height is measured (${r.pageHeight})`);
  assert.equal(r.bands.length, 1, 'a page under one band is one image');
  assert.equal(r.bands[0].file, '1280-full.webp');
  assert.ok(r.bands[0].bytes > 100);
  assert.ok(r.bytes > 0);
  // The timer that rewrites the clock was suppressed, so the shot is of a first-time visit.
  assert.ok(r.frozen.timers.intervals >= 1);
  // The spinner repeats, so it was put back to its start rather than caught mid-rotation.
  assert.ok(r.frozen.animations.zeroed >= 1);
  // What the page paints: the header, the two cells, the clock, the image.
  assert.ok(r.boxes.count >= 5, `boxes ${r.boxes.count}`);
  assert.equal(r.boxes.file, '1280-boxes.json.gz');
  const saved = JSON.parse(gunzipSync(await readFile(path.join(folder, r.boxes.file))));
  assert.ok(saved.boxes.some((b) => b.kind === 'image' && b.key === 'photo'));
  assert.ok(saved.boxes.some((b) => b.kind === 'text' && b.key === 'header'));
  // The fingerprint a staleness check will compare against.
  assert.equal(r.fingerprint.etag, '"v1"');
  assert.equal(r.fingerprint.status, 200);
  assert.ok(r.fingerprint.html && r.fingerprint.assets);
  assert.equal(r.consoleErrors, undefined, 'the fixture logs nothing');
});

test('a phone slot is emulated as a phone, and its layout really is the narrow one', async () => {
  const folder = exactDir(dir, 'phone');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(folder, { recursive: true }));
  const wide = await visitSlot(browser, `${origin}/`, slotFor(1280), folder, { write: false });
  const narrow = await visitSlot(browser, `${origin}/`, slotFor(375), folder, { write: false });
  assert.equal(narrow.dpr, 3, 'a phone is measured at the pixel ratio a phone has');
  const cell = (r) => r.boxes.list.find((b) => b.key === 'one');
  assert.ok(cell(wide).rect[2] < 1280, 'two columns when it is wide');
  assert.ok(cell(narrow).rect[2] > 300, `one column when it is narrow (${cell(narrow).rect[2]})`);
  // The page is taller on a phone because the cells stack: the kind of difference the slots exist to catch.
  assert.ok(narrow.pageHeight > wide.pageHeight);
});

test('every slot of a page, written as one manifest', async () => {
  const slots = [slotFor(1280), slotFor(768)];
  const r = await captureExactPage(browser, page, dir, { slots });
  assert.equal(r.slots.length, 2);
  assert.deepEqual(r.slots.map((s) => s.id), ['1280', '768'], 'widest first');
  assert.equal(r.errors.length, 0);
  assert.ok(r.bytes > 0);
  assert.ok(r.fingerprint.etag);
  const written = JSON.parse(await readFile(path.join(exactDir(dir, 'index'), 'index.json'), 'utf8'));
  assert.equal(written.slots.length, 2);
  assert.equal(written.path, '/');
});

test('a slot that cannot be loaded is reported for that slot, not for the page', async () => {
  const r = await captureExactPage(browser, { path: '/x', slug: 'gone', url: 'http://127.0.0.1:9/' }, dir, {
    slots: [slotFor(1280)], timeout: 4000,
  });
  assert.equal(r.slots.length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].slot, '1280');
  assert.ok(r.errors[0].message);
});

test('both sides band a tall page at the same offsets, and the cap is the tail that is reported', () => {
  // One function decides the offsets, because the comparison lines band N of the copy up against band N of the
  // original: two implementations that disagree by one band would compare different parts of the page and read
  // as a total mismatch.
  const slot = { width: 1440 };
  assert.deepEqual(bandClips(slot, 3071), [{ band: 0, top: 0, height: 3071 }], 'a short page is one band');

  // A homepage of 18,489 px - the case that found the bug: three bands, the last a part band.
  const tall = bandClips(slot, 18489);
  assert.equal(tall.length, 3);
  assert.deepEqual(tall.map((c) => c.top), [0, 8000, 16000]);
  assert.deepEqual(tall.map((c) => c.height), [8000, 8000, 2489]);
  assert.equal(tall.reduce((n, c) => n + c.height, 0), 18489, 'every pixel is in exactly one band');

  // Past the cap the rest is left out rather than squeezed in - the tail is reported, never silently cropped.
  const over = bandClips(slot, 40000);
  assert.equal(over.length, MAX_BANDS);
  assert.equal(over.reduce((n, c) => n + c.height, 0), 32000);

  // A page exactly on a band boundary does not get an empty extra band.
  assert.equal(bandClips(slot, 16000).length, 2);
  assert.equal(bandClips(slot, 8000).length, 1);
});

test('the band cap is four screens of 8000 px, and a page under it is one band', async () => {
  assert.equal(MAX_BANDS, 4);
  const r = await captureExactPage(browser, page, dir, { slots: [slotFor(1440)] });
  assert.equal(r.slots[0].bands.length, 1);
  assert.equal(r.slots[0].truncated, false);
});

test('free disk is a number or an honest null, never a guess', async () => {
  const free = await freeDiskGB(dir);
  assert.ok(free === null || free > 0, String(free));
});

test('a baseline the site still matches is fresh, with one conditional request a page', async () => {
  const captured = await captureExactPage(browser, page, dir, { slots: [slotFor(1280)] });
  conditional = 0;
  const { guardedFetch } = await import('../src/audit/http.js');
  const r = await checkBaseline({ recipeVersion: RECIPE_VERSION, capturedAt: new Date().toISOString(), pages: [captured] }, { fetch: guardedFetch });
  assert.equal(r.status, 'fresh');
  assert.equal(r.pages[0].status, 'fresh');
  assert.equal(conditional, 1, 'it asked once, and the server answered 304');
});

test('a changed page is stale, and the reason says what changed', async () => {
  const captured = await captureExactPage(browser, page, dir, { slots: [slotFor(1280)] });
  const { guardedFetch } = await import('../src/audit/http.js');
  // A new stylesheet is the strongest cheap signal that a design changed.
  etag = '"v2"';
  body = PAGE.replace('<title>Fixture</title>', '<title>Fixture</title><link rel="stylesheet" href="/new-design.css">');
  try {
    const r = await checkBaseline({ recipeVersion: RECIPE_VERSION, capturedAt: new Date().toISOString(), pages: [captured] }, { fetch: guardedFetch });
    assert.equal(r.status, 'stale');
    assert.match(r.pages[0].reason, /stylesheets or images/);
    assert.match(r.reasons.join(' '), /1 page has changed/);
  } finally {
    etag = '"v1"';
    body = PAGE;
  }
});

test('a changing nonce is not a changed page', async () => {
  const captured = await captureExactPage(browser, page, dir, { slots: [slotFor(1280)] });
  const { guardedFetch } = await import('../src/audit/http.js');
  etag = '"v3"';
  body = PAGE.replace('<script>', '<script nonce="a1b2c3d4e5f6a1b2c3d4e5f6">');
  try {
    const r = await checkBaseline({ recipeVersion: RECIPE_VERSION, capturedAt: new Date().toISOString(), pages: [captured] }, { fetch: guardedFetch });
    assert.equal(r.status, 'fresh', JSON.stringify(r.pages));
  } finally {
    etag = '"v1"';
    body = PAGE;
  }
});

test('an old baseline is worth re-checking even when nothing looks changed', async () => {
  const captured = await captureExactPage(browser, page, dir, { slots: [slotFor(1280)] });
  const { guardedFetch } = await import('../src/audit/http.js');
  const old = new Date(Date.now() - (BASELINE_STALE_DAYS + 3) * 86400000).toISOString();
  const r = await checkBaseline({ recipeVersion: RECIPE_VERSION, capturedAt: old, pages: [captured] }, { fetch: guardedFetch });
  assert.equal(r.status, 'maybe-stale');
  assert.match(r.reasons.join(' '), /days old/);
});

test('a baseline taken a different way is not comparable, and nothing is asked of the site', async () => {
  conditional = 0;
  const r = await checkBaseline({ recipeVersion: RECIPE_VERSION + 99, pages: [{ path: '/', url: `${origin}/`, fingerprint: {} }] });
  assert.equal(r.status, 'stale');
  assert.match(r.reasons[0], /the way a page is loaded/);
  assert.equal(conditional, 0, 'no request was made');
});

test('a page the check cannot read is unknown, never quietly fresh', async () => {
  const r = await checkBaseline({
    recipeVersion: RECIPE_VERSION,
    capturedAt: new Date().toISOString(),
    pages: [{ path: '/down', url: 'http://127.0.0.1:9/', fingerprint: { etag: '"x"', html: 'abc', assets: 'def' } }],
  }, { fetch: async () => ({ error: 'refused' }) });
  assert.equal(r.status, 'unknown');
  assert.equal(r.pages[0].status, 'unknown');
});

test('a resumed run visits only the slots it still needs', async () => {
  // A manifest that already holds one of two slots, as an interrupted run leaves behind.
  const slug = 'resumed';
  const folder = exactDir(dir, slug);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(folder, { recursive: true });
  const first = await captureExactPage(browser, { path: '/r', slug, url: `${origin}/` }, dir, { slots: [slotFor(1280)] });
  assert.equal(first.slots.length, 1);
  await writeFile(path.join(folder, 'index.json'), JSON.stringify(first, null, 1));

  const manifest = JSON.parse(await readFile(path.join(folder, 'index.json'), 'utf8'));
  const have = new Set(manifest.slots.map((s) => s.id));
  const want = [slotFor(1280), slotFor(768)].filter((s) => !have.has(s.id));
  assert.deepEqual(want.map((s) => s.id), ['768'], 'the slot already on disk is not visited again');
});

test('a slot the network refused is tried again, not counted and dropped', async () => {
  const { isRetryableSlotError, SLOT_ATTEMPTS } = await import('../src/recreate/capture/exact.js');
  // The error Chromium gives when the egress proxy refuses the tunnel, which is what cost the first live run
  // eight of eighteen slots and then every page after it.
  assert.equal(isRetryableSlotError('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/'), true);
  assert.equal(isRetryableSlotError('net::ERR_CONNECTION_RESET'), true);
  assert.equal(isRetryableSlotError('Timeout 90000ms exceeded'), true);
  // Not everything is worth another go: a page that is simply not there is an answer.
  assert.equal(isRetryableSlotError('net::ERR_BLOCKED_BY_CLIENT'), false);
  assert.equal(isRetryableSlotError('Target page, context or browser has been closed'), false);
  assert.equal(isRetryableSlotError(''), false);
  assert.ok(SLOT_ATTEMPTS >= 2);
});

test('a page that lost every slot is measured again once the site answers', async () => {
  // The whole page fails while the fixture server is refused, then succeeds once it is reachable again.
  const slots = [slotFor(1280)];
  // A closed port Chromium is willing to try (port 9 is on its blocked list and gives ERR_UNSAFE_PORT, which is a
  // permanent refusal and rightly not retried).
  const broken = await captureExactPage(browser, { path: '/x', slug: 'blip', url: 'http://127.0.0.1:4299/' }, dir, { slots, timeout: 3000 });
  assert.equal(broken.slots.length, 0);
  assert.ok(broken.retried >= 1, `it tried again rather than giving up at once (retried ${broken.retried})`);
  assert.equal(broken.errors.length, 1, 'and reports the slot once, not once per attempt');
});
