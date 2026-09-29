// Collects every asset the recreated pages need from the capture files (capture/<slug>/<view>.json):
// images (img, srcset, lazy attributes, CSS backgrounds, pseudo-element content, video posters,
// og:image), icons (link rel=icon and friends), fonts (the @font-face rules of families the page
// actually used) and media (video/audio sources). Each URL appears once, whatever the number of
// pages and views that use it.
import { parseSrcset } from './css.js';

export const KINDS = ['font', 'icon', 'image', 'media'];
// When a URL is used as two kinds (an SVG as favicon and background), the kind with the larger limit wins.
const MERGE_RANK = { media: 0, image: 1, font: 2, icon: 3 };

/** Dedupe key: the URL without its fragment. The query stays: image CDNs use it for size and format. */
export function assetKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

const ICON_REL = /(^|\s)(icon|shortcut|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/i;
const IMAGE_META = /^(og:image(:url|:secure_url)?|twitter:image(:src)?|msapplication-tileimage)$/i;
const LAZY_SRCSET = /srcset$/;
const CSS_URL = /url\((['"]?)(.*?)\1\)/g;
const SVG_HREF = /\s(?:xlink:)?href\s*=\s*["']([^"'#][^"']*)["']/gi;
const FONT_FORMAT_RANK = { woff2: 0, woff: 1, truetype: 2, opentype: 2, 'embedded-opentype': 9, svg: 9 };

function fontRank({ url, format }) {
  if (format) return FONT_FORMAT_RANK[format.replace(/-variations$/, '')] ?? 5;
  const ext = new URL(url).pathname.split('.').pop().toLowerCase();
  return { woff2: 0, woff: 1, ttf: 2, otf: 2 }[ext] ?? 5;
}

const faceKey = (f) => JSON.stringify([f.family.toLowerCase(), String(f.weight), f.style, f.unicodeRange, f.src.map((s) => s.url)]);

/**
 * @param {{ slug: string, view: string, data: object }[]} captures  parsed capture files
 * @param {{ fontFaces?: object[] }} [extra]  @font-face rules read from cross-origin stylesheets
 * @returns {{ assets: { url: string, kind: string, from: string, pages: string[] }[], fontFaces: object[], unusedFontFaces: number }}
 *   assets are in download order: fonts, icons, images, media; within a kind, in the order the pages use them.
 */
export function collectAssets(captures, extra = {}) {
  const found = new Map();
  const add = (url, kind, from, slug, base) => {
    let abs;
    try {
      abs = base ? new URL(url, base).href : url;
    } catch {
      return;
    }
    const key = assetKey(abs);
    if (!key) return;
    const entry = found.get(key);
    if (!entry) {
      found.set(key, { url: key, kind, from, pages: new Set([slug]) });
      return;
    }
    entry.pages.add(slug);
    if (MERGE_RANK[kind] < MERGE_RANK[entry.kind]) Object.assign(entry, { kind, from });
  };

  const usedFamilies = new Set();
  const loadedFontUrls = new Set();
  const faces = new Map();

  for (const { slug, data } of captures) {
    const base = data.url || data.finalUrl;

    for (const link of data.head?.links ?? []) {
      if (ICON_REL.test(link.rel) && link.href) add(link.href, 'icon', 'link-icon', slug);
    }
    for (const m of data.head?.meta ?? []) {
      if (IMAGE_META.test(m.property ?? m.name ?? '') && m.content) add(m.content, 'image', 'meta', slug, base);
    }

    const walk = (node) => {
      if (!node || !node.tag) return;
      const { tag, attrs = {}, lazy = {} } = node;
      if (tag === 'img' || (tag === 'input' && /^image$/i.test(attrs.type ?? ''))) {
        // currentSrc (what the browser picked at this width) and the fallback src attribute.
        if (node.src) add(node.src, 'image', 'img', slug);
        if (attrs.src) add(attrs.src, 'image', 'img', slug, base);
        for (const c of parseSrcset(attrs.srcset, base)) add(c.url, 'image', 'srcset', slug);
      } else if (tag === 'source') {
        // <picture><source srcset> is an image; <video><source src> is media.
        if (attrs.srcset) for (const c of parseSrcset(attrs.srcset, base)) add(c.url, 'image', 'srcset', slug);
        else if (node.src) add(node.src, 'media', 'media', slug);
      }
      if ((tag === 'video' || tag === 'audio') && node.src) add(node.src, 'media', 'media', slug);
      if (tag === 'video' && node.poster) add(node.poster, 'image', 'poster', slug);
      for (const [name, value] of Object.entries(lazy)) {
        if (LAZY_SRCSET.test(name)) for (const c of parseSrcset(value, base)) add(c.url, 'image', 'lazy', slug);
        else if (value && !value.startsWith('data:')) add(value.trim(), 'image', 'lazy', slug, base);
      }
      if (node.svg) {
        for (const m of node.svg.matchAll(SVG_HREF)) {
          if (!/^(data|javascript):/i.test(m[1])) add(m[1], 'image', 'svg', slug, base);
        }
      }
      for (const pseudo of [node.before, node.after]) {
        for (const m of pseudo?.content?.matchAll(CSS_URL) ?? []) if (!m[2].startsWith('data:')) add(m[2], 'image', 'pseudo', slug, base);
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(data.body);

    for (const url of data.cssUrls ?? []) add(url, 'image', 'css', slug);
    for (const r of data.resources ?? []) {
      if (r.type === 'image') add(r.url, 'image', 'resource', slug);
      else if (r.type === 'media') add(r.url, 'media', 'resource', slug);
      else if (r.type === 'font' && r.status < 400) {
        loadedFontUrls.add(assetKey(r.url));
        add(r.url, 'font', 'resource', slug);
      }
    }
    for (const f of data.loadedFonts ?? []) usedFamilies.add(f.family.toLowerCase());
    for (const f of data.fontFaces ?? []) {
      // Captures before 4a.7 stored same-origin sources as bare URL strings.
      const face = { ...f, src: f.src.map((s) => (typeof s === 'string' ? { url: s, format: null } : s)) };
      faces.set(faceKey(face), face);
    }
  }
  for (const f of extra.fontFaces ?? []) faces.set(faceKey(f), f);

  // Only faces of families the pages rendered with. The browser loaded the files it needed; a face
  // it did not load (a unicode-range subset these pages never used) gets its best format as a fallback.
  const fontFaces = [];
  let unusedFontFaces = 0;
  for (const face of faces.values()) {
    if (!usedFamilies.has(face.family.toLowerCase()) || !face.src.length) {
      unusedFontFaces++;
      continue;
    }
    fontFaces.push(face);
    const loaded = face.src.filter((s) => loadedFontUrls.has(assetKey(s.url)));
    const wanted = loaded.length ? loaded : [[...face.src].sort((a, b) => fontRank(a) - fontRank(b))[0]];
    for (const s of wanted) add(s.url, 'font', 'font-face', 'fonts');
  }

  const assets = [...found.values()]
    .map((a) => ({ ...a, pages: [...a.pages] }))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return { assets, fontFaces, unusedFontFaces };
}
