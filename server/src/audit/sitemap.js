import * as cheerio from 'cheerio';
import { fetchPage } from './http.js';

const MAX_CHILD_SITEMAPS = 5;
const MAX_URLS = 5000;

export function parseSitemap(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const locs = (sel) => $(sel).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  if ($('sitemapindex').length) return { kind: 'index', urls: locs('sitemapindex sitemap loc') };
  if ($('urlset').length) return { kind: 'urlset', urls: locs('urlset url loc') };
  return { kind: 'invalid', urls: [] };
}

/**
 * Loads sitemaps listed in robots.txt, falling back to /sitemap.xml. Follows one level of sitemap index.
 * @returns {{ status: 'found'|'missing'|'invalid', urls: string[], sources: object[], fromRobots: boolean, detail: string }}
 */
export async function loadSitemaps(origin, robotsSitemaps = []) {
  const fromRobots = robotsSitemaps.length > 0;
  const roots = fromRobots ? robotsSitemaps.slice(0, MAX_CHILD_SITEMAPS) : [`${origin}/sitemap.xml`];
  const sources = [];
  const urls = new Set();

  async function load(url, depth) {
    if (/\.gz$/i.test(url)) {
      sources.push({ url, status: 'skipped', detail: 'gzip sitemaps are not read' });
      return;
    }
    const res = await fetchPage(url, { timeout: 12000, maxBytes: 10 * 1024 * 1024 });
    if (res.status !== 200 || !res.body) {
      sources.push({ url, status: 'missing', httpStatus: res.status, error: res.error });
      return;
    }
    const parsed = parseSitemap(res.body);
    sources.push({ url, status: parsed.kind === 'invalid' ? 'invalid' : 'found', kind: parsed.kind, count: parsed.urls.length });
    if (parsed.kind === 'index' && depth === 0) {
      for (const child of parsed.urls.slice(0, MAX_CHILD_SITEMAPS)) await load(child, 1);
    } else if (parsed.kind === 'urlset') {
      for (const u of parsed.urls) if (urls.size < MAX_URLS) urls.add(u);
    }
  }

  for (const root of roots) await load(root, 0);

  const anyFound = sources.some((s) => s.status === 'found');
  const anyInvalid = sources.some((s) => s.status === 'invalid');
  const status = anyFound ? 'found' : anyInvalid ? 'invalid' : 'missing';
  return { status, urls: [...urls], sources, fromRobots };
}
