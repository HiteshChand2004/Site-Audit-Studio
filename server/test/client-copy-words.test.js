// The plain words of the app (client/src/copy.js): the four result words and the statuses they stand for, the four score
// names, the reason words, the one warning shown when the copy's own visual checks say part of it looks different (in the
// app and in the report), and the copy's own warnings without look scores.
// Pure functions and constants, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_KIND, copyStackOf, fixedLine, lookWarning, plainWarning, reasonWord, REASON_WORDS, RESULT_EXPLAIN, RESULT_WORD_FOR, RESULT_WORDS, resultTitle, SCORE_NAMES } from '../../client/src/copy.js';
import { lookWarning as reportLookWarning } from '../src/report/words.js';

// Every case below is checked on both the app's warning and the report's (report/words.js), which must say the same.
const look = (r, o) => {
  const app = lookWarning(r, o);
  if (!o) assert.equal(reportLookWarning(r), app, 'the report says the same as the app');
  return app;
};

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
  assert.equal(look(passing()), null);
  assert.equal(look({}), null);
  assert.equal(look(null), null);
});

test('a low match score names the page, the screen size and what differs', () => {
  const r = passing();
  r.fidelity.status = 'mixed';
  r.fidelity.lowPages = ['/about'];
  r.fidelity.pages.push({ path: '/about', low: true, lowViews: ['mobile', 'desktop'] });
  assert.equal(look(r), 'Part of the copy looks different from the original: on /about (computer, phone) parts have a different size or sit in a different place. Open Compare to look.');
  // Low over the whole site with no single page below the bar: every page.
  const all = passing();
  all.fidelity.status = 'low';
  assert.match(look(all), /on every page parts have a different size/);
});

test('a low visual difference names the page, the screen size and what differs', () => {
  const r = passing();
  r.fidelity.diff = { status: 'mixed', lowPages: ['/pricing'] };
  r.fidelity.pages.push({ path: '/pricing', low: false, lowViews: [], diff: { low: true, lowViews: ['tablet'] } });
  assert.equal(look(r), 'Part of the copy looks different from the original: on /pricing (tablet) it does not look the same. Open Compare to look.');
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
  const text = look(r);
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
  assert.equal(look(r), 'Part of the copy looks different from the original: on /blog (phone) the converted version is built differently. Open Compare to look.');
});

test('an as-is page that failed its visual check names the page and the screen size', () => {
  const r = passing();
  r.copy.pages.push({ path: '/contact', problems: [{ check: 'visual', width: 390, value: 50, min: 65 }, { check: 'hover', value: 0.5, min: 0.9 }] });
  assert.equal(look(r), 'Part of the copy looks different from the original: on /contact (phone) it does not look the same. Open Compare to look.');
});

test('the same page and cause at several sizes is one part; more than four parts are counted', () => {
  const r = passing();
  r.exact.pages.push({
    page: '/a',
    slots: [390, 768, 1440].map((width) => ({ width, accepted: false, heightOk: true, pixelsOk: true, boxes: { extra: 1 } })),
  });
  assert.match(look(r), /on \/a \(computer, tablet, phone\) something was added/);
  for (const page of ['/b', '/c', '/d', '/e', '/f']) r.copy.pages.push({ path: page, problems: [{ check: 'visual', width: 1440 }] });
  assert.match(look(r), /; and in 2 more places\. Open Compare to look\.$/);
});

test('on Compare the warning is for the page shown, plus what was found for every page, and does not send the reader to Compare', () => {
  const r = passing();
  r.copy.pages.push({ path: '/contact', problems: [{ check: 'visual', width: 390 }] }, { path: '/team', problems: [{ check: 'visual', width: 1440 }] });
  assert.equal(look(r, { page: '/contact' }), 'Part of the copy looks different from the original: on /contact (phone) it does not look the same.');
  assert.equal(look(r, { page: '/' }), null, 'nothing found on this page');
  r.fidelity.status = 'low';
  assert.equal(look(r, { page: '/' }), 'Part of the copy looks different from the original: on every page parts have a different size or sit in a different place.');
});

test('the copy’s own warnings: a look score covered by the warning is left out, a drift keeps its words without scores', () => {
  assert.equal(plainWarning('Overall fidelity is 72/100, below the 80 threshold. Compare the preview with the original before using the site.'), null);
  assert.equal(plainWarning('Fidelity is below 80/100 on 1 page: / (72).'), null);
  assert.equal(plainWarning('The visual difference score is 60/100, below 65: the recreated pages look clearly different from the originals. See the heatmaps in the report.'), null);
  assert.equal(plainWarning('The layout drifts from the original at 2 of 9 measured page widths between the captured sizes: / at 320px (61), /a at 480px (58).'),
    'The layout drifts from the original at 2 of 9 measured page widths between the captured sizes: / at 320px, /a at 480px.');
  assert.equal(plainWarning('Fidelity was not measured for 1 page (time limit of the build step): /x.'), 'Fidelity was not measured for 1 page (time limit of the build step): /x.');
});

test('Results: each row in plain words with its reason word; the four explanations; the one fixed line', () => {
  assert.equal(resultTitle({ key: 'aeo.llms-txt', title: 'llms.txt' }), 'Guide for AI tools');
  assert.equal(resultTitle({ key: 'platform.framer', title: 'Framer runtime' }), 'The site builder’s code is still in the copy');
  assert.equal(resultTitle({ key: 'x.unknown', title: 'Something new' }), 'Something new', 'an unknown check keeps its own title');
  assert.equal(reasonWord({ key: 'crawl.sitemap', reason: 'owner' }), REASON_WORDS.address);
  assert.equal(reasonWord({ key: 'seo.title-tag', reason: 'owner' }), REASON_WORDS.owner);
  assert.equal(reasonWord({ key: 'crawl.sitemapx', reason: 'owner' }), REASON_WORDS.owner, 'only the address checks themselves');
  assert.equal(reasonWord({ key: 'a', reason: null }), REASON_WORDS.unexplained);
  assert.equal(reasonWord({ key: 'a', reason: 'look+deploy' }), `${REASON_WORDS.look} · ${REASON_WORDS.deploy}`);
  assert.equal(reasonWord({ key: 'a' }), null, 'no reason given = no word');
  assert.deepEqual(Object.keys(RESULT_EXPLAIN), ['better', 'open', 'regressed', 'manual']);
  assert.doesNotMatch(RESULT_EXPLAIN.manual, /backend/i);
  assert.equal(fixedLine({ fixes: { counts: { alt: 12, names: 3, lang: 0 } } }), 'Fixed in the copy: 12 image descriptions, 3 names for links, buttons and fields.');
  assert.equal(fixedLine({ fixes: { counts: {} } }), null);
  assert.equal(fixedLine(null), null);
});

test('what the copy is, in plain words, from the technology it was packaged in', () => {
  assert.deepEqual(Object.keys(COPY_KIND), ['html', 'react-vite', 'nextjs', 'mern']);
  assert.equal(copyStackOf({ stack: 'html', asIs: { stack: 'react-vite' } }), 'react-vite', 'an as-is copy is packaged in asIs.stack');
  assert.equal(copyStackOf({ stack: 'nextjs' }), 'nextjs');
  assert.equal(copyStackOf(null, 'mern'), 'mern');
  for (const words of Object.values(COPY_KIND)) assert.doesNotMatch(words, /vite|express|mongo/i);
});
