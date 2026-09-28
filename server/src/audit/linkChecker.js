import { fetchPage } from './http.js';
import { limiter, pathOf, urlKey } from './util.js';

const MAX_LINKS = 500;
const CONCURRENCY = 8;
const PER_HOST = 2;

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

async function probe(url) {
  const head = await fetchPage(url, { method: 'HEAD', timeout: 8000, readBody: false });
  // Many servers mishandle HEAD, so confirm any failure with a GET before reporting it.
  if (head.error || head.status >= 400) {
    const get = await fetchPage(url, { timeout: 10000, readBody: false });
    return get.error && !head.error ? head : get;
  }
  return head;
}

/**
 * @param {object} o
 * @param {Array<{url:string,status:number,error?:string,facts?:object}>} o.pages  crawled pages (their links are checked)
 * @param {(done:number,total:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function checkLinks({ pages, onProgress, signal }) {
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
  const targets = all.slice(0, MAX_LINKS);
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
        res = await hostLimit(link.url)(() => global(() => (signal?.aborted ? null : probe(link.url))));
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
