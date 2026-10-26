// The plain words of the app (client/src/copy.js): the four result words and the statuses they stand for, the four score
// names, the reason words, and the one warning shown when the copy's own visual checks say part of it looks different.
// Pure functions and constants, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookWarning, REASON_WORDS, RESULT_WORD_FOR, RESULT_WORDS, SCORE_NAMES } from '../../client/src/copy.js';

test('the four result words exist and are the words for these statuses', () => {
  assert.deepEqual(Object.values(RESULT_WORDS), ['Better', 'Still needs work', 'Got worse', 'Needs a person']);
  assert.deepEqual(RESULT_WORD_FOR, {
    fixed: 'Better',
    improved: 'Better',
    open: 'Still needs work',
    regressed: 'Got worse',
    manual: 'Needs a person',
  });
  for (const word of Object.values(RESULT_WORD_FOR)) assert.ok(Object.values(RESULT_WORDS).includes(word), word);
});

test('the four score names and the reason words', () => {
  assert.deepEqual(SCORE_NAMES, { performance: 'Speed', seo: 'Found on Google', accessibility: 'Easy for everyone', 'best-practices': 'Safe & modern' });
  assert.equal(REASON_WORDS.address, 'Needs the new site’s address');
  assert.equal(REASON_WORDS.owner, 'Your own text: your choice');
  assert.equal(REASON_WORDS.look, 'Changing it would change the look');
  assert.equal(REASON_WORDS.deploy, 'Can only be measured once it’s online');
  for (const key of ['third_party', 'backend', 'converted', 'unresolved', 'unexplained']) assert.ok(REASON_WORDS[key], key);
});

// A copy whose every visual check passed, in every place lookWarning reads.
const passing = () => ({
  fidelity: {
    status: 'ok', lowPages: [],
    pages: [{ path: '/', low: false, lowViews: [], diff: { low: false, lowViews: [] } }],
    diff: { status: 'ok', lowPages: [] },
  },
  exact: { pages: [{ page: '/', slots: [{ width: 390, accepted: true, heightOk: true, pixelsOk: true, boxesOk: true }] }] },
  outputs: { html: 'dist', 'react-vite': { status: 'ready', equivalence: { ok: true, dom: { equal: 1, total: 1 }, pages: [{ path: '/', dom: 'equal' }] } } },
  copy: { pages: [{ path: '/', problems: [] }] },
});

test('nothing is said when every visual check passed, or when there is no result', () => {
  assert.equal(lookWarning(passing()), null);
  assert.equal(lookWarning({}), null);
  assert.equal(lookWarning(null), null);
});

test('a low match score names the page, the screen size and what differs', () => {
  const r = passing();
  r.fidelity.status = 'mixed';
  r.fidelity.lowPages = ['/about'];
  r.fidelity.pages.push({ path: '/about', low: true, lowViews: ['mobile', 'desktop'] });
  assert.equal(lookWarning(r), 'Part of the copy looks different from the original: on /about (computer, phone) parts have a different size or sit in a different place. Open Compare to look.');
  // Low over the whole site with no single page below the bar: every page.
  const all = passing();
  all.fidelity.status = 'low';
  assert.match(lookWarning(all), /on every page parts have a different size/);
});

test('a low visual difference names the page, the screen size and what differs', () => {
  const r = passing();
  r.fidelity.diff = { status: 'mixed', lowPages: ['/pricing'] };
  r.fidelity.pages.push({ path: '/pricing', low: false, lowViews: [], diff: { low: true, lowViews: ['tablet'] } });
  assert.equal(lookWarning(r), 'Part of the copy looks different from the original: on /pricing (tablet) it does not look the same. Open Compare to look.');
});

test('an exact-comparison slot that was not accepted names each of its causes', () => {
  const r = passing();
  r.exact.pages.push({
    page: '/team',
    slots: [
      { width: 390, accepted: false, heightOk: true, pixelsOk: true, boxes: { missing: 2 } },
      { width: 1440, accepted: false, heightOk: false, pixelsOk: false, boxes: { hard: 1 } },
      { width: 1025, accepted: true, heightOk: true, pixelsOk: true },
    ],
  });
  const text = lookWarning(r);
  assert.match(text, /on \/team \(phone\) something is missing/);
  assert.match(text, /on \/team \(computer\) the page is a different height/);
  assert.match(text, /on \/team \(computer\) something sits in the wrong place/);
  assert.doesNotMatch(text, /laptop/, 'the accepted slot is not named');
});

test('a converted version that is not identical names the page and the screen size', () => {
  const r = passing();
  r.outputs['react-vite'].equivalence = {
    ok: false, dom: { equal: 1, total: 2 },
    pages: [{ path: '/', dom: 'equal' }, { path: '/blog', dom: 'different', difference: { view: 'mobile' } }],
  };
  assert.equal(lookWarning(r), 'Part of the copy looks different from the original: on /blog (phone) the converted version is built differently. Open Compare to look.');
});

test('an as-is page that failed its visual check names the page and the screen size', () => {
  const r = passing();
  r.copy.pages.push({ path: '/contact', problems: [{ check: 'visual', width: 390, value: 50, min: 65 }, { check: 'hover', value: 0.5, min: 0.9 }] });
  assert.equal(lookWarning(r), 'Part of the copy looks different from the original: on /contact (phone) it does not look the same. Open Compare to look.');
});

test('the same page and cause at several sizes is one part; more than four parts are counted', () => {
  const r = passing();
  r.exact.pages.push({
    page: '/a',
    slots: [390, 768, 1440].map((width) => ({ width, accepted: false, heightOk: true, pixelsOk: true, boxes: { extra: 1 } })),
  });
  assert.match(lookWarning(r), /on \/a \(computer, tablet, phone\) something was added/);
  for (const page of ['/b', '/c', '/d', '/e', '/f']) r.copy.pages.push({ path: page, problems: [{ check: 'visual', width: 1440 }] });
  assert.match(lookWarning(r), /; and in 2 more places\. Open Compare to look\.$/);
});
