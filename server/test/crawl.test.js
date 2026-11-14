// Crawl + link check against the local fixture site (no browser, no Lighthouse).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './serve-fixture.js';
import { fetchPage } from '../src/audit/http.js';
import { crawl } from '../src/audit/crawler.js';
import { checkLinks } from '../src/audit/linkChecker.js';
import { loadRobots } from '../src/audit/robots.js';
import { loadSitemaps } from '../src/audit/sitemap.js';

// The fixture runs on localhost, which the SSRF guard blocks unless this dev flag is set.
process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4199;
const origin = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = await startFixtureServer(PORT);
});
after(() => server.close());

test('robots and missing sitemap are read from the site', async () => {
  const robots = await loadRobots(origin);
  assert.equal(robots.status, 'found');
  assert.deepEqual(robots.blockedAiCrawlers, ['GPTBot']);
  const sitemap = await loadSitemaps(origin, robots.sitemaps);
  assert.equal(sitemap.status, 'missing');
  assert.equal(sitemap.sources[0].httpStatus, 404);
});

test('crawl finds the pages and the link check finds the seeded broken links', async () => {
  const home = await fetchPage(`${origin}/`);
  const robots = await loadRobots(origin);
  const result = await crawl({ home, maxPages: 10, robots });
  const paths = result.pages.map((p) => new URL(p.url).pathname).sort();
  assert.deepEqual(paths, ['/', '/about.html', '/old-pricing', '/pricing.html', '/server-error', '/team/missing']);
  assert.equal(result.pages.filter((p) => p.facts).length, 3);

  const links = await checkLinks({ pages: result.pages });
  const broken = Object.fromEntries(links.broken.map((b) => [new URL(b.url).pathname, b.status]));
  assert.deepEqual(broken, { '/old-pricing': 404, '/server-error': 500, '/team/missing': 404 });
  assert.equal(links.broken.find((b) => b.url.endsWith('/team/missing')).foundOn, '/about.html');
});

test('maxPages caps the crawl', async () => {
  const home = await fetchPage(`${origin}/`);
  const result = await crawl({ home, maxPages: 2, robots: { isAllowed: () => true } });
  assert.equal(result.pages.length, 2);
  assert.equal(result.truncated, true);
  // What was found and not read is named, with why: the page limit.
  assert.equal(result.cutBy, 'pages');
  const read = new Set(result.pages.map((p) => new URL(p.url).pathname));
  const left = result.notRead.map((u) => new URL(u).pathname);
  assert.ok(left.length > 0);
  for (const p of left) assert.ok(!read.has(p), `${p} was read and is not "not read"`);
  const full = await crawl({ home, maxPages: 10, robots: { isAllowed: () => true } });
  assert.deepEqual(left.filter((p) => !full.pages.some((q) => new URL(q.url).pathname === p)), [], 'every address not read is a page of the site');
  assert.deepEqual([full.notRead, full.cutBy], [[], null], 'a crawl that read everything leaves nothing');
});

test('a crawl stopped by its time names what it did not read, and says it ran out of time', async () => {
  const { crawlLimitOf } = await import('../src/audit/index.js');
  const home = await fetchPage(`${origin}/`);
  const controller = new AbortController();
  controller.abort();
  const result = await crawl({ home, maxPages: 10, robots: { isAllowed: () => true }, signal: controller.signal });
  assert.equal(result.pages.length, 1, 'only the homepage, already fetched');
  assert.equal(result.cutBy, 'time');
  assert.ok(result.notRead.length > 0);
  const limit = crawlLimitOf(result, 1);
  assert.deepEqual({ ...limit, urls: limit.urls.length }, { found: 1 + result.notRead.length, read: 1, notRead: result.notRead.length, cutBy: 'time', urls: result.notRead.length });
  assert.equal(crawlLimitOf({ notRead: [], cutBy: null }, 5), null);
  assert.equal(crawlLimitOf({ notRead: [`${origin}/a?x=1`], cutBy: 'pages' }, 5), null, 'a query-string variant is not a page');
});
