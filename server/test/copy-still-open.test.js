// "Still open" rows on an as-is copy (copy/gotWorse.js explainOpen, spec §5): a row failing on both sides carries one of the
// five reasons only on evidence the run measured, or is marked UNEXPLAINED — a fix the copy still owes — never given a reason by
// default, never left out. Also the per-page Lighthouse score rows (reaudit/lighthousePages.js) that got worse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainWorse, markOutside } from '../src/copy/gotWorse.js';
import { dataPathsOf, liftNetworkFailures, questionsByPageOf, siteDataPaths } from '../src/reaudit/index.js';
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
  assert.deepEqual(r.open.map((o) => o.reason), [null, 'look', null]);
  assert.deepEqual(r.open.map((o) => o.group), ['bug', 'look', 'missing-fixer'], 'title length: the fix exists (Step 3) and recorded no reason, so a bug; motion: its own track');
  assert.equal(r.open[2].unexplained, true, 'a motion effect the copy lost is a fix still owed, not a reason');
  assert.deepEqual(r.openSummary, { total: 3, explained: 1, unexplained: 2, byReason: { look: 1 }, byGroup: { bug: 1, look: 1, 'missing-fixer': 1 } });
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
  assert.match(fixable.evidence, /Fix not built yet/);
  assert.equal(fixable.group, 'missing-fixer');

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

test('still open: an FAQ-schema row on pages with FAQ-like parts but not one question is the owner\'s (c, outside); one question anywhere, or no crawl, stays owed', () => {
  const row = { key: 'aeo.faq-schema', before: { status: 'fail', detail: 'FAQ-style content on 1 page (/app.html) has no FAQPage schema.' }, after: { status: 'fail', detail: 'FAQ-style content on 1 page (/app.html) has no FAQPage schema.' } };
  // A screen of collapsible settings panels (<details><summary>Printing</summary>): FAQ-like, but no question to mark up.
  const panels = { '/': { questions: 0, faqSignals: 0 }, '/app.html': { questions: 0, faqSignals: 5 } };
  const r = openOne(row, { copyPages: ['/', '/app.html'], questionsByPage: panels });
  assert.equal(r.reason, 'owner');
  assert.equal(r.group, 'needs-info');
  assert.equal(r.unexplained, undefined);
  assert.match(r.evidence, /\/app\.html.*not one question/);

  // It leaves "still open" for the calm section, and the top count follows.
  const checklist = { summary: { open: 1, regressed: 0 }, items: [{ status: 'open', key: row.key, reason: r.reason, group: r.group }] };
  markOutside(checklist);
  assert.equal(checklist.items[0].outside, true);
  assert.equal(checklist.summary.open, 0);
  assert.equal(checklist.outside.open, 1);

  // A real FAQ the copy did not mark up stays a fix still owed: one question (a heading or a summary) is enough to keep it.
  assert.equal(openOne(row, { questionsByPage: { '/app.html': { questions: 1, faqSignals: 5 } } }).unexplained, true);
  assert.equal(openOne(row, { questionsByPage: { '/faq/': { questions: 6, faqSignals: 1 } } }).unexplained, true);
  // Every failing page must be question-free: one page with questions keeps the row owed.
  assert.equal(openOne(row, { questionsByPage: { '/app.html': { questions: 0, faqSignals: 5 }, '/help/': { questions: 3, faqSignals: 2 } } }).unexplained, true);
  // No crawl facts, or unreadable ones: nothing is assumed.
  assert.equal(openOne(row).unexplained, true);
  assert.equal(openOne(row, { questionsByPage: { '/app.html': { questions: NaN, faqSignals: 5 } } }).unexplained, true);
  // The rule is the FAQ row's only: another structured-data row is unchanged.
  assert.equal(openOne({ key: 'aeo.json-ld-schema', after: { detail: 'No structured data found.' } }, { questionsByPage: panels }).unexplained, true);
});

test('questionsByPageOf reads the crawl\'s question headings and FAQ-like parts per page path', () => {
  const crawl = { pages: [
    { url: 'http://127.0.0.1:5555/app.html', facts: { questionHeadings: [], faqSignals: 5 } },
    { url: 'http://127.0.0.1:5555/faq/', facts: { questionHeadings: [{ text: 'Why?' }, { text: 'How?' }], faqSignals: 1 } },
    { url: 'not a url', facts: {} },
  ] };
  assert.deepEqual(questionsByPageOf(crawl), { '/app.html': { questions: 0, faqSignals: 5 }, '/faq/': { questions: 2, faqSignals: 1 } });
  assert.equal(questionsByPageOf(null), null);
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

test('a Best practices score row counts only that category\'s checks; its console errors are read request by request (backend, a file lost to the network)', () => {
  const bp = (extra = {}, copyAudits = {}) => worseOne({
    key: 'lighthouse-score.desktop.best-practices./faq/a/', page: '/faq/a/', before: { score: 100 }, after: { score: 96 },
    lighthousePage: {
      mode: 'desktop', category: 'best-practices',
      failing: { original: [], copy: ['max-potential-fid', 'errors-in-console'] },
      copyFailingByCategory: { 'best-practices': [{ id: 'errors-in-console', weight: 1 }], performance: [{ id: 'max-potential-fid', weight: 0 }] },
      copyAudits: {
        'max-potential-fid': { title: 'Max Potential First Input Delay', urls: [] },
        'errors-in-console': { title: 'Browser errors were logged to the console', urls: [`${COPY}/api/v1/items/a`, `${COPY}/favicon.svg`] },
        ...copyAudits,
      },
    },
  }, extra);
  // Backend known, favicon lost to the network while copying: still owed, with the true cause; never the speed check.
  const both = bp({ backendPaths: ['/api/v1/items/a'], liftFailures: [{ url: 'https://example-original.test/favicon.svg', reason: 'dns' }] });
  assert.equal(both.reason, null);
  assert.doesNotMatch(both.evidence, /Max Potential/, 'a speed check never explains a Best practices score');
  assert.match(both.evidence, /\/favicon\.svg: the original serves it, but it could not be downloaded while the copy was made because the network was down \(dns\)/);
  assert.match(both.evidence, /\/api\/v1\/items\/a/);
  // Every failed request has a reason: the row is explained (the backend).
  const api = bp({ backendPaths: ['/api/v1/items/a'] }, { 'errors-in-console': { title: 'Browser errors were logged to the console', urls: [`${COPY}/api/v1/items/a`] } });
  assert.equal(api.reason, 'backend');
  assert.equal(api.unexplained, undefined);
  // Without the lift's failure the missing file stays a plain fix owed ("does not hold the file").
  assert.match(bp({ backendPaths: ['/api/v1/items/a'] }).evidence, /does not hold the file \/favicon\.svg/);
  // A row kept before copyFailingByCategory was recorded: the old list (every category) still applies.
  const old = worseOne({ key: 'lighthouse-score.desktop.best-practices./', before: { score: 100 }, after: { score: 96 }, lighthousePage: { mode: 'desktop', category: 'best-practices', failing: { original: [], copy: ['brand-new-audit'] }, copyAudits: { 'brand-new-audit': { title: 'Something new', urls: [] } } } });
  assert.match(old.evidence, /Something new/);
});

test('an older Best practices row (no copyFailingByCategory): the saved Lighthouse report says which checks are the category\'s, so a speed check never leaves it unexplained', () => {
  const report = { categories: {
    'best-practices': { auditRefs: [{ id: 'errors-in-console', weight: 1 }, { id: 'brand-new-audit', weight: 5 }] },
    performance: { auditRefs: [{ id: 'interactive', weight: 0 }, { id: 'max-potential-fid', weight: 0 }, { id: 'largest-contentful-paint', weight: 25 }] },
  }, audits: {} };
  const row = (mode, speed) => worseOne({
    key: `lighthouse-score.${mode}.best-practices./login/`, page: '/login/', before: { score: 100 }, after: { score: 96 },
    lighthousePage: { mode, category: 'best-practices',
      failing: { original: ['largest-contentful-paint'], copy: [speed, 'errors-in-console', 'largest-contentful-paint'] },
      copyAudits: { [speed]: { title: speed, urls: [] }, 'errors-in-console': { title: 'Browser errors were logged to the console', urls: [`${COPY}/auth/me`] } } },
  }, { backendPaths: ['/auth/me'], newLhr: { [mode]: report } });
  for (const [mode, speed] of [['mobile', 'interactive'], ['desktop', 'max-potential-fid']]) {
    const r = row(mode, speed);
    assert.equal(r.reason, 'backend', `${mode}: ${r.evidence}`);
    assert.equal(r.unexplained, undefined);
    assert.doesNotMatch(r.evidence, new RegExp(speed));
    assert.match(r.evidence, /\/auth\/me/);
  }
  // A check of the category that no rule covers still leaves it unexplained.
  const own = worseOne({ key: 'lighthouse-score.mobile.best-practices./', before: { score: 100 }, after: { score: 92 },
    lighthousePage: { mode: 'mobile', category: 'best-practices', failing: { original: [], copy: ['interactive', 'brand-new-audit'] }, copyAudits: { 'brand-new-audit': { title: 'Something new', urls: [] } } } },
  { newLhr: { mobile: report } });
  assert.equal(own.reason, null);
  assert.match(own.evidence, /Something new/);
  assert.doesNotMatch(own.evidence, /interactive/);
});

test('siteDataPaths: a data address the copy left as the original does, read from the site host\'s own part of a reason that names several hosts', () => {
  const same = [
    { path: '/auth/me', reason: 'www.example-original.test: not-an-asset; fonts.googleapis.com: http-404; fonts.gstatic.com: http-404' },
    { path: '/api/billing/me', reason: 'example-original.test: http-401; fonts.gstatic.com: http-404' },
    { path: '/api/plain', reason: 'not-an-asset' },
    { path: '/missing.png', reason: 'example-original.test: http-404; fonts.gstatic.com: not-an-asset' },
    { path: '/api/other', reason: 'api.someone-else.test: not-an-asset' },
    { path: '/api/rule', reason: 'api.example-backend.test: not-an-asset' },
  ];
  assert.deepEqual(siteDataPaths(same, { siteUrl: SITE, hosts: ['api.example-backend.test'] }).sort(), ['/api/billing/me', '/api/plain', '/api/rule', '/auth/me']);
  assert.deepEqual(siteDataPaths(null, { siteUrl: SITE }), []);
});

test('contrast: an element failing only in the copy with exactly the colours the original draws it with (its capture) is the original\'s own (d)', () => {
  const node = (html, fg, bg, target) => ({ html, target: [target], any: [{ data: { fgColor: fg, bgColor: bg, contrastRatio: 4.3 } }] });
  const axe = (nodes) => ({ violations: [{ id: 'color-contrast', nodes }] });
  const known = node('<a href="/x">Known</a>', '#ada5a3', '#ffffff', 'li > a');
  const kicker = node('<p class="kicker">Sound familiar?</p>', '#6e5ce6', '#f2f0fe', '.visible > .kicker');
  // The original's capture: the kicker inside a block, its colour on itself, a translucent background laid over white.
  const capture = (color) => ({
    htmlStyle: { 'background-color': 'rgba(0, 0, 0, 0)' },
    body: { tag: 'body', style: { 'background-color': 'rgb(255, 255, 255)' }, children: [
      { tag: 'section', style: {}, children: [
        { tag: 'div', attrs: { class: 'fade-up' }, style: { opacity: '0' }, children: [
          { tag: 'p', attrs: { class: 'kicker' }, style: { color, 'background-color': 'rgba(182, 170, 252, 0.18)' }, children: [{ text: 'Sound familiar?' }] },
        ] },
      ] },
    ] },
  });
  const row = (originalCapture) => worseOne({ key: 'axe.color-contrast', before: { count: 1 }, after: { count: 2 } }, { oldAxe: axe([known]), newAxe: axe([known, kicker]), originalCapture });
  const own = row(capture('rgb(110, 92, 230)'));
  assert.equal(own.reason, 'look');
  assert.equal(own.group, 'look');
  assert.match(own.evidence, /exactly the colours the original draws it with/);
  // Another colour on the original (the copy changed it), no capture, or an element the capture lacks: still our bug.
  assert.equal(row(capture('rgb(20, 20, 20)')).reason, null);
  assert.equal(row(null).reason, null);
  const other = worseOne({ key: 'axe.color-contrast' }, { oldAxe: axe([known]), newAxe: axe([known, node('<p class="kicker">Something else</p>', '#6e5ce6', '#f2f0fe', 'p')]), originalCapture: capture('rgb(110, 92, 230)') });
  assert.equal(other.reason, null);
});

test('contrast: an element caught mid-fade (text AND background = the original\'s colours at one common opacity) is the original\'s own; anything else stays red', async () => {
  const { fadeOpacity } = await import('../src/copy/gotWorse.js');
  const node = (html, fg, bg, target) => ({ html, target: [target], any: [{ data: { fgColor: fg, bgColor: bg, contrastRatio: 4.46 } }] });
  const axe = (nodes) => ({ violations: [{ id: 'color-contrast', nodes }] });
  const known = node('<a href="/x">Known</a>', '#ada5a3', '#ffffff', 'li > a');
  // The original: a white menu panel (the part that fades in) on a light blue page, its text #445063.
  const capture = {
    htmlStyle: { 'background-color': 'rgba(0, 0, 0, 0)' },
    body: { tag: 'body', style: { 'background-color': 'rgb(232, 241, 255)' }, children: [
      { tag: 'div', attrs: { class: 'menu' }, style: { 'background-color': 'rgb(255, 255, 255)', opacity: '0.25' }, children: [
        { tag: 'p', attrs: { class: 'item' }, style: { color: 'rgb(68, 80, 99)' }, children: [{ text: 'Clinic' }] },
      ] },
    ] },
  };
  const row = (fg, bg, html = '<p class="item">Clinic</p>', originalCapture = capture) => worseOne({ key: 'axe.color-contrast', before: { count: 1 }, after: { count: 2 } }, { oldAxe: axe([known]), newAxe: axe([known, node(html, fg, bg, '.menu > .item')]), originalCapture });
  // The copy read at ~76 % opacity: #445063 on white over the page's blue → #6b7688 on #fafcff.
  const faded = row('#6b7688', '#fafcff');
  assert.equal(faded.reason, 'look');
  assert.match(faded.evidence, /caught mid-fade/);
  assert.match(faded.evidence, /76 % opacity/);
  // The text at one opacity and the background at another: no single opacity explains both.
  assert.equal(row('#6b7688', '#eff5ff').reason, null);
  // A colour that is no blend of the original's.
  assert.equal(row('#8b3a3a', '#fafcff').reason, null);
  // The element is not in the capture, or there is no capture.
  assert.equal(row('#6b7688', '#fafcff', '<p class="item">Something else</p>').reason, null);
  assert.equal(row('#6b7688', '#fafcff', undefined, null).reason, null);
  // The rule itself: fully drawn (opacity 1) is the exact-colour rule's case, not this one.
  const c = { fg: [68, 80, 99], bg: [255, 255, 255], backdrops: [[255, 255, 255], [232, 241, 255]] };
  assert.equal(fadeOpacity(c, [107, 118, 136], [250, 252, 255]), 0.763);
  assert.equal(fadeOpacity(c, [68, 80, 99], [255, 255, 255]), null);
});

test('dataPathsOf: the data addresses the original asked its own servers (site or a host excluded by rule) for; liftNetworkFailures: files lost to the network', () => {
  const record = { entries: [
    { url: 'https://api.example-backend.test/api/v1/items?page=1', kind: 'data' },
    { url: 'https://www.example-original.test/api/v1/me', kind: 'data' },
    { url: 'https://tracker.test/collect', kind: 'data' },
    { url: 'https://www.example-original.test/app.js', kind: 'script' },
  ] };
  assert.deepEqual(dataPathsOf(record, { siteUrl: SITE, hosts: ['api.example-backend.test'] }).sort(), ['/api/v1/items', '/api/v1/me']);
  assert.deepEqual(dataPathsOf(null, { siteUrl: SITE }), []);
  const report = { asIs: { lift: { pages: [
    { downloads: { failedUrls: [{ url: 'https://example-original.test/favicon.svg', reason: 'dns' }, { url: 'https://example-original.test/big.mp4', reason: 'too-large' }] } },
    { downloads: { failedUrls: [{ url: 'https://example-original.test/a.png', reason: 'refused' }] } },
  ] } } };
  assert.deepEqual(liftNetworkFailures(report).map((f) => f.url), ['https://example-original.test/favicon.svg', 'https://example-original.test/a.png']);
  assert.deepEqual(liftNetworkFailures({}), []);
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

test('a sitemap, robots, llms.txt or canonical row that got worse with no new-site address: the owner decides (c); with an address it stays unexplained', () => {
  const noAddress = { address: { used: null, detail: 'no address was given for the new site' } };
  const r = worseOne({ key: 'crawl.sitemap', before: { detail: '/sitemap.xml · 64 URLs' }, after: { detail: '/sitemap.xml → 404' } }, noAddress);
  assert.equal(r.reason, 'owner');
  assert.match(r.evidence, /no address was given for the new site/);
  assert.equal(worseOne({ key: 'aeo.llms-txt' }, noAddress).reason, 'owner');
  assert.equal(worseOne({ key: 'crawl.sitemap', after: { detail: '/sitemap.xml → 404' } }, { address: { used: 'https://new.example.net' } }).unexplained, true);
  assert.equal(worseOne({ key: 'crawl.sitemap', after: { detail: '/sitemap.xml → 404' } }).unexplained, true, 'without address information nothing is assumed');
});

test('still open image rows: only a lossy or resized file could close them (d), on evidence per file; without evidence still owed', () => {
  const rows = (id, list) => ({ [id]: { details: { items: list.map(([url, wastedBytes]) => ({ url, wastedBytes })) } } });
  const row = (id, copyRows, originalRows, extra = {}) => openOne({ key: `lighthouse.${id}`, after: { detail: 'Images could be smaller' } },
    { newLhr: { mobile: lhr(rows(id, copyRows)) }, oldLhr: { mobile: lhr(rows(id, originalRows)) }, ...extra });

  // The copy already holds a lossless WebP of the original's PNG: more saving needs a lossy file.
  const ours = row('modern-image-formats', [[`${COPY}/img/hero.sas-0123456789.webp`, 30000]], []);
  assert.equal(ours.reason, 'look');
  assert.match(ours.evidence, /already a lossless WebP the copy made/);

  // The very file the original's CDN serves (the lift named it hero~<hash>.jpg from hero.jpg?w=800), the same saving.
  const served = row('uses-responsive-images', [[`${COPY}/img/hero~1a2b3c4d.jpg`, 40000]], [['https://cdn.example-original.test/img/hero.jpg?w=800', 41000]]);
  assert.equal(served.reason, 'look');
  assert.match(served.evidence, /the original serves this file \(cdn\.example-original\.test\)/);
  assert.match(served.evidence, /only a lossy or resized file could close it/);

  // The copy could save much more than the original on the same file: it holds a heavier file. Not a look change: still owed.
  const heavier = row('uses-responsive-images', [[`${COPY}/img/hero.jpg`, 400000]], [['https://www.example-original.test/img/hero.jpg', 41000]]);
  assert.equal(heavier.reason, null);
  assert.equal(heavier.group, 'missing-fixer');

  // A PNG the fix left: explained only with the fix's own reason for leaving it.
  const png = [[`${COPY}/img/logo.png`, 9000]];
  const pngOriginal = [['https://www.example-original.test/img/logo.png', 9000]];
  assert.equal(row('modern-image-formats', png, pngOriginal).group, 'missing-fixer', 'no reason recorded: not explained');
  const left = row('modern-image-formats', png, pngOriginal, { fixOpen: [{ kind: 'webp', page: '/', reason: 'd', detail: '/img/logo.png is not converted to WebP: it carries gAMA' }] });
  assert.equal(left.reason, 'look');
  assert.match(left.evidence, /it carries gAMA/);

  // One file explained, one not: the row is not explained.
  assert.equal(row('modern-image-formats', [[`${COPY}/img/hero.sas-0123456789.webp`, 30000], [`${COPY}/img/new.jpg`, 5000]], []).group, 'missing-fixer');
  // Not a per-file image audit: unchanged.
  assert.equal(row('offscreen-images', [[`${COPY}/img/hero.sas-0123456789.webp`, 30000]], []).group, 'missing-fixer');
});

// Pages behind a sign-in: the server sends an empty shell, and with no one signed in the site's own script shows its sign-in page
// (the same title and heading). The copy runs the same script, so the duplicate is the original's backend, not a text to fix.
// A real duplicate (two pages with content of their own sharing a title) stays a fix still owed.
test('duplicate titles a sign-in gate makes are the backend; a real duplicate stays a fix still owed', () => {
  const page = (origin, at, title, heading, { shell = false, text = 800 } = {}) => ({
    url: `${origin}${at}`, status: 200,
    facts: { title, metaDescription: `About ${at}`, headings: [{ level: 2, text: heading }], textLength: text, rawTextLength: shell ? 22 : text, ...(shell && { rendered: true }) },
  });
  const site = (origin, slash) => [
    page(origin, '/', 'Home · Brand', 'Price what gets built.'),
    page(origin, `/login${slash}`, 'Sign in · Brand', 'Pick up where you left off.'),
    page(origin, `/projects${slash}`, 'Sign in · Brand', 'Pick up where you left off.', { shell: true }),
    page(origin, `/estimate/new${slash}`, 'Sign in · Brand', 'Pick up where you left off.', { shell: true }),
  ];
  const ORIG = 'https://www.example-original.test';
  const crawls = { original: { pages: site(ORIG, '') }, copy: { pages: site(COPY, '/') } };
  const row = { key: 'seo.title-tag.duplicate', after: { detail: '3 pages share a duplicate title: /login/, /estimate/new/, /projects/.' } };
  const gated = openOne(row, { crawls });
  assert.equal(gated.reason, 'backend', JSON.stringify(gated));
  assert.equal(gated.group, 'needs-info');
  assert.match(gated.evidence, /\/estimate\/new, \/projects show \/login/);
  assert.match(gated.evidence, /on the original too/);

  const owed = (c, why) => assert.equal(openOne(row, { crawls: c }).unexplained, true, why);
  // Two pages with real content of their own sharing a title: a real duplicate.
  const real = (origin) => [page(origin, '/', 'Home · Brand', 'Welcome'), page(origin, '/about', 'Brand', 'About us'), page(origin, '/team', 'Brand', 'Our team')];
  owed({ original: { pages: real(ORIG) }, copy: { pages: real(COPY) } }, 'a real duplicate stays a fix still owed');
  // A shell showing the same title but another heading: not the other page, a real duplicate.
  owed({ original: crawls.original, copy: { pages: site(COPY, '/').map((p) => (p.url.endsWith('/projects/') ? { ...p, facts: { ...p.facts, headings: [{ level: 1, text: 'Your estimates' }] } } : p)) } }, 'another heading');
  // The original does not show the same duplicate (its /projects had its own title).
  owed({ original: { pages: site(ORIG, '').map((p) => (p.url.endsWith('/projects') ? { ...p, facts: { ...p.facts, title: 'Your estimates · Brand' } } : p)) }, copy: crawls.copy }, 'not the same duplicate on the original');
  // Only shells in the group (no real page they show): nothing to point at.
  owed({ original: { pages: site(ORIG, '').filter((p) => !p.url.endsWith('/login')) }, copy: { pages: site(COPY, '/').filter((p) => !p.url.endsWith('/login/')) } }, 'shells only');
  // A gate plus one real duplicate elsewhere: the whole row stays owed.
  const mixed = (origin, slash) => [...site(origin, slash), page(origin, `/about${slash}`, 'Brand', 'About'), page(origin, `/team${slash}`, 'Brand', 'Team')];
  owed({ original: { pages: mixed(ORIG, '') }, copy: { pages: mixed(COPY, '/') } }, 'a real duplicate beside the gate');
  // No crawls read: as before.
  owed(null, 'no crawl');
});
