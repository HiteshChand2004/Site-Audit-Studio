// sitemap.xml, robots.txt and llms.txt of the recreated site (Phase 5). The first two name the site's own
// origin (baseUrl: the project's target domain, else the original origin), never the preview.
//   sitemap.xml  every recreated page that may be indexed (no noindex), at its canonical URL when that
//                is a page of this site, else at its own URL; no invented lastmod/priority.
//   robots.txt   keeps the intent of the original robots.txt that discovery read: a site closed to all
//                crawlers stays closed, and AI crawlers it blocked stay blocked; everything else allowed.
//                Points to the sitemap.
//   llms.txt     the original site's /llms.txt, copied as it is (the owner wrote it). When the original has none,
//                a plain one in the llmstxt.org format is generated from the pages' titles and descriptions (not
//                when the original's was too large to read whole: a warning asks to copy it by hand).
// Only general inputs: page heads, the parsed original robots.txt and its llms.txt. Nothing is site-specific.

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

// llms.txt (llmstxt.org): the site name, the homepage description, then one line per listed page.
const mdText = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim();
function llmsTxt(pages, urls, siteName, origin) {
  if (!urls.length) return null;
  const lines = [`# ${mdText(siteName || new URL(origin).hostname)}`, ''];
  if (pages[0]?.head?.description) lines.push(`> ${mdText(pages[0].head.description)}`, '');
  lines.push('## Pages', '');
  for (const t of pages) {
    const url = sitemapUrl(t.info, t.head, origin);
    if (!url) continue;
    const description = mdText(t.head.description);
    lines.push(`- [${mdText(t.head.title) || t.info.path}](${url})${description ? `: ${description}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {object} o
 * @param {{ info: { path: string }, head: object }[]} o.pages  recreated pages with their final head
 * @param {string} o.baseUrl  origin the site is published at
 * @param {{ status?: string, blocksAll?: boolean, blockedAiCrawlers?: string[] } | null} [o.robots]
 *   the original robots.txt as discovery parsed it (null when unknown)
 * @param {{ found?: boolean, text?: string|null, tooLarge?: boolean } | null} [o.llms]  the original /llms.txt
 * @param {string|null} [o.siteName]  heading of a generated llms.txt
 * @returns {{ files: { path: string, content: string }[], sitemap: { urls: string[], excluded: string[] },
 *   robots: { blocksAll: boolean, blockedAiCrawlers: string[], source: string },
 *   llms: { copied: boolean, bytes: number, tooLarge: boolean } }}
 */
export function crawlFiles({ pages, baseUrl, robots = null, llms = null, siteName = null }) {
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

  const copied = llms?.text?.trim() ? llms.text : null;
  const generated = copied || llms?.tooLarge ? null : llmsTxt(pages, urls, siteName, origin);
  const llmsText = copied ?? generated;
  return {
    files: [
      { path: 'sitemap.xml', content: sitemap },
      { path: 'robots.txt', content: lines.join('\n') },
      ...(llmsText ? [{ path: 'llms.txt', content: llmsText }] : []),
    ],
    sitemap: { urls, excluded },
    robots: { blocksAll, blockedAiCrawlers, source: found ? 'original robots.txt rules' : 'default (the original site has no robots.txt)' },
    llms: { copied: Boolean(copied), generated: Boolean(generated), bytes: llmsText ? Buffer.byteLength(llmsText) : 0, tooLarge: Boolean(llms?.tooLarge) },
  };
}
