// Exact mode, phase C: the correction loop steered by the exact comparison. The pure parts are checked on their
// own, because they are what decides whether a round is kept - and a loop that measures the wrong thing cannot be
// rescued by any corrector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctExact, exactRows, judgingSlots, makeExactRound, slotScore, viewForWidth, GOOD_ENOUGH_PCT, PIXEL_FLOOR_PCT, ROUNDS_PER_PAGE,
} from '../src/recreate/verify/exact/correct.js';
import { createLedger } from '../src/recreate/verify/ledger.js';
import { applyFixesByPath, fixesByPath, restoreFixes, snapshotFixes } from '../src/recreate/verify/exact/correct.js';

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

test('a round opens one width per view, the narrower where a view has two', async () => {
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
  // 1280 and 1025 are both the laptop view, so only the narrower of the two was opened.
  assert.deepEqual(asked, ['1440', '1025']);
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

test('a round is judged on one width per view, and carries the other widths forward', async () => {
  // Measuring all eighteen slots a round cost eleven minutes on flexibench, and most of those renders only
  // confirmed that nothing else had moved. A corrector writes its value for every view the element exists in,
  // so one width per view - the view's own capture width - already shows a change that helps one layout and
  // hurts another; what a width inside a view does differently is caught by the verification pass below.
  const widths = [1920, 1440, 1280, 1279, 1024, 1023, 810, 768, 430, 375];
  const slots = widths.map((w) => ({ id: String(w), width: w, height: 800, dpr: 1, mobile: w < 768, hasTouch: w < 768 }));
  assert.deepEqual([...judgingSlots(slots)].sort(), ['1024', '1440', '375', '768'], 'one per view');
  const asked = [];
  const renderer = {
    origin: 'http://127.0.0.1:0',
    server: { overrides: new Map() },
    context: async (slot) => { asked.push(slot.id); throw new Error('no browser in this test'); },
  };
  const baseline = {
    slots,
    pages: [{ path: '/', slug: 'index', slots: slots.map((s) => ({ id: s.id, pageHeight: 1000, bands: [{ file: 'b.webp', top: 0, height: 800 }], boxes: { file: 'b.json.gz' } })) }],
  };
  const treeOf = new Map([['/', { info: { path: '/', slug: 'index', outPath: 'index.html' } }]]);
  const round = makeExactRound({ renderer, baseline, treeOf, workspace: '/nowhere' });
  const base = {
    slots: slots.map((s) => ({ page: '/', view: viewForWidth(s.width), slot: s.id, width: s.width, score: 50, layout: 50, pixel: 50, heightOff: false })),
    rects: new Map(),
  };

  const r = await round({
    site: { pages: [] }, ledger: createLedger(), css: 'body{}', round: 1, pages: ['/'],
    trials: [{ byView: { laptop: { gap: '8px' } } }],
    base,
  });
  // Only the four judged widths were opened; the other six kept the numbers they had.
  assert.deepEqual(asked.sort(), ['1024', '1440', '375', '768']);
  assert.equal(r.carried, 6);
  // In this test there is no browser, so those four could not be measured - and a round with a slot it could
  // not measure is unjudgeable: its score is nothing, which is what makes the loop refuse it rather than read
  // the carried slots as 'no worse'.
  assert.equal(r.failed, 4);
  assert.equal(r.score, 0);
  assert.equal(r.slots.length, 6, 'the six it could carry');
  assert.ok(r.slots.every((s) => s.carried && s.score === 50));

  // The verification pass asks for everything, whatever is being tried.
  asked.length = 0;
  await round({
    site: { pages: [] }, ledger: createLedger(), css: 'body{}', round: 'verify:/', pages: ['/'],
    trials: [{ byView: { laptop: { gap: '8px' } } }], base, all: true,
  });
  assert.equal(asked.length, 10, 'every slot of the page');

  // And a first round, with nothing to carry, is judged on the same four: a round that measured everything the
  // first time and four slots afterwards could not compare the two.
  asked.length = 0;
  const firstRound = await round({ site: { pages: [] }, ledger: createLedger(), css: 'body{}', round: 0, pages: ['/'] });
  assert.deepEqual(asked.sort(), ['1024', '1440', '375', '768']);
  assert.equal(firstRound.carried, 0, 'nothing to carry, and nothing invented either');
  assert.deepEqual(firstRound.slots, []);
});

test('the opening measurement covers every slot, not only the four a round is judged on', async () => {
  // It is the before of the whole run, and the per-page verification compares against it. Judge on four and
  // measure the before on four, and a width inside a view has no number to be compared with - so harm there
  // could not be detected at all. This is the guarantee the cheap rounds are affordable because of.
  const widths = [1920, 1440, 1280, 1024, 768, 430, 375, 320];
  const slots = widths.map((w) => ({ id: String(w), width: w, height: 800, dpr: 1, mobile: w < 768, hasTouch: w < 768 }));
  const asked = [];
  await correctExact({
    renderer: {
      origin: 'http://127.0.0.1:0',
      server: { overrides: new Map() },
      context: async (slot) => { asked.push(slot.id); throw new Error('no browser in this test'); },
    },
    baseline: {
      slots,
      pages: [{ path: '/', slug: 'index', slots: slots.map((s) => ({ id: s.id, pageHeight: 1000, bands: [{ file: 'b.webp', top: 0, height: 800 }], boxes: { file: 'b.json.gz' } })) }],
    },
    site: { pages: [{ info: { path: '/', slug: 'index', outPath: 'index.html' }, root: { tag: 'body', children: [] }, views: ['desktop'] }] },
    ir: { pages: [], breakpoints: {} },
    ledger: createLedger(),
    baseCss: '',
    workspace: '/nowhere',
  });
  assert.deepEqual(asked.sort(), [...widths].map(String).sort(), 'every slot of the page');
});

test('the loop\'s fixes survive an interruption: keyed by place, checked against the element', () => {
  // Half an hour of measuring used to live only in memory until the whole generate step finished, so an
  // interruption a minute before the end threw all of it away. The key is the element's place in the tree, which a
  // tree built again from the same capture reproduces exactly.
  const tree = () => ({
    info: { path: '/' },
    root: {
      tag: 'body',
      children: [
        { tag: 'header', cpath: 'body>header:1', children: [{ tag: 'h1', cpath: 'body>header:1>h1:1', children: [] }] },
        { tag: 'main', cpath: 'body>main:1', children: [{ tag: 'p', cpath: 'body>main:1>p:1', children: [] }] },
      ],
    },
  });

  const a = tree();
  a.root.children[0].children[0].fix = { desktop: { decls: { width: '320px' } } };
  a.root.children[1].fix = { mobile: { decls: { 'min-height': '48px' } } };
  const saved = fixesByPath(a);
  assert.deepEqual(Object.keys(saved).sort(), ['0.0', '1']);
  assert.equal(saved['1'].cpath, 'body>main:1', 'the original\'s own path travels with it as a check');
  // It has to survive JSON, since that is what the checkpoint is.
  const throughJson = JSON.parse(JSON.stringify(saved));

  const b = tree();
  const r = applyFixesByPath(b, throughJson);
  assert.equal(r.applied, 2);
  assert.deepEqual(r.mismatched, []);
  assert.deepEqual(b.root.children[0].children[0].fix, { desktop: { decls: { width: '320px' } } });
  assert.deepEqual(b.root.children[1].fix, { mobile: { decls: { 'min-height': '48px' } } });
  // A copy, not the saved object: a later round must not write back into the checkpoint's data.
  b.root.children[1].fix.mobile.decls['min-height'] = '0px';
  assert.equal(throughJson['1'].fix.mobile.decls['min-height'], '48px');
});

test('a loop that accepted nothing saves and restores as cleanly as one that did', () => {
  // The expensive thing is that the loop ran, not that it changed something: on a real site it measured for
  // twenty-seven minutes and accepted nothing, and a resume must not pay that again to reach the same answer.
  const tree = { info: { path: '/' }, root: { tag: 'body', children: [{ tag: 'main', cpath: 'body>main:1', children: [] }] } };
  const saved = fixesByPath(tree);
  assert.deepEqual(saved, {}, 'no fixes, so nothing is keyed');
  const r = applyFixesByPath(tree, JSON.parse(JSON.stringify(saved)));
  assert.equal(r.applied, 0);
  assert.deepEqual(r.mismatched, [], 'and nothing is a mismatch either, so the caller can accept it');
});

test('fixes that do not fit the tree are refused rather than half-applied', () => {
  // A tree that is not the same tree would take some of the fixes and not others, which is worse than taking none:
  // the page would be corrected in parts that were never measured together.
  const other = {
    info: { path: '/' },
    root: {
      tag: 'body',
      children: [
        { tag: 'header', cpath: 'body>header:1', children: [{ tag: 'h2', cpath: 'body>header:1>h2:1', children: [] }] },
        { tag: 'main', cpath: 'body>section:9', children: [] },
      ],
    },
  };
  const saved = {
    '0.0': { fix: { desktop: { decls: { width: '320px' } } }, cpath: 'body>header:1>h1:1', tag: 'h1' },
    1: { fix: { mobile: { decls: { 'min-height': '48px' } } }, cpath: 'body>main:1', tag: 'main' },
    '7.7': { fix: { desktop: { decls: { gap: '8px' } } }, cpath: 'body>aside:1', tag: 'aside' },
  };
  const r = applyFixesByPath(other, saved);
  assert.equal(r.mismatched.length, 3, 'a different tag, a different original path, and a place that is not there');
  assert.deepEqual(r.mismatched.sort(), ['0.0', '1', '7.7']);
  assert.equal(r.applied, 0);
});

test('a loop that changed nothing reports the score it started with, not a better one', async () => {
  // Measured on a real site: scoreBefore was every slot of every page (29.9) while each page's own scoreAfter came
  // from its four judging slots (38.6), so averaging the two read as +8.7 points the loop had not earned. An
  // unchanged page has to contribute the score it started with.
  const widths = [1440, 1024, 768, 375];
  const slots = widths.map((w) => ({ id: String(w), width: w, height: 800, dpr: 1, mobile: w < 768, hasTouch: w < 768 }));
  const scores = { 1440: 60, 1024: 20, 768: 20, 375: 20 };   // mean 30; the judging slot alone would read 60
  const page = { path: '/', slug: 'index', outPath: 'index.html' };
  const baseline = {
    slots,
    pages: [{ ...page, slots: slots.map((s) => ({ id: s.id, pageHeight: 1000, bands: [{ file: 'b.webp', top: 0, height: 800 }], boxes: { file: 'b.json.gz' } })) }],
  };
  // A round that reports the scores above and never applies anything, standing in for the real measurement.
  const round = async ({ pages, all }) => {
    const used = all ? slots : slots.filter((s) => s.width === 1440);
    const out = used.map((s) => ({ page: '/', view: viewForWidth(s.width), slot: s.id, width: s.width, score: scores[s.id], layout: scores[s.id], pixel: scores[s.id], heightOff: false }));
    return { slots: out, rects: new Map(), measured: out.length, carried: 0, score: out.reduce((n, s) => n + s.score, 0) / out.length };
  };
  const out = await correctExact({
    renderer: { origin: 'http://127.0.0.1:0', server: { overrides: new Map() }, close: async () => {} },
    baseline,
    site: { pages: [{ info: page, root: { tag: 'body', children: [] }, views: ['desktop'] }] },
    ir: { pages: [], breakpoints: {} },
    ledger: createLedger(),
    baseCss: '',
    workspace: '/nowhere',
    round,
  });
  assert.equal(out.applied, 0, 'nothing was applied');
  assert.equal(out.scoreBefore, 30, 'every slot of the page');
  assert.equal(out.scoreAfter, 30, 'and the same number afterwards, not the judging slot\'s 60');
});

test('a page that does not hold up is put back exactly as it was', () => {
  // The revert has to be exact, or a refused page keeps half a correction.
  const leaf = { tag: 'p', children: [], fix: { desktop: { decls: { gap: '4px' } } } };
  const bare = { tag: 'span', children: [] };
  const tree = { root: { tag: 'body', children: [leaf, bare] } };
  const saved = snapshotFixes(tree);

  // The loop writes new declarations on both.
  leaf.fix.desktop.decls.gap = '12px';
  leaf.fix.tablet = { decls: { 'flex-wrap': 'wrap' } };
  bare.fix = { mobile: { decls: { width: '100%' } } };

  restoreFixes(tree, saved);
  assert.deepEqual(leaf.fix, { desktop: { decls: { gap: '4px' } } }, 'the fix it had is the fix it has');
  assert.equal(bare.fix, undefined, 'and a node that had none has none');
});
