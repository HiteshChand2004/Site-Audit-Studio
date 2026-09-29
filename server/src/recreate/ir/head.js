// The <head> of each recreated page: title, meta description, canonical, Open Graph, Twitter card,
// icons, language and structured data. Whatever the original page has is kept. Missing fields are
// filled from the page's own content only (never invented) and every filled field is reported as
// auto-generated with its source. A field that cannot be derived stays missing and is reported.
import { deepText, isElement } from './tree.js';

const KEEP_META = /^(robots|googlebot|author|theme-color|application-name|color-scheme|keywords|format-detection|[\w-]+-verification)$/i;
const ICON_REL = /(^|\s)(icon|shortcut|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/i;
const IMAGE_META = /^(og:image(:url|:secure_url)?|twitter:image(:src)?)$/i;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Shortens text at a sentence end, else at a word boundary. */
export function clip(text, max = DESCRIPTION_MAX) {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.match(/^(.*[.!?])\s/);
  if (sentence && sentence[1].length >= max * 0.5) return sentence[1];
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max - 1).replace(/[\s,;:–—-]+$/, '')}…`;
}

function find(node, test) {
  if (!isElement(node)) return null;
  if (test(node)) return node;
  for (const c of node.children) {
    const hit = find(c, test);
    if (hit) return hit;
  }
  return null;
}

const visibleOnDesktop = (n) => {
  const d = n.views.desktop;
  return !d || (!d.hidden && d.rect[2] * d.rect[3] > 0);
};

/** Site name for titles and og:site_name: og:site_name, JSON-LD name, logo text, host name. */
export function siteNameOf(head, root, url) {
  const og = head.meta?.find((m) => m.property === 'og:site_name')?.content;
  if (clean(og)) return { value: clean(og), source: 'og:site_name' };
  for (const raw of head.jsonLd ?? []) {
    try {
      const items = [JSON.parse(raw)].flat().flatMap((x) => x['@graph'] ?? [x]);
      const named = items.find((x) => /^(Organization|WebSite|LocalBusiness|Corporation)$/.test([x['@type']].flat()[0]) && clean(x.name));
      if (named) return { value: clean(named.name), source: 'structured data' };
    } catch {
      // invalid JSON-LD is kept as is and ignored here
    }
  }
  const home = new URL('/', url).href;
  const logo = find(root, (n) => n.tag === 'a' && (n.href === home || n.attrs.href === '/') && clean(deepText(n)));
  if (logo && clean(deepText(logo)).length <= 40) return { value: clean(deepText(logo)), source: 'logo text' };
  return { value: new URL(url).hostname.replace(/^www\./, ''), source: 'host name' };
}

/**
 * @param {object} o
 * @param {object} o.head       captured head (desktop view)
 * @param {object} o.page       { url, path, outPath }
 * @param {object} o.root       merged body tree
 * @param {(url:string, base?:string)=>string|null} o.assetFile
 * @param {string} o.baseUrl    origin used for canonical and og:url (target domain or original origin)
 * @param {{ value: string, source: string }} o.siteName
 * @param {{ rel: string, asset: string }[]} o.siteIcons  icons of the homepage, used when a page has none
 * @returns {{ head: object, auto: { field: string, value: string, source: string }[], missing: string[] }}
 */
export function buildHead({ head, page, root, assetFile, baseUrl, siteName, siteIcons = [] }) {
  const auto = [];
  const missing = [];
  const fill = (field, value, source) => {
    auto.push({ field, value, source });
    return value;
  };
  const metaOf = (key) => head.meta?.find((m) => m.name?.toLowerCase() === key || m.property?.toLowerCase() === key)?.content;
  const absAsset = (file) => new URL(`assets/${file}`, `${baseUrl}/`).href;

  const h1 = find(root, (n) => n.tag === 'h1' && visibleOnDesktop(n) && clean(deepText(n)));
  const main = find(root, (n) => n.tag === 'main') ?? root;
  const paragraph = find(main, (n) => n.tag === 'p' && visibleOnDesktop(n) && clean(deepText(n)).length >= 50);

  let title = clean(head.title);
  if (!title) {
    if (h1) {
      const text = clean(deepText(h1));
      const withSite = `${text} | ${siteName.value}`;
      title = fill('title', withSite.length <= TITLE_MAX && !text.includes(siteName.value) ? withSite : clip(text, TITLE_MAX), 'first heading');
    } else if (siteName) title = fill('title', siteName.value, siteName.source);
    else missing.push('title');
  }

  let description = clean(metaOf('description'));
  if (!description) {
    const og = clean(metaOf('og:description'));
    if (og) description = fill('description', clip(og), 'og:description');
    else if (paragraph) description = fill('description', clip(deepText(paragraph)), 'first paragraph');
    else missing.push('description');
  }

  const original = head.links?.find((l) => /(^|\s)canonical(\s|$)/i.test(l.rel))?.href;
  let canonicalPath = new URL(page.url).pathname;
  if (original) {
    try {
      const u = new URL(original);
      if (u.host.replace(/^www\./, '') === new URL(page.url).host.replace(/^www\./, '')) canonicalPath = u.pathname + u.search;
    } catch {
      // an invalid canonical is replaced below
    }
  }
  const canonical = new URL(canonicalPath, `${baseUrl}/`).href;
  if (!original) fill('canonical', canonical, 'page URL');

  const lang = head.lang || (metaOf('og:locale') ? metaOf('og:locale').replace('_', '-') : null);
  if (!head.lang) {
    if (lang) fill('lang', lang, 'og:locale');
    else missing.push('lang');
  }

  // Kept meta tags; image URLs point to the local copy on the site's own origin.
  const meta = [];
  const seen = new Set();
  for (const m of head.meta ?? []) {
    const key = (m.property ?? m.name ?? '').toLowerCase();
    if (!key || !m.content || key === 'description' || key === 'og:url') continue;
    if (!(KEEP_META.test(key) || key.startsWith('og:') || key.startsWith('twitter:') || key.startsWith('article:'))) continue;
    let content = m.content;
    if (IMAGE_META.test(key)) {
      const file = assetFile(content, page.url);
      if (!file) continue;
      content = absAsset(file);
    }
    if (seen.has(key) && !key.startsWith('og:image') && !key.startsWith('article:')) continue;
    seen.add(key);
    meta.push({ ...(m.property ? { property: m.property } : { name: m.name }), content });
  }
  const add = (attr, key, value, source) => {
    if (seen.has(key) || !value) return;
    seen.add(key);
    meta.push({ [attr]: key, content: fill(key, value, source) });
  };
  add('property', 'og:title', title, 'title');
  add('property', 'og:description', description, 'description');
  meta.push({ property: 'og:url', content: canonical });
  add('property', 'og:type', 'website', 'default');
  add('property', 'og:site_name', siteName?.value, siteName?.source);
  if (!seen.has('og:image')) {
    const img = find(root, (n) => n.tag === 'img' && (n.natural?.[0] ?? 0) >= 200 && assetFile(n.src ?? n.attrs.src, page.url));
    if (img) add('property', 'og:image', absAsset(assetFile(img.src ?? img.attrs.src, page.url)), 'first large image');
  }
  add('name', 'twitter:card', seen.has('og:image') || seen.has('twitter:image') ? 'summary_large_image' : 'summary', 'default');

  let icons = [];
  for (const l of head.links ?? []) {
    if (!ICON_REL.test(l.rel)) continue;
    const file = assetFile(l.href, page.url);
    if (file) icons.push({ rel: l.rel, asset: file, ...(l.sizes && { sizes: l.sizes }), ...(l.type && { type: l.type }) });
  }
  if (!icons.length && siteIcons.length) {
    icons = siteIcons;
    fill('icon', siteIcons.map((i) => i.asset).join(', '), 'homepage icon');
  }

  const alternates = (head.links ?? [])
    .filter((l) => /(^|\s)alternate(\s|$)/i.test(l.rel) && l.hreflang)
    .map((l) => ({ hreflang: l.hreflang, href: l.href }));

  return {
    head: { lang, title, description, canonical, meta, icons, alternates, jsonLd: head.jsonLd ?? [] },
    auto,
    missing,
  };
}

/** A plain SVG favicon (first letter of the site name on the brand colour) for sites without one. */
export function generatedFavicon(name, color) {
  const letter = (clean(name).match(/[\p{L}\p{N}]/u)?.[0] ?? 'S').toUpperCase().replace(/[<&>]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="44" font-family="system-ui, sans-serif" font-size="36" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>\n`;
}
