// Exact mode, phase C: the correction loop steered by the exact comparison. The pure parts are checked on their
// own, because they are what decides whether a round is kept - and a loop that measures the wrong thing cannot be
// rescued by any corrector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctExact, exactRows, pageBase, makeExactRound, slotScore, viewForWidth, GOOD_ENOUGH_PCT, PIXEL_FLOOR_PCT, ROUNDS_PER_PAGE,
} from '../src/recreate/verify/exact/correct.js';
import { createLedger } from '../src/recreate/verify/ledger.js';
import { correctLayout } from '../src/recreate/verify/correct.js';
import { applyFixesByPath, fixesByPath, restoreFixes, snapshotFixes } from '../src/recreate/verify/exact/correct.js';

test('a width is corrected in the view whose media query covers it', () => {
  // An exact slot is a width; a declaration has to live in the view that governs it or it will not apply there.
  // Without the copy's breakpoints the view widths are the guess, which is what this has always done. The four
  // views are named because the registry now also holds the one an exact run captures at 700.
  const four = ['desktop', 'laptop', 'tablet', 'mobile'];
  assert.equal(viewForWidth(1920, four), 'desktop');
  assert.equal(viewForWidth(1440, four), 'desktop');
  assert.equal(viewForWidth(1439, four), 'laptop');
  assert.equal(viewForWidth(1025, four), 'laptop');
  assert.equal(viewForWidth(1024, four), 'laptop');
  assert.equal(viewForWidth(1023, four), 'tablet');
  assert.equal(viewForWidth(810, four), 'tablet');
  assert.equal(viewForWidth(768, four), 'tablet');
  assert.equal(viewForWidth(767, four), 'mobile');
  assert.equal(viewForWidth(320, four), 'mobile');
});

test('given the copy\'s breakpoints, a width is mapped by the query that really covers it', () => {
  // The media queries stack widest first, so the narrowest one that still matches has the last word. Guessing from
  // the view widths is close but not exact, and the difference is a declaration that never applies.
  const four = ['desktop', 'laptop', 'tablet', 'mobile'];
  const bpFour = { laptop: 1279.98, tablet: 1023.98, mobile: 767.98 };
  // At exactly 1280 the laptop query (max-width 1279.98) does not match, so the base view governs. The view-width
  // guess said laptop, and a declaration written there would have done nothing at that width.
  assert.equal(viewForWidth(1280, four), 'laptop', 'what the guess says');
  assert.equal(viewForWidth(1280, four, bpFour), 'desktop', 'what the stylesheet does');
  // Everywhere else the two agree, which is why the guess has been good enough until now.
  for (const w of [1920, 1440, 1279, 1024, 1023, 768, 767, 430, 320]) {
    assert.equal(viewForWidth(w, four, bpFour), viewForWidth(w, four), `${w}px`);
  }

  // Five views: 640-767 belongs to the view captured at 700, and 639 and below to the phone - which is the whole
  // point of capturing that band. The view-width guess cannot express it: it would name the phone, whose query
  // ends at 639.98.
  const five = ['desktop', 'laptop', 'tablet', 'large-phone', 'mobile'];
  const bpFive = { laptop: 1279.98, tablet: 1023.98, 'large-phone': 767.98, mobile: 639.98 };
  for (const w of [767, 700, 699, 640]) assert.equal(viewForWidth(w, five, bpFive), 'large-phone', `${w}px`);
  for (const w of [639, 430, 375, 320]) assert.equal(viewForWidth(w, five, bpFive), 'mobile', `${w}px`);
  assert.equal(viewForWidth(768, five, bpFive), 'tablet');
  assert.equal(viewForWidth(640, five), 'mobile', 'and the guess alone would have written it where it cannot apply');
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

test('the page the loop starts on is the one with the worst width, except the homepage goes first', () => {
  // The order is by each page's single worst width, which is right - but it left the homepage tenth of eleven on a
  // real run, and an interrupted run would then never have corrected the page anybody looks at. The fast pass
  // forces the homepage in because it only does three pages; exact mode dropped that when it took on every page.
  const slots = [
    { page: '/about', slot: '640', width: 640, score: 3, view: 'mobile', layout: 3, pixel: 3 },
    { page: '/about', slot: '1440', width: 1440, score: 80, view: 'desktop', layout: 80, pixel: 80 },
    { page: '/', slot: '375', width: 375, score: 40, view: 'mobile', layout: 40, pixel: 40 },
    { page: '/deep', slot: '768', width: 768, score: 9, view: 'tablet', layout: 9, pixel: 9 },
  ];
  // pageBase is what each page's rounds are read against, and it must describe that page only.
  const about = pageBase({ slots, rects: new Map([['/about|mobile', 'x'], ['/|mobile', 'y']]) }, '/about');
  assert.deepEqual(about.slots.map((s) => s.slot), ['640', '1440'], 'its own widths, nobody else\'s');
  assert.equal(about.score, 41.5, 'and its own mean, not the whole run\'s');
  assert.equal(about.measured, 2);
  assert.equal(about.carried, 0);
  assert.deepEqual([...about.rects.keys()], ['/about|mobile'], 'and its own rects');
  // The worst width of the view stands for the view, which is what judge() reads to refuse a per-slot drop.
  assert.equal(about.by.get('/about|mobile').slot, '640');
  assert.equal(pageBase({ slots }, '/nothing-here'), null, 'a page with no measurement has no base');
});

test('the budget is three rounds, and the loop never measures one stylesheet twice', () => {
  // Three, not five: of 66 proposals in the last full run none survived, and all six that passed the round gate
  // were reverted. At eighteen widths a round, rounds four and five were twelve minutes a page for nothing.
  assert.equal(ROUNDS_PER_PAGE, 3);
  // And correctLayout no longer opens its own starting round when the caller hands one in. That round measured the
  // same page with the identical stylesheet - 198 renders a run, about forty minutes, and two chances to disagree.
  const base = { slots: [{ page: '/', slot: '1440', width: 1440, view: 'desktop', score: 50, layout: 50, pixel: 50 }], rects: new Map(), score: 50, layout: 50, pixel: 50, by: new Map() };
  let measured = 0;
  const round = async () => { measured += 1; return { ...base, slots: [...base.slots] }; };
  return correctLayout({
    ir: { pages: [], breakpoints: {} },
    site: { pages: [{ info: { path: '/', outPath: 'index.html' }, root: { tag: 'body', children: [] }, views: ['desktop'] }] },
    ledger: createLedger(),
    baseCss: '',
    candidates: [{ path: '/', outPath: 'index.html', score: 50, view: 'desktop' }],
    round,
    pages: 1,
    maxRounds: 0,
    minTime: 0,
    base,
  }).then((out) => {
    assert.equal(measured, 0, 'the given measurement was used as it stands');
    assert.equal(out.baseMeasured, false);
    assert.equal(out.scoreBefore, 50);
  });
});



test('a round measures every width of the page, because a view is not one width', async () => {
  // Judging a round on one width per view was affordable and unsound. A corrector writes its value for every view
  // an element appears in, and the phone view alone governs nine of these eighteen widths - 320 to 767. On a real
  // site that let six changes through which the full check then found cost 13 to 21 points at 639, 430 and 390:
  // all inside the view that had been judged on 375 alone.
  const widths = [1920, 1440, 1280, 1279, 1024, 1023, 810, 768, 767, 640, 639, 430, 414, 390, 375, 360, 320];
  const slots = widths.map((w) => ({ id: String(w), width: w, height: 800, dpr: 1, mobile: w < 768, hasTouch: w < 768 }));
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
    slots: slots.map((s) => ({ page: '/', view: viewForWidth(s.width, ['desktop', 'laptop', 'tablet', 'mobile']), slot: s.id, width: s.width, score: 50, layout: 50, pixel: 50, heightOff: false })),
    rects: new Map(),
  };

  // A trial for the laptop view alone is still judged on all eighteen: the loop corrects one page at a time, and
  // what a declaration reaches is not something to assume from the view it was written for.
  const r = await round({
    site: { pages: [] }, ledger: createLedger(), css: 'body{}', round: 1, pages: ['/'],
    trials: [{ byView: { laptop: { gap: '8px' } } }],
    base,
  });
  assert.equal(asked.length, widths.length, 'every width of the page');
  assert.equal(r.carried, 0, 'nothing is carried forward, so nothing is assumed');
  // None could be measured here, so the round is unjudgeable rather than perfect - the rule that stops silence
  // being read as success.
  assert.equal(r.failed, widths.length);
  assert.equal(r.score, 0);

  // And the phone view really does govern half the widths, which is why one of them could not stand for it.
  const mobile = widths.filter((w) => viewForWidth(w, ['desktop', 'laptop', 'tablet', 'mobile']) === 'mobile');
  assert.deepEqual(mobile, [767, 640, 639, 430, 414, 390, 375, 360, 320]);
  assert.ok(mobile.length > widths.length / 2);
});

test('the opening measurement covers every slot, which is the before every later round is read against', async () => {
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
