// sitemap.xml and robots.txt of the recreated site (Phase 5). Both name the site's own origin
// (baseUrl: the project's target domain, else the original origin), never the preview.
//   sitemap.xml  every recreated page that may be indexed (no noindex), at its canonical URL when that
//                is a page of this site, else at its own URL; no invented lastmod/priority.
//   robots.txt   keeps the intent of the original robots.txt that discovery read: a site closed to all
//                crawlers stays closed, and AI crawlers it blocked stay blocked; everything else allowed.
//                Points to the sitemap.
// Only general inputs: page heads and the parsed original robots.txt. Nothing is site-specific.

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const noindex = (head) => (head.meta ?? []).some((m) => /^(robots|googlebot)$/i.test(m.name ?? '') && /noindex/i.test(m.content ?? ''));

/** The URL a page is listed under, or null when it must not be listed. */
function sitemapUrl(page, head, origin) {
  if (noindex(head)) return null;
  const own = new URL(page.path, origin).href;
  try {
    const canonical = new URL(head.canonical);
    return canonical.origin === origin ? canonical.href : own;
  } catch {
    return own;
  }
}

/**
 * @param {object} o
 * @param {{ info: { path: string }, head: object }[]} o.pages  recreated pages with their final head
 * @param {string} o.baseUrl  origin the site is published at
 * @param {{ status?: string, blocksAll?: boolean, blockedAiCrawlers?: string[] } | null} [o.robots]
 *   the original robots.txt as discovery parsed it (null when unknown)
 * @returns {{ files: { path: string, content: string }[], sitemap: { urls: string[], excluded: string[] },
 *   robots: { blocksAll: boolean, blockedAiCrawlers: string[], source: string } }}
 */
export function crawlFiles({ pages, baseUrl, robots = null }) {
  const origin = new URL(baseUrl).origin;
  const urls = [];
  const excluded = [];
  for (const t of pages) {
    const url = sitemapUrl(t.info, t.head, origin);
    if (!url) excluded.push(t.info.path);
    else if (!urls.includes(url)) urls.push(url);
  }
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  const found = robots?.status === 'found';
  const blocksAll = found && Boolean(robots.blocksAll);
  const blockedAiCrawlers = found && !blocksAll ? [...new Set(robots.blockedAiCrawlers ?? [])] : [];
  const lines = ['User-agent: *', blocksAll ? 'Disallow: /' : 'Allow: /', ''];
  for (const ua of blockedAiCrawlers) lines.push(`User-agent: ${ua}`, 'Disallow: /', '');
  lines.push(`Sitemap: ${origin}/sitemap.xml`, '');

  return {
    files: [
      { path: 'sitemap.xml', content: sitemap },
      { path: 'robots.txt', content: lines.join('\n') },
    ],
    sitemap: { urls, excluded },
    robots: { blocksAll, blockedAiCrawlers, source: found ? 'original robots.txt rules' : 'default (the original site has no robots.txt)' },
  };
}
