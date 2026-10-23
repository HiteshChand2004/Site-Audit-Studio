// "Still open" rows on an as-is copy (copy/gotWorse.js explainOpen, spec §5): a row failing on both sides carries one of the
// five reasons only on evidence the run measured, or is marked UNEXPLAINED — a fix the copy still owes — never given a reason by
// default, never left out. Also the per-page Lighthouse score rows (reaudit/lighthousePages.js) that got worse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainWorse } from '../src/copy/gotWorse.js';
import { notesEntries } from '../src/recreate/export/notes.js';

const SITE = 'https://www.example-original.test/';
const COPY = 'http://127.0.0.1:5555';
const base = { siteUrl: SITE, copyOrigin: COPY, copyPages: ['/'], chosenPages: ['/'] };
const openOne = (item, extra = {}) => explainWorse({ ...base, ...extra, items: [{ status: 'open', title: item.key, ...item }] }).open[0];
const worseOne = (item, extra = {}) => explainWorse({ ...base, ...extra, items: [{ status: 'regressed', title: item.key, ...item }] }).items[0];

const lhr = (audits) => ({ audits });
const weight = (bytes) => ({ 'total-byte-weight': { numericValue: bytes, numericUnit: 'byte' } });
const lcp = (selector, ms) => ({
  'largest-contentful-paint-element': { metricSavings: { LCP: ms }, details: { items: [{ items: [{ node: { selector, path: selector, snippet: `<${selector}>` } }] }] } },
});
const items = (id, urls) => ({ [id]: { details: { items: urls.map((url) => ({ url })) } } });

test('"still open" rows get one of the five reasons on evidence, or UNEXPLAINED; the counts come with them', () => {
  const r = explainWorse({
    ...base,
    items: [
      { status: 'regressed', key: 'links.broken-new', title: 'New broken links', links: { new: [{ url: 'https://example-original.test/pricing', status: 404 }] } },
      { status: 'open', key: 'seo.title-tag.length', title: 'Title length', after: { detail: '2 titles outside 10-60 characters.' } },
      { status: 'open', key: 'axe.color-contrast', title: 'Contrast', after: { detail: '5 elements.' } },
      { status: 'open', key: 'motion.hover', title: 'Hover effects kept', after: { detail: '3 of 9 found on the recreated site.' } },
      { status: 'fixed', key: 'seo.canonical-url', title: 'Canonical' },
    ],
  });
  assert.equal(r.items.length, 1, 'the rows that got worse are as before');
  assert.equal(r.open.length, 3, 'every open row, none fixed or passing');
  assert.deepEqual(r.open.map((o) => o.reason), ['owner', 'look', null]);
  assert.equal(r.open[2].unexplained, true, 'a motion effect the copy lost is a fix still owed, not a reason');
  assert.deepEqual(r.openSummary, { total: 3, explained: 2, unexplained: 1, byReason: { owner: 1, look: 1 } });
});

test('still open: Lighthouse audits are split by what they name: third-party code (a), fixable without a visible change (UNEXPLAINED), the original\'s own code (d), the host (e) only when the copy did not grow', () => {
  const third = openOne({ key: 'lighthouse.unused-javascript', after: { detail: 'Reduce unused JavaScript' } },
    { newLhr: { mobile: lhr(items('unused-javascript', ['https://www.googletagmanager.com/gtag/js', 'https://connect.facebook.net/en_US/fbevents.js'])) } });
  assert.equal(third.reason, 'third_party');
  assert.match(third.evidence, /googletagmanager\.com, connect\.facebook\.net/);

  const own = openOne({ key: 'lighthouse.unused-javascript', after: { detail: 'Reduce unused JavaScript' } },
    { newLhr: { mobile: lhr(items('unused-javascript', ['http://127.0.0.1:5555/assets/app.js', 'https://www.googletagmanager.com/gtag/js'])) } });
  assert.equal(own.reason, 'look', 'one of the files is the site\'s own: the as-is copy keeps it as written');
  assert.match(own.evidence, /app\.js/);

  const fixable = openOne({ key: 'lighthouse.modern-image-formats', after: { detail: 'Serve images in next-gen formats' } },
    { newLhr: { mobile: lhr(items('modern-image-formats', ['http://127.0.0.1:5555/img/hero.jpg'])) } });
  assert.equal(fixable.reason, null);
  assert.equal(fixable.unexplained, true);
  assert.match(fixable.evidence, /fix still owed/);

  const ms = (n) => ({ 'largest-contentful-paint': { numericValue: n, numericUnit: 'millisecond', score: 0.4 } });
  const timing = openOne({ key: 'lighthouse.largest-contentful-paint', after: { detail: '4.1 s' } },
    { oldLhr: { mobile: lhr({ ...ms(3000), ...weight(500000), ...lcp('img.hero', 3000) }) }, newLhr: { mobile: lhr({ ...ms(4000), ...weight(500000), ...lcp('img.hero', 4000) }) } });
  assert.equal(timing.reason, 'deploy', 'the same page, no heavier, the same largest element: the local preview against a host');

  const grew = openOne({ key: 'lighthouse.largest-contentful-paint', after: { detail: '4.1 s' } },
    { oldLhr: { mobile: lhr({ ...ms(3000), ...weight(500000), ...lcp('img.hero', 3000) }) }, newLhr: { mobile: lhr({ ...ms(4000), ...weight(900000), ...lcp('img.hero', 4000) }) } });
  assert.equal(grew.reason, null, 'a copy that sends more is not explained by the host');
});

test('still open: words only the owner writes (c), the original\'s own structure and colours (d), and the files that need a new address (c)', () => {
  assert.equal(openOne({ key: 'axe.image-alt' }).reason, 'owner');
  assert.equal(openOne({ key: 'axe.link-name' }).reason, 'owner');
  assert.equal(openOne({ key: 'axe.heading-order' }).reason, 'look');
  assert.equal(openOne({ key: 'axe.duplicate-id' }).reason, 'look');
  assert.equal(openOne({ key: 'axe.color-contrast' }).reason, 'look');
  assert.equal(openOne({ key: 'axe.some-new-rule' }).unexplained, true, 'a rule no table covers is not given a reason by default');
  assert.equal(openOne({ key: 'seo.headings.none' }).reason, 'look');
  assert.equal(openOne({ key: 'seo.image-alt-text' }).reason, 'owner');
  assert.equal(openOne({ key: 'seo.title-tag.missing' }).unexplained, true, 'the copy fills a missing title from the page, so an open one is owed');
  assert.equal(openOne({ key: 'seo.title-tag.missing' }, { revertedPages: ['/about/'] }).reason, 'look', 'unless the page\'s fixes were undone for changing it');
  const noAddress = { address: { used: null, detail: 'no address was given for the new site' } };
  assert.equal(openOne({ key: 'seo.canonical-url' }, noAddress).reason, 'owner');
  assert.match(openOne({ key: 'seo.canonical-url' }, noAddress).evidence, /no address was given/);
  assert.equal(openOne({ key: 'crawl.sitemap' }, noAddress).reason, 'owner');
  assert.equal(openOne({ key: 'crawl.sitemap' }, { address: { used: 'https://new.example.net' } }).unexplained, true, 'with an address the copy writes it, so an open row is owed');
  assert.equal(openOne({ key: 'aeo.llms-txt' }, noAddress).reason, 'owner');
  assert.equal(openOne({ key: 'aeo.ai-crawler-access' }).reason, 'owner');
  assert.equal(openOne({ key: 'platform.framer', after: { detail: 'Framer still detected.' } }).reason, 'look');
  assert.equal(openOne({ key: 'seo.https' }).reason, 'deploy');
});

test('still open: a link broken on both sides, to another site or to a page the original lacks too (c); to a page the copy holds (UNEXPLAINED)', () => {
  const r = openOne({ key: 'links.broken', links: { open: [
    { url: 'https://gone.example.org/x', status: 404 },
    { url: 'https://www.example-original.test/old-page', status: 404 },
  ] } });
  assert.equal(r.reason, 'owner');
  const held = openOne({ key: 'links.broken', links: { open: [{ url: 'https://www.example-original.test/', status: 500 }] } });
  assert.equal(held.reason, null);
  assert.equal(held.unexplained, true);
});

test('a per-page Lighthouse score row that got worse: performance is the host\'s only when the copy did not grow; the other categories follow the checks failing only in the copy', () => {
  const score = (extra) => worseOne({ key: 'lighthouse-score.mobile.performance./', before: { score: 70 }, after: { score: 61 }, lighthousePage: { mode: 'mobile', category: 'performance', weight: { original: 500000, copy: 505000 }, lcp: { original: { selector: 'img.hero', snippet: '<img class="hero">' }, copy: { selector: 'img.hero', snippet: '<img class="hero">' } }, failing: { original: [], copy: [] }, copyAudits: {}, ...extra } });
  assert.equal(score().reason, 'deploy');
  assert.match(score().evidence, /70 → 61 \(phone\)/);
  assert.equal(score({ weight: { original: 500000, copy: 800000 } }).reason, null, 'heavier: unexplained');
  assert.equal(score({ lcp: { original: { selector: 'img.hero', snippet: 'a' }, copy: { selector: 'h1', snippet: 'b' } } }).reason, null, 'another largest element: unexplained');

  const a11y = (failing, copyAudits) => worseOne({ key: 'lighthouse-score.desktop.accessibility./about/', before: { score: 90 }, after: { score: 84 }, lighthousePage: { mode: 'desktop', category: 'accessibility', failing, copyAudits } });
  assert.equal(a11y({ original: ['image-alt'], copy: ['image-alt', 'link-name'] }, { 'link-name': { title: 'Links do not have a discernible name', urls: [] } }).reason, 'owner');
  const mixed = a11y({ original: [], copy: ['link-name', 'brand-new-audit'] }, { 'link-name': { title: 'Links', urls: [] }, 'brand-new-audit': { title: 'Something new', urls: [] } });
  assert.equal(mixed.reason, null, 'one check no rule covers leaves the row unexplained');
  assert.match(mixed.evidence, /Something new/);
  assert.equal(a11y({ original: ['x'], copy: ['x'] }, {}).reason, null, 'the same checks on both sides: the score moved without a cause the row can name');
});

test('KNOWN-ISSUES.md also lists every "still open" row with its reason or UNEXPLAINED', () => {
  const shipped = { files: ['index.html'], read: () => null };
  const stillOpen = [
    { status: 'open', title: 'Title tag', before: { detail: '2 titles outside 10-60 characters' }, after: { detail: '2 titles outside 10-60 characters' }, reason: 'owner', reasonEvidence: 'The text is the owner\'s own' },
    { status: 'open', title: 'Hover effects kept', before: { detail: '9' }, after: { detail: '3 of 9' }, reason: null, unexplained: true, reasonEvidence: 'A fix still owed.' },
  ];
  const [, known] = notesEntries({ report: { baseUrl: SITE, asIs: {}, copy: { openItems: [], worse: [], stillOpen } }, stack: 'html', root: 'r', shipped });
  assert.match(known.content, /## Still open: Title tag[\s\S]*What this means: The text is the owner's own[\s\S]*Reason: c — /);
  assert.match(known.content, /## Still open: Hover effects kept[\s\S]*Tried: no automatic fix yet[\s\S]*Reason: UNEXPLAINED/);
});
