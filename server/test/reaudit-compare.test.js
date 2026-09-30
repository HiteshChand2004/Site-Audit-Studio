// Fix checklist rules (Phase 5.2) on synthetic data: classification, URL mapping, the page scope,
// Lighthouse / platform / fallback rows, and the recreated sitemap.xml + robots.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemKey } from '../src/audit/util.js';
import { compareAudits } from '../src/reaudit/compare/index.js';
import { classify, evidenceFor } from '../src/reaudit/compare/rules.js';
import { newPathOf, normUrl, pairPages, toOriginalUrl } from '../src/reaudit/compare/scope.js';
import { crawlFiles } from '../src/recreate/ir/crawlFiles.js';

const r = (rank, extra = {}) => ({ rank, ...extra });

test('classify: fixed, improved, open, regressed, pass, n/a', () => {
  assert.equal(classify(r(2), r(0)), 'fixed');
  assert.equal(classify(r(1), r(0)), 'fixed');
  assert.equal(classify(r(2), r(1)), 'improved');
  assert.equal(classify(r(2, { count: 5 }), r(2, { count: 2 })), 'improved');
  assert.equal(classify(r(1, { score: 0.6 }), r(1, { score: 0.7 })), 'improved');
  assert.equal(classify(r(1, { score: 0.6 }), r(1, { score: 0.62 })), 'open');
  assert.equal(classify(r(2, { count: 2 }), r(2, { count: 2 })), 'open');
  assert.equal(classify(r(2, { count: 2 }), r(2, { count: 4 })), 'open');
  assert.equal(classify(r(1), r(2)), 'regressed');
  assert.equal(classify(r(0), r(1)), 'regressed');
  assert.equal(classify(r(0), r(0)), 'pass');
  assert.equal(classify(r(2), null), 'na');
  assert.equal(classify(null, r(0)), 'pass');
  assert.equal(classify(null, r(1)), 'open');
});

test('URLs: normalized, paths of emitted pages, mapped back to the original site', () => {
  assert.equal(normUrl('https://www.Site.test/about/#x'), 'site.test/about');
  assert.equal(normUrl('http://site.test/'), 'site.test/');
  assert.equal(normUrl('http://127.0.0.1:5100/a?b=1'), '127.0.0.1:5100/a?b=1');
  assert.equal(newPathOf('index.html'), '/');
  assert.equal(newPathOf('about/index.html'), '/about/');
  assert.equal(newPathOf('work.html'), '/work.html');
  const map = { newOrigin: 'http://127.0.0.1:5100', oldOrigin: 'https://www.site.test', reportPages: [{ url: 'https://www.site.test/about-us', outPath: 'about-us/index.html' }] };
  assert.equal(toOriginalUrl('http://127.0.0.1:5100/about-us/', map), 'https://www.site.test/about-us');
  assert.equal(toOriginalUrl('http://127.0.0.1:5100/nope.html', map), 'https://www.site.test/nope.html');
  assert.equal(toOriginalUrl('https://elsewhere.test/x', map), 'https://elsewhere.test/x');
});

const facts = (over = {}) => ({ title: 'A good page title', metaDescription: 'x'.repeat(80), canonical: 'c', og: {}, headings: [{ level: 1 }], images: [], links: [], jsonLd: [], questionHeadings: [], faqSignals: 0, mixedContent: [], robotsMeta: null, lang: 'en', viewport: true, charset: true, twitter: {}, ...over });

test('page scope: pairs by original URL (www and trailing slash ignored), reports the rest', () => {
  const reportPages = [{ url: 'https://site.test/', outPath: 'index.html' }, { url: 'https://site.test/a/', outPath: 'a/index.html' }, { url: 'https://site.test/b', outPath: 'b.html' }];
  const oldPages = [
    { url: 'https://www.site.test/', facts: facts() },
    { url: 'https://www.site.test/a', facts: facts() },
    { url: 'https://www.site.test/c', facts: facts() },
    { url: 'https://www.site.test/404', status: 404, facts: null },
  ];
  const newPages = [{ url: 'http://127.0.0.1:5100/', facts: facts() }, { url: 'http://127.0.0.1:5100/a/', facts: facts() }, { url: 'http://127.0.0.1:5100/b.html', facts: facts() }];
  const p = pairPages({ reportPages, oldPages, newPages, newOrigin: 'http://127.0.0.1:5100' });
  assert.deepEqual(p.pairs.map((x) => x.path), ['/', '/a/']);
  assert.deepEqual(p.outOfScope, ['https://www.site.test/c']);
  assert.deepEqual(p.missingInOld, ['/b.html']);
  assert.deepEqual(p.missingInNew, []);
});

const lhr = (audits, refs) => ({
  categories: { performance: { auditRefs: refs.performance ?? [] }, 'best-practices': { auditRefs: refs['best-practices'] ?? [] } },
  audits,
});

test('checklist without crawls: stored results by key (old audits without keys too), Lighthouse, platform, manual', () => {
  const oldAudit = {
    url: 'https://site.test/',
    analysisId: 'a1',
    // Stored before 5.2: no `key` on items.
    seo: [{ status: 'fail', title: 'Meta description', detail: 'Missing on the homepage.' }, { status: 'fail', title: 'HTTPS', detail: 'plain HTTP' }],
    aeo: [{ status: 'pass', title: 'llms.txt', detail: 'ok' }],
    crawl: { sitemap: { status: 'fail', detail: '/sitemap.xml → 404' }, robots: { status: 'pass', detail: 'ok' }, metaTags: { status: 'warn', detail: 'x' } },
    accessibility: [{ id: 'color-contrast', impact: 'serious', title: 'Contrast', count: 4 }],
    brokenLinks: { broken: [{ url: 'https://site.test/gone', status: 404 }] },
    techStack: [{ id: 'framer', name: 'Framer' }],
    manualRebuild: [{ kind: 'form', title: 'Contact form backend', detail: 'x' }],
    scores: { mobile: { performance: 40 }, desktop: null },
  };
  const newAudit = {
    url: 'http://127.0.0.1:5100/',
    seo: [{ key: 'seo.meta-description', status: 'pass', title: 'Meta description', detail: 'ok' }, { key: 'seo.https', status: 'fail', title: 'HTTPS', detail: 'plain HTTP' }],
    aeo: [{ key: 'aeo.llms-txt', status: 'warn', title: 'llms.txt', detail: 'none' }],
    crawl: { sitemap: { status: 'pass', detail: 'ok' }, robots: { status: 'pass', detail: 'ok' }, metaTags: { status: 'warn', detail: 'x' } },
    accessibility: [{ id: 'color-contrast', impact: 'serious', title: 'Contrast', count: 1 }],
    brokenLinks: { broken: [] },
    techStack: [{ id: 'custom', name: 'Custom/Unknown' }],
    manualRebuild: [],
    scores: { mobile: { performance: 95 }, desktop: null },
  };
  const perfRefs = { performance: [{ id: 'render-blocking-resources' }, { id: 'uses-text-compression' }, { id: 'largest-contentful-paint', group: 'metrics' }] };
  const oldLh = lhr({
    'render-blocking-resources': { title: 'Eliminate render-blocking resources', score: 0.3, scoreDisplayMode: 'metricSavings', displayValue: 'Est savings 900 ms' },
    'uses-text-compression': { title: 'Enable text compression', score: 1, scoreDisplayMode: 'metricSavings' },
    'largest-contentful-paint': { title: 'LCP', score: 0.1, scoreDisplayMode: 'numeric' },
  }, perfRefs);
  const newLh = lhr({
    'render-blocking-resources': { title: 'Eliminate render-blocking resources', score: 1, scoreDisplayMode: 'metricSavings' },
    'uses-text-compression': { title: 'Enable text compression', score: 0, scoreDisplayMode: 'metricSavings' },
    'largest-contentful-paint': { title: 'LCP', score: 1, scoreDisplayMode: 'numeric' },
  }, perfRefs);
  const report = {
    recreateId: 'r1',
    pages: [{ url: 'https://site.test/', outPath: 'index.html' }],
    fixes: [{ id: 'crawl-files', title: 'sitemap.xml and robots.txt generated', status: 'fixed', count: 2 }],
    autoGenerated: [{ page: '/', field: 'description', value: 'd', source: 'first paragraph' }],
    manual: [{ kind: 'form', title: 'Form on / needs a backend', detail: 'x' }],
  };
  const c = compareAudits({
    old: { audit: oldAudit, crawl: null, lighthouse: { mobile: oldLh, desktop: null } },
    next: { audit: newAudit, crawl: null, lighthouse: { mobile: newLh, desktop: null } },
    report,
    newOrigin: 'http://127.0.0.1:5100',
  });
  const item = (key) => c.items.find((i) => i.key === key);
  assert.equal(c.scope.mode, 'site');
  assert.match(c.notes.join(' '), /whole-site results/);
  assert.equal(itemKey('seo', 'Meta description'), 'seo.meta-description');
  assert.equal(item('seo.meta-description').status, 'fixed');
  assert.equal(item('seo.meta-description').review, true);
  assert.equal(item('seo.https').status, 'na');
  assert.equal(item('aeo.llms-txt').status, 'regressed');
  assert.equal(item('crawl.sitemap').status, 'fixed');
  assert.equal(item('crawl.sitemap').evidence[0].fix, 'crawl-files');
  assert.equal(item('crawl.robots').status, 'pass');
  assert.equal(item('axe.color-contrast').status, 'improved');
  assert.equal(item('links.broken').status, 'fixed');
  assert.equal(item('links.broken-new'), undefined);
  assert.equal(item('platform.framer').status, 'fixed');
  assert.equal(item('platform.custom'), undefined);
  // Lighthouse: failing audits only, metrics left to the score strip, deploy checks n/a, local-preview note.
  assert.equal(item('lighthouse.render-blocking-resources').status, 'fixed');
  assert.match(item('lighthouse.render-blocking-resources').note, /local preview/);
  assert.equal(item('lighthouse.uses-text-compression').status, 'na');
  assert.match(item('lighthouse.uses-text-compression').note, /deploy/);
  assert.equal(item('lighthouse.largest-contentful-paint'), undefined);
  // Manual items from the analysis and the recreate, never fixed.
  assert.deepEqual(c.items.filter((i) => i.status === 'manual').map((i) => i.title).sort(), ['Contact form backend', 'Form on / needs a backend']);
  assert.deepEqual(c.scores, { before: oldAudit.scores, after: newAudit.scores });
  // Rows are grouped by category in a fixed order; ranks never leak into the output.
  assert.equal(c.items[0].category, 'performance');
  assert.ok(c.items.every((i) => !i.before || !('rank' in i.before)));
  assert.equal(c.summary.total, c.items.length);
});

test('evidence: only for known checks, auto-generated values flagged', () => {
  assert.equal(evidenceFor('seo.language', { fixes: [], autoGenerated: [] }), null);
  const ev = evidenceFor('seo.image-alt-text', { fixes: [{ id: 'img-alt', title: 'Alt', status: 'partial', count: 3, open: 1 }], autoGenerated: [{ field: 'alt', value: 'Team photo', source: 'file name' }] });
  assert.equal(ev.review, true);
  assert.equal(ev.evidence[0].open, 1);
  assert.equal(ev.evidence[1].autoGenerated, 1);
});

const head = (over = {}) => ({ canonical: null, meta: [], ...over });

test('sitemap.xml lists indexable pages at the site origin; robots.txt keeps the original intent', () => {
  const pages = [
    { info: { path: '/' }, head: head({ canonical: 'https://new.test/' }) },
    { info: { path: '/about/' }, head: head({ canonical: 'https://other.test/about/' }) },
    { info: { path: '/private/' }, head: head({ meta: [{ name: 'robots', content: 'noindex, follow' }] }) },
    { info: { path: '/a&b/' }, head: head() },
  ];
  const out = crawlFiles({ pages, baseUrl: 'https://new.test/', robots: { status: 'found', blocksAll: false, blockedAiCrawlers: ['GPTBot', 'GPTBot', 'ClaudeBot'] } });
  assert.deepEqual(out.sitemap.urls, ['https://new.test/', 'https://new.test/about/', 'https://new.test/a&b/']);
  assert.deepEqual(out.sitemap.excluded, ['/private/']);
  const sitemap = out.files.find((f) => f.path === 'sitemap.xml').content;
  assert.match(sitemap, /<loc>https:\/\/new\.test\/a&amp;b\/<\/loc>/);
  assert.ok(!/lastmod|priority/.test(sitemap));
  const robots = out.files.find((f) => f.path === 'robots.txt').content;
  assert.match(robots, /User-agent: \*\nAllow: \//);
  assert.match(robots, /User-agent: GPTBot\nDisallow: \//);
  assert.equal(robots.match(/GPTBot/g).length, 1);
  assert.match(robots, /Sitemap: https:\/\/new\.test\/sitemap\.xml/);

  const closed = crawlFiles({ pages, baseUrl: 'https://new.test', robots: { status: 'found', blocksAll: true, blockedAiCrawlers: ['GPTBot'] } });
  assert.match(closed.files[1].content, /User-agent: \*\nDisallow: \//);
  assert.ok(!/GPTBot/.test(closed.files[1].content));
  const none = crawlFiles({ pages, baseUrl: 'https://new.test', robots: { status: 'missing' } });
  assert.match(none.robots.source, /no robots\.txt/);
  assert.match(none.files[1].content, /Allow: \//);
});

test('legacy checklist: the original fixed / open / manual list, pass and n/a left out', async () => {
  const { legacyChecklist } = await import('../src/reaudit/contract.js');
  const items = ['fixed', 'improved', 'open', 'regressed', 'changed', 'manual', 'na', 'pass'].map((status) => ({ key: `k.${status}`, status, title: status, after: { detail: `${status} now` } }));
  assert.deepEqual(legacyChecklist(items).map((i) => [i.key, i.status, i.detail]), [
    ['k.fixed', 'fixed', 'fixed now'],
    ['k.improved', 'open', 'improved now'],
    ['k.open', 'open', 'open now'],
    ['k.regressed', 'open', 'regressed now'],
    ['k.manual', 'manual', 'manual now'],
  ]);
  assert.deepEqual(legacyChecklist(), []);
});

test('CPU-timing audits: a worse local measurement is "changed (noisy locally)", never a regression', () => {
  const refs = { performance: [{ id: 'cpu-a' }, { id: 'cpu-b' }, { id: 'savings' }] };
  const timing = (score, ms) => ({ title: `CPU ${ms}`, score, scoreDisplayMode: 'metricSavings', numericUnit: 'millisecond', displayValue: `${ms} ms`, details: { type: 'table' } });
  const saving = (score) => ({ title: 'Savings', score, scoreDisplayMode: 'metricSavings', numericUnit: 'millisecond', details: { type: 'opportunity' } });
  const oldLh = lhr({ 'cpu-a': timing(1, 400), 'cpu-b': timing(0.2, 3000), savings: saving(1) }, refs);
  const newLh = lhr({ 'cpu-a': timing(0, 5200), 'cpu-b': timing(1, 300), savings: saving(0.2) }, refs);
  const audit = (url) => ({ url, seo: [], aeo: [], crawl: {}, accessibility: [], brokenLinks: { broken: [] }, techStack: [], manualRebuild: [] });
  const c = compareAudits({
    old: { audit: audit('https://site.test/'), crawl: null, lighthouse: { mobile: oldLh, desktop: null } },
    next: { audit: audit('http://127.0.0.1:5100/'), crawl: null, lighthouse: { mobile: newLh, desktop: null } },
    report: { pages: [] },
    newOrigin: 'http://127.0.0.1:5100',
  });
  const item = (key) => c.items.find((i) => i.key === key);
  assert.equal(item('lighthouse.cpu-a').status, 'changed');
  assert.match(item('lighthouse.cpu-a').note, /noisy locally/);
  assert.equal(item('lighthouse.cpu-b').status, 'fixed');
  assert.equal(item('lighthouse.savings').status, 'regressed');
  assert.equal(c.summary.changed, 1);
  assert.equal(c.summary.regressed, 1);
});
