// Which pages the fix checklist compares, and how URLs of the recreated site (served on a throwaway
// preview origin) map back to the original site. Everything comes from the recreate report
// (original URL + output path of each page) and the two crawls; nothing is site-specific.
import { siteHost } from '../../audit/util.js';

/** Comparable form of a URL: host without www, no protocol, no hash, no trailing slash (except "/"). */
export function normUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${siteHost(u.hostname)}${u.port ? `:${u.port}` : ''}${pathname}${u.search}`;
  } catch {
    return String(url);
  }
}

/** URL path of an emitted page: "about/index.html" → "/about/", "index.html" → "/". */
export const newPathOf = (outPath) => `/${outPath.replace(/(^|\/)index\.html$/, '$1')}`;

// A page's path on the recreated site: the one its output recorded (Next.js moves about.html to /about/), else the original layout.
const pathOnNew = (page) => page.newPath ?? newPathOf(page.outPath);

/**
 * Pairs every recreated page with its page in the OLD crawl and in the NEW crawl.
 * @param {object} o
 * @param {{ url: string, outPath: string }[]} o.reportPages  recreate report pages (homepage first)
 * @param {object[]} o.oldPages  OLD crawl.json pages (with facts)
 * @param {object[]} o.newPages  NEW crawl.json pages (with facts)
 * @param {string} o.newOrigin   the origin the re-audit served the build on
 * @returns {{ pairs: { path: string, url: string, old: object, new: object }[], outOfScope: string[], missingInNew: string[], missingInOld: string[] }}
 *   pairs: pages both crawls have, in report order; outOfScope: OLD pages that were not recreated;
 *   missingInNew / missingInOld: recreated pages one crawl did not reach (left out of the comparison)
 */
export function pairPages({ reportPages, oldPages, newPages, newOrigin }) {
  const index = (pages) => {
    const map = new Map();
    for (const p of pages) {
      if (!p.facts) continue;
      for (const u of [p.url, p.requestedUrl]) if (u && !map.has(normUrl(u))) map.set(normUrl(u), p);
    }
    return map;
  };
  const oldByUrl = index(oldPages);
  const newByUrl = index(newPages);
  const pairs = [];
  const missingInNew = [];
  const missingInOld = [];
  const used = new Set();
  for (const rp of reportPages) {
    const path = pathOnNew(rp);
    const oldPage = oldByUrl.get(normUrl(rp.url));
    const newPage = newByUrl.get(normUrl(`${newOrigin}${path}`));
    if (!newPage) missingInNew.push(path);
    else if (!oldPage) missingInOld.push(path);
    else {
      pairs.push({ path, url: rp.url, old: oldPage, new: newPage });
      used.add(oldPage);
    }
  }
  const outOfScope = oldPages.filter((p) => p.facts && !used.has(p)).map((p) => p.url);
  return { pairs, outOfScope, missingInNew, missingInOld };
}

/**
 * Maps a URL seen on the recreated site back to the original site, so links can be matched.
 * Recreated pages map to their original URL; other paths on the preview origin to the original
 * origin; URLs elsewhere (live links, external sites) stay as they are.
 */
export function toOriginalUrl(url, { newOrigin, oldOrigin, reportPages }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.origin !== newOrigin) return url;
  const key = normUrl(`${newOrigin}${u.pathname}`);
  const page = reportPages.find((p) => normUrl(`${newOrigin}${pathOnNew(p)}`) === key);
  return page ? page.url : `${oldOrigin}${u.pathname}${u.search}`;
}
