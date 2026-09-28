import { pathOf, plural } from '../util.js';

/** The "Meta, sitemap & robots" section: crawl.sitemap / crawl.robots / crawl.metaTags. */
export function analyzeCrawl({ robots, sitemap, homeFacts }) {
  let sitemapItem;
  const src = sitemap.sources[0];
  if (sitemap.status === 'found') {
    const where = sitemap.sources.filter((s) => s.status === 'found').map((s) => pathOf(s.url));
    sitemapItem = { status: 'pass', detail: `${where.join(', ')} · ${plural(sitemap.urls.length, 'URL')}` };
  } else if (sitemap.status === 'invalid') {
    sitemapItem = { status: 'fail', detail: `${pathOf(src.url)} is not a valid XML sitemap` };
  } else {
    sitemapItem = { status: 'fail', detail: `${src ? pathOf(src.url) : '/sitemap.xml'} → ${src?.httpStatus || src?.error || 'not found'}` };
  }

  let robotsItem;
  if (robots.status !== 'found') {
    robotsItem = { status: 'warn', detail: `robots.txt → ${robots.httpStatus || robots.error || 'not found'}` };
  } else if (robots.blocksAll) {
    robotsItem = { status: 'fail', detail: 'robots.txt blocks all crawlers from the whole site (Disallow: /)' };
  } else if (!robots.sitemaps.length) {
    robotsItem = { status: 'warn', detail: 'robots.txt exists but has no Sitemap: directive' };
  } else {
    robotsItem = { status: 'pass', detail: `robots.txt exists and lists ${plural(robots.sitemaps.length, 'sitemap')}` };
  }

  const tags = [
    ['viewport', Boolean(homeFacts?.viewport)],
    ['charset', Boolean(homeFacts?.charset)],
    ['twitter:card', Boolean(homeFacts?.twitter.card)],
    ['theme-color', Boolean(homeFacts?.themeColor)],
    ['favicon', Boolean(homeFacts?.favicon)],
  ];
  const essentialsMissing = !homeFacts?.viewport || !homeFacts?.charset;
  const allPresent = tags.every(([, ok]) => ok);
  const metaTags = {
    status: essentialsMissing ? 'fail' : allPresent ? 'pass' : 'warn',
    detail: tags.map(([name, ok]) => `${name} ${ok ? '✓' : '✗'}`).join(', '),
  };

  return { sitemap: sitemapItem, robots: robotsItem, metaTags };
}
