import { extractPage, looksLikeShell } from './extract.js';
import { fetchPage, isHtml } from './http.js';
import { sameSite, urlKey } from './util.js';

const NON_PAGE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|zip|rar|7z|gz|dmg|exe|docx?|xlsx?|pptx?|csv|json|xml|txt|css|js|woff2?|ttf)$/i;
const CONCURRENCY = 4;

/**
 * Breadth-first crawl of same-site HTML pages.
 * @param {object} o
 * @param {object} o.home          the already-fetched homepage response (from fetchPage)
 * @param {number} o.maxPages
 * @param {number} [o.maxDepth]
 * @param {{isAllowed:(url:string)=>boolean}} o.robots
 * @param {string[]} [o.sitemapUrls]
 * @param {string[]} [o.seedUrls]  pages crawled first, before the homepage's links (re-audit: the recreated pages)
 * @param {(url:string)=>Promise<{html:string}|null>} [o.render]  used for client-rendered pages
 * @param {(done:number,total:number,url:string)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]  stops starting new pages; partial results are returned
 */
export async function crawl({ home, maxPages, maxDepth = 3, robots, sitemapUrls = [], seedUrls = [], render, onProgress, signal }) {
  const pages = [];
  const seen = new Set();
  const queue = [];
  let skippedByRobots = 0;

  const enqueue = (url, depth) => {
    const key = urlKey(url);
    if (seen.has(key) || depth > maxDepth) return;
    if (!sameSite(url, home.url) || NON_PAGE.test(new URL(url).pathname)) return;
    seen.add(key);
    if (!robots.isAllowed(url)) {
      skippedByRobots++;
      return;
    }
    queue.push({ url, depth });
  };

  async function toPage(res, depth) {
    const page = {
      url: res.url,
      requestedUrl: res.requestedUrl,
      status: res.status,
      depth,
      redirects: res.redirects,
      error: res.error || null,
      facts: null,
    };
    if (res.status < 200 || res.status >= 300 || !isHtml(res) || !res.body) return page;
    let facts = extractPage(res.body, res.url);
    const rawTextLength = facts.textLength;
    if (render && looksLikeShell(facts)) {
      const rendered = await render(res.url).catch(() => null);
      if (rendered?.html) facts = { ...extractPage(rendered.html, res.url), rendered: true };
    }
    page.facts = { ...facts, rawTextLength };
    return page;
  }

  seen.add(urlKey(home.url));
  seen.add(urlKey(home.requestedUrl || home.url));
  const homePage = await toPage(home, 0);
  pages.push(homePage);
  for (const u of seedUrls) enqueue(u, 1);
  homePage.facts?.links.forEach((l) => enqueue(l.href, 1));
  for (const u of sitemapUrls.slice(0, maxPages * 3)) enqueue(u, 1);
  onProgress?.(1, Math.min(maxPages, 1 + queue.length), home.url);

  const crawledKeys = new Set([urlKey(home.url)]);
  const inflight = new Set();
  let started = 1;
  while (queue.length || inflight.size) {
    while (queue.length && inflight.size < CONCURRENCY && started < maxPages && !signal?.aborted) {
      const { url, depth } = queue.shift();
      started++;
      const task = (async () => {
        const res = await fetchPage(url, { timeout: 12000 });
        const page = await toPage(res, depth).catch((err) => ({ url: res.url, status: res.status, depth, error: err.message, facts: null }));
        // A redirect can land on a page that was already crawled.
        const key = urlKey(page.url);
        if (crawledKeys.has(key)) return;
        crawledKeys.add(key);
        pages.push(page);
        page.facts?.links.forEach((l) => enqueue(l.href, depth + 1));
        onProgress?.(pages.length, Math.min(maxPages, pages.length + queue.length + inflight.size - 1), url);
      })();
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
    if (!inflight.size) break;
    await Promise.race(inflight);
  }

  return {
    pages,
    skippedByRobots,
    truncated: queue.length > 0,
    aborted: Boolean(signal?.aborted),
  };
}
