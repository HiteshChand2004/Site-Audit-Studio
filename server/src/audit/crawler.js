import { extractPage, looksLikeShell } from './extract.js';
import { fetchPage, isHtml } from './http.js';
import { pageKey, sameSite } from './util.js';

const NON_PAGE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|zip|rar|7z|gz|dmg|exe|docx?|xlsx?|pptx?|csv|json|xml|txt|css|js|woff2?|ttf)$/i;
// Pages fetched at once unless the caller asks for another number (Analyze keeps 4; Recreate's discovery asks for more).
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
 * @param {number} [o.concurrency]  pages fetched at once (default 4)
 * @param {(facts:object, html:string)=>boolean} [o.needsRender]  which fetched pages get the browser render (default: a shell)
 * @param {(done:number,total:number,url:string)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]  stops starting new pages; partial results are returned
 * @param {Set<string>|null} [o.only]  page keys (pageKey): only these pages are fetched; links are still followed from them.
 *   The result then has `firstQueue`: key -> place in the first queue of the same crawl without `only`
 */
export async function crawl({ home, maxPages, maxDepth = 3, robots, sitemapUrls = [], seedUrls = [], render, onProgress, signal, concurrency = CONCURRENCY, needsRender = looksLikeShell, only = null }) {
  const pages = [];
  const seen = new Set();
  const queue = [];
  let skippedByRobots = 0;

  // With `only`: each page's place in the first queue as a crawl without `only` would build it (homepage links, seeds and
  // sitemap are all queued before the first fetch, and pages start in queue order), so the caller can tell which of the
  // chosen pages that crawl would have fetched within maxPages.
  const firstQueue = only ? new Map() : null;
  const firstSeen = new Set();
  let queueing = Boolean(only);
  const enqueue = (url, depth) => {
    const key = pageKey(url);
    if (seen.has(key) || depth > maxDepth) return;
    if (!sameSite(url, home.url) || NON_PAGE.test(new URL(url).pathname)) return;
    if (queueing && !firstSeen.has(key)) {
      firstSeen.add(key);
      if (robots.isAllowed(url)) firstQueue.set(key, firstQueue.size);
    }
    if (only && !only.has(key)) return;
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
    if (render && needsRender(facts, res.body)) {
      const rendered = await render(res.url).catch(() => null);
      if (rendered?.html) facts = { ...extractPage(rendered.html, res.url), rendered: true };
    }
    page.facts = { ...facts, rawTextLength };
    return page;
  }

  seen.add(pageKey(home.url));
  seen.add(pageKey(home.requestedUrl || home.url));
  for (const k of seen) firstSeen.add(k);
  const homePage = await toPage(home, 0);
  pages.push(homePage);
  for (const u of seedUrls) enqueue(u, 1);
  homePage.facts?.links.forEach((l) => enqueue(l.href, 1));
  for (const u of sitemapUrls.slice(0, maxPages * 3)) enqueue(u, 1);
  queueing = false;
  onProgress?.(1, Math.min(maxPages, 1 + queue.length), home.url);

  const crawledKeys = new Set([pageKey(home.url)]);
  const inflight = new Set();
  let started = 1;
  while (queue.length || inflight.size) {
    while (queue.length && inflight.size < concurrency && started < maxPages && !signal?.aborted) {
      const { url, depth } = queue.shift();
      started++;
      const task = (async () => {
        const res = await fetchPage(url, { timeout: 12000 });
        const page = await toPage(res, depth).catch((err) => ({ url: res.url, status: res.status, depth, error: err.message, facts: null }));
        // A redirect can land on a page that was already crawled.
        const key = pageKey(page.url);
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
    ...(firstQueue && { firstQueue }),
  };
}

/**
 * Why a crawl read the pages it read, for the person reading the report: 'time-limit' (its step's time ran out and it stopped
 * starting pages), 'page-limit' (maxPages started with addresses still waiting) or 'all-found' (nothing left to follow).
 * Pure, from the crawl's own result; null when there is no crawl result (the step failed or was skipped: audit.errors says so).
 * @param {{ pages: object[], truncated?: boolean, aborted?: boolean } | null | undefined} result
 * @param {{ maxPages: number, timeLimitMs?: number | null }} o
 */
export function crawlStopOf(result, { maxPages, timeLimitMs = null }) {
  if (!result || !Array.isArray(result.pages) || result.aborted === undefined) return null;
  const reason = result.aborted ? 'time-limit' : result.truncated ? 'page-limit' : 'all-found';
  return {
    reason,
    read: result.pages.length,
    maxPages,
    ...(reason === 'time-limit' && timeLimitMs != null && { timeLimitSeconds: Math.round(timeLimitMs / 1000) }),
  };
}
