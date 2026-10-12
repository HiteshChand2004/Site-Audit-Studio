// Exact mode, phase A3: the index of what a page paints, and pairing the original's boxes with the copy's without
// inventing differences. The collector runs in a real browser; the pairing is checked on its output.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { boxLookups, collectExactBoxes, compareBoxes, pairBoxes, MAX_PAIR_NODES } from '../src/recreate/verify/exact/boxes.js';
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

test('identity pairs boxes that identical text cannot, which is what the report pass was missing', () => {
  // On a real page the comparison after the build paired 79 of 577 boxes and called the other 498 missing and extra
  // at the same time, because the shipped HTML carries no identity and pairing fell back to the text an element
  // contains. Three cards reading the same thing is all it takes.
  const card = (n, y, extra = {}) => ({ kind: 'text', key: 'read more', tag: 'a', path: `body>ul:1>li:${n}>a:1`, parent: 'read more', rect: [0, y, 100, 20], n, ...extra });
  const original = [card(1, 100), card(2, 200), card(3, 300)];
  // The copy has them all, in place, but one extra wrapper shifted the middle one down by two pixels.
  const copy = [
    { ...card(1, 100), sid: 11 },
    { ...card(2, 202), sid: 12 },
    { ...card(3, 300), sid: 13 },
  ];
  const cpathOf = (sid) => ({ 11: 'body>ul:1>li:1>a:1', 12: 'body>ul:1>li:2>a:1', 13: 'body>ul:1>li:3>a:1' }[sid] ?? null);

  const withIds = compareBoxes(original, copy, { cpathOf });
  assert.equal(withIds.byPath, 3, 'every box paired by the element it came from');
  assert.equal(withIds.paired, 3);
  assert.equal(withIds.missing, 0);
  assert.equal(withIds.extra, 0);
  assert.equal(withIds.within, 2, 'and the one that really moved is the one reported');

  // Without identity the same comparison has only the text to go on.
  const withoutIds = compareBoxes(original, copy.map(({ sid, ...b }) => b), { cpathOf: null });
  assert.equal(withoutIds.byPath, 0, 'nothing could be paired by identity');
  assert.ok(
    withoutIds.missing + withoutIds.extra >= withIds.missing + withIds.extra,
    `identity pairs at least as well: ${JSON.stringify({ withIds, withoutIds })}`,
  );
});

test('a length the text decides gets a budget; a length the copy wrote does not', () => {
  // The defect this grading exists for: the comparison graded every box to a pixel, while every corrector refuses
  // to touch a box with text of its own. The only boxes being graded were the ones nobody was allowed to fix, so
  // 0 of 198 widths could ever be accepted, however good the copy was.
  const original = [
    { kind: 'text', key: 'heading', n: 1, tag: 'h1', path: 'body>h1:1', parent: '', rect: [0, 0, 300, 40] },
    { kind: 'image', key: 'hero', n: 1, tag: 'img', path: 'body>img:1', parent: '', rect: [0, 60, 300, 200] },
  ];
  const copy = [
    { kind: 'text', key: 'heading', n: 1, tag: 'h1', path: 'body>h1:1', parent: '', rect: [0, 0, 301.6, 40], sid: 1 },
    { kind: 'image', key: 'hero', n: 1, tag: 'img', path: 'body>img:1', parent: '', rect: [0, 60, 301.6, 200], sid: 2 },
  ];
  const cpathOf = (sid) => ({ 1: 'body>h1:1', 2: 'body>img:1' }[sid] ?? null);
  const r = compareBoxes(original, copy, { cpathOf });

  // Both are reported as outside a pixel: the strict number is not softened.
  assert.equal(r.within, 0);
  assert.equal(r.paired, 2);
  // But only the image is charged. The heading is as wide as its own text, which no declaration can change.
  assert.equal(r.hard, 1, JSON.stringify(r.worst));
  assert.equal(r.textBeyond, 0);
  assert.equal(r.worst.find((w) => w.tag === 'img').grade, 'replaced');
  assert.equal(r.worst.find((w) => w.tag === 'h1').grade, 'text');
  assert.equal(r.beyondCorrectors, 1, 'and the report says how many boxes the loop was not allowed to try');

  // The same heading once the copy writes its width: now it is the copy's own number and held to the pixel.
  const written = compareBoxes(original, copy, { cpathOf, sizedOf: (sid) => (sid === 1 ? 'wh' : null) });
  assert.equal(written.hard, 2);
  assert.equal(written.beyondCorrectors, 0);
});

test('a text length further out than type can explain is still a defect, under its own name', () => {
  const a = [{ kind: 'text', key: 'x', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [0, 0, 100, 20] }];
  const b = [{ kind: 'text', key: 'x', n: 1, tag: 'p', path: 'body>p:1', parent: '', rect: [0, 0, 118, 20], sid: 1 }];
  const r = compareBoxes(a, b, { cpathOf: () => 'body>p:1' });
  assert.equal(r.hard, 0, 'not the copy writing a wrong number');
  assert.equal(r.textBeyond, 1, 'but eighteen pixels is not a font metric either');
  assert.equal(r.dist.more, 1);
});

test('the pixel the copy asked for on purpose is expected, not counted as a defect', () => {
  // ir/styles.js writes a text width a pixel wide, because a width cut to the pixel wraps the same label onto a
  // second line. Until the node recorded that, the box measured about a pixel from the original and was reported as
  // wrong on every run, at every width, by construction - a defect the engine had created in its own report.
  const a = [{ kind: 'text', key: 'label', n: 1, tag: 'span', path: 'body>span:1', parent: '', rect: [0, 0, 80.4, 20] }];
  const b = [{ kind: 'text', key: 'label', n: 1, tag: 'span', path: 'body>span:1', parent: '', rect: [0, 0, 82, 20], sid: 7 }];
  const cpathOf = () => 'body>span:1';
  const sizedOf = () => 'wh';

  const blind = compareBoxes(a, b, { cpathOf, sizedOf });
  assert.equal(blind.hard, 1, 'without the record it looks like a 1.6 px error');

  const knowing = compareBoxes(a, b, { cpathOf, sizedOf, slackOf: () => ({ w: [0, 1.6] }) });
  assert.equal(knowing.hard, 0);
  assert.equal(knowing.within, 1, 'and the box counts as right, because it is exactly where it was asked to be');
  assert.equal(knowing.slackUsed, 1, 'reported, so the allowance can never be silent');

  // The allowance is a direction, not a free pixel: the other way round is still an error.
  const wrongWay = compareBoxes(
    [{ ...a[0], rect: [0, 0, 82, 20] }],
    [{ ...b[0], rect: [0, 0, 80.4, 20] }],
    { cpathOf, sizedOf, slackOf: () => ({ w: [0, 1.6] }) },
  );
  assert.equal(wrongWay.hard, 1);
});

test('the lookups read what generate saved, and what older runs saved', () => {
  const now = boxLookups({ version: 2, cpaths: { 3: 'body>p:1' }, sized: { 3: { mobile: 'wh' } }, slack: { 3: { mobile: { w: [-1, 0] } } } });
  assert.equal(now.cpathOf(3), 'body>p:1');
  assert.equal(now.sizedOf(3, 'mobile'), 'wh');
  assert.equal(now.sizedOf(3, 'desktop'), null, 'per view: a width written for the phone says nothing about the desktop');
  assert.deepEqual(now.slackOf(3, 'mobile'), { w: [-1, 0] });
  assert.equal(now.graded, 1);

  // A workspace written before any of this still pairs boxes by path; it simply has nothing to grade them by.
  const old = boxLookups({ 3: 'body>p:1' });
  assert.equal(old.cpathOf(3), 'body>p:1');
  assert.equal(old.sizedOf(3, 'mobile'), null);
  assert.equal(old.slackOf(3, 'mobile'), null);
  assert.equal(old.graded, 0);
  assert.equal(old.pairs, 1);
});
