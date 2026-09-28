// Crawl + link check against the local fixture site (no browser, no Lighthouse).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './serve-fixture.js';
import { fetchPage } from '../src/audit/http.js';
import { crawl } from '../src/audit/crawler.js';
import { checkLinks } from '../src/audit/linkChecker.js';
import { loadRobots } from '../src/audit/robots.js';
import { loadSitemaps } from '../src/audit/sitemap.js';

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
});
