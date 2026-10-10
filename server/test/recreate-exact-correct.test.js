// Exact mode, phase C: the correction loop steered by the exact comparison. The pure parts are checked on their
// own, because they are what decides whether a round is kept - and a loop that measures the wrong thing cannot be
// rescued by any corrector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctExact, exactRows, makeExactRound, slotScore, viewForWidth, GOOD_ENOUGH_PCT, PIXEL_FLOOR_PCT, ROUNDS_PER_PAGE,
} from '../src/recreate/verify/exact/correct.js';
import { createLedger } from '../src/recreate/verify/ledger.js';

test('a width is corrected in the view whose media query covers it', () => {
  // An exact slot is a width; a declaration has to live in the view that governs it or it will not apply there.
  assert.equal(viewForWidth(1920), 'desktop');
  assert.equal(viewForWidth(1440), 'desktop');
  assert.equal(viewForWidth(1439), 'laptop');
  assert.equal(viewForWidth(1025), 'laptop');
  assert.equal(viewForWidth(1024), 'laptop');
  assert.equal(viewForWidth(1023), 'tablet');
  assert.equal(viewForWidth(810), 'tablet');
  assert.equal(viewForWidth(768), 'tablet');
  assert.equal(viewForWidth(767), 'mobile');
  assert.equal(viewForWidth(320), 'mobile');
});

test('a slot that matches scores 100, and every way of being wrong lowers it', () => {
  const perfect = slotScore({ diffRaw: 0, boxes: { paired: 20, within: 20, missing: 0, extra: 0 }, heightOriginal: 2000, heightCopy: 2000 });
  assert.equal(perfect.score, 100);
  assert.equal(perfect.layout, 100);
  assert.equal(perfect.pixel, 100);
  assert.equal(perfect.heightOff, false);

  // Boxes out of place pull the layout half down.
  const moved = slotScore({ diffRaw: 0, boxes: { paired: 20, within: 10, missing: 0, extra: 0 }, heightOriginal: 2000, heightCopy: 2000 });
  assert.equal(moved.layout, 50);
  assert.ok(moved.score < perfect.score);

  // A missing element counts against the copy as much as a moved one, and an extra one too.
  assert.ok(slotScore({ diffRaw: 0, boxes: { paired: 10, within: 10, missing: 10, extra: 0 }, heightOriginal: 1, heightCopy: 1 }).layout === 50);
  assert.ok(slotScore({ diffRaw: 0, boxes: { paired: 10, within: 10, missing: 0, extra: 10 }, heightOriginal: 1, heightCopy: 1 }).layout === 50);

  // Pixels: the scale is explicit, so a number can be read rather than guessed at.
  assert.equal(slotScore({ diffRaw: PIXEL_FLOOR_PCT, boxes: null, heightOriginal: 1, heightCopy: 1 }).pixel, 0);
  assert.equal(slotScore({ diffRaw: PIXEL_FLOOR_PCT / 2, boxes: null, heightOriginal: 1, heightCopy: 1 }).pixel, 50);

  // A page far off in height is flagged, which is what makes the loop work on it first.
  assert.equal(slotScore({ diffRaw: 0, boxes: null, heightOriginal: 1000, heightCopy: 1400 }).heightOff, true);
  assert.equal(slotScore({ diffRaw: 0, boxes: null, heightOriginal: 1000, heightCopy: 1050 }).heightOff, false);
});

test('the box differences are handed to the ledger in the vocabulary it already speaks', () => {
  const rows = exactRows({
    worst: [
      // Same size, wrong place.
      { path: 'body>div:1', tag: 'div', expected: [0, 100, 200, 50], actual: [0, 140, 200, 50], delta: [0, 40, 0, 0], off: 40 },
      // Right place, wrong size.
      { path: 'body>p:1', tag: 'p', expected: [0, 0, 300, 20], actual: [0, 0, 260, 20], delta: [0, 0, -40, 0], off: 40 },
    ],
    missingItems: [{ path: 'body>span:9', tag: 'span', rect: [10, 10, 40, 40] }],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'offset');
  assert.equal(rows[0].moved, true);
  assert.equal(rows[0].cpath, 'body>div:1');
  assert.equal(rows[1].kind, 'size');
  assert.equal(rows[1].widthOk, false);
  assert.equal(rows[1].heightOk, true);
  assert.equal(rows[2].kind, 'missing');
  assert.equal(rows[2].actual, null);
  // The ledger takes them without complaint, which is the point of using its own shape.
  const ledger = createLedger();
  ledger.beginRound(0);
  ledger.observe({ page: '/', view: 'desktop', rows });
  assert.ok(ledger.summary());
});

test('a round reports one slot per page and view, the worst standing for the view', async () => {
  // Two slots, 1025 and 1440, which are two different views - and 1280, which shares "laptop" with 1025.
  const slots = [
    { id: '1440', width: 1440, height: 900, dpr: 1, mobile: false, hasTouch: false },
    { id: '1280', width: 1280, height: 800, dpr: 1, mobile: false, hasTouch: false },
    { id: '1025', width: 1025, height: 768, dpr: 1, mobile: false, hasTouch: false },
  ];
  // A renderer and a baseline that record what was asked of them instead of opening a browser.
  const asked = [];
  const renderer = {
    origin: 'http://127.0.0.1:0',
    server: { overrides: new Map() },
    context: async (slot) => {
      asked.push(slot.id);
      throw new Error('no browser in this test');
    },
  };
  const baseline = {
    slots,
    pages: [{ path: '/', slug: 'index', slots: slots.map((s) => ({ id: s.id, pageHeight: 1000, bands: [{ file: `${s.id}-full.webp`, top: 0, height: 900 }], boxes: { file: `${s.id}-boxes.json.gz` } })) }],
  };
  const treeOf = new Map([['/', { info: { path: '/', slug: 'index', outPath: 'index.html' } }]]);
  const ledger = createLedger();
  const round = makeExactRound({ renderer, baseline, treeOf, workspace: '/nowhere' });
  const r = await round({ site: { pages: [] }, ledger, css: 'body{}', round: 1, pages: ['/'] });
  // Every slot was attempted, in the order the baseline holds them.
  assert.deepEqual(asked, ['1440', '1280', '1025']);
  // None could be measured here, so nothing is claimed: an empty round, not a perfect one.
  assert.deepEqual(r.slots, []);
  assert.equal(r.score, 0);
  // The stylesheet override is always removed again, whatever happened.
  assert.equal(renderer.server.overrides.has('css/site.css'), false);
});

test('with nothing measurable the loop says so instead of reporting success', async () => {
  const out = await correctExact({
    renderer: { origin: 'http://127.0.0.1:0', server: { overrides: new Map() }, context: async () => { throw new Error('none'); } },
    baseline: { slots: [], pages: [] },
    site: { pages: [] },
    ir: { pages: [], breakpoints: {} },
    ledger: createLedger(),
    baseCss: '',
    workspace: '/nowhere',
  });
  assert.equal(out.stopped, 'nothing-to-measure');
  assert.equal(out.applied, 0);
  assert.equal(out.rounds, 0);
  assert.deepEqual(out.pages, []);
});

test('the budget is rounds, not a clock, and it is five per page', () => {
  assert.equal(ROUNDS_PER_PAGE, 5);
  // A page already matching everywhere is skipped rather than risked: the threshold is the acceptance number.
  assert.equal(GOOD_ENOUGH_PCT, 0.5);
});
