// Page discovery for Recreate: which pages of the site get rebuilt.
// A fresh, SSRF-guarded mini crawl (robots.txt respected) collects candidates. The homepage always
// comes first, then pages the homepage links to (in link order, so the main navigation wins), then
// sitemap pages, then anything else the crawl found. URLs with a query string, non-HTML files and addresses that do not
// exist (404 / 410) are skipped with a reason. An address robots.txt closes is still a page (captured by the browser, flagged).
// A page is never left out because its backend is not there: a login, cart, account or dashboard page, a page the server
// answers with 401 / 403 / 5xx, and one that fails at network level are all pages of the site. They are captured as the
// browser renders them, and one that cannot be rendered at all is rebuilt from the evidence there is (inspect.js).
// Eligible pages beyond the page limit are listed (their links get a local notice page). In "All pages" mode the crawl
// reads the whole site (up to the safety cap) and follows links deeper.
import { createHash } from 'node:crypto';
import { crawl } from '../audit/crawler.js';
import { looksClientRendered } from '../audit/extract.js';
import { fetchPage, isBotChallenge, isHtml } from '../audit/http.js';
import { fetchLlmsTxt, loadRobots } from '../audit/robots.js';
import { loadSitemaps } from '../audit/sitemap.js';
import { pageKey, sameSite } from '../audit/util.js';
import { RecreateError } from './errors.js';

// Paths whose content or forms need a real backend: recreated like any page (the visible UI), and reported under "Manual
// rebuild needed" for what only a backend can do.
const BACKEND_PATH =
  /(^|\/)(log-?in|sign-?in|sign-?up|register|logout|account|my-account|cart|basket|checkout|wp-admin|wp-login\.php|admin|dashboard)(\/|\.html?$|$)/i;
const NON_PAGE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|zip|rar|7z|gz|dmg|exe|docx?|xlsx?|pptx?|csv|json|xml|txt|css|js|woff2?|ttf)$/i;
// Enough candidates to fill the limit after skips, without crawling the whole site.
const crawlBudget = (limit) => Math.min(60, 1 + limit * 3 + 10);
// "All pages": every page the crawl can reach, up to the safety cap (+ room for skipped URLs), any depth that matters.
const ALL_PAGES_EXTRA = 50;
const ALL_PAGES_DEPTH = 8;
// Pages discovery fetches at once (plain HTTP requests, cheap: browser renders are limited separately by the caller).
export const CRAWL_CONCURRENCY = 8;

/** Pages fetched at once while finding pages: SAS_CRAWL_CONCURRENCY (1–16), else CRAWL_CONCURRENCY. */
export function crawlConcurrency(env = process.env) {
  const n = Number(env.SAS_CRAWL_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : CRAWL_CONCURRENCY;
}

/**
 * Output file for a URL path: "/" → index.html, "/about.html" → about.html, "/about" and "/about/" →
 * about/index.html, so the recreated site keeps the original URLs. Unsafe characters become "-".
 */
export function outPathFor(pathname) {
  const segments = decodeURIComponent(pathname)
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '') || 'page');
  if (!segments.length) return 'index.html';
  const last = segments[segments.length - 1];
  if (/\.html?$/.test(last) && !pathname.endsWith('/')) {
    segments[segments.length - 1] = last.replace(/\.htm$/, '.html');
    return segments.join('/');
  }
  return [...segments, 'index.html'].join('/');
}

// Longest folder name. Windows refuses paths over 260 characters to the image library (sharp: "unable to open for write"),
// and data/projects/<id>/recreate/<id>.tmp/capture/<slug>/desktop-full.webp already takes ~170 of them: a page with a long
// address (a blog post title) failed its capture and was linked to the original site.
const MAX_SLUG = 48;

/** Folder name for a page's capture files: "index", "about", "blog__first-post"; a long one is cut and ends in a short hash. */
export const slugFor = (outPath) => {
  const slug = outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replaceAll('/', '__') || 'index';
  if (slug.length <= MAX_SLUG) return slug;
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `${slug.slice(0, MAX_SLUG - 9).replace(/[-_.]+$/, '')}-${hash}`;
};

/** Why a URL cannot be a recreated page, or null when it can. */
export function skipReason(url, origin) {
  const u = new URL(url);
  if (!sameSite(url, origin)) return 'external';
  if (NON_PAGE.test(u.pathname)) return 'not-html';
  if (u.search) return 'query';
  return null;
}

/** Does the address look like a page whose content or forms need a backend (login, account, cart, admin …)? */
export const needsBackend = (url) => {
  try {
    return BACKEND_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** A status that means "no page here" (a broken link), as opposed to a page whose server or backend failed. */
export const NOT_FOUND_STATUS = new Set([404, 410]);

export const SKIP_LABELS = {
  // Kept for reports written before backend pages were recreated.
  backend: 'Needs a backend (login, cart, checkout or account); rebuild it manually.',
  'not-found': 'The address does not exist on the original (404 / 410): a broken link, not a page.',
  query: 'URL has a query string; treated as a variant of another page.',
  'not-html': 'Not an HTML page.',
  robots: 'Blocked by robots.txt.',
  error: 'The page did not load (error status or network failure).',
};

/**
 * Picks the pages to recreate from crawl results. Pure: no network.
 * @param {object} o
 * @param {object[]} o.pages       crawler pages ({ url, requestedUrl, status, depth, facts })
 * @param {string} o.homeUrl
 * @param {string[]} o.sitemapUrls
 * @param {string[]} [o.knownUrls]  pages the analysis found (its crawl renders pages that are built by script)
 * @param {{isAllowed:(url:string)=>boolean}} o.robots
 * @param {number} o.limit         pages besides the homepage
 */
export function selectPages({ pages, homeUrl, sitemapUrls = [], knownUrls = [], robots, limit }) {
  const origin = new URL(homeUrl).origin;
  const byKey = new Map();
  for (const p of pages) {
    byKey.set(pageKey(p.url), p);
    if (p.requestedUrl) byKey.set(pageKey(p.requestedUrl), p);
  }
  const home = pages[0];

  // Candidate order: homepage links, sitemap, rest of the crawl. Each URL keeps its first source.
  const order = [];
  const seen = new Set([pageKey(home.url)]);
  const add = (url, source) => {
    let key;
    try {
      key = pageKey(url);
    } catch {
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    order.push({ url, key, source });
  };
  for (const l of home.facts?.links ?? []) if (l.internal) add(l.href, 'home-link');
  for (const u of sitemapUrls) add(u, 'sitemap');
  for (const u of knownUrls) add(u, 'analysis');
  for (const p of pages.slice(1)) add(p.url, 'crawl');

  const selected = [{ page: home, source: 'home' }];
  const skipped = [];
  const beyondLimit = [];
  for (const c of order) {
    let reason = skipReason(c.url, origin);
    if (reason === 'external') continue;
    const page = byKey.get(c.key);
    // robots.txt asks crawlers not to read it - often the very pages that need a backend (an admin, a cart, an account).
    // It is still a page of the site the copy is made of: the crawl above did not fetch it, so the capture's browser
    // opens it like any other page, and the report says robots.txt closes it.
    if (!reason && !robots.isAllowed(c.url)) {
      const target = page ?? { url: c.url, depth: null };
      if (selected.some((s) => pageKey(s.page.url) === pageKey(target.url))) continue;
      if (selected.length <= limit) selected.push({ page: target, source: c.source, robotsBlocked: true });
      else beyondLimit.push({ url: target.url, source: c.source });
      continue;
    }
    if (!reason && !page) {
      // Known (sitemap or link) but not crawled within the crawl budget: still a real page.
      beyondLimit.push({ url: c.url, source: c.source });
      continue;
    }
    // The crawler only extracts facts from 2xx HTML responses. Without them: a 2xx is a file, not a page; a 404 / 410 is
    // a broken link; anything else - 401, 403, 5xx, a network failure - is a page whose server or backend failed, and it
    // is still a page of the site: it is captured as the browser renders it (inspect.js rebuilds it from evidence when
    // even that fails), flagged `degraded`.
    let degraded = null;
    if (!reason && !page.facts) {
      if (NOT_FOUND_STATUS.has(page.status)) reason = 'not-found';
      else if (!page.error && page.status >= 200 && page.status < 300) reason = 'not-html';
      else degraded = { status: page.status ?? null, error: page.error ?? null };
    }
    if (reason) {
      skipped.push({ url: c.url, source: c.source, reason, status: page?.status ?? null });
      continue;
    }
    // A redirect can land on a page that is already selected.
    if (selected.some((s) => pageKey(s.page.url) === pageKey(page.url))) continue;
    if (selected.length <= limit) selected.push({ page, source: c.source, ...(degraded && { degraded }) });
    else beyondLimit.push({ url: page.url, source: c.source });
  }

  const usedOut = new Set();
  const result = selected.map(({ page, source, degraded, robotsBlocked }) => {
    let outPath = outPathFor(new URL(page.url).pathname);
    // Two URLs can map to one file ("/About" and "/about"); keep the first, number the rest.
    for (let i = 2; usedOut.has(outPath); i++) outPath = outPath.replace(/(-\d+)?(\/index)?\.html$/, `-${i}$2.html`);
    usedOut.add(outPath);
    return {
      url: page.url,
      path: new URL(page.url).pathname,
      outPath,
      slug: slugFor(outPath),
      source,
      title: page.facts?.title ?? null,
      depth: page.depth,
      ...(degraded && { degraded }),
      ...(needsBackend(page.url) && { needsBackend: true }),
      ...(robotsBlocked && { robotsBlocked: true }),
    };
  });
  return { pages: result, skipped, beyondLimit };
}

/**
 * Crawls the site and selects the pages to recreate.
 * @param {object} o
 * @param {string} o.url       the analyzed homepage URL
 * @param {number} o.limit     pages besides the homepage (projects.recreate_pages)
 * @param {boolean} [o.all]    "All pages": crawl the whole site (up to `limit`, the safety cap) instead of a sample
 * @param {string[]} [o.knownUrls]  pages the analysis found: crawled first, so no page it saw is missed
 * @param {(url:string)=>Promise<{html:string}|null>} [o.render]  a browser render for pages whose links are built by
 *   script (the server sends an empty shell), as the analysis crawl does
 * @param {AbortSignal} [o.signal]
 * @param {(fraction:number, message?:string)=>void} [o.onProgress]
 * @returns {Promise<{ homeUrl: string, origin: string, pages: object[], skipped: object[], beyondLimit: object[],
 *   sitemap: { status: string, count: number }, crawled: number }>}
 */
/**
 * What the site does with an address that does not exist. A copy that answers 200 with a blank page where the
 * original answers 404 with its own design is wrong in a way no screenshot of a real page would ever show.
 * Asked with one request for an address no site would have.
 * @returns {Promise<{ url, status, html, ownPage, title, bytes } | null>}
 */
export async function probeNotFound(origin, { signal } = {}) {
  const url = new URL(`/sas-no-such-page-${Math.random().toString(36).slice(2, 10)}`, origin).href;
  const r = await fetchPage(url, { timeout: 15000, signal }).catch(() => null);
  if (!r || r.error) return null;
  const body = r.body ?? '';
  const html = /text\/html/i.test(r.contentType ?? '') || /^\s*<(!doctype|html)/i.test(body);
  // A page of the site's own, rather than a server's bare "Not Found": it has a head and some substance, which is
  // what makes it worth capturing and rebuilding like any other page.
  const ownPage = html && body.length > 500 && /<(head|title|link|style)[\s>]/i.test(body);
  return {
    url,
    status: r.status,
    html,
    ownPage,
    title: (body.match(/<title[^>]*>([^<]{1,200})</i) ?? [])[1]?.trim() ?? null,
    bytes: body.length,
  };
}

export async function discoverPages({ url, limit, all = false, knownUrls = [], render, signal, onProgress, notFound = false }) {
  const home = await fetchPage(url, { timeout: 20000, signal });
  if (home.error === 'blocked') throw new RecreateError(home.message);
  if (home.error || home.status >= 400) throw new RecreateError(`Could not load the homepage (${home.error || `HTTP ${home.status}`}).`);
  if (isBotChallenge(home)) {
    throw new RecreateError('The site answered with a bot-protection challenge; Site Audit Studio does not bypass bot protection.');
  }
  if (!isHtml(home)) throw new RecreateError('The homepage is not an HTML page.');

  const origin = new URL(home.url).origin;
  const [robots, llms] = await Promise.all([loadRobots(origin), fetchLlmsTxt(origin)]);
  const sitemap = await loadSitemaps(origin, robots.sitemaps);
  onProgress?.(0.2, 'Finding pages');
  const result = await crawl({
    home,
    maxPages: all ? limit + 1 + ALL_PAGES_EXTRA : crawlBudget(limit),
    maxDepth: all ? ALL_PAGES_DEPTH : 2,
    robots,
    sitemapUrls: sitemap.urls.filter((u) => sameSite(u, origin)),
    seedUrls: knownUrls.filter((u) => sameSite(u, origin)),
    render,
    // HTTP first: a page is parsed from the HTML the server sends; a browser render only when that HTML may lack what a
    // visitor sees (an app shell, an empty mount point, a page asking for JavaScript): when in doubt, render.
    needsRender: looksClientRendered,
    concurrency: crawlConcurrency(),
    signal,
    onProgress: (done, total) => onProgress?.(0.2 + 0.8 * (done / Math.max(total, 1)), `Found ${done} pages`),
  });
  const selection = selectPages({ pages: result.pages, homeUrl: home.url, sitemapUrls: sitemap.urls, knownUrls, robots, limit });
  return {
    homeUrl: home.url,
    origin,
    ...selection,
    sitemap: { status: sitemap.status, count: sitemap.urls.length },
    // The original robots.txt rules the recreated robots.txt keeps (ir/crawlFiles.js).
    robots: { status: robots.status, blocksAll: robots.blocksAll, blockedAiCrawlers: robots.blockedAiCrawlers },
    // The original /llms.txt, copied as it is (ir/crawlFiles.js); text is null when absent or too large.
    llms: { found: llms.found, text: llms.text, tooLarge: llms.tooLarge },
    crawled: result.pages.length,
  };
}
