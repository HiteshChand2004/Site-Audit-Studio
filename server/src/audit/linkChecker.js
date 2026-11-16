import { fetchPage } from './http.js';
import { limiter, pathOf, urlKey } from './util.js';

const MAX_LINKS = 500;
const CONCURRENCY = 8;
// At once on one website: as many as the crawl reads its pages with (crawler.js), so a large site's own links (most of them)
// are not checked at half the crawl's pace.
const PER_HOST = 4;

/**
 * broken      → the link is dead for real visitors (4xx/5xx, DNS failure, refused, bad TLS)
 * unverified  → the server would not answer an automated check (rate limits, bot walls, auth, timeouts),
 *               or the link points at a private network address the SSRF guard does not let us request
 * ok          → 2xx
 */
export function classifyLink(status, error) {
  if (error) return ['timeout', 'error', 'too-many-redirects', 'blocked'].includes(error) ? 'unverified' : 'broken';
  if (status >= 200 && status < 400) return 'ok';
  if ([401, 403, 407, 429, 999].includes(status)) return 'unverified';
  if (status >= 400) return 'broken';
  return 'unverified';
}

const UNVERIFIED_REASON = {
  401: 'Requires login',
  403: 'Server refused automated checks',
  407: 'Proxy authentication required',
  429: 'Rate limited',
  999: 'Blocks automated checks',
};

/** One link's answer; null when the check was stopped meanwhile (it is then not counted as checked, nor as timed out). */
async function probe(url, signal) {
  const head = await fetchPage(url, { method: 'HEAD', timeout: 8000, readBody: false, signal });
  if (signal?.aborted) return null;
  // Many servers mishandle HEAD, so confirm any failure with a GET before reporting it.
  if (head.error || head.status >= 400) {
    const get = await fetchPage(url, { timeout: 10000, readBody: false, signal });
    if (signal?.aborted) return null;
    return get.error && !head.error ? head : get;
  }
  return head;
}

/**
 * The links of the crawled pages, and what the crawl already knows of them (their status), deduplicated.
 * @param {Array<{url:string,status:number,error?:string,requestedUrl?:string,facts?:object}>} pages
 */
function planLinks(pages) {
  // url key → { url, foundOn }
  const links = new Map();
  for (const page of pages) {
    for (const link of page.facts?.links ?? []) {
      const key = urlKey(link.href);
      if (!links.has(key)) links.set(key, { url: link.href, foundOn: pathOf(page.url) });
    }
  }
  // Crawled pages already have a status; reuse it instead of fetching again.
  const known = new Map();
  for (const p of pages) {
    const result = { status: p.status, error: p.error };
    known.set(urlKey(p.url), result);
    if (p.requestedUrl) known.set(urlKey(p.requestedUrl), result);
  }
  const all = [...links.entries()];
  return { all, targets: all.slice(0, MAX_LINKS), known };
}

/** How many links the check will ask for (the ones the crawl did not read): what its time limit follows (audit/index.js). */
export const linksToCheck = (pages) => {
  const { targets, known } = planLinks(pages);
  return targets.filter(([key]) => !known.has(key)).length;
};

/**
 * @param {object} o
 * @param {Array<{url:string,status:number,error?:string,facts?:object}>} o.pages  crawled pages (their links are checked)
 * @param {(done:number,total:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function checkLinks({ pages, onProgress, signal }) {
  const { all, targets, known } = planLinks(pages);
  const global = limiter(CONCURRENCY);
  const hosts = new Map();
  const hostLimit = (url) => {
    const host = new URL(url).hostname;
    if (!hosts.has(host)) hosts.set(host, limiter(PER_HOST));
    return hosts.get(host);
  };

  let done = 0;
  const results = await Promise.all(
    targets.map(async ([key, link]) => {
      let res = known.get(key);
      if (!res && !signal?.aborted) {
        // Stopped (the step's time): links waiting are skipped and links being checked end at once, so what was checked is kept.
        res = await hostLimit(link.url)(() => global(() => (signal?.aborted ? null : probe(link.url, signal))));
      }
      done++;
      if (done % 5 === 0 || done === targets.length) onProgress?.(done, targets.length);
      if (!res) return null;
      return { ...link, status: res.status, error: res.error, verdict: classifyLink(res.status, res.error) };
    }),
  );

  const checked = results.filter(Boolean);
  return {
    checked: checked.length,
    total: all.length,
    truncated: all.length > targets.length || checked.length < targets.length,
    broken: checked
      .filter((r) => r.verdict === 'broken')
      .map((r) => ({ url: r.url, status: r.error ? r.error.toUpperCase() : r.status, foundOn: r.foundOn })),
    unverified: checked
      .filter((r) => r.verdict === 'unverified')
      .map((r) => ({
        url: r.url,
        status: r.error ? r.error.toUpperCase() : r.status,
        reason:
          r.error === 'timeout'
            ? 'Timed out'
            : r.error === 'blocked'
              ? 'Private network address (not requested)'
              : UNVERIFIED_REASON[r.status] || 'Could not verify',
        foundOn: r.foundOn,
      })),
  };
}
