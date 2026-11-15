// "Got worse" on an as-is copy (copy/gotWorse.js): each regressed row carries one of the five reasons only on evidence the run
// measured, and a row no rule backs is marked unexplained, never given a reason by default, never left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainWorse, reasonText } from '../src/copy/gotWorse.js';
import { notesEntries } from '../src/recreate/export/notes.js';

const SITE = 'https://www.example-original.test/';
const COPY = 'http://127.0.0.1:5555';
const base = { siteUrl: SITE, copyOrigin: COPY, copyPages: ['/'], chosenPages: ['/'] };
const one = (item, extra = {}) => explainWorse({ ...base, ...extra, items: [{ status: 'regressed', title: item.key, ...item }] }).items[0];

const lhr = (audits) => ({ audits });
const weight = (bytes) => ({ 'total-byte-weight': { numericValue: bytes, numericUnit: 'byte' } });
const lcp = (selector, ms) => ({
  'largest-contentful-paint-element': { metricSavings: { LCP: ms }, details: { items: [{ items: [{ node: { selector, path: selector, snippet: `<${selector}>` } }] }] } },
});
const requests = (types) => ({ 'network-requests': { details: { items: types.map((resourceType) => ({ resourceType })) } } });
const LOAD = ['Document', 'Stylesheet', 'Script', 'Script', 'Image'];

test('links to pages that were not chosen for the copy: the owner decides (c); a page asked for, or a file, is unexplained', () => {
  const left = one({ key: 'links.broken-new', links: { new: [{ url: 'https://www.example-original.test/pricing', status: 404, foundOn: '/' }] } });
  assert.equal(left.reason, 'owner');
  assert.equal(left.evidence, 'These pages of your site were not copied: /pricing. The copy holds 1 page (/). The links to them are still in the copy, '
    + 'and there they lead to a "page not found" error (404); on the original they work. To fix it: make the copy again with these pages included, '
    + 'or change or remove the links to them in the copy before you publish it.');

  const asked = one({ key: 'links.broken-new', links: { new: [{ url: 'https://example-original.test/about', status: 404 }] } }, { chosenPages: ['/', '/about/'] });
  assert.equal(asked.reason, null);
  assert.equal(asked.unexplained, true);
  assert.match(asked.evidence, /asked for but is not in the copy/);

  const file = one({ key: 'links.broken-new', links: { new: [{ url: 'https://example-original.test/brochure.pdf', status: 404 }] } });
  assert.equal(file.reason, null, 'a file the copy lacks is a fix still owed');

  const held = one({ key: 'links.broken-new', links: { new: [{ url: 'https://example-original.test/', status: 500 }] } });
  assert.equal(held.reason, null, 'the copy holds this page, so its failing is not a choice');

  const external = one({ key: 'links.broken-new', links: { new: [{ url: 'https://gone.example.org/x', status: 404 }] } });
  assert.equal(external.reason, 'owner', 'a dead link to another site is the owner\'s decision');
});

test('console errors: third-party hosts (a), prefetches of pages not copied (c), a missing file of the copy is unexplained', () => {
  const errors = (urls) => ({ mobile: lhr({ 'errors-in-console': { details: { items: urls.map((url) => ({ source: 'network', description: 'Failed to load resource', sourceLocation: { url } })) } } }) });
  const third = one({ key: 'lighthouse.errors-in-console' }, { newLhr: errors(['https://widgets.other.example/w.js']) });
  assert.equal(third.reason, 'third_party');

  const prefetch = one({ key: 'lighthouse.errors-in-console' }, { newLhr: errors([`${COPY}/contact?_rsc=abc`, `${COPY}/about?_rsc=abc`]) });
  assert.equal(prefetch.reason, 'owner');

  const mixed = one({ key: 'lighthouse.errors-in-console' }, { newLhr: errors([`${COPY}/contact?_rsc=abc`, `${COPY}/assets/hero.mp4`]) });
  assert.equal(mixed.reason, null, 'one part without a reason leaves the whole row unexplained');
  assert.match(mixed.evidence, /1 of 2 console errors have no reason: .*hero\.mp4/);
  assert.equal(mixed.parts.length, 2, 'every part is kept with its own verdict');

  // A slice of a file the original serves in pieces (a runtime's binary index): a file, not a page, whatever its extension's length.
  const ranged = one({ key: 'lighthouse.errors-in-console' }, { newLhr: errors([`${COPY}/cms/a1b2/index-default-0.sitecms?range=0-120`]) });
  assert.equal(ranged.reason, null, 'a missing file is unexplained');
  assert.match(ranged.evidence, /serves in pieces/, 'and the evidence says what the copy must do');
  assert.doesNotMatch(ranged.evidence, /page that was not copied/, 'never taken for a page the owner left out');

  const both = one({ key: 'lighthouse.errors-in-console' }, { newLhr: errors([`${COPY}/contact?_rsc=abc`, 'https://widgets.other.example/w.js']) });
  assert.equal(both.reason, 'owner+third_party', 'parts with different reasons name each one');
  assert.match(reasonText(both.reason), /^c — .* \/ a — /);
});

test('Lighthouse: a check whose amount did not grow is the host (e); one that grew, or a different largest element, is unexplained', () => {
  const bytes = (n) => ({ 'unused-javascript': { details: { overallSavingsBytes: n }, score: 0 } });
  const same = one({ key: 'lighthouse.unused-javascript' }, { oldLhr: { mobile: lhr(bytes(67000)) }, newLhr: { mobile: lhr(bytes(23000)) } });
  assert.equal(same.reason, 'deploy');
  assert.match(same.evidence, /did not grow/);

  const grew = one({ key: 'lighthouse.unused-javascript' }, { oldLhr: { mobile: lhr(bytes(20000)) }, newLhr: { mobile: lhr(bytes(90000)) } });
  assert.equal(grew.reason, null);
  assert.match(grew.evidence, /grew in the copy/);

  const time = (sel, ms, w, load = LOAD) => lhr({ ...lcp(sel, ms), ...weight(w), ...(load ? requests(load) : {}) });
  const host = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1.hero', 0, 500000) }, newLhr: { mobile: time('h1.hero', 650, 495000) } });
  assert.equal(host.reason, 'deploy', 'the same bytes, the same largest element, the same requests: only slower on the local preview');
  assert.equal(host.group, 'measurement', 'shown as "only reads worse", not hidden');
  assert.match(host.evidence, /0 → 650 ms/, 'both numbers');
  assert.match(host.evidence, /488 KB → 483 KB/);
  assert.match(host.evidence, /the same requests \(5 \(2 Script, 1 Document, 1 Stylesheet, 1 Image\)\)/);

  // Strict: any one of the three that is not the same keeps the row counted, with the difference named.
  const lighter = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1.hero', 0, 500000) }, newLhr: { mobile: time('h1.hero', 650, 450000) } });
  assert.equal(lighter.reason, null, 'a copy 10 % lighter is still not the same page');
  assert.match(lighter.evidence, /weighs 439 KB against the original's 488 KB/);
  const moreRequests = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1.hero', 0, 500000) }, newLhr: { mobile: time('h1.hero', 650, 500000, [...LOAD, 'Fetch']) } });
  assert.equal(moreRequests.reason, null, 'one more request: not the same load');
  assert.match(moreRequests.evidence, /other requests than the original: 6 .*1 Fetch.* against 5/);
  const swapped = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1.hero', 0, 500000) }, newLhr: { mobile: time('h1.hero', 650, 500000, ['Document', 'Stylesheet', 'Script', 'Image', 'Image']) } });
  assert.equal(swapped.reason, null, 'as many requests, of other types: not the same load');
  const noRequests = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1.hero', 0, 500000) }, newLhr: { mobile: time('h1.hero', 650, 500000, null) } });
  assert.equal(noRequests.reason, null, 'requests not measured: no proof');
  assert.match(noRequests.evidence, /requests are not in both reports/);
  const noElement = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: lhr({ ...weight(500000), ...requests(LOAD) }) }, newLhr: { mobile: time('h1.hero', 650, 500000) } });
  assert.equal(noElement.reason, null, 'the largest element named on one side only: no proof');

  const other = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('video.hero', 5000, 29e6) }, newLhr: { mobile: time('img.banner', 14000, 4e6) } });
  assert.equal(other.reason, null, 'a missing video made another element the largest: not the host');
  assert.match(other.evidence, /not the same one/);

  const heavier = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1', 0, 500000) }, newLhr: { mobile: time('h1', 900, 900000) } });
  assert.equal(heavier.reason, null);
});

test('contrast: the original\'s own colours seen more often is its look (d); a colour the original never failed with is unexplained', () => {
  const axe = (nodes) => ({ violations: [{ id: 'color-contrast', nodes: nodes.map(([target, fg]) => ({ target: [target], html: `<span class="${target}">`, any: [{ data: { fgColor: fg, bgColor: '#ffffff', contrastRatio: 3.16 } }] })) }] });
  const oldAxe = axe([['.chip:nth-child(1)', '#8b90a5'], ['.label', '#8b90a5']]);
  const more = one({ key: 'axe.color-contrast' }, { oldAxe, newAxe: axe([['.chip:nth-child(1)', '#8b90a5'], ['.chip:nth-child(8)', '#8b90a5'], ['.label', '#8b90a5']]) });
  assert.equal(more.reason, 'look');
  const fresh = one({ key: 'axe.color-contrast' }, { oldAxe, newAxe: axe([['.chip:nth-child(1)', '#8b90a5'], ['.new', '#bbbbbb']]) });
  assert.equal(fresh.reason, null);
  assert.match(fresh.evidence, /colours the original does not fail with/);
});

test('a check no rule covers is unexplained, and the summary counts every row', () => {
  const r = explainWorse({
    ...base,
    items: [
      { status: 'regressed', key: 'motion.hover', title: 'Hover effects kept' },
      { status: 'regressed', key: 'links.broken-new', title: 'New broken links', links: { new: [{ url: 'https://example-original.test/pricing', status: 404 }] } },
      { status: 'open', key: 'seo.title-tag', title: 'Title' },
    ],
  });
  assert.equal(r.items.length, 2, 'only the rows that got worse, all of them');
  assert.deepEqual(r.summary, { total: 2, explained: 1, unexplained: 1, byReason: { owner: 1 }, byGroup: { 'missing-fixer': 1, 'needs-info': 1 } });
  assert.equal(r.items[0].unexplained, true);
  assert.equal(r.items[0].group, 'missing-fixer', 'motion is its own track: owed, not a bug');
  assert.match(reasonText(null), /^UNEXPLAINED/);
});

test('every row gets one of the seven groups; only what nothing explains and no planned fix covers is "our bug"', () => {
  const r = explainWorse({
    ...base,
    oldLhr: { mobile: lhr({ 'unused-javascript': { score: 0, details: { overallSavingsBytes: 50000, items: [{ url: 'https://www.example-original.test/app.js' }] } } }) },
    newLhr: { mobile: lhr({ 'unused-javascript': { score: 0, details: { overallSavingsBytes: 48000, items: [{ url: `${COPY}/app.js` }] } } }) },
    items: [
      { status: 'open', key: 'seo.title-tag.length', title: 'Title length', after: { detail: '/: 74 characters' } },
      { status: 'open', key: 'crawl.meta-tags', title: 'Meta tags', after: { detail: 'theme-color ✗' } },
      { status: 'open', key: 'axe.aria-prohibited-attr', title: 'ARIA' },
      { status: 'open', key: 'lighthouse.modern-image-formats', title: 'Images' },
      { status: 'open', key: 'lighthouse.prioritize-lcp-image', title: 'LCP priority' },
      { status: 'open', key: 'lighthouse.unused-javascript', title: 'Unused JS' },
      { status: 'open', key: 'platform.nextjs', title: 'Next.js' },
      { status: 'open', key: 'axe.heading-order', title: 'Headings' },
      { status: 'open', key: 'seo.canonical-url', title: 'Canonical' },
      { status: 'open', key: 'crawl.https', title: 'HTTPS' },
      { status: 'open', key: 'something.unknown', title: 'Unknown' },
    ],
  });
  const g = Object.fromEntries(r.open.map((i) => [i.key, i.group]));
  assert.deepEqual(g, {
    'seo.title-tag.length': 'bug',
    // Step 3 built the theme colour / icon fix: still missing with no reason recorded (no fixOpen) is a bug.
    'crawl.meta-tags': 'bug',
    // Step 4 built the role="img" fix: still failing with no reason recorded (no fixOpen) is a bug.
    'axe.aria-prohibited-attr': 'bug',
    'lighthouse.modern-image-formats': 'missing-fixer',
    'lighthouse.prioritize-lcp-image': 'bug',
    'lighthouse.unused-javascript': 'own-code',
    'platform.nextjs': 'own-code',
    'axe.heading-order': 'look',
    'seo.canonical-url': 'needs-info',
    'crawl.https': 'measurement',
    'something.unknown': 'bug',
  });
  assert.match(r.open[0].evidence, /still outside the range: a bug to report/, 'the fix exists now (Step 3)');
  assert.equal(r.openSummary.byGroup.bug, 5, 'title length + meta tags (Step 3), prohibited names (Step 4): fixes built, no reason recorded; LCP priority; unknown');
  assert.match(reasonText(null, 'missing-fixer'), /^Fix not built yet — /);
  assert.match(reasonText('owner', 'needs-info'), /^Needs information from you — .*\(c\)$/);
});

test('KNOWN-ISSUES.md lists every row that got worse, the unexplained ones as such', () => {
  const shipped = { files: ['index.html'], read: () => null };
  const worse = [
    { status: 'regressed', title: 'New broken links', before: { detail: 'No broken links.' }, after: { detail: '8 broken links' }, reason: 'owner', reasonEvidence: 'go to pages not chosen' },
    { status: 'regressed', title: 'Browser errors', before: { status: 'pass' }, after: { status: 'fail' }, reason: null, unexplained: true, reasonEvidence: 'the copy does not hold /assets/hero.mp4' },
  ];
  const [, known] = notesEntries({ report: { baseUrl: SITE, asIs: {}, copy: { openItems: [], worse } }, stack: 'html', root: 'r', shipped });
  assert.match(known.content, /## Got worse: New broken links[\s\S]*What this means: go to pages not chosen[\s\S]*Reason: c — /);
  assert.match(known.content, /## Got worse: Browser errors[\s\S]*What this means: the copy does not hold \/assets\/hero\.mp4[\s\S]*Tried: no automatic fix yet[\s\S]*Reason: UNEXPLAINED/);
});

test('an image row that got worse is a look change only when the copy serves the original\'s own file, never when it holds a heavier one', () => {
  const rows = (id, list) => ({ [id]: { score: 0, details: { items: list.map(([url, wastedBytes]) => ({ url, wastedBytes })), overallSavingsBytes: list.reduce((s, [, b]) => s + b, 0) } } });
  const worse = (copyRows, originalRows, fixOpen = []) => one({ key: 'lighthouse.modern-image-formats', after: { detail: 'Serve images in next-gen formats' } },
    { newLhr: { mobile: lhr(rows('modern-image-formats', copyRows)) }, oldLhr: { mobile: lhr(rows('modern-image-formats', originalRows)) }, fixOpen });
  // The copy names one more file than the original (a WebP it made): the amount grew, yet every file is explained. A JPEG is
  // tried as a WebP too (f4eb306), so one left as it is needs the fix's recorded reason, like a PNG.
  const files = [[`${COPY}/img/a.sas-0123456789.webp`, 20000], [`${COPY}/img/b~1a2b3c4d.jpg`, 30000]];
  const left = [{ kind: 'webp', page: '/', reason: 'd', detail: '/img/b~1a2b3c4d.jpg is left as it is: every WebP up to quality 95 shows a visible difference' }];
  const made = worse(files, [['https://cdn.example-original.test/img/b.jpg?w=800', 30000]], left);
  assert.equal(made.reason, 'look');
  assert.equal(made.group, 'look');
  const noReason = worse(files, [['https://cdn.example-original.test/img/b.jpg?w=800', 30000]]);
  assert.equal(noReason.reason, null, 'a JPEG the fix left without saying why is not explained');
  // The flexibench shape: the original's CDN sent a small file, the copy holds the large one. A real gap: still owed.
  const big = worse([[`${COPY}/img/photo.png`, 14000000]], [['https://cdn.example-original.test/img/photo.png', 73000]]);
  assert.equal(big.reason, null);
  assert.equal(big.group, 'missing-fixer');
});

test('a script that threw is a script error, never "the copy does not hold the file"; React #418 is the framework rejecting the changed markup', () => {
  const chunk = `${COPY}/_next/static/chunks/fd9d1056-a79584be52eb02e9.js`;
  const thrown = (description, source = 'exception') => ({ source, description, sourceLocation: { url: chunk } });
  const row = one({ key: 'lighthouse.errors-in-console' }, { newLhr: { mobile: lhr({ 'errors-in-console': { details: { items: [
    thrown('Error: Minified React error #418; visit https://react.dev/errors/418 for the full message'),
  ] } } }) } });
  assert.equal(row.reason, null, 'a hydration error is ours to fix');
  assert.doesNotMatch(row.evidence, /does not hold the file/);
  assert.match(row.evidence, /React #418 \(a script error: the framework rejected the copy's changed markup \(React #418\)/);
  assert.match(row.evidence, /thrown in \/_next\/static\/chunks\/fd9d1056-a79584be52eb02e9\.js, which the copy holds and which ran/);

  const other = one({ key: 'lighthouse.errors-in-console' }, { newLhr: { mobile: lhr({ 'errors-in-console': { details: { items: [thrown('TypeError: x is undefined')] } } }) } });
  assert.match(other.evidence, /a script error \(thrown in \/_next\/static\/chunks\/[^)]+\): TypeError: x is undefined/);
  assert.doesNotMatch(other.evidence, /does not hold the file/);

  // A per-page Best practices row: the console's entries (lighthousePages.js consoleEntries) say which is a script error; the
  // same error thrown on several loads is one part. A row with addresses only keeps the old wording.
  const page = (errors, urls) => one({
    key: 'lighthouse-score.mobile.best-practices./blog/x/', before: { score: 100 }, after: { score: 96 },
    lighthousePage: { mode: 'mobile', category: 'best-practices', failing: { original: [], copy: ['errors-in-console'] },
      copyFailingByCategory: { 'best-practices': [{ id: 'errors-in-console', weight: 1 }] },
      copyAudits: { 'errors-in-console': { title: 'Browser errors were logged to the console', urls, ...(errors && { errors }) } } },
  });
  const e418 = { source: 'exception', text: 'Error: Minified React error #418; visit https://react.dev/errors/418', url: chunk };
  const withEntries = page([e418, e418, { source: 'exception', text: 'Error: Minified React error #423; visit https://react.dev/errors/423', url: chunk }], [chunk]);
  assert.match(withEntries.evidence, /2 of 2 console errors have no reason: React #418 \(a script error: the framework rejected/);
  assert.match(withEntries.evidence, /React #423/);
  assert.doesNotMatch(withEntries.evidence, /does not hold the file/);
  const older = page(null, [`${COPY}/img/missing.png`]);
  assert.match(older.evidence, /failed requests have no reason: .*the copy does not hold the file \/img\/missing\.png/);
});

test('a stylesheet the browser refused: the console row names it, and hover / motion rows point at it instead of "still owed"', () => {
  const css = `${COPY}/67767fd5/css/site.webflow.shared.d42c59d33.css`;
  const refused = { source: 'other', description: `Failed to find a valid digest in the 'integrity' attribute for resource '${css}' with computed SHA-384 integrity 'abc'. The resource has been blocked.`, sourceLocation: { url: `${COPY}/` } };
  const newLhr = { mobile: lhr({ 'errors-in-console': { details: { items: [refused] } } }) };
  const consoleRow = one({ key: 'lighthouse.errors-in-console' }, { newLhr });
  assert.match(consoleRow.evidence, /the copy holds \/67767fd5\/css\/site\.webflow\.shared\.d42c59d33\.css, but the browser refused it: its integrity hash does not match the file/);

  const hover = one({ key: 'motion.hover', after: { detail: '0 of them react on the recreated site.' } }, { newLhr });
  assert.equal(hover.group, 'bug');
  assert.equal(hover.unexplained, true);
  assert.doesNotMatch(hover.evidence, /separate track/);
  assert.match(hover.evidence, /The copy's stylesheet did not load, so the page was drawn without the rules these effects are made of: \/67767fd5\/css\/site\.webflow\.shared\.d42c59d33\.css \(its integrity hash does not match the file, so the browser refused it\)/);

  // A stylesheet answered with an error counts too; a refused script or a missing image does not.
  const missing = { mobile: lhr({ 'network-requests': { details: { items: [{ url: `${COPY}/css/a.css`, resourceType: 'Stylesheet', statusCode: 404 }, { url: `${COPY}/img/b.png`, resourceType: 'Image', statusCode: 404 }] } } }) };
  assert.match(one({ key: 'motion.reveal' }, { newLhr: missing }).evidence, /\/css\/a\.css \(it answered 404\)\. A bug to fix/);
  const script = { mobile: lhr({ 'errors-in-console': { details: { items: [{ ...refused, description: refused.description.replace(css, `${COPY}/js/app.js`) }] } } }) };
  assert.match(one({ key: 'motion.hover' }, { newLhr: script }).evidence, /Fix not built yet: Motion is a separate track/);
  assert.match(one({ key: 'motion.hover' }).evidence, /Fix not built yet: Motion is a separate track/, 'with every stylesheet loaded, the effect is still owed');
});
