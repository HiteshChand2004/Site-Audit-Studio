// Link and loading fixers.
//
// Tree level (before styles are built):
// - Broken links: links whose target the audit's link check (or discovery) found broken (4xx/5xx,
//   DNS, refused) lose their href; the text stays. Unverified links (401/403/429/timeouts) are kept.
// - Images: the largest image in the first screen of the desktop and mobile views is the likely LCP
//   element: fetchpriority="high" and never lazy. Images below the first screen in every view get
//   loading="lazy" and decoding="async"; iframes below it get loading="lazy".
// IR level (after each IR build):
// - Fonts: font-display swap on every @font-face that blocks text (auto/block/missing), and a
//   <link rel="preload"> for the font files of the (at most two) families that carry most of each
//   page's text.
import { urlKey } from '../../audit/util.js';
import { isElement, isText } from '../ir/tree.js';
import { RECREATE_VIEWS } from '../views.js';

// The first screen of each captured view (a view missing here would count every image as "below the fold").
const FOLD = Object.fromEntries(RECREATE_VIEWS.map((v) => [v.id, v.height]));
// An image smaller than this (CSS px²) is an icon, not an LCP candidate.
const MIN_LCP_AREA = 150 * 100;
const MAX_FONT_PRELOADS = 2;

function walk(node, fn) {
  if (!isElement(node)) return;
  fn(node);
  for (const c of node.children) walk(c, fn);
}

const shown = (n, v) => {
  const d = n.views[v];
  return !!d && !d.hidden && d.rect[2] > 0 && d.rect[3] > 0;
};

/**
 * The broken link targets from the analysis and from discovery: Map<urlKey, { url, status, source }>.
 * @param {object} audit      the analysis audit JSON (brokenLinks.broken)
 * @param {object[]} skipped  discovery skips (reason 'error' with an HTTP error or no response)
 */
export function brokenTargets(audit, skipped = []) {
  const out = new Map();
  for (const b of audit?.brokenLinks?.broken ?? []) if (b?.url) out.set(urlKey(b.url), { url: b.url, status: b.status, source: 'audit' });
  for (const s of skipped) {
    if (s.reason === 'error' && (s.status == null || s.status === 0 || s.status >= 400) && !out.has(urlKey(s.url))) {
      out.set(urlKey(s.url), { url: s.url, status: s.status || 'error', source: 'discovery' });
    }
  }
  return out;
}

// Attributes that only mean something on a link; an unlinked element keeps none of them.
const LINK_ONLY_ATTRS = ['href', 'target', 'rel', 'hreflang', 'download', 'ping', 'referrerpolicy', 'type', 'aria-label'];

/**
 * Unlinks links to broken targets: the element becomes a <span> with the same text, classes and id, and
 * loses every link-only attribute. An <a> left without href is flagged by crawlers ("not crawlable"),
 * and aria-label is not allowed on a plain span. The stylesheet reset already renders a link like its
 * parent text (color, decoration, cursor), so the span looks the same.
 * @returns {object[]} the unlinked links
 */
export function fixBrokenLinks(t, broken, origin) {
  const fixed = [];
  if (!broken.size) return fixed;
  walk(t.root, (n) => {
    if (n.tag !== 'a') return;
    const href = n.href ?? n.attrs.href;
    if (!href) return;
    let abs;
    try {
      abs = new URL(href, t.info.url);
    } catch {
      return;
    }
    const hit = broken.get(urlKey(abs.href));
    if (!hit) return;
    delete n.href;
    for (const attr of LINK_ONLY_ATTRS) delete n.attrs[attr];
    n.tag = 'span';
    const text = n.children.filter(isText).map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    fixed.push({ page: t.info.path, url: hit.url, status: hit.status, internal: new URL(hit.url).host.replace(/^www\./, '') === new URL(origin).host.replace(/^www\./, ''), text });
  });
  return fixed;
}

/**
 * fetchpriority for the LCP candidate, lazy loading below the first screen.
 * @returns {{ priority: object[], lazy: number, lazyFrames: number }}
 */
export function fixLoading(t) {
  const images = [];
  const frames = [];
  walk(t.root, (n) => {
    if (n.tag === 'img') images.push(n);
    else if (n.tag === 'iframe') frames.push(n);
  });
  const priority = new Set();
  for (const v of ['desktop', 'mobile']) {
    let best = null;
    let bestArea = MIN_LCP_AREA;
    for (const img of images) {
      if (!shown(img, v)) continue;
      const [, y, w, h] = img.views[v].rect;
      if (y >= FOLD[v]) continue;
      const area = w * Math.min(h, FOLD[v] - y);
      if (area > bestArea) {
        best = img;
        bestArea = area;
      }
    }
    if (best) priority.add(best);
  }
  const below = (n) => {
    const views = Object.keys(n.views).filter((v) => shown(n, v));
    return views.length > 0 && views.every((v) => n.views[v].rect[1] >= FOLD[v]);
  };
  let lazy = 0;
  for (const img of images) {
    if (priority.has(img)) {
      img.attrs.fetchpriority = 'high';
      img.attrs.loading = 'eager';
      delete img.attrs.decoding;
    } else if (below(img)) {
      if (img.attrs.loading !== 'lazy') lazy++;
      img.attrs.loading = 'lazy';
      img.attrs.decoding = 'async';
    }
  }
  let lazyFrames = 0;
  for (const f of frames) {
    if (below(f) && f.attrs.loading !== 'lazy') {
      f.attrs.loading = 'lazy';
      lazyFrames++;
    }
  }
  return {
    priority: [...priority].map((img) => ({ page: t.info.path, src: img.src ?? img.attrs.src ?? null })),
    lazy,
    lazyFrames,
  };
}

const swappedFrom = new WeakMap();
const familyList =(value) => String(value ?? '').split(/,\s*/).map((f) => f.replace(/^["']|["']$/g, '').trim().toLowerCase()).filter(Boolean);

/**
 * font-display swap and per-page font preloads on a built IR. Idempotent: it runs after every
 * IR build of the fit pass.
 * @returns {{ display: object[], preloads: object[] }}
 */
export function fixFonts(ir) {
  const display = [];
  for (const f of ir.fontFaces) {
    // Font face objects are shared between IR builds; remember the original value once.
    if (!f.display || f.display === 'auto' || f.display === 'block') {
      swappedFrom.set(f, f.display || 'auto');
      f.display = 'swap';
    }
    if (swappedFrom.has(f)) display.push({ family: f.family, weight: f.weight ?? null, from: swappedFrom.get(f) });
  }
  // The first family of a class's font-family list that has a local @font-face.
  const local = new Set(ir.fontFaces.map((f) => f.family.toLowerCase()));
  const familyOf = new Map();
  for (const r of ir.rules) {
    const cls = r.selector.match(/^\.([\w-]+)$/)?.[1];
    const value = r.parts.base?.['font-family'];
    if (!cls || !value) continue;
    const family = familyList(value).find((f) => local.has(f));
    familyOf.set(cls, family ?? null);
  }

  const preloads = [];
  for (const page of ir.pages) {
    const weight = new Map();
    const visit = (n, inherited) => {
      if (!n || 'text' in n) return;
      const own = (n.class ?? '').split(/\s+/).map((c) => familyOf.get(c)).find((f) => f !== undefined);
      const family = own !== undefined ? own : inherited;
      const text = n.children?.filter((c) => 'text' in c).reduce((s, c) => s + c.text.trim().length, 0) ?? 0;
      if (family && text) weight.set(family, (weight.get(family) ?? 0) + text);
      n.children?.forEach((c) => visit(c, family));
    };
    visit(page.body, familyOf.get(page.html?.class ?? '') ?? null);
    const families = [...weight].sort((a, b) => b[1] - a[1]).slice(0, MAX_FONT_PRELOADS).map(([f]) => f);
    const list = [];
    for (const family of families) {
      const faces = ir.fontFaces.filter((f) => f.family.toLowerCase() === family && (!f.style || f.style === 'normal') && f.src.length);
      const face = faces.sort((a, b) => Math.abs(Number(a.weight || 400) - 400) - Math.abs(Number(b.weight || 400) - 400))[0];
      if (!face) continue;
      const src = face.src.find((s) => /woff2/.test(s.format ?? s.asset)) ?? face.src[0];
      const type = /\.woff2$/.test(src.asset) ? 'font/woff2' : /\.woff$/.test(src.asset) ? 'font/woff' : null;
      list.push({ asset: src.asset, as: 'font', ...(type && { type }) });
      preloads.push({ page: page.path, family: face.family, asset: src.asset });
    }
    page.head = { ...page.head, preload: list };
  }
  return { display, preloads };
}
