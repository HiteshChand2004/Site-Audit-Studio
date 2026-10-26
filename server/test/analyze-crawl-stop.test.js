// Why the Analyze crawl read fewer pages than its limit (audit.crawlStop), and the sentence the app shows for it. A small
// site of its own on a random loopback port; no browser, no Lighthouse.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchPage } from '../src/audit/http.js';
import { crawl, crawlStopOf } from '../src/audit/crawler.js';
import { assembleAudit } from '../src/audit/assemble.js';
import { crawlStopText } from '../../client/src/copy.js';

// The site is on localhost, which the SSRF guard blocks unless this dev flag is set.
process.env.SAS_ALLOW_LOCALHOST = '1';

const PAGES = 6; // the homepage and /p1 … /p5, every one linking to every other
const SLOW_MS = 800; // how long a page answers on the slow site
let server;
let origin;
let slow = false;

before(async () => {
  server = http.createServer((req, res) => {
    const links = Array.from({ length: PAGES - 1 }, (_, i) => `<a href="/p${i + 1}">Page ${i + 1}</a>`).join(' ');
    const send = () => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Page ${req.url}</title></head><body><h1>${req.url}</h1><p>Some text on this page.</p>${links}</body></html>`);
    if (slow && req.url !== '/') setTimeout(send, SLOW_MS);
    else send();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const robots = { isAllowed: () => true };

test('all found: the site had no more pages to follow, and nothing extra is shown', async () => {
  slow = false;
  const home = await fetchPage(`${origin}/`);
  const result = await crawl({ home, maxPages: 100, robots });
  assert.equal(result.pages.length, PAGES);
  const stop = crawlStopOf(result, { maxPages: 100, timeLimitMs: 75000 });
  assert.deepEqual(stop, { reason: 'all-found', read: PAGES, maxPages: 100 });
  assert.equal(crawlStopText({ crawlStop: stop }), null);
});

test('page limit: max pages reached with addresses still waiting', async () => {
  slow = false;
  const home = await fetchPage(`${origin}/`);
  const result = await crawl({ home, maxPages: 3, robots });
  const stop = crawlStopOf(result, { maxPages: 3, timeLimitMs: 75000 });
  assert.deepEqual(stop, { reason: 'page-limit', read: 3, maxPages: 3 });
  assert.equal(crawlStopText({ crawlStop: stop }), 'The crawl stopped at the 3-page limit. The site may have more pages.');
});

test('time limit: the step stopped the crawl, which keeps what it read, and the real limit is named', async () => {
  slow = true;
  const home = await fetchPage(`${origin}/`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200); // as the crawl step's timer does when its time runs out
  const result = await crawl({ home, maxPages: 100, robots, signal: controller.signal, concurrency: 2 });
  assert.equal(result.aborted, true);
  assert.ok(result.pages.length < PAGES, 'stopped before every page was read');
  const stop = crawlStopOf(result, { maxPages: 100, timeLimitMs: 75000 });
  assert.deepEqual(stop, { reason: 'time-limit', read: result.pages.length, maxPages: 100, timeLimitSeconds: 75 });
  assert.equal(crawlStopText({ crawlStop: stop }), 'The crawl stopped at its 75-second time limit, before the 100-page limit.');
  // The real numbers, never fixed ones: a scaled step limit and another page limit.
  assert.equal(
    crawlStopText({ crawlStop: crawlStopOf({ pages: new Array(42), aborted: true, truncated: true }, { maxPages: 60, timeLimitMs: 150000 }) }),
    'The crawl stopped at its 150-second time limit, before the 60-page limit.',
  );
});

test('the reason travels in the analysis result; an analysis without it (older, or no crawl) loads and shows nothing extra', () => {
  const base = {
    project: { id: 'p', name: 'x', url: origin, stack: 'html' }, analysisId: 'a', url: `${origin}/`, frame: {}, screenshots: {},
    metrics: {}, metricsByDevice: {}, scores: {}, techStack: [], weaknesses: [], seo: [], aeo: [], crawl: {},
    links: { checked: 0, broken: [] }, accessibility: [], manualRebuild: [], pagesCrawled: 42, errors: [],
  };
  const stop = { reason: 'time-limit', read: 42, maxPages: 100, timeLimitSeconds: 75 };
  const audit = assembleAudit({ ...base, crawlStop: stop });
  assert.deepEqual(audit.crawlStop, stop);
  assert.equal(audit.pagesCrawled, 42, 'existing fields unchanged');

  // An old analysis: no field at all, and the result is shaped exactly as before.
  const old = assembleAudit(base);
  assert.equal('crawlStop' in old, false);
  assert.equal(crawlStopText(old), null);
  assert.equal(crawlStopText(JSON.parse(JSON.stringify(old))), null);
  assert.equal(crawlStopText(null), null);
  assert.equal(crawlStopText({ isDummy: true }), null);

  // No crawl result (the step failed or was skipped: the homepage-only fallback has no `aborted`), so no reason is made up.
  assert.equal(crawlStopOf(null, { maxPages: 100 }), null);
  assert.equal(crawlStopOf({ pages: [{}], skippedByRobots: 0 }, { maxPages: 100 }), null);
});
