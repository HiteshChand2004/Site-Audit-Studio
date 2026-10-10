// Exact mode, phase A3: the index of what a page paints, and pairing the original's boxes with the copy's without
// inventing differences. The collector runs in a real browser; the pairing is checked on its output.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { collectExactBoxes, compareBoxes, pairBoxes, MAX_PAIR_NODES } from '../src/recreate/verify/exact/boxes.js';
import { slotFor } from '../src/recreate/verify/exact/slots.js';

const PORT = 4204;
const slot = slotFor(1280);

// The original. Repeated identical text, an image, an inline SVG, a hidden element, a link, and text inside a
// wrapper that the copy below removes.
const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>
  body { margin: 0; font: 16px/1.5 system-ui; width: 1280px; }
  .card { height: 100px; }
  .gone { display: none; }
  img, svg { display: block; }
</style></head><body>
  <div class="card"><h2>Read more</h2></div>
  <div class="card"><h2>Read more</h2></div>
  <div class="card"><h2>Read more</h2></div>
  <a href="/gone.html" id="dead">Broken link text</a>
  <p class="gone">Never shown</p>
  <img src="/photo.jpg" width="200" height="100" alt="">
  <svg viewBox="0 0 10 10" width="24" height="24"><path d="M0 0 L10 10"/></svg>
  <div class="wrap"><span>Wrapped words</span></div>
</body></html>`;

// The copy, as the recreate would emit it: the dead link is a span, the empty wrapper is gone, the image is a
// re-encoded and renamed file, and one element carries a measurement id.
const COPY = `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>
  body { margin: 0; font: 16px/1.5 system-ui; width: 1280px; }
  .card { height: 100px; }
  .gone { display: none; }
  img, svg { display: block; }
</style></head><body>
  <div class="card"><h2>Read more</h2></div>
  <div class="card"><h2>Read more</h2></div>
  <div class="card"><h2>Read more</h2></div>
  <span id="dead" data-sas-id="7">Broken link text</span>
  <p class="gone">Never shown</p>
  <img src="/assets/images/photo-800w-0123456789.webp" width="200" height="100" alt="">
  <svg viewBox="0 0 10 10" width="24" height="24"><path d="M0 0 L10 10"/></svg>
  <span>Wrapped words</span>
</body></html>`;

// The copy again, with one card missing and one section pushed 40 px down: the shape a real defect has.
const BROKEN = COPY.replace('<div class="card"><h2>Read more</h2></div>\n  <div class="card"><h2>Read more</h2></div>\n  <div class="card"><h2>Read more</h2></div>',
  '<div class="card"><h2>Read more</h2></div>\n  <div class="card" style="height:140px"><h2>Read more</h2></div>');

const pages = { '/original': ORIGINAL, '/copy': COPY, '/broken': BROKEN };
let server;
let browser;

before(async () => {
  server = createServer((req, res) => {
    const body = pages[req.url] ?? '<!doctype html><title>x</title><body>nothing</body>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  server.close();
});

async function indexOf(path) {
  const context = await browser.newContext({ viewport: { width: slot.width, height: slot.height }, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'load' });
    await page.waitForTimeout(150);
    return await page.evaluate(collectExactBoxes, {});
  } finally {
    await context.close().catch(() => {});
  }
}

// Indexed once each, when the first test that needs it asks (the browser only exists after the hook above).
const indexes = new Map();
const ix = async (path) => {
  if (!indexes.has(path)) indexes.set(path, await indexOf(path));
  return indexes.get(path);
};

test('only what is painted is indexed, each with the place it is painted at', async () => {
  const original = await ix('/original');
  const kinds = original.boxes.reduce((acc, b) => ({ ...acc, [b.kind]: (acc[b.kind] ?? 0) + 1 }), {});
  assert.equal(kinds.image, 1);
  assert.equal(kinds.svg, 1);
  // Three headings, the link, and the wrapped words: text comes from an element's own text, so the cards that
  // merely contain a heading are not boxes of their own.
  assert.equal(kinds.text, 5, JSON.stringify(original.boxes.map((b) => `${b.kind}:${b.key}`)));
  assert.equal(original.truncated, false);
  // An element that is not rendered has no box, and is counted rather than dropped.
  assert.equal(original.counts.hidden, 1);
  assert.ok(!original.boxes.some((b) => b.key === 'never shown'));
  for (const b of original.boxes) {
    assert.equal(b.rect.length, 4);
    assert.ok(b.rect[2] > 0 && b.rect[3] > 0);
    // A tag name may hold a digit (h2) or a hyphen (a custom element).
    assert.match(b.path, /^body(>[a-z][a-z0-9-]*:\d+)*$/);
  }
});

test('repeated identical text is told apart by where it comes, in document order', async () => {
  const original = await ix('/original');
  const more = original.boxes.filter((b) => b.key === 'read more');
  assert.equal(more.length, 3);
  assert.deepEqual(more.map((b) => b.n), [1, 2, 3]);
  for (let i = 1; i < more.length; i++) assert.ok(more[i].rect[1] > more[i - 1].rect[1], 'numbered down the page');
});

test('an image is keyed by its file, not its address: a renamed, re-sized, re-encoded copy still matches', async () => {
  const [original, copy] = [await ix('/original'), await ix('/copy')];
  const a = original.boxes.find((b) => b.kind === 'image');
  const b = copy.boxes.find((x) => x.kind === 'image');
  assert.equal(a.key, 'photo');
  assert.equal(b.key, 'photo', 'the -800w size and the -0123456789 hash and the .webp are all stripped');
  assert.equal(a.ar, b.ar);
});

test('an SVG is keyed by its shape, so the same drawing matches', async () => {
  const [original, copy] = [await ix('/original'), await ix('/copy')];
  const a = original.boxes.find((b) => b.kind === 'svg');
  const b = copy.boxes.find((x) => x.kind === 'svg');
  assert.equal(a.key, b.key);
  assert.match(a.key, /^0 0 10 10\|path1\|/);
});

test('a faithful copy produces no differences, although its tags and files differ', async () => {
  const [original, copy] = [await ix('/original'), await ix('/copy')];
  const r = compareBoxes(original.boxes, copy.boxes);
  assert.equal(r.missing, 0, JSON.stringify(r.missingItems));
  assert.equal(r.extra, 0, JSON.stringify(r.extraItems));
  assert.equal(r.paired, original.boxes.length);
  assert.equal(r.within, r.paired, JSON.stringify(r.worst));
  assert.equal(r.fallback, false);
  // The dead link became a span and the empty wrapper was dropped: keyed on what is painted, both still pair.
  assert.ok(original.boxes.some((b) => b.tag === 'a' && b.key === 'broken link text'));
  assert.ok(copy.boxes.some((b) => b.tag === 'span' && b.key === 'broken link text'));
});

test('the measurement id pairs a box by path, which beats guessing by content', async () => {
  const [original, copy] = [await ix('/original'), await ix('/copy')];
  // data-sas-id 7 is the copy's version of the original's link.
  const link = original.boxes.find((b) => b.key === 'broken link text');
  const r = pairBoxes(original.boxes, copy.boxes, { cpathOf: (sid) => (sid === 7 ? link.path : null) });
  assert.equal(r.byPath, 1);
  assert.equal(r.missing.length, 0);
  assert.equal(r.extra.length, 0);
  const paired = r.pairs.find(([a]) => a.key === 'broken link text');
  assert.equal(paired[1].sid, 7);
});

test('a missing element is one missing element, not a cascade of shifted ones', async () => {
  const [original, broken] = [await ix('/original'), await ix('/broken')];
  const r = compareBoxes(original.boxes, broken.boxes);
  // One card is gone from the copy.
  assert.equal(r.missing, 1, JSON.stringify(r.missingItems));
  assert.equal(r.missingItems[0].key, 'read more');
  assert.equal(r.extra, 0);
  // The surviving cards still pair - and the one the taller card pushed down is reported as moved, with the
  // distance it moved by, rather than everything below it being called missing.
  const moved = r.worst.filter((w) => Math.abs(w.delta[1]) > 1);
  assert.ok(moved.length >= 1, JSON.stringify(r.worst));
  assert.ok(r.paired >= original.boxes.length - 1);
});

test('a box within a pixel is not a difference; a pixel past that is', () => {
  const a = [{ kind: 'text', key: 'x', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [10, 10, 100, 20] }];
  const near = [{ kind: 'text', key: 'x', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [10.9, 10, 100, 20] }];
  const far = [{ kind: 'text', key: 'x', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [12, 10, 100, 20] }];
  assert.equal(compareBoxes(a, near).within, 1);
  const off = compareBoxes(a, far);
  assert.equal(off.within, 0);
  assert.equal(off.worst[0].off, 2);
  assert.deepEqual(off.worst[0].delta, [2, 0, 0, 0]);
});

test('too many boxes to align properly says so instead of guessing quietly', () => {
  const make = (n, shift = 0) => Array.from({ length: n }, (_, i) => ({
    kind: 'text', key: `row ${i}`, n: 1, tag: 'p', path: `body>p:${i + 1}`, parent: '', rect: [0, i * 10 + shift, 100, 9],
  }));
  const r = compareBoxes(make(MAX_PAIR_NODES + 10), make(MAX_PAIR_NODES + 10));
  assert.equal(r.fallback, true);
  assert.equal(r.paired, MAX_PAIR_NODES + 10);
  assert.equal(r.missing, 0);
});

test('an element the copy adds is reported as extra, and named', () => {
  const a = [{ kind: 'text', key: 'kept', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [0, 0, 10, 10] }];
  const b = [
    { kind: 'text', key: 'kept', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [0, 0, 10, 10] },
    { kind: 'text', key: 'cookie notice', n: 1, tag: 'div', path: 'body>div:1', parent: '', rect: [0, 40, 100, 20] },
  ];
  const r = compareBoxes(a, b);
  assert.equal(r.extra, 1);
  assert.equal(r.extraItems[0].key, 'cookie notice');
  assert.equal(r.missing, 0);
});
