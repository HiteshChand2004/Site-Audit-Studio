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

  const time = (sel, ms, w) => lhr({ ...lcp(sel, ms), ...weight(w) });
  const host = one({ key: 'lighthouse.largest-contentful-paint-element' }, { oldLhr: { mobile: time('h1.hero', 0, 500000) }, newLhr: { mobile: time('h1.hero', 650, 480000) } });
  assert.equal(host.reason, 'deploy', 'the same page, not heavier, only slower on the local preview');

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
  assert.deepEqual(r.summary, { total: 2, explained: 1, unexplained: 1, byReason: { owner: 1 } });
  assert.equal(r.items[0].unexplained, true);
  assert.match(reasonText(null), /^UNEXPLAINED/);
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
