// Exact mode, phase A1: the viewports an exact copy is measured at, and the site's own breakpoints that earn a slot.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exactSlots, FIXED_WIDTHS, MAX_BREAKPOINT_SLOTS, PHONE_BELOW, pickBounds, slotFor, SHORT_WINDOW, TABLET_BELOW,
} from '../src/recreate/verify/exact/slots.js';
import { distinctBounds, mediaBounds, pickBreakpoints } from '../src/recreate/ir/index.js';
import { EXACT_ONLY_VIEWS, VIEW_WIDTHS, viewsFor } from '../src/recreate/views.js';

const q = (condition, rules = 0) => ({ condition, rules });

test('every fixed width is measured, each emulated as the device that width belongs to', () => {
  const { slots } = exactSlots();
  for (const w of FIXED_WIDTHS) assert.ok(slots.some((s) => s.width === w && s.origin === 'fixed'), `width ${w}`);
  // The short window is its own slot, not a second entry for 1440.
  const short = slots.filter((s) => s.width === SHORT_WINDOW.width);
  assert.equal(short.length, 2);
  assert.deepEqual(short.map((s) => s.id).sort(), ['1440', '1440x600']);

  for (const s of slots) {
    const phone = s.width < PHONE_BELOW;
    const tablet = !phone && s.width < TABLET_BELOW;
    assert.equal(s.dpr, phone ? 3 : tablet ? 2 : 1, `dpr of ${s.id}`);
    assert.equal(s.mobile, phone || tablet, `mobile of ${s.id}`);
    assert.equal(s.hasTouch, phone || tablet, `touch of ${s.id}`);
    assert.ok(s.height > 0);
  }
  // Widest first, so a page's widest layout is seen before the narrow ones it falls back to.
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i - 1].width >= slots[i].width, 'ordered by width');
});

test('mediaBounds: the width a layout changes at, however the query is written', () => {
  const bounds = mediaBounds([q('(max-width: 767.98px)', 3), q('(min-width: 768px)', 5), q('(max-width: 48em)', 1)]);
  assert.deepEqual(bounds.map((b) => b.value), [767.98, 767.98, 768]);
  assert.deepEqual(bounds.map((b) => b.rules), [3, 5, 1]);

  // Conditions that are not about the width of the window carry no breakpoint.
  const none = mediaBounds([
    q('print'), q('(min-resolution: 2dppx)'), q('(prefers-reduced-motion: no-preference)'),
    q('(hover: hover) and (min-width: 900px)'), q('(max-width: 900px) and (orientation: landscape)'),
    q('(min-aspect-ratio: 16/9) and (min-width: 1200px)'), q(''), null,
  ]);
  assert.deepEqual(none, []);

  // A capture saved before exact mode has plain strings and no counts, and must still work.
  assert.deepEqual(mediaBounds(['(max-width: 600px)']), [{ value: 600, condition: '(max-width: 600px)', rules: 0 }]);
  assert.deepEqual(mediaBounds(undefined), []);
});

test('pickBreakpoints still reads what it always did, now through mediaBounds', () => {
  const picked = pickBreakpoints(['(max-width: 1279.98px)', '(max-width: 1023.98px)', '(max-width: 767.98px)']);
  assert.equal(picked.source, 'site');
  assert.equal(picked.laptop, 1279.98);
  assert.equal(picked.tablet, 1023.98);
  assert.equal(picked.mobile, 767.98);
  // A query that is not about width cannot move a breakpoint.
  assert.equal(pickBreakpoints(['print', '(min-resolution: 2dppx)']).source, 'default');
});

test('one boundary written two ways is one boundary, and its rules add up', () => {
  const { kept } = pickBounds([q('(max-width: 1024px)', 40), q('(min-width: 1025px)', 3)]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].rules, 43);
});

test('the breakpoints that carry the most rules win, and the rest are named', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(q(`(max-width: ${400 + i * 30}px)`, i + 1));
  const { kept, rejected } = pickBounds(many);
  assert.equal(kept.length, MAX_BREAKPOINT_SLOTS, 'capped per site');
  // Ranked by weight: the last query has the most rules.
  assert.equal(Math.floor(kept[0].value), 400 + 39 * 30);
  assert.equal(rejected.length, many.length - kept.length);
  for (const r of rejected) assert.match(r.reason, /over-cap|outside-range|merged-into-\d+/);
  assert.ok(rejected.some((r) => r.reason === 'over-cap'));
  // Nothing is lost silently: every rejection names the boundary and why.
  for (const r of rejected) assert.ok(r.condition && Number.isFinite(r.bound));
});

test('two boundaries a few pixels apart measure the same layout twice, so one is enough', () => {
  const { kept, rejected } = pickBounds([q('(max-width: 768px)', 10), q('(max-width: 771px)', 5)]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].rules, 10, 'the heavier one is kept');
  assert.equal(rejected[0].reason, 'merged-into-768');
});

test('a boundary adds the width either side of itself, and never a slot that is already there', () => {
  // 1024 is a fixed width, so only the pixel above it is new; 600 is not, so both sides are.
  const { slots } = exactSlots({ mediaRules: [q('(max-width: 1024px)', 20), q('(max-width: 600px)', 10)] });
  const added = slots.filter((s) => s.origin === 'breakpoint').map((s) => s.width).sort((a, b) => a - b);
  assert.deepEqual(added, [600, 601, 1025]);
  assert.equal(slots.filter((s) => s.width === 1024).length, 1, '1024 is not measured twice');
  for (const s of slots.filter((x) => x.origin === 'breakpoint')) assert.ok(Number.isFinite(s.bound));
  // A phone-width boundary is still emulated as a phone.
  const narrow = exactSlots({ mediaRules: [q('(max-width: 500px)', 9)] }).slots.find((s) => s.width === 500);
  assert.equal(narrow.dpr, 3);
  assert.equal(narrow.mobile, true);
});

test('the whole list stays about twenty slots, even for a stylesheet full of breakpoints', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(q(`(max-width: ${331 + i * 37}px)`, i + 1));
  const { slots } = exactSlots({ mediaRules: many });
  assert.ok(slots.length <= FIXED_WIDTHS.length + 1 + MAX_BREAKPOINT_SLOTS * 2, `got ${slots.length}`);
  assert.ok(slots.length >= FIXED_WIDTHS.length + 1);
});

test('slotFor: a height of its own earns a name of its own', () => {
  assert.equal(slotFor(1440).id, '1440');
  assert.equal(slotFor(1440, { height: 600 }).id, '1440x600');
  assert.equal(slotFor(1440, { height: 900 }).id, '1440', 'the usual height is not spelled out');
});

test('the boundaries the site declares are kept once each, with the rules that hang off them', () => {
  // The same query is captured once per page and once per view, so on an eleven-page site the raw list said
  // 639.98 eighty-eight times. It travels into the IR, and the sweep ranks boundaries by how many rules use them.
  const raw = [
    ...Array.from({ length: 88 }, () => ({ value: 639.98, rules: 3, condition: '(min-width: 640px)' })),
    ...Array.from({ length: 44 }, () => ({ value: 767.98, rules: 9, condition: '(min-width: 768px)' })),
    { value: 767.98, rules: 2, condition: '(min-width: 768px)' },
    { value: NaN, rules: 1 },
    null,
  ];
  const got = distinctBounds(raw);
  assert.deepEqual(got.map((b) => b.value), [639.98, 767.98], 'one entry each, in order, nothing invented');
  assert.equal(got.find((b) => b.value === 767.98).rules, 9, 'the largest rule count seen for it');
  assert.deepEqual(distinctBounds([]), []);
  assert.deepEqual(distinctBounds(), []);
});

test('an exact run captures the band between a phone and a tablet; an ordinary run does not', () => {
  // Measured on a real site: the original had three layouts below 1024 - under 640, 640-767, then 768 up - and the
  // copy had two, so its 375 px styles governed 640-767 and the page was 12-14% too short across that band. No
  // breakpoint can fix that: whichever side of 640 wins, one regime gets styles never measured for it. The band
  // needs its own capture, and a fifth view costs a fifth of the capture again, which only an exact run can spend.
  const ordinary = viewsFor({}).map((v) => v.id);
  const exact = viewsFor({ exact: true }).map((v) => v.id);
  assert.deepEqual(ordinary, ['desktop', 'laptop', 'tablet', 'mobile'], 'unchanged from every run before this');
  assert.deepEqual(exact, ['desktop', 'laptop', 'tablet', 'large-phone', 'mobile']);
  assert.deepEqual(exact.filter((v) => !ordinary.includes(v)), EXACT_ONLY_VIEWS);
  // Widest first, because the CSS is a base plus one max-width query per narrower view.
  const widths = viewsFor({ exact: true }).map((v) => v.width);
  assert.deepEqual(widths, [...widths].sort((a, b) => b - a));
  assert.ok(VIEW_WIDTHS['large-phone'] > 640 && VIEW_WIDTHS['large-phone'] < 768, 'inside the band it is there for');
});

test('each view gets the breakpoint of the gap above it, whatever the view set', () => {
  const four = ['desktop', 'laptop', 'tablet', 'mobile'];
  const five = ['desktop', 'laptop', 'tablet', 'large-phone', 'mobile'];
  const tailwindish = ['(min-width: 640px)', '(min-width: 768px)', '(min-width: 1024px)', '(min-width: 1280px)'];

  // Four views: exactly what this has always produced, declared boundaries or not.
  assert.deepEqual(pickBreakpoints([], { views: four }), { laptop: 1279.98, tablet: 1023.98, mobile: 767.98, source: 'default' });
  assert.deepEqual(pickBreakpoints([]), { laptop: 1279.98, tablet: 1023.98, mobile: 767.98, source: 'default' });
  assert.deepEqual(pickBreakpoints([], { laptop: false }), { tablet: 1023.98, mobile: 767.98, source: 'default' });
  assert.deepEqual(pickBreakpoints(tailwindish, { views: four }), { laptop: 1279.98, tablet: 1023.98, mobile: 767.98, source: 'site' });

  // Five: the phone keeps what the site declares at 640 and the new view takes the band above it. This is the
  // three regimes the original had, which four views could not express at all.
  assert.deepEqual(pickBreakpoints(tailwindish, { views: five }), {
    laptop: 1279.98, tablet: 1023.98, 'large-phone': 767.98, mobile: 639.98, source: 'site',
  });
  // With nothing declared, the phone's boundary is the new view's width less a hundredth - not the stale 767.98
  // that assumed the tablet came next.
  assert.equal(pickBreakpoints([], { views: five }).mobile, 699.98);
});
