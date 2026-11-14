// The pages of a site the app has seen, in order of importance: the order the page picker shows them in and, when a page cap
// cuts the list of an as-is copy (behavior/preserve/asis.js asIsPageChoice), the order it keeps them in. General, from what
// the Check read of the homepage (audit/extract.js: every link with the part of the page it stands in), never from a site's name:
//   0 the homepage, 1 its header / menu links, 2 its other links, 3 its footer links (each in the order the homepage has them),
//   4 every other page: shallower paths first, then the crawl's own depth, then by address.
// A Check made before links carried their part (no `region` on any link) gives every homepage link rank 2, in page order.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditDir } from '../config/paths.js';
import { sameSite } from '../audit/util.js';

/** The path a page is known by: no query, no hash, no trailing slash ("/" for the homepage). */
export function pathKeyOf(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

const RANK_OF_REGION = { header: 1, footer: 3 };

/**
 * A function giving each page (by address) its place: lower first.
 * @param {{ homeUrl: string, homeLinks?: { href: string, internal?: boolean, region?: string | null }[], depthOf?: Map<string, number> }} o
 */
export function importanceOf({ homeUrl, homeLinks = [], depthOf = new Map() }) {
  const home = pathKeyOf(homeUrl);
  const linked = new Map(); // path -> { rank, at }
  homeLinks.forEach((l, at) => {
    if (l.internal === false || !sameSite(l.href, homeUrl)) return;
    const key = pathKeyOf(l.href);
    if (!key || key === home) return;
    const rank = RANK_OF_REGION[l.region] ?? 2;
    const had = linked.get(key);
    if (!had || rank < had.rank) linked.set(key, { rank, at: had ? Math.min(had.at, at) : at });
  });
  return (url) => {
    const key = pathKeyOf(url);
    if (key === home) return [0, 0, 0, ''];
    const l = linked.get(key);
    if (l) return [l.rank, l.at, 0, key ?? ''];
    const segments = (key ?? '').split('/').filter(Boolean).length;
    return [4, segments, depthOf.get(key) ?? 99, key ?? ''];
  };
}

/** Sorts addresses by importanceOf (a stable sort: equal places keep their order). */
export function byImportance(urls, rankOf) {
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a[3].localeCompare(b[3]);
  };
  return urls.map((u) => ({ u, r: rankOf(u) })).sort((x, y) => cmp(x.r, y.r)).map((x) => x.u);
}

/**
 * Every page of the project the app has seen, most important first: each page a Check read (2xx, crawl.json of the latest 20
 * analyses), each page a copy captured (the latest 5), no query-string variants; and the order function they were sorted by.
 * @param {{ id: string, url: string }} project
 * @param {{ analysisIds: string[], recreateReports: object[] }} sources  newest first
 */
export async function knownPages(project, { analysisIds, recreateReports }) {
  const urls = new Map();
  const add = (u) => {
    try {
      const url = new URL(u);
      if (url.search || !sameSite(url.href, project.url)) return;
      url.hash = '';
      const key = pathKeyOf(url.href);
      if (!urls.has(key)) urls.set(key, url.href);
    } catch {
      // not an address
    }
  };
  add(project.url);
  let homeLinks = null;
  const depthOf = new Map();
  for (const id of analysisIds) {
    const crawl = await readFile(path.join(auditDir(project.id, id), 'crawl.json'), 'utf8').then(JSON.parse, () => null);
    // The newest Check that read the homepage decides the order of its links.
    if (!homeLinks && crawl?.pages?.[0]?.facts?.links) homeLinks = crawl.pages[0].facts.links;
    for (const p of crawl?.pages ?? []) {
      if (!(p.status >= 200 && p.status < 300)) continue;
      add(p.url);
      const key = pathKeyOf(p.url);
      if (Number.isInteger(p.depth) && !(depthOf.get(key) <= p.depth)) depthOf.set(key, p.depth);
    }
  }
  for (const report of recreateReports) for (const p of report?.pages ?? []) if (p.url && !p.notFound) add(p.url);
  const rankOf = importanceOf({ homeUrl: project.url, homeLinks: homeLinks ?? [], depthOf });
  const ordered = byImportance([...urls.values()], rankOf);
  return { pages: ordered.map((url) => ({ path: pathKeyOf(url), url })), rankOf };
}
