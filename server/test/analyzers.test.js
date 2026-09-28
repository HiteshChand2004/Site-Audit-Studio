import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../src/audit/extract.js';
import { analyzeSeo, crawlErrorsItem } from '../src/audit/analyzers/seo.js';
import { analyzeAeo } from '../src/audit/analyzers/aeo.js';
import { analyzeCrawl } from '../src/audit/analyzers/crawlChecks.js';
import { analyzeA11y } from '../src/audit/analyzers/a11y.js';
import { buildMetrics, buildScores } from '../src/audit/analyzers/metrics.js';
import { parseRobots } from '../src/audit/robots.js';
import { parseSitemap } from '../src/audit/sitemap.js';
import { classifyLink } from '../src/audit/linkChecker.js';
import { computeFrame } from '../src/audit/frame.js';
import { assembleAudit } from '../src/audit/assemble.js';
import { buildDummyAudit } from '../src/dummy/audit.js';

const site = (name) => readFileSync(new URL(`./fixtures/site/${name}`, import.meta.url), 'utf8');
const page = (name, path) => {
  const url = `http://localhost:4100${path}`;
  const facts = extractPage(site(name), url);
  return { url, status: 200, facts: { ...facts, rawTextLength: facts.textLength } };
};
const byTitle = (items, title) => items.find((i) => i.title === title);

const home = page('index.html', '/');
const pages = [home, page('about.html', '/about.html'), page('pricing.html', '/pricing.html')];

test('extractPage pulls the SEO facts', () => {
  const f = home.facts;
  assert.equal(f.title, 'Fixture Co — Test site for Site Audit Studio');
  assert.equal(f.metaDescription, null);
  assert.equal(f.lang, 'en');
  assert.equal(f.images.filter((i) => i.alt === null).length, 1);
  assert.equal(f.questionHeadings.length, 2);
  assert.ok(f.links.some((l) => l.href === 'http://localhost:4100/about.html' && l.internal));
});

test('SEO: seeded issues are found', () => {
  const seo = analyzeSeo(pages, home);
  assert.equal(byTitle(seo, 'Meta description').status, 'fail');
  assert.match(byTitle(seo, 'Meta description').detail, /homepage/);
  assert.equal(byTitle(seo, 'Open Graph tags').status, 'fail'); // og:image missing
  assert.equal(byTitle(seo, 'Headings').status, 'warn'); // two h1 on /pricing.html
  assert.match(byTitle(seo, 'Headings').detail, /pricing/);
  assert.equal(byTitle(seo, 'Image alt text').status, 'warn');
  assert.equal(byTitle(seo, 'Language').status, 'pass');
  assert.equal(byTitle(seo, 'HTTPS').status, 'fail'); // fixture is http://
});

test('SEO: crawl errors item', () => {
  assert.equal(crawlErrorsItem(pages).status, 'pass');
  assert.equal(crawlErrorsItem([...pages, { url: 'http://localhost:4100/x', status: 404 }]).status, 'fail');
});

test('AEO: FAQ without schema, heading skip, blocked AI crawler, llms.txt', () => {
  const robots = { blockedAiCrawlers: ['GPTBot'] };
  const aeo = analyzeAeo({ pages, home, robots, llms: { found: false }, renderedTextLength: home.facts.textLength });
  assert.equal(byTitle(aeo, 'JSON-LD schema').status, 'fail');
  assert.equal(byTitle(aeo, 'FAQ schema').status, 'fail');
  assert.equal(byTitle(aeo, 'Heading hierarchy').status, 'warn');
  assert.equal(byTitle(aeo, 'Structured answers').status, 'pass');
  assert.equal(byTitle(aeo, 'Content without JavaScript').status, 'pass');
  assert.equal(byTitle(aeo, 'llms.txt').status, 'warn');
  assert.match(byTitle(aeo, 'AI crawler access').detail, /GPTBot/);
});

test('AEO: client-rendered content is flagged', () => {
  const shell = { ...home, facts: { ...home.facts, rawTextLength: 20 } };
  const aeo = analyzeAeo({ pages, home: shell, robots: { blockedAiCrawlers: [] }, llms: { found: true }, renderedTextLength: 2000 });
  assert.equal(byTitle(aeo, 'Content without JavaScript').status, 'fail');
});

test('robots.txt parsing and AI crawler rules', () => {
  const r = parseRobots('https://a.test/robots.txt', site('robots.txt'));
  assert.equal(r.isAllowed('https://a.test/'), true);
  assert.equal(r.isAllowed('https://a.test/', 'GPTBot'), false);
  assert.deepEqual(r.sitemaps, []);
});

test('sitemap parsing: urlset, index, invalid', () => {
  assert.deepEqual(parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.test/</loc></url><url><loc>https://a.test/b</loc></url></urlset>'), {
    kind: 'urlset',
    urls: ['https://a.test/', 'https://a.test/b'],
  });
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>').kind, 'index');
  assert.equal(parseSitemap('<!doctype html><html><body>404</body></html>').kind, 'invalid');
});

test('crawl checks section', () => {
  const crawl = analyzeCrawl({
    robots: { status: 'found', sitemaps: [], blocksAll: false },
    sitemap: { status: 'missing', urls: [], sources: [{ url: 'http://localhost:4100/sitemap.xml', status: 'missing', httpStatus: 404 }] },
    homeFacts: home.facts,
  });
  assert.deepEqual(crawl.sitemap, { status: 'fail', detail: '/sitemap.xml → 404' });
  assert.equal(crawl.robots.status, 'warn');
  assert.equal(crawl.metaTags.status, 'warn');
  assert.match(crawl.metaTags.detail, /twitter:card ✗/);
});

test('link classification', () => {
  assert.equal(classifyLink(200), 'ok');
  assert.equal(classifyLink(301), 'ok');
  assert.equal(classifyLink(404), 'broken');
  assert.equal(classifyLink(500), 'broken');
  assert.equal(classifyLink(0, 'dns'), 'broken');
  assert.equal(classifyLink(429), 'unverified');
  assert.equal(classifyLink(999), 'unverified');
  assert.equal(classifyLink(403), 'unverified');
  assert.equal(classifyLink(0, 'timeout'), 'unverified');
});

test('frame check from headers', () => {
  assert.deepEqual(computeFrame({ 'x-frame-options': 'sameorigin' }), { frameable: false, reason: 'X-Frame-Options: SAMEORIGIN' });
  assert.equal(computeFrame({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }).frameable, false);
  assert.equal(computeFrame({ 'content-security-policy': 'frame-ancestors *' }).frameable, true);
  assert.equal(computeFrame({}).frameable, true);
});

test('a11y grouping and metrics without Lighthouse', () => {
  const rows = analyzeA11y({
    violations: [
      { id: 'image-alt', impact: 'critical', help: 'Images must have alternate text', helpUrl: 'x', nodes: [1] },
      { id: 'color-contrast', impact: 'serious', help: 'Elements must meet contrast', helpUrl: 'y', nodes: [1, 2, 3] },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.impact, r.count]), [['critical', 1], ['serious', 3]]);
  assert.equal(buildMetrics(null).lcp, null);
  assert.deepEqual(buildScores(null, null), { mobile: null, desktop: null });
});

test('assembled audit keeps every key of the UI contract', () => {
  const project = { id: 'p1', name: 'Fixture', url: 'http://localhost:4100/', updated_at: new Date().toISOString() };
  const dummy = buildDummyAudit(project);
  const audit = assembleAudit({
    project,
    analysisId: 'a1',
    url: project.url,
    frame: { frameable: true, reason: null },
    metrics: buildMetrics(null),
    scores: buildScores(null, null),
    techStack: [],
    weaknesses: [],
    seo: [],
    aeo: [],
    crawl: { sitemap: {}, robots: {}, metaTags: {} },
    links: { checked: 0, broken: [] },
    accessibility: [],
    manualRebuild: [],
    pagesCrawled: 1,
    errors: [],
  });
  for (const key of Object.keys(dummy)) assert.ok(key in audit, `missing key: ${key}`);
  for (const key of Object.keys(dummy.metrics)) assert.ok(key in audit.metrics, `missing metrics.${key}`);
  for (const key of Object.keys(dummy.crawl)) assert.ok(key in audit.crawl, `missing crawl.${key}`);
  assert.deepEqual(Object.keys(audit.brokenLinks).filter((k) => k in dummy.brokenLinks), Object.keys(dummy.brokenLinks));
  assert.equal(audit.isDummy, false);
  assert.equal(audit.recreate.isDummy, true);
});
