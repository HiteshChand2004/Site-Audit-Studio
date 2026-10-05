// Full addresses copied from the original site (structured data, llms.txt, hreflang alternates) are moved onto the
// new site's address (full-site E.1): a page of the copy → baseUrl + its path in the copy, a downloaded file → its local
// copy, any other page of the site → the copy's notice page at that path (ir/notice.js, like links in the pages).
// Addresses on other hosts are left as they are (they are not the original site). Uses the same link resolver as the
// page links (ir/links.js), so a page is named the same way everywhere.

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()\[\]{}|\\^`]+/g;

/** The path a site file is served at: index.html → /, about/index.html → /about/, about.html → /about.html. */
export function servedPath(outPath) {
  if (outPath === 'index.html') return '/';
  if (outPath.endsWith('/index.html')) return `/${outPath.slice(0, -'index.html'.length)}`;
  return `/${outPath}`;
}

/**
 * @param {object} o
 * @param {(href: string, pageUrl: string) => object|null} o.resolveLink  ir/links.js createLinkResolver
 * @param {string} o.baseUrl  the new site's address
 * @returns {{ url: (href: string, pageUrl: string) => string, json: (raw: string, pageUrl: string) => string, text: (s: string, pageUrl: string) => string, count: () => number }}
 */
export function createRebaser({ resolveLink, baseUrl }) {
  const base = `${new URL(baseUrl).origin}/`;
  let changed = 0;
  const url = (href, pageUrl) => {
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return href;
    let link;
    try {
      link = resolveLink(href, pageUrl);
    } catch {
      return href;
    }
    let out = null;
    if (link?.page) out = new URL(servedPath(link.page) + (link.hash ?? ''), base).href;
    else if (link?.anchor) out = new URL(link.anchor, href).href.replace(new URL(href).origin + '/', base);
    else if (link?.asset) out = new URL(`assets/${link.asset}`, base).href;
    else if (link?.file) out = new URL(servedPath(link.file), base).href;
    if (!out || out === href) return href;
    changed++;
    return out;
  };
  // Every string value of the JSON that is a full address is moved; keys and other values stay as they are.
  const walk = (v, pageUrl) => {
    if (typeof v === 'string') return url(v, pageUrl);
    if (Array.isArray(v)) return v.map((x) => walk(x, pageUrl));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, pageUrl)]));
    return v;
  };
  const json = (raw, pageUrl) => {
    try {
      return JSON.stringify(walk(JSON.parse(raw), pageUrl));
    } catch {
      return raw; // invalid JSON-LD is dropped later by the HTML guard
    }
  };
  const text = (s, pageUrl) => s.replace(URL_IN_TEXT, (m) => {
    // Trailing punctuation of a sentence is not part of the address.
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    return url(m.slice(0, m.length - trail.length), pageUrl) + trail;
  });
  return { url, json, text, count: () => changed };
}
