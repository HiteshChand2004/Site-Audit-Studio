// The correction loop: the per-element box pairs compareLayout hands out, which elements a mismatch region blames
// (verify/locate.js), the ledger that keeps all of it across rounds (verify/ledger.js), and the loop itself
// (verify/correct.js) - what it proposes, what it keeps, and what it puts back.
// Mostly pure functions on small trees; the last few drive a real browser through measureSite, with no fixture server.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureSite } from '../src/recreate/generate.js';
import { compareLayout, openRenderer, viewScore } from '../src/recreate/verify/layout.js';
import { nodesInBox } from '../src/recreate/verify/locate.js';
import { createLedger } from '../src/recreate/verify/ledger.js';
import {
  aspect, correctLayout, correctReport, drift, gridTracks, judge, missingElement, paintCause, restoreDropped, spacing, trialCss,
  wrapping, wrongHeight, MIN_ACCEPT_MARGIN,
} from '../src/recreate/verify/correct.js';
import { marginForNoise } from '../src/recreate/verify/exact/correct.js';
import { buildStyles } from '../src/recreate/ir/styles.js';

const V = 'desktop';
/** An element node shaped like the IR's: `rect` is what the capture saw, `sid` what the measurement build emits. */
const el = (tag, rect, children = [], extra = {}) => ({ tag, children, views: { [V]: { rect, style: {} } }, ...extra });
const text = (s) => ({ text: s });

/**
 *   body
 *     section
 *       row              -> renders right
 *         fine           -> renders right
 *         narrow         -> renders 60 px wide instead of 100 (a size mismatch)
 *         gone           -> does not render at all
 *       shifted          -> right size, half its width to the right (an offset mismatch)
 */
function tree() {
  const fine = el('a', [0, 0, 100, 50], [text('ok')], { sid: 4, cpath: 'body>section:1>div:1>a:1' });
  const narrow = el('a', [100, 0, 100, 50], [text('narrow')], { sid: 5, cpath: 'body>section:1>div:1>a:2' });
  const gone = el('a', [200, 0, 100, 50], [text('gone')], { sid: 6, cpath: 'body>section:1>div:1>a:3' });
  const row = el('div', [0, 0, 400, 50], [fine, narrow, gone], { sid: 3, cpath: 'body>section:1>div:1' });
  const shifted = el('p', [0, 100, 400, 40], [text('shifted')], { sid: 7, cpath: 'body>section:1>p:1' });
  const section = el('section', [0, 0, 400, 200], [row, shifted], { sid: 2, cpath: 'body>section:1' });
  const body = el('body', [0, 0, 400, 400], [section], { sid: 1, cpath: 'body' });
  const rects = {
    1: [0, 0, 400, 400], 2: [0, 0, 400, 200], 3: [0, 0, 400, 50],
    4: [0, 0, 100, 50], 5: [100, 0, 60, 50], 7: [200, 100, 400, 40],
  };
  return { body, rects, nodes: { fine, narrow, gone, row, shifted, section } };
}

test('compareLayout hands out the per-element pairs without changing a single count', () => {
  const { body, rects } = tree();
  const plain = compareLayout(body, V, rects);
  const withPairs = compareLayout(body, V, rects, { pairs: true });
  assert.equal(plain.pairs, undefined, 'the existing callers get what they always got');
  const { pairs, ...counts } = withPairs;
  assert.deepEqual(counts, { elements: plain.elements, sizes: plain.sizes, boxes: plain.boxes, missing: plain.missing });
  assert.equal(counts.elements, 7, 'body, section, row, and the four leaves');
  assert.equal(counts.missing, 1);

  // Only the elements that fail a check are listed: one that fits is absent, so its offset delta is 0 by definition.
  assert.deepEqual(pairs.map((p) => [p.sid, p.kind]), [[5, 'size'], [6, 'missing'], [7, 'offset']]);
  const narrow = pairs.find((p) => p.sid === 5);
  assert.equal(narrow.cpath, 'body>section:1>div:1>a:2');
  assert.equal(narrow.widthOk, false);
  assert.equal(narrow.heightOk, true);
  assert.deepEqual(narrow.expected, [100, 0, 100, 50]);
  assert.deepEqual(narrow.actual, [100, 0, 60, 50]);
  const gone = pairs.find((p) => p.sid === 6);
  assert.equal(gone.actual, null, 'an element that never rendered has no box');
  assert.equal(gone.iou, 0);
  const shifted = pairs.find((p) => p.sid === 7);
  assert.equal(shifted.widthOk, true, 'the right size in the wrong place is an offset, not a size');
  assert.ok(shifted.iou > 0 && shifted.iou < 0.6, String(shifted.iou));
});

test('compareLayout skips a state copy and anything hidden in the view', () => {
  const hidden = el('div', [0, 0, 10, 10], [], { sid: 9, cpath: 'h' });
  hidden.views[V].hidden = true;
  const copy = el('div', [0, 0, 10, 10], [], { sid: 10, cpath: 'c', stateAttrs: { hidden: '' } });
  const body = el('body', [0, 0, 400, 400], [hidden, copy], { sid: 1, cpath: 'body' });
  const out = compareLayout(body, V, { 1: [0, 0, 400, 400] }, { pairs: true });
  assert.equal(out.elements, 1, 'only the body counts');
  assert.deepEqual(out.pairs, []);
});

test('a mismatch box blames the element that explains it, not its ancestors', () => {
  const { body, rects } = tree();
  // A box over the whole row.
  const out = nodesInBox(body, V, rects, { x: 0, y: 0, w: 400, h: 60 });
  // The row, the section and the body all overlap the box, but they render correctly, so they are not candidates.
  assert.deepEqual(out.map((c) => c.sid).sort(), [5, 6]);
  for (const c of out) assert.equal(c.leafness, 1);
  const gone = out.find((c) => c.sid === 6);
  assert.equal(gone.misfit, 1, 'an element that did not render is as wrong as it gets');
  assert.equal(gone.actual, null);
  assert.equal(gone.cpath, 'body>section:1>div:1>a:3');
});

test('an element in another branch is not counted as a descendant', () => {
  // The bug this guards: leafness counted by depth alone would treat `shifted` (deeper than the row's own children
  // are not, but in a different branch) as a descendant of a candidate, because the elements in between render
  // correctly and are never candidates themselves.
  const { body, rects } = tree();
  const out = nodesInBox(body, V, rects, { x: 0, y: 0, w: 400, h: 200 });
  const byId = new Map(out.map((c) => [c.sid, c]));
  assert.ok(byId.has(5) && byId.has(6) && byId.has(7));
  for (const sid of [5, 6, 7]) assert.equal(byId.get(sid).leafness, 1, `sid ${sid} has no misfitting descendants`);
});

test('a parent is blamed less once a child already explains the difference', () => {
  // Parent and child are both wrong: the child is the one to fix, so the parent's blame is halved by leafness.
  const kid = el('span', [0, 0, 100, 20], [text('x')], { sid: 3, cpath: 'p>span' });
  const parent = el('div', [0, 0, 200, 40], [kid], { sid: 2, cpath: 'p' });
  const body = el('body', [0, 0, 200, 200], [parent], { sid: 1, cpath: 'body' });
  const rects = { 1: [0, 0, 200, 200], 2: [0, 0, 80, 40], 3: [0, 0, 20, 20] };
  const out = nodesInBox(body, V, rects, { x: 0, y: 0, w: 200, h: 50 });
  const p = out.find((c) => c.sid === 2);
  const k = out.find((c) => c.sid === 3);
  assert.equal(p.leafness, 0.5, 'one misfitting descendant');
  assert.equal(k.leafness, 1);
  assert.ok(k.blame > 0 && p.blame > 0);
});

test('an empty or far-away box blames nobody', () => {
  const { body, rects } = tree();
  assert.deepEqual(nodesInBox(body, V, rects, { x: 0, y: 0, w: 0, h: 10 }), []);
  assert.deepEqual(nodesInBox(body, V, rects, { x: 2000, y: 2000, w: 50, h: 50 }), []);
});

test('the ledger keys entries by cpath and counts the ones it cannot key', () => {
  const { body, rects } = tree();
  const ledger = createLedger();
  ledger.beginRound(0);
  const { pairs } = compareLayout(body, V, rects, { pairs: true });
  ledger.observe({ page: '/', view: V, rows: [...pairs, { sid: 99, cpath: null, kind: 'size', tag: 'div' }] });
  assert.equal(ledger.entries.size, 3);
  assert.equal(ledger.skipped.noKey, 1, 'an element the desktop capture never saw cannot be followed between rounds');
  const e = ledger.entries.get(`/|${V}|body>section:1>div:1>a:3`);
  assert.equal(e.kind, 'missing');
  assert.equal(e.frozen, false);
  assert.equal(e.lastSeen, 0);
});

test('the ledger separates what is still wrong from what went away', () => {
  const { body, rects } = tree();
  const ledger = createLedger();
  ledger.beginRound(0);
  ledger.observe({ page: '/', view: V, rows: compareLayout(body, V, rects, { pairs: true }).pairs });
  assert.equal(ledger.summary().open, 3);

  // Round 1: the narrow element now renders at its captured width, so it is simply not reported again.
  ledger.beginRound(1);
  const fixed = { ...rects, 5: [100, 0, 100, 50] };
  ledger.observe({ page: '/', view: V, rows: compareLayout(body, V, fixed, { pairs: true }).pairs });
  const s = ledger.summary();
  assert.equal(s.open, 2);
  assert.equal(s.cleared, 1);
  assert.equal(s.rounds, 1);
  assert.deepEqual(s.byKind, { missing: 1, offset: 1 });
  assert.equal(s.elements, 3, 'the element that came good is remembered, not forgotten');
});

test('a cause names the kind of difference, never one element, so the histogram stays one row per kind', () => {
  // Found on a real run: the drift corrector used to put the culprit's path in the cause, which made report.json
  // carry one cause row per element instead of one per kind.
  const culprit = cap('div', { desktop: [[0, 0, 100, 200], {}] }, [], { sid: 2, cpath: 'body>div:2' });
  const node = cap('p', { desktop: [[0, 300, 100, 40], {}] }, [text('after it')], { sid: 3, cpath: 'body>p:1' });
  const group = groupOf(node, { desktop: { kind: 'offset', expected: [0, 300, 100, 40], actual: [0, 150, 100, 40] } });
  const out = drift(group, {
    ...ctxOf({ rendered: { '2|desktop': [0, 0, 100, 50], '3|desktop': [0, 150, 100, 40] } }),
    heightCulprit: () => culprit,
  });
  assert.equal(out.cause, 'drift', 'the kind, not body>div:2');
  assert.equal(out.target, culprit, 'the culprit is identified by the target, which is where it belongs');

  // And the summary caps the histogram even if some future cause were per-element.
  const ledger = createLedger();
  ledger.beginRound(0);
  const rows = Array.from({ length: 40 }, (_, i) => ({ sid: i, cpath: `body>div:${i}`, kind: 'size', tag: 'div', expected: [0, 0, 10, 10], actual: [0, 0, 4, 10], widthOk: false, heightOk: true, iou: 0.4 }));
  ledger.observe({ page: '/', view: V, rows });
  [...ledger.entries.values()].forEach((e, i) => { e.cause = `kind-${i}`; });
  const s = ledger.summary();
  assert.equal(Object.keys(s.byCause).length, 20);
  assert.equal(s.causeKinds, 40, 'how many there really were is still reported');
});

test('the ledger summary is bounded and JSON-safe', () => {
  const ledger = createLedger();
  ledger.beginRound(0);
  const rows = Array.from({ length: 500 }, (_, i) => ({ sid: i, cpath: `body>div:${i}`, kind: 'size', tag: 'div', expected: [0, i, 10, 10], actual: [0, i, 4, 10], widthOk: false, heightOk: true, iou: 0.4 }));
  ledger.observe({ page: '/', view: V, rows });
  const s = ledger.summary();
  assert.equal(s.elements, 500);
  assert.equal(s.worst.length, 10, 'a report is not a place for 500 elements');
  // No Set, no live node reference: this goes into report.json.
  assert.doesNotThrow(() => JSON.stringify(s));
  assert.equal(JSON.parse(JSON.stringify(s)).worst.length, 10);
  assert.ok(s.worst.every((w) => w.open === true));
});

test('a region that differs only at the detail scale never reaches the ledger', () => {
  const { body, rects } = tree();
  const ledger = createLedger();
  ledger.beginRound(0);
  const candidates = nodesInBox(body, V, rects, { x: 0, y: 0, w: 400, h: 200 });
  assert.ok(candidates.length > 0);
  ledger.observePixels({ page: '/', view: V, region: { fx: 0, fy: 0, fw: 1, fh: 0.5, score: 0.2, coarse: false }, candidates });
  assert.equal(ledger.entries.size, 0, 'text anti-aliasing is not something to correct');

  ledger.observePixels({ page: '/', view: V, region: { fx: 0, fy: 0, fw: 1, fh: 0.5, score: 0.2, coarse: true }, candidates });
  assert.ok(ledger.entries.size > 0);
  const e = [...ledger.entries.values()][0];
  assert.equal(e.region.coarse, true);
  assert.ok(e.blame > 0);
});

test('resolve re-attaches the nodes after a rebuild and drops the ones that are gone', () => {
  const { body, rects, nodes } = tree();
  const ledger = createLedger();
  ledger.beginRound(0);
  ledger.observe({ page: '/', view: V, rows: compareLayout(body, V, rects, { pairs: true }).pairs });
  assert.equal(ledger.entries.size, 3);

  // A rebuild: numberNodes hands out new sids, and one element was removed from the tree by a fixer.
  nodes.row.children = nodes.row.children.filter((c) => c !== nodes.gone);
  nodes.narrow.sid = 500;
  nodes.shifted.sid = 700;
  ledger.resolve({ pages: [{ root: body, info: { path: '/' } }] });
  assert.equal(ledger.entries.size, 2, 'the element that no longer exists is dropped, not carried as a ghost');
  const e = ledger.entries.get(`/|${V}|body>section:1>div:1>a:2`);
  assert.equal(e.sid, 500, 'the new sid, so the next trial rule targets the right element');
  assert.equal(e.node, nodes.narrow);
});

test('resolve follows an element through a cpathAlt', () => {
  const kid = el('span', [0, 0, 10, 10], [], { sid: 2, cpath: 'body>div:1>span:1' });
  const body = el('body', [0, 0, 100, 100], [kid], { sid: 1, cpath: 'body' });
  const ledger = createLedger();
  ledger.beginRound(0);
  ledger.observe({ page: '/', view: V, rows: [{ sid: 2, cpath: 'body>wrapper:1>span:1', kind: 'size', tag: 'span', expected: [0, 0, 10, 10], actual: [0, 0, 4, 10], widthOk: false, heightOk: true, iou: 0.4 }] });
  // A plain wrapper was removed, so the node carries its old path as well.
  kid.cpathAlt = ['body>wrapper:1>span:1'];
  ledger.resolve({ pages: [{ root: body, info: { path: '/' } }] });
  assert.equal(ledger.entries.size, 1);
  assert.equal([...ledger.entries.values()][0].node, kid);
});

test('nothing is ever tried twice, and a rolled-back element is frozen', () => {
  const ledger = createLedger();
  ledger.beginRound(0);
  ledger.observe({ page: '/', view: V, rows: [{ sid: 1, cpath: 'body>div:1', kind: 'size', tag: 'div', expected: [0, 0, 10, 10], actual: [0, 0, 4, 10], widthOk: false, heightOk: true, iou: 0.4 }] });
  const e = [...ledger.entries.values()][0];
  assert.equal(ledger.wasTried(e, 'flex-collapse', 'width'), false);
  ledger.markTried(e, 'flex-collapse', 'width');
  assert.equal(ledger.wasTried(e, 'flex-collapse', 'width'), true);
  assert.equal(ledger.wasTried(e, 'flex-collapse', 'min-width'), false, 'a different property is a different attempt');
  assert.equal(ledger.wasTried(e, 'grid-tracks', 'width'), false, 'so is a different corrector');
  ledger.freeze([e]);
  assert.equal(e.frozen, true);
  assert.equal(ledger.summary().worst[0].frozen, true);
});

// --- What a correction does to the stylesheet ---------------------------------------------------------------------

test('a trial rule is written per view, desktop at base level and the narrower views in their own media query', () => {
  const ir = { breakpoints: { laptop: 1199.98, tablet: 809.98, mobile: 479.98 } };
  const css = trialCss([{ target: { sid: 7 }, byView: { desktop: { width: '1200px' }, mobile: { width: '360px' } } }], ir);
  assert.match(css, /\[data-sas-id="7"\] \{\n {2}width: 1200px;\n\}/);
  assert.match(css, /@media \(max-width: 479\.98px\) \{\n\[data-sas-id="7"\] \{\n {2}width: 360px;\n\}\n\}/);
  // The site's own breakpoints, and the desktop rule before the media query, exactly as emitCss orders its sections.
  assert.ok(css.indexOf('width: 1200px') < css.indexOf('@media'), 'base before the media queries');
  assert.equal(css.includes('1023.98'), false, 'the breakpoints of this site, not the defaults');

  // Widest first, so each narrower view builds on the wider one.
  const all = trialCss([{ target: { sid: 1 }, byView: { laptop: { width: '1px' }, tablet: { width: '2px' } } }], ir);
  assert.ok(all.indexOf('1199.98') < all.indexOf('809.98'));
  // An element the measurement build gave no id cannot be targeted, so it is left out rather than written wrongly.
  assert.equal(trialCss([{ target: { sid: null }, byView: { desktop: { width: '1px' } } }], ir).includes('data-sas-id'), false);
  assert.equal(trialCss([], ir), '');
});

test('a round is kept only if nothing got worse', () => {
  const slot = (k, score) => ({ k, score });
  const state = (score, layout, pixel, slots) => ({ score, layout, pixel, by: new Map(slots.map((s) => [s.k, s])) });
  const base = state(80, 80, 80, [slot('a|desktop', 90), slot('a|mobile', 70)]);

  assert.deepEqual(judge(base, state(85, 84, 86, [slot('a|desktop', 95), slot('a|mobile', 75)])), { ok: true });
  // Not enough to call an improvement.
  assert.equal(judge(base, state(80.2, 80, 80, [slot('a|desktop', 90), slot('a|mobile', 70)])).ok, false);
  // The whole selection improved, but one page and view paid for it. This is the guard the fit pass does not have,
  // and the reason 147 width fixes on a real site could add up to no gain at all.
  const sacrifice = judge(base, state(85, 85, 85, [slot('a|desktop', 99), slot('a|mobile', 60)]));
  assert.equal(sacrifice.ok, false);
  assert.match(sacrifice.why, /a\|mobile fell 10/);
  // Pixels bought with broken boxes, and boxes bought with broken pixels: both refused.
  assert.equal(judge(state(80, 70, 90, [slot('a|desktop', 80)]), state(82, 80, 85, [slot('a|desktop', 82)])).ok, false);
  assert.equal(judge(state(80, 90, 70, [slot('a|desktop', 80)]), state(82, 85, 80, [slot('a|desktop', 82)])).ok, false);
});

test('a corrected element gets its own rule and the elements that shared its style keep theirs', () => {
  // The dedup trap: ir.rules is keyed by the style signature, so one rule is shared by every element with the same
  // style. A correction must not reach the others - it changes the signature, so the namer mints a new class.
  const styled = () => ({ desktop: { rect: [0, 0, 100, 50], style: { 'background-color': 'rgb(10, 20, 30)', 'padding-top': '8px' } } });
  const a = { tag: 'div', children: [text('A')], views: styled() };
  const b = { tag: 'div', children: [text('B')], views: styled() };
  const body = { tag: 'body', children: [a, b], views: { desktop: { rect: [0, 0, 400, 400], style: {} } } };
  const page = { root: body, views: ['desktop'] };

  const first = buildStyles([page], { assetFile: () => null });
  assert.equal(a.class, b.class, 'the same style is one rule');
  assert.equal(first.rules.length, 1);
  const shared = JSON.parse(JSON.stringify(first.rules[0].parts));

  a.fix = { desktop: { decls: { width: '123px' } } };
  const second = buildStyles([page], { assetFile: () => null });
  assert.notEqual(a.class, b.class, 'the corrected element is on its own now');
  assert.equal(second.rules.length, 2);
  const ruleOf = (cls) => second.rules.find((r) => r.selector === `.${cls}`);
  assert.equal(ruleOf(a.class).parts.base.width, '123px');
  // The element that merely shared the style is untouched: same declarations, the correction nowhere in sight.
  assert.deepEqual(ruleOf(b.class).parts, shared);
  assert.equal(ruleOf(b.class).parts.base.width, undefined);
});

test('a correction replaces the width the fit pass inferred instead of fighting it', () => {
  // resolveHints turns the fit pass's @fw hint into a width or a max-width. A measured correction must win, so the
  // hint is dropped when the correction sets a size of its own.
  const node = { tag: 'div', children: [], views: { desktop: { rect: [0, 0, 100, 50], style: { 'background-color': 'rgb(1, 2, 3)' } } } };
  const body = { tag: 'body', children: [node], views: { desktop: { rect: [0, 0, 400, 400], style: {} } } };
  const page = { root: body, views: ['desktop'] };

  node.fix = { desktop: { w: { px: 100, ratio: 0.25, flex: false } } };
  const inferred = buildStyles([page], { assetFile: () => null });
  const base = inferred.rules.find((r) => r.selector === `.${node.class}`).parts.base;
  assert.ok(base.width || base['max-width'], 'the fit pass had its say');

  node.fix = { desktop: { w: { px: 100, ratio: 0.25, flex: false }, decls: { width: '77px' } } };
  const corrected = buildStyles([page], { assetFile: () => null });
  assert.equal(corrected.rules.find((r) => r.selector === `.${node.class}`).parts.base.width, '77px');
});

// --- The correctors, one at a time --------------------------------------------------------------------------------
// Each is handed what the loop hands it: the capture, the parents, the boxes of the current render, and what the
// generated stylesheet actually says. Every value a corrector writes has to come from the capture.

/** A node with a captured box and style per view. */
const cap = (tag, perView, children = [], extra = {}) => ({
  tag, children, class: extra.class ?? null, sid: extra.sid ?? null, cpath: extra.cpath ?? `x${extra.sid ?? 0}`,
  views: Object.fromEntries(Object.entries(perView).map(([v, [rect, style]]) => [v, { rect, style: style ?? {} }])),
  ...extra,
});
const groupOf = (node, perView) => ({ cpath: node.cpath, node, perView: new Map(Object.entries(perView)), entries: Object.values(perView) });

/** @param {object} o emitted: what the stylesheet says; rendered: the boxes of the current render, by sid */
const ctxOf = ({ views = ['desktop'], parents = new Map(), emitted = {}, rendered = {} }) => ({
  views,
  parents,
  renderedRect: (node, view) => rendered[`${node.sid}|${view}`] ?? null,
  emitted: (node, view, prop) => emitted[`${node.sid}|${view}|${prop}`] ?? null,
  missingAncestor: () => false,
  heightCulprit: () => null,
  contentTooTall: (node, view) => (node.children ?? []).some((c) => {
    const want = c.views?.[view]?.rect?.[3];
    const got = rendered[`${c.sid}|${view}`]?.[3];
    return want && got != null && got > want + Math.max(3, want * 0.05);
  }),
});

test('a captured layout property the stylesheet never carried over is written back', () => {
  const row = cap('div', { desktop: [[0, 0, 400, 50], { 'justify-content': 'space-between', 'align-items': 'center' }] }, [], { sid: 1 });
  const group = groupOf(row, { desktop: { kind: 'size' } });

  // Nothing of it reached the stylesheet: both properties are restored.
  const out = restoreDropped(group, ctxOf({ rendered: { '1|desktop': [0, 0, 400, 50] } }));
  assert.equal(out.id, 'restore-layout');
  assert.equal(out.target, row);
  assert.deepEqual(out.byView.desktop, { 'justify-content': 'space-between', 'align-items': 'center' });

  // What the stylesheet already says is left alone - a correction is for what was lost, not for what is there.
  const partly = restoreDropped(group, ctxOf({ emitted: { '1|desktop|justify-content': 'space-between' } }));
  assert.deepEqual(partly.byView.desktop, { 'align-items': 'center' });
  const nothing = restoreDropped(group, ctxOf({ emitted: { '1|desktop|justify-content': 'space-between', '1|desktop|align-items': 'center' } }));
  assert.equal(nothing, null);
});

test('an image the asset step never downloaded is reported, never invented', () => {
  const box = cap('div', { desktop: [[0, 0, 100, 100], { 'background-image': 'url("asset:hero-abc.webp")' }] }, [], { sid: 1 });
  // As a layout difference the url is skipped outright.
  assert.equal(restoreDropped(groupOf(box, { desktop: { kind: 'size' } }), ctxOf({})), null);
  // As a pixel difference it is named.
  assert.deepEqual(paintCause(groupOf(box, { desktop: { kind: 'pixel' } }), ctxOf({})), { cause: 'asset-missing' });
});

test('a difference that is only pixels is named, and one that is not is left to the other correctors', () => {
  const words = cap('p', { desktop: [[0, 0, 100, 20], {}] }, [text('Hello')], { sid: 1 });
  assert.deepEqual(paintCause(groupOf(words, { desktop: { kind: 'pixel' } }), ctxOf({})), { cause: 'font-render' });
  const image = cap('img', { desktop: [[0, 0, 100, 20], {}] }, [], { sid: 2 });
  assert.deepEqual(paintCause(groupOf(image, { desktop: { kind: 'pixel' } }), ctxOf({})), { cause: 'image-content' });
  const plain = cap('div', { desktop: [[0, 0, 100, 20], {}] }, [], { sid: 3 });
  assert.deepEqual(paintCause(groupOf(plain, { desktop: { kind: 'pixel' } }), ctxOf({})), { cause: 'paint-unexplained' });
  // A box in the wrong place has a cause of its own: this corrector must not claim it.
  assert.equal(paintCause(groupOf(plain, { desktop: { kind: 'size' } }), ctxOf({})), null);
});

test('children the right size but the wrong distance apart get the gap the capture measured', () => {
  const kid = (i, sid) => cap('div', { desktop: [[i * 120, 0, 100, 50], {}] }, [], { sid });
  const a = kid(0, 2);
  const b = kid(1, 3);
  const c = kid(2, 4);
  const row = cap('div', { desktop: [[0, 0, 400, 50], { display: 'flex' }] }, [a, b, c], { sid: 1 });
  const parents = new Map([[a, row], [b, row], [c, row]]);
  // Rendered with no gap at all: 0, 100, 200.
  const rendered = { '1|desktop': [0, 0, 400, 50], '2|desktop': [0, 0, 100, 50], '3|desktop': [100, 0, 100, 50], '4|desktop': [200, 0, 100, 50] };
  const out = spacing(groupOf(b, { desktop: { kind: 'offset' } }), ctxOf({ parents, rendered }));
  assert.equal(out.target, row, 'the row is fixed, not the children');
  assert.deepEqual(out.byView.desktop, { 'column-gap': '20px' });

  // Already the right distance apart: nothing to do.
  const fine = { ...rendered, '3|desktop': [120, 0, 100, 50], '4|desktop': [240, 0, 100, 50] };
  assert.equal(spacing(groupOf(b, { desktop: { kind: 'offset' } }), ctxOf({ parents, rendered: fine })), null);
});

test('an uneven spacing is not flattened into one gap', () => {
  const a = cap('div', { desktop: [[0, 0, 100, 50], {}] }, [], { sid: 2 });
  const b = cap('div', { desktop: [[120, 0, 100, 50], {}] }, [], { sid: 3 });
  const c = cap('div', { desktop: [[300, 0, 100, 50], {}] }, [], { sid: 4 });
  const row = cap('div', { desktop: [[0, 0, 400, 50], { display: 'flex' }] }, [a, b, c], { sid: 1 });
  const parents = new Map([[a, row], [b, row], [c, row]]);
  const rendered = { '2|desktop': [0, 0, 100, 50], '3|desktop': [100, 0, 100, 50], '4|desktop': [200, 0, 100, 50] };
  // 20 px then 80 px: that is not a gap, so no gap is written.
  assert.equal(spacing(groupOf(b, { desktop: { kind: 'offset' } }), ctxOf({ parents, rendered })), null);
});

test('a row that wrapped when it should not is told not to', () => {
  const a = cap('div', { desktop: [[0, 0, 200, 50], {}] }, [], { sid: 2 });
  const b = cap('div', { desktop: [[200, 0, 200, 50], {}] }, [], { sid: 3 });
  const row = cap('div', { desktop: [[0, 0, 400, 50], { display: 'flex' }] }, [a, b], { sid: 1 });
  const parents = new Map([[a, row], [b, row]]);
  // Rendered on two lines.
  const rendered = { '2|desktop': [0, 0, 200, 50], '3|desktop': [0, 50, 200, 50] };
  const out = wrapping(groupOf(b, { desktop: { kind: 'offset' } }), ctxOf({ parents, rendered }));
  assert.equal(out.target, row);
  assert.deepEqual(out.byView.desktop, { 'flex-wrap': 'nowrap' });

  // And a row that should wrap and did not.
  const wrapped = cap('div', { desktop: [[0, 0, 200, 100], { display: 'flex' }] }, [a, b], { sid: 1 });
  const two = cap('div', { desktop: [[0, 50, 200, 50], {}] }, [], { sid: 3 });
  wrapped.children = [a, two];
  const out2 = wrapping(groupOf(two, { desktop: { kind: 'offset' } }), ctxOf({
    parents: new Map([[a, wrapped], [two, wrapped]]),
    rendered: { '2|desktop': [0, 0, 200, 50], '3|desktop': [200, 0, 200, 50] },
  }));
  assert.deepEqual(out2.byView.desktop, { 'flex-wrap': 'wrap' });
});

test('a grid whose columns land in the wrong place gets its tracks from the captured boxes', () => {
  const a = cap('div', { desktop: [[0, 0, 100, 50], {}] }, [], { sid: 2 });
  const b = cap('div', { desktop: [[150, 0, 200, 50], {}] }, [], { sid: 3 });
  const grid = cap('div', { desktop: [[0, 0, 400, 50], { display: 'grid' }] }, [a, b], { sid: 1 });
  const parents = new Map([[a, grid], [b, grid]]);
  const rendered = { '2|desktop': [0, 0, 100, 50], '3|desktop': [100, 0, 200, 50] };
  const out = gridTracks(groupOf(b, { desktop: { kind: 'offset' } }), ctxOf({ parents, rendered }));
  assert.equal(out.target, grid);
  assert.deepEqual(out.byView.desktop, { 'grid-template-columns': '100px 200px' });

  // Not when the stylesheet already defines the tracks: that is refine.js's business, not a lost rule.
  const defined = gridTracks(groupOf(b, { desktop: { kind: 'offset' } }), ctxOf({ parents, rendered, emitted: { '1|desktop|grid-template-columns': '1fr 2fr' } }));
  assert.equal(defined, null);
});

test('a box the wrong height is held open or held down, never a text box', () => {
  const box = cap('div', { desktop: [[0, 0, 100, 200], {}] }, [], { sid: 1 });
  const short = wrongHeight(groupOf(box, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 100, 50] } }));
  assert.deepEqual(short.byView.desktop, { 'min-height': '200px' });
  const tall = wrongHeight(groupOf(box, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 100, 600] } }));
  assert.deepEqual(tall.byView.desktop, { height: '200px' });
  // Within tolerance: nothing.
  assert.equal(wrongHeight(groupOf(box, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 100, 202] } })), null);
  // A line of text that wraps a pixel differently is a font difference, not a layout error.
  const words = cap('p', { desktop: [[0, 0, 100, 200], {}] }, [text('Hi')], { sid: 1 });
  assert.equal(wrongHeight(groupOf(words, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 100, 50] } })), null);
});

test('a box is not held down when what is inside it is the thing that is too tall', () => {
  // Clamping the parent would clip the child, the pixels would get worse and the whole round would be refused -
  // taking any good correction in the same round down with it. The child is what to fix, so the cause is recorded
  // and nothing is proposed here.
  const child = cap('div', { desktop: [[0, 0, 100, 180], {}] }, [], { sid: 2 });
  const box = cap('div', { desktop: [[0, 0, 100, 200], {}] }, [child], { sid: 1 });
  const group = groupOf(box, { desktop: { kind: 'size' } });
  const ctx = ctxOf({ rendered: { '1|desktop': [0, 0, 100, 600], '2|desktop': [0, 0, 100, 560] } });
  assert.equal(wrongHeight(group, ctx), null);
  assert.equal(group.perView.get('desktop').cause, 'taller-content');

  // The same box, but its child renders at the height the capture measured: now the box itself is wrong and is held down.
  const ok = ctxOf({ rendered: { '1|desktop': [0, 0, 100, 600], '2|desktop': [0, 0, 100, 180] } });
  const out = wrongHeight(groupOf(box, { desktop: { kind: 'size' } }), ok);
  assert.deepEqual(out.byView.desktop, { height: '200px' });
});

test('an image drawn at the wrong shape gets the aspect ratio the capture saw', () => {
  const img = cap('img', { desktop: [[0, 0, 200, 100], {}] }, [], { sid: 1 });
  const out = aspect(groupOf(img, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 200, 300] } }));
  assert.deepEqual(out.byView.desktop, { 'aspect-ratio': '200 / 100' });
  assert.equal(aspect(groupOf(img, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 400, 200] } })), null, 'the same shape at another size is fine');
  const div = cap('div', { desktop: [[0, 0, 200, 100], {}] }, [], { sid: 1 });
  assert.equal(aspect(groupOf(div, { desktop: { kind: 'size' } }), ctxOf({ rendered: { '1|desktop': [0, 0, 200, 300] } })), null, 'only replaced elements have an aspect ratio to keep');
});

test('a correction is written for every view the element exists in, each from that view own capture', () => {
  // Why this matters: a declaration committed for the desktop view lands in the stylesheet base, where it would
  // also apply to the narrower views. Giving each view its own captured value removes that leak.
  const box = cap('div', {
    desktop: [[0, 0, 400, 100], {}],
    mobile: [[0, 0, 300, 80], {}],
  }, [], { sid: 1 });
  const out = missingElement(groupOf(box, { desktop: { kind: 'missing' }, mobile: { kind: 'missing' } }), ctxOf({ views: ['desktop', 'mobile'] }));
  assert.equal(out.id, 'empty-box');
  assert.deepEqual(out.byView.desktop, { width: '400px', height: '100px', 'flex-shrink': '0' });
  assert.deepEqual(out.byView.mobile, { width: '300px', height: '80px', 'flex-shrink': '0' });
});

test('only the topmost element missing from a chain is corrected', () => {
  const kid = cap('div', { desktop: [[0, 0, 100, 50], {}] }, [], { sid: 2 });
  const group = groupOf(kid, { desktop: { kind: 'missing' } });
  const ctx = { ...ctxOf({}), missingAncestor: () => true };
  assert.equal(missingElement(group, ctx), null, 'fixing the ancestor brings the whole subtree back');
});

// --- What reaches the report ---------------------------------------------------------------------------------------

test('the report names what each corrector did and what is still different, by cause', () => {
  const { fix, manual } = correctReport({
    rounds: 3,
    applied: 28,
    reverted: 13,
    scoreBefore: 74.8,
    scoreAfter: 81.2,
    stopped: 'rejected',
    rejected: [{ corrector: 'height', count: 11, why: 'score 74.6 is not 1 above 74.8' }],
    byCorrector: {
      'flex-collapse': { applied: 28, reverted: 0 },
      height: { applied: 0, reverted: 11 },
      'drift-height': { applied: 0, reverted: 2 },
    },
    ledger: { elements: 400, open: 61, byCause: { 'font-render': 40, 'asset-missing': 3, 'image-content': 2, 'taller-content': 16 } },
  });

  assert.equal(fix.id, 'layout-correct');
  assert.equal(fix.count, 28);
  assert.equal(fix.open, 61);
  assert.equal(fix.status, 'partial', 'some corrected, some still different');
  assert.match(fix.title, /28 layout corrections/);
  // Per corrector, the one that paid off first.
  assert.deepEqual(fix.items[0], { corrector: 'flex-collapse', applied: 28, reverted: 0 });
  assert.equal(fix.items.length, 3);
  // Per cause, biggest first, and marked when a person has to act on it.
  assert.deepEqual(fix.openItems[0], { cause: 'font-render', elements: 40, manual: false });
  assert.equal(fix.openItems.find((i) => i.cause === 'asset-missing').manual, true);
  // A refused change set is on the record with the reason, not hidden.
  assert.equal(fix.refused[0].corrector, 'height');
  assert.deepEqual(fix.score, { before: 74.8, after: 81.2 });

  // Only the causes a person can act on become manual rows: a file that is missing, an image's own pixels.
  assert.deepEqual(manual.map((m) => m.cause).sort(), ['asset-missing', 'image-content']);
  assert.equal(manual.every((m) => m.kind === 'asset'), true);
  assert.match(manual.find((m) => m.cause === 'asset-missing').title, /\(3 elements\)/);
  assert.match(manual.find((m) => m.cause === 'image-content').title, /\(2 elements\)/);
  for (const row of manual) assert.ok(row.detail.length > 20, 'a manual row says what to do about it');
  // Text drawn by a different font is an explanation, not a task.
  assert.equal(manual.some((m) => m.cause === 'font-render'), false);
});

test('the report entry is honest when nothing was corrected, and absent when there was nothing to do', () => {
  const nothingWorked = correctReport({
    rounds: 2, applied: 0, reverted: 9, stopped: 'rejected',
    byCorrector: { height: { applied: 0, reverted: 9 } },
    ledger: { elements: 120, open: 120, byCause: {} },
  });
  assert.equal(nothingWorked.fix.status, 'open');
  assert.equal(nothingWorked.fix.count, 0);
  assert.match(nothingWorked.fix.title, /no change measured closer/);
  assert.deepEqual(nothingWorked.manual, []);

  // Everything matched: nothing open, so the entry reads as fixed.
  const clean = correctReport({ rounds: 1, applied: 4, reverted: 0, byCorrector: { gap: { applied: 4, reverted: 0 } }, ledger: { elements: 4, open: 0, byCause: {} } });
  assert.equal(clean.fix.status, 'fixed');

  // The loop never ran, so it has nothing to say.
  assert.deepEqual(correctReport({ stopped: 'nothing-to-measure' }), { fix: null, manual: [] });
  assert.deepEqual(correctReport(null), { fix: null, manual: [] });
});

test('everything the report carries survives JSON, and stays bounded', () => {
  // report.json is written with JSON.stringify: a Set or a live node reference would throw or bloat it.
  const byCause = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`cause-${i}`, i + 1]));
  const byCorrector = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`fixer-${i}`, { applied: i, reverted: 1 }]));
  const { fix, manual } = correctReport({ applied: 5, reverted: 5, byCorrector, ledger: { elements: 900, open: 900, byCause } });
  assert.equal(fix.items.length, 20, 'a report is not a place for 40 correctors');
  assert.equal(fix.openItems.length, 20);
  assert.doesNotThrow(() => JSON.stringify({ fix, manual }));
  const back = JSON.parse(JSON.stringify({ fix, manual }));
  assert.equal(back.fix.items.length, 20);
  assert.equal(back.fix.id, 'layout-correct');
});

// --- The loop, against a real browser -----------------------------------------------------------------------------

const irNode = (tag, { rect, children = [], cls = null, sid, cpath }) => ({
  t: tag, tag, class: cls, sid, cpath, children, views: { desktop: { rect, style: {} } },
});

/**
 * A page whose spacer the copy collapses: the capture saw it 100 px tall, the stylesheet gives it 0, so the spacer
 * does not render at all and what follows it sits too high.
 */
function collapsedPage() {
  const spacer = irNode('div', { rect: [0, 0, 200, 100], cls: 'spacer', sid: 2, cpath: 'body>div:1' });
  const below = irNode('div', { rect: [0, 100, 200, 40], cls: 'below', sid: 3, cpath: 'body>div:2', children: [text('Below')] });
  const body = irNode('body', { rect: [0, 0, 1440, 140], sid: 1, cpath: 'body', children: [spacer, below] });
  const htmlNode = irNode('html', { rect: [0, 0, 1440, 140], sid: 0, cpath: 'html', children: [body] });
  const ir = {
    version: 1,
    pages: [{ outPath: 'index.html', head: { lang: 'en', title: 'p', meta: [], alternates: [], icons: [], preload: [], jsonLd: [] }, html: {}, body }],
    rules: [{ selector: '.spacer', parts: { base: { height: '0px' } } }],
    tokens: {}, fontFaces: [], keyframes: [], breakpoints: { source: 'single-view' }, files: [],
  };
  const tree = { root: body, htmlNode, views: ['desktop'], info: { path: '/', outPath: 'index.html', slug: 'index' } };
  return { ir, site: { pages: [tree] }, spacer, below };
}

let root;
let renderer;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sas-correct-'));
  renderer = await openRenderer(root);
});
after(async () => {
  await renderer?.close();
  await rm(root, { recursive: true, force: true });
});

const RESET = 'body { margin: 0 } .below { height: 40px }\n';

async function scoreOnce(ir, site, css) {
  let got = null;
  await measureSite(renderer, ir, site, {
    extraOverrides: { 'css/site.css': css },
    onView: (tree, view, result) => {
      const cmp = compareLayout(tree.root, view, result.rects, { pairs: true });
      got = { score: viewScore(cmp, null), cmp, scrollHeight: result.scrollHeight };
    },
  });
  return got;
}

test('a candidate stylesheet is served without rebuilding, and survives more than one measurement', async () => {
  const { ir, site } = collapsedPage();
  const tall = await scoreOnce(ir, site, `${RESET}.spacer { height: 100px }`);
  const flat = await scoreOnce(ir, site, `${RESET}.spacer { height: 0px }`);
  assert.equal(tall.cmp.missing, 0, 'the spacer renders when the candidate stylesheet says so');
  assert.equal(flat.cmp.missing, 1, 'and not when it does not');
  assert.ok(tall.score > flat.score);
  // measureSite clears the override map when it is done, so the stylesheet is re-installed on every call. Were it
  // not, this second measurement would quietly fall back to whatever is on disk and decide nothing.
  const again = await scoreOnce(ir, site, `${RESET}.spacer { height: 100px }`);
  assert.equal(again.cmp.missing, 0);
  assert.equal(again.score, tall.score);
});

test('only the chosen pages and views are rendered', async () => {
  const { ir, site } = collapsedPage();
  const irTwo = { ...ir, pages: [ir.pages[0], { ...ir.pages[0], outPath: 'other.html' }] };
  const siteTwo = {
    pages: [site.pages[0], { ...site.pages[0], views: ['desktop', 'mobile'], info: { path: '/other', outPath: 'other.html', slug: 'other' } }],
  };

  const seen = [];
  const all = await measureSite(renderer, irTwo, siteTwo, { onView: (tree, view) => seen.push(`${tree.info.path} ${view}`) });
  assert.deepEqual(seen.sort(), ['/ desktop', '/other desktop', '/other mobile']);
  assert.equal(all.started, 2);

  const picked = [];
  const one = await measureSite(renderer, irTwo, siteTwo, {
    only: new Set(['other.html']),
    viewsOf: () => ['desktop'],
    onView: (tree, view) => picked.push(`${tree.info.path} ${view}`),
  });
  assert.deepEqual(picked, ['/other desktop']);
  assert.equal(one.started, 1, 'started counts the selection, not the whole site');
});

test('the loop finds the collapsed element, sizes it from the capture and commits it per view', async () => {
  const { ir, site, spacer, below } = collapsedPage();
  const baseCss = `${RESET}.spacer { height: 0px }`;
  const start = await scoreOnce(ir, site, baseCss);
  assert.equal(start.cmp.missing, 1);

  const ledger = createLedger();
  const out = await correctLayout({
    measure: (opts) => measureSite(renderer, ir, site, opts),
    ir,
    site,
    ledger,
    baseCss,
    candidates: [{ path: '/', outPath: 'index.html', view: 'desktop', score: start.score, scrollHeight: start.scrollHeight }],
    deadline: Date.now() + 60000,
  });

  assert.equal(out.applied, 1, JSON.stringify(out));
  assert.equal(out.reverted, 0);
  assert.equal(out.elements, 1);
  assert.ok(out.scoreAfter > out.scoreBefore, `${out.scoreBefore} -> ${out.scoreAfter}`);
  assert.deepEqual(Object.keys(out.byCorrector), ['empty-box']);
  // Committed as a per-view node fix, which is what ir/styles.js writes into the rules every emitter reads.
  assert.equal(spacer.fix.desktop.decls.height, '100px');
  assert.equal(spacer.fix.desktop.decls.width, '200px');
  // The value came from the capture, never from a screenshot of our own.
  assert.equal(spacer.fix.desktop.decls.height, `${spacer.views.desktop.rect[3]}px`);
  // What followed the spacer was in the wrong place only because the spacer was: not blamed, not touched.
  assert.equal(below.fix, undefined);
});

test('a round that does not help is put back, and those elements are left alone', async () => {
  // The spacer is an empty box the capture saw, so a size is the obvious thing to try - but here it is not rendered
  // because the stylesheet hides it, which a size cannot cure. The proposal is made, measured, found to change
  // nothing, and dropped: nothing is committed and those elements are not offered again.
  const { ir, site, spacer } = collapsedPage();
  const baseCss = `${RESET}.spacer { display: none }`;
  const start = await scoreOnce(ir, site, baseCss);
  assert.equal(start.cmp.missing, 1);

  const ledger = createLedger();
  const out = await correctLayout({
    measure: (opts) => measureSite(renderer, ir, site, opts),
    ir,
    site,
    ledger,
    baseCss,
    candidates: [{ path: '/', outPath: 'index.html', view: 'desktop', score: start.score, scrollHeight: start.scrollHeight }],
    deadline: Date.now() + 60000,
  });

  assert.equal(out.applied, 0, JSON.stringify(out));
  assert.ok(out.reverted >= 1);
  assert.equal(spacer.fix, undefined, 'nothing is committed from a round that did not help');
  assert.ok([...ledger.entries.values()].some((e) => e.frozen), 'and those elements are not offered again');
  // The refusal is recorded by the kind of correction that earned it, and the loop went on to look for another
  // kind rather than giving up: a refused change set costs a round, not the whole pass.
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].corrector, 'empty-box');
  // This change moved the score by nothing at all, which the refusal now says in those words and flags:
  // "did not move" and "made it worse" are different findings about a corrector.
  assert.match(out.rejected[0].why, /did not move/);
  assert.equal(out.rejected[0].noEffect, true);
  assert.equal(out.stopped, 'converged', 'nothing else was left to try once those elements were frozen');
});

test('an element missing for a reason the loop cannot name is recorded, not guessed at', async () => {
  // Nothing renders because the whole body is hidden. The topmost missing element is the body itself, and there is
  // no captured display to put back, so the loop proposes nothing at all and says why in the ledger.
  const { ir, site, spacer } = collapsedPage();
  const baseCss = `${RESET}body { display: none }`;
  const start = await scoreOnce(ir, site, baseCss);

  const ledger = createLedger();
  const out = await correctLayout({
    measure: (opts) => measureSite(renderer, ir, site, opts),
    ir,
    site,
    ledger,
    baseCss,
    candidates: [{ path: '/', outPath: 'index.html', view: 'desktop', score: start.score, scrollHeight: start.scrollHeight }],
    deadline: Date.now() + 60000,
  });

  assert.equal(out.applied, 0, JSON.stringify(out));
  assert.equal(out.reverted, 0, 'nothing was tried, so there is nothing to put back');
  assert.equal(out.stopped, 'converged');
  assert.equal(spacer.fix, undefined);
  const causes = out.ledger.byCause;
  assert.equal(causes['missing-unexplained'] > 0, true, JSON.stringify(causes));
});

test('the loop does nothing at all when there is no time for a round', async () => {
  const { ir, site, spacer } = collapsedPage();
  const out = await correctLayout({
    measure: (opts) => measureSite(renderer, ir, site, opts),
    ir,
    site,
    ledger: createLedger(),
    baseCss: RESET,
    candidates: [{ path: '/', outPath: 'index.html', view: 'desktop', score: 50, scrollHeight: 140 }],
    deadline: Date.now() + 1000,
  });
  assert.equal(out.stopped, 'time-limit');
  assert.equal(out.rounds, 0);
  assert.equal(out.applied, 0);
  assert.equal(spacer.fix, undefined);
});

test('the bar a change must clear follows the noise that was measured, not a fixed guess', () => {
  // The five gains a real run threw away, and the three harms it rightly refused. The flat margin of one point
  // refused all eight; with the noise floor measured at zero, the bar is the floor and only the harms are refused.
  const at = (s) => ({ score: s, layout: s, pixel: s, by: new Map() });
  const quiet = marginForNoise({ 320: 0, 768: 0, 1440: 0 });
  assert.equal(quiet, MIN_ACCEPT_MARGIN, 'nothing moved between two captures, so the bar is the floor');

  for (const [before, after] of [[85.6, 85.9], [84.7, 85.1], [84.7, 85], [56.4, 56.7], [11.6, 11.7]]) {
    assert.equal(judge(at(before), at(after), { margin: quiet }).ok, true, `${before} -> ${after} is a real gain`);
    assert.equal(judge(at(before), at(after)).ok, false, `${before} -> ${after} was refused by the flat point`);
  }
  for (const [before, after] of [[24.7, 10.4], [18, 14.6], [12.6, 11.9]]) {
    assert.equal(judge(at(before), at(after), { margin: quiet }).ok, false, `${before} -> ${after} is a regression`);
  }

  // A loud measurement earns a wide bar - the point of measuring it rather than assuming.
  assert.ok(marginForNoise({ 320: 0.25 }) > 1, 'a quarter percent of pixel noise is worth more than a point');
  assert.ok(marginForNoise({ 320: 1 }) > marginForNoise({ 320: 0.25 }), 'and more noise, more bar');
  // One loud width is enough to raise it: the bar is the worst case, not the average.
  assert.equal(marginForNoise({ 320: 0, 768: 0.25 }), marginForNoise({ 768: 0.25 }));

  // Every protection stays exactly as it was, whatever the bar.
  const dropped = judge({ score: 50, layout: 50, pixel: 50, by: new Map() },
    { score: 60, layout: 40, pixel: 80, by: new Map() }, { margin: quiet });
  assert.equal(dropped.ok, false, 'a big score rise cannot buy a fall in the element boxes');
  const slot = judge({ score: 50, layout: 50, pixel: 50, by: new Map([['/|desktop', { score: 90 }]]) },
    { score: 60, layout: 60, pixel: 60, by: new Map([['/|desktop', { score: 80 }]]) }, { margin: quiet });
  assert.equal(slot.ok, false, 'nor a single page and view falling more than two points');
});

test('a change with no measurable effect is named as such, not reported as harm', () => {
  // Eleven of a real run's twenty-two refusals were one-element proposals that moved the score by nothing at all.
  // They are still refused - CSS added for no measured gain is a risk taken for free - but "did not move" and
  // "made it worse" are different findings and the report should not read as though they were the same.
  const at = (s) => ({ score: s, layout: s, pixel: s, by: new Map() });
  const flat = judge(at(24.7), at(24.7), { margin: MIN_ACCEPT_MARGIN });
  assert.equal(flat.ok, false);
  assert.equal(flat.same, true);
  assert.match(flat.why, /did not move/);

  const worse = judge(at(24.7), at(10.4), { margin: MIN_ACCEPT_MARGIN });
  assert.equal(worse.ok, false);
  assert.notEqual(worse.same, true);
  assert.match(worse.why, /is not/);
});
