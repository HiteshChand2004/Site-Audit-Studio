// The platform-free intermediate representation (IR) of the recreated site. Every stack emitter
// (plain HTML now, React / Next.js later) works from it:
//
//   { version, baseUrl, breakpoints: { laptop?, tablet, mobile }, tokens, fontFaces, keyframes, boxSizingReset, motion? (ir/motion.js),
//     rules: [{ selector, parts: { base, laptop?, tablet?, mobile? } }],
//     files: [{ path, content }],                  generated files (a favicon when the site has none)
//     pages: [{ url, path, outPath, slug, head, html: { class }, body: IRNode,
//               content: null | { source: 'wordpress-rest', type, id, slug, title, excerpt, html, date, modified } }] }
// head.preload lists the font files the page preloads (fixers/perf.js).
//
// IRNode = { text } | { t: tag, sid, class?, id?, b?, attrs, children, raw? (inline SVG) }. Attribute values
// are plain strings or references the emitter resolves per page: { asset } (a file under assets/),
// [{ asset, d }] (srcset), { page, hash } (a recreated page), { live, reason } (the original site),
// { external } and { anchor }. CSS values reference files as url("asset:images/x.png").
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { platformCdnHost } from '../assets/cdn.js';
import { buildHead, generatedFavicon, siteNameOf } from './head.js';
import { detectLang, refineHeadTexts } from './seoText.js';
import { createAssetResolver, createLinkResolver } from './links.js';
import { meaningful, MOUNT_IDS, PLATFORM_CLASS_PATTERNS } from './names.js';
import { buildStyles, mapUrls } from './styles.js';
import { DROP_TAGS, guardAttributes } from '../fixers/html.js';
import { contentRecord, headHints, itemFor } from '../fixers/wordpress.js';
import { addRemoved, emptyRemoved, sanitizeSvg } from '../fixers/svg.js';
import { EXACT_ONLY_VIEWS, KNOWN_VIEW_IDS, VIEW_WIDTHS } from '../views.js';
import { BLOCK_TAGS, buildPageTree, deepText, displayOf, isElement, isText, VIEW_IDS } from './tree.js';
import { crawlFiles } from './crawlFiles.js';
import { noticePage } from './notice.js';

export const IR_VERSION = 1;
export const GENERATED_FAVICON = 'icons/favicon-generated.svg';
export const DEFAULT_BREAKPOINTS = { laptop: 1279.98, tablet: 1023.98, mobile: 767.98 };
const BLOCK_DISPLAY = /^(block|flex|grid|flow-root|list-item|table)$/;
const ICON_REL = /(^|\s)(icon|shortcut|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/i;

/** Reads the capture files of one page: { desktop, tablet?, mobile? }. */
export async function readPageCaptures(dir, page) {
  const out = {};
  for (const [view, info] of Object.entries(page.views)) {
    out[view] = JSON.parse(await readFile(path.join(dir, 'capture', page.slug, info.file), 'utf8'));
  }
  return out;
}

// Conditions that say nothing about how wide the window is: a width written inside one belongs to that condition,
// not to a breakpoint of the layout.
const NOT_A_WIDTH = /\b(print|resolution|prefers-|hover\s*:|orientation|device-|container|aspect-ratio)/i;

/**
 * Every width boundary the site's own media queries declare, as the width the layout changes *at*: a max-width is that
 * value, a min-width a hair below it (the same decision written the other way round). Shared by pickBreakpoints and by
 * the exact compare's slot list (verify/exact/slots.js), so one regex decides what counts as a breakpoint.
 * @param {{ condition: string, rules?: number }[]|string[]} queries  the capture's `mediaRules` (with rule counts) or
 *   its `mediaQueries` (plain strings, which is all a capture saved before exact mode has)
 * @returns {{ value: number, condition: string, rules: number }[]}
 */
export function mediaBounds(queries) {
  const out = [];
  for (const q of queries ?? []) {
    const condition = typeof q === 'string' ? q : q?.condition ?? '';
    const rules = typeof q === 'string' ? 0 : Number(q?.rules) || 0;
    if (!condition || NOT_A_WIDTH.test(condition)) continue;
    for (const m of condition.matchAll(/\((max|min)-width:\s*([\d.]+)(px|em|rem)\)/g)) {
      const px = parseFloat(m[2]) * (m[3] === 'px' ? 1 : 16);
      out.push({ value: m[1] === 'max' ? px : px - 0.02, condition, rules });
    }
  }
  return out;
}

/**
 * Media query boundaries for the laptop, tablet and mobile overrides, taken from the original site's own
 * breakpoints when it has them: for each view the widest boundary between its capture width and the next
 * wider capture (laptop 1024 → 1440, tablet 768 → 1024, mobile 375 → 768). Without a laptop capture the
 * tablet boundary is the widest one between 768 and 1440, as before 4b.6.3.
 */
/**
 * One entry per distinct boundary, keeping the largest rule count seen for it. The same query is captured once per
 * page and once per view, so the raw list says 639.98 eighty-eight times for a site that declares it once.
 */
export function distinctBounds(bounds) {
  const by = new Map();
  for (const b of bounds ?? []) {
    if (!Number.isFinite(b?.value)) continue;
    const at = by.get(b.value);
    if (!at || (b.rules ?? 0) > (at.rules ?? 0)) by.set(b.value, { value: b.value, rules: b.rules ?? 0, condition: b.condition });
  }
  return [...by.values()].sort((x, y) => x.value - y.value);
}

const round2 = (n) => Math.round(n * 100) / 100;

export function pickBreakpoints(queries, { laptop: hasLaptop = true, views = null } = {}) {
  const bounds = mediaBounds(queries).map((b) => b.value);
  // The views in play, widest first. A view's styles were measured at its own width and apply from there up to the
  // next wider view, so its breakpoint is the widest boundary the site declares inside that gap. Taken from the
  // view list rather than named one by one, because exact mode captures a view between the tablet and the phone
  // and a breakpoint nobody computes for it would leave its media query at a default that no page was measured at.
  const list = (views ?? KNOWN_VIEW_IDS.filter((id) => !EXACT_ONLY_VIEWS.includes(id) && (id !== 'laptop' || hasLaptop)))
    .filter((id) => VIEW_WIDTHS[id] != null)
    .sort((a, b) => VIEW_WIDTHS[b] - VIEW_WIDTHS[a]);
  const out = {};
  let found = false;
  for (const [i, id] of list.entries()) {
    if (i === 0) continue;                          // the widest view is the base, it has no media query
    const lo = VIEW_WIDTHS[id];
    const hi = VIEW_WIDTHS[list[i - 1]];
    const widest = Math.max(...bounds.filter((b) => b >= lo && b < hi), -1);
    if (widest > 0) found = true;
    // No boundary declared in the gap: the narrower of what the default table says for this view and the next
    // wider view's width less a hundredth. The table's own laptop value (1279.98) is deliberately below the
    // desktop width, so it cannot simply be derived; and its mobile value assumes the tablet view comes next, so
    // it cannot simply be trusted once a view sits between them. Taking the narrower is right in both cases.
    out[id] = widest > 0 ? widest : Math.min(DEFAULT_BREAKPOINTS[id] ?? Infinity, round2(hi - 0.02));
  }
  return { ...out, source: found ? 'site' : 'default' };
}

// Colour normalisation shared with the emitter: rgb() → #rrggbb, #abc → #aabbcc.
export function hexColor(value) {
  const v = String(value).trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return `#${[...m[1]].map((c) => c + c).join('')}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/);
  if (m) return `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

const PLATFORM_TOKEN = /^--(framer|wf|wix|wp|sqs|elementor|chakra|tw|mantine|mui|shopify|token)-?/i;
/** Colour design tokens of the site (:root custom properties): { name: '#rrggbb' }. */
function colorTokens(customProps = {}) {
  const tokens = {};
  const used = new Set();
  let n = 0;
  for (const [name, value] of Object.entries(customProps)) {
    const hex = hexColor(value);
    if (!hex || used.has(hex)) continue;
    used.add(hex);
    const bare = name.slice(2);
    tokens[meaningful(bare) && !PLATFORM_TOKEN.test(name) ? name : `--color-${++n}`] = hex;
  }
  return tokens;
}

// Accent colour for a generated favicon: the most used saturated background of links and buttons.
function brandColor(root) {
  const counts = new Map();
  const walk = (n) => {
    if (!isElement(n)) return;
    const hex = hexColor(n.views.desktop?.style['background-color'] ?? '');
    if (hex) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 60) counts.set(hex, (counts.get(hex) ?? 0) + (n.tag === 'a' || n.tag === 'button' ? 3 : 1));
    }
    n.children.forEach(walk);
  };
  walk(root);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '#334155';
}

function htmlNode(captures, views, root) {
  const node = { tag: 'html', attrs: {}, views: {}, children: [root] };
  for (const v of views) {
    const c = captures[v];
    node.views[v] = { style: c.htmlStyle ?? {}, rect: [0, 0, c.viewport?.[0] ?? VIEW_WIDTHS[v], c.scrollHeight ?? 0], hidden: false };
  }
  return node;
}

const lazySrcOf = (n) => n.lazy?.['data-src'] ?? n.lazy?.['data-lazy-src'] ?? n.lazy?.['data-original'];
const imageFile = (n, pageUrl, assetResolve) => assetResolve(n.attrs.src, pageUrl) ?? assetResolve(n.src, pageUrl) ?? assetResolve(lazySrcOf(n), pageUrl)
  ?? srcsetRefs(n.attrs.srcset ?? n.lazy?.['data-srcset'], pageUrl, assetResolve)[0]?.asset ?? null;

// Images whose file was not downloaded are left out (never linked live), before any style is built for them.
function dropMissingImages(root, pageUrl, assetResolve) {
  const dropped = [];
  const walk = (n) => {
    if (!isElement(n)) return;
    n.children = n.children.filter((c) => {
      if (!isElement(c) || c.tag !== 'img' || imageFile(c, pageUrl, assetResolve)) return true;
      dropped.push(c.src ?? c.attrs.src ?? lazySrcOf(c) ?? null);
      return false;
    });
    n.children.forEach(walk);
  };
  walk(root);
  return dropped;
}

function numberNodes(root) {
  let sid = 0;
  const walk = (n) => {
    if (!isElement(n)) return;
    n.sid = ++sid;
    n.children.forEach(walk);
  };
  walk(root);
  return sid;
}

/**
 * Builds the page trees, heads and site-wide data from the captures. The result is mutable: the
 * fit pass adds per-node size fixes before buildIR() runs again.
 * @param {object} o
 * @param {{ info: object, captures: Record<string, object> }[]} o.pages  homepage first
 * @param {{ map: object, fontFaces?: object[], keyframes?: object[] }} o.assets  the assets step result
 * @param {string} o.baseUrl
 * @param {string} o.origin
 * @param {object[]} [o.livePages]
 * @param {object[]} [o.skipped]
 * @param {object|null} [o.robots]  the original robots.txt as discovery parsed it (for robots.txt)
 * @param {object|null} [o.llms]  the original /llms.txt as discovery read it (copied as it is)
 */
// A page is a few pixels wider than the screen for all sorts of harmless reasons (a scrollbar, a rounding); this
// much more means its layout simply does not fit, which is a different thing.
const REFLOW_SLACK_PX = 16;

/**
 * The views in which the original does NOT reflow: its own layout stays wider than the screen, so the page
 * overflows sideways instead of rearranging. Plenty of real sites have no phone layout at all and do exactly this.
 *
 * It matters because every width heuristic in the IR assumes the opposite. Left alone, the copy's root shrinks to
 * the screen, every width inside it is clamped to that, the text wraps two or three times as often and the page
 * comes out far too tall - which is the single biggest difference measured on real narrow views. The copy has to
 * overflow where the original overflowed.
 * @returns {string[]} view ids, in the page's own view order
 */
export function noReflowViews(tree) {
  const out = [];
  for (const view of tree.views ?? []) {
    const width = tree.root?.views?.[view]?.rect?.[2];
    const viewport = VIEW_WIDTHS[view];
    if (width && viewport && width > viewport + REFLOW_SLACK_PX) out.push(view);
  }
  return out;
}

export function prepareSite({ pages, assets, baseUrl, origin, livePages = [], skipped = [], wp = null, robots = null, llms = null, asIs = false }) {
  const assetResolve = createAssetResolver(assets.map ?? {});
  const resolveLink = createLinkResolver({ pages: pages.map((p) => p.info), livePages, skipped, origin, assetFile: (url) => assetResolve(url) });

  const home = pages[0];
  const queries = [];
  const keyframes = new Map();
  // An animation whose keyframes could not be carried over: the element keeps its `animation: <name> …`, the rule
  // it names never ships, and the animation does nothing at all. That used to happen without a word anywhere.
  const keyframesLost = new Map();
  // Same name, a different body on another page: one stylesheet cannot hold both.
  const keyframesClash = new Map();
  const trees = [];
  let truncated = false;
  for (const { info, captures } of pages) {
    const bodies = Object.fromEntries(Object.entries(captures).map(([v, c]) => [v, c.body]));
    const tree = buildPageTree(bodies);
    for (const c of Object.values(captures)) {
      queries.push(...(c.mediaQueries ?? []));
      for (const k of c.keyframes ?? []) {
        if (k.css) {
          if (!keyframes.has(k.name)) keyframes.set(k.name, k.css);
          // One stylesheet for the whole site, so the first definition of a name wins. Where two pages define the
          // same name differently, every page after the first gets the wrong motion - silently, until now.
          else if (keyframes.get(k.name) !== k.css) keyframesClash.set(k.name, { name: k.name, page: info.path });
        } else if (!keyframesLost.has(k.name)) keyframesLost.set(k.name, { name: k.name, bytes: k.bytes ?? null, page: info.path });
      }
      truncated ||= !!c.truncated;
    }
    const droppedImages = dropMissingImages(tree.root, info.url, assetResolve);
    const nodes = numberNodes(tree.root);
    trees.push({ info, captures, ...tree, nodes, droppedImages, noReflow: noReflowViews(tree), htmlNode: htmlNode(captures, tree.views, tree.root) });
  }
  for (const k of assets.keyframes ?? []) {
    if (k.css) {
      if (!keyframes.has(k.name)) keyframes.set(k.name, k.css);
    } else if (!keyframesLost.has(k.name)) keyframesLost.set(k.name, { name: k.name, bytes: k.bytes ?? null, page: null });
  }
  // One that came through from somewhere else is not lost after all.
  for (const name of keyframes.keys()) keyframesLost.delete(name);

  const homeHead = home.captures.desktop.head ?? {};
  const siteName = siteNameOf(homeHead, trees[0].root, home.info.url);
  const files = [];
  let siteIcons = [];
  for (const l of homeHead.links ?? []) {
    const file = ICON_REL.test(l.rel) && assetResolve(l.href, home.info.url);
    if (file) siteIcons.push({ rel: l.rel, asset: file, ...(l.sizes && { sizes: l.sizes }), ...(l.type && { type: l.type }) });
  }
  const anyPageIcon = pages.some(({ captures, info }) => (captures.desktop.head?.links ?? []).some((l) => ICON_REL.test(l.rel) && assetResolve(l.href, info.url)));
  let faviconGenerated = false;
  if (!anyPageIcon) {
    files.push({ path: `assets/${GENERATED_FAVICON}`, content: generatedFavicon(siteName.value, brandColor(trees[0].root)) });
    siteIcons = [{ rel: 'icon', asset: GENERATED_FAVICON, type: 'image/svg+xml' }];
    faviconGenerated = true;
  }

  const themeColor = brandColor(trees[0].root);
  for (const t of trees) {
    const item = itemFor(wp, t.info.url);
    if (item) t.wp = { item, content: contentRecord(item) };
    const built = buildHead({
      rest: headHints(item),
      head: t.captures.desktop.head ?? {},
      page: t.info,
      root: t.root,
      assetFile: assetResolve,
      baseUrl,
      siteName,
      siteIcons,
      themeColor,
    });
    t.head = built.head;
    t.headAuto = built.auto.map((a) => (a.field === 'icon' && faviconGenerated ? { ...a, source: 'generated from the site name and brand colour' } : a));
    t.headMissing = built.missing;
    if (t.headMissing.includes('lang')) {
      const lang = detectLang(deepText(t.root));
      if (lang) {
        t.head.lang = lang;
        t.headMissing = t.headMissing.filter((f) => f !== 'lang');
        t.headAuto.push({ field: 'lang', value: lang, source: 'language of the page text' });
      }
    }
  }
  // Titles / descriptions that are too short, too long or shared by several pages (needs every head).
  // As is: a title or description of the original is never rewritten, however short, long or duplicated it is. The
  // re-audit still measures them, so what they cost is reported rather than lost.
  const headTexts = asIs ? { titles: 0, descriptions: 0, skipped: 'as-is' } : refineHeadTexts(trees, siteName.value);

  // sitemap.xml + robots.txt (after the heads: canonical and robots meta decide what is listed).
  const { files: crawlFileList, ...crawl } = crawlFiles({ pages: trees, baseUrl, robots, llms, siteName: siteName.value });
  files.push(...crawlFileList);

  const fontFaces = (assets.fontFaces ?? []).filter((f) => f.local).map((f) => ({
    family: f.family,
    weight: f.weight,
    style: f.style,
    display: f.display,
    unicodeRange: f.unicodeRange,
    src: f.src.filter((s) => s.file).map((s) => ({ asset: s.file, format: s.format ?? null })),
  }));

  return {
    pages: trees,
    baseUrl,
    origin,
    siteName,
    // No breakpoints when the pages were captured in one view only (a capture made while only desktop was on, views.js): no media queries.
    breakpoints: pages.some(({ captures }) => Object.keys(captures).length > 1) ? pickBreakpoints(queries, { views: [...new Set(pages.flatMap(({ captures }) => Object.keys(captures)))] }) : { source: 'single-view' },
    // The boundaries the site declares itself: refine offers them as candidates and judges them on the widths
    // either side (verify/refine.js specsFor), which is how a boundary between two swept widths is found at all.
    // One entry per distinct boundary, carrying how many rules hang off it - the queries arrive once per page and
    // view, so the raw list repeats the same value scores of times and would travel into the IR that way.
    mediaBounds: distinctBounds(mediaBounds(queries)),
    ...(asIs && { asIs: true }),
    tokens: colorTokens(home.captures.desktop.customProps),
    keyframes,
    fontFaces,
    files,
    crawlFiles: crawl,
    headTexts,
    truncated,
    keyframesLost: [...keyframesLost.values()],
    keyframesClash: [...keyframesClash.values()],
    assetResolve,
    resolveLink,
  };
}

// The template id of a hover card's hovered look (emitters write <template data-w-tpl="hover">).
export const HOVER_TEMPLATE = 'hover';

const SKIP_ATTRS = new Set(['class', 'style', 'id', 'src', 'srcset', 'href', 'poster', 'action']);

const newSafetyStats = () => ({ elements: 0, attrs: { handlers: 0, scriptUrls: 0, other: 0 }, svg: emptyRemoved(), svgChanged: 0 });

// Inline SVG: builder class names removed, external references pointed at the local copy (or dropped).
function rewriteSvg(svg, pageUrl, assetResolve) {
  return svg
    .replace(/^<svg\b([^>]*)>/, (all, attrs) => `<svg${attrs.replace(/\s(class|style)="[^"]*"/g, '')}>`)
    .replace(/\sclass="([^"]*)"/g, (all, list) => {
      const kept = list.split(/\s+/).filter((c) => c && !PLATFORM_CLASS_PATTERNS.some((re) => re.test(c)));
      return kept.length ? ` class="${kept.join(' ')}"` : '';
    })
    .replace(/\s((?:xlink:)?href)="([^"#][^"]*)"/g, (all, name, url) => {
      if (/^data:/i.test(url)) return all;
      const file = assetResolve(url.replace(/#.*$/, ''), pageUrl);
      return file ? ` ${name}="asset:${file}${url.includes('#') ? url.slice(url.indexOf('#')) : ''}"` : '';
    });
}

function referencedIds(root) {
  const ids = new Set();
  const walk = (n) => {
    if (!isElement(n)) return;
    for (const k of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'list']) {
      for (const id of String(n.attrs[k] ?? '').split(/\s+/)) if (id) ids.add(id);
    }
    const href = n.attrs.href ?? '';
    if (href.startsWith('#') && href.length > 1) ids.add(decodeURIComponent(href.slice(1)));
    n.children.forEach(walk);
  };
  walk(root);
  return ids;
}

function srcsetRefs(value, base, assetResolve) {
  const out = [];
  for (const part of String(value ?? '').split(/,(?=\s*\S+\s+\d)|,\s+/)) {
    const [url, d] = part.trim().split(/\s+/);
    const file = url && assetResolve(url, base);
    if (file) out.push({ asset: file, ...(d && { d }) });
  }
  return out;
}

/** Converts one page tree into IR nodes and collects link and drop statistics. */
function pageBody(t, site, stats) {
  const { assetResolve, resolveLink } = site;
  const pageUrl = t.info.url;
  const keepIds = referencedIds(t.root);
  const convert = (n) => {
    if (isText(n)) return { text: n.text };
    if (DROP_TAGS.has(n.tag)) {
      stats.safety.elements++;
      return null;
    }
    const attrs = {};
    for (const [k, v] of Object.entries(n.attrs)) if (!SKIP_ATTRS.has(k) && !k.startsWith('data-')) attrs[k] = v;
    guardAttributes(attrs, stats.safety.attrs);
    // Motion tokens (ir/motion.js): the stylesheet's hover / reveal / loop rules select on them.
    if (n.motionTokens?.length) attrs['data-motion'] = n.motionTokens.join(' ');
    // States of tabs / carousels / filtered lists (ir/states.js): which state an area is, which state a control shows.
    if (n.stateAttrs) Object.assign(attrs, n.stateAttrs);
    const out = { t: n.tag, sid: n.sid, attrs, children: [], ...(n.asisHtml && { asisHtml: n.asisHtml }) };
    // A state the page does not start in (another tab, slide or filter) is written inside a <template> (emitters): not part
    // of the page until the script shows it, so the page's element count stays the original's.
    if (n.stateAttrs?.['data-w-set'] && 'hidden' in n.stateAttrs) out.tpl = n.stateAttrs['data-w-set'];
    // A card's hovered look (ir/states.js expandHoverCards) waits the same way until the card is first pointed at.
    else if (n.stateAttrs && 'data-w-hcopy' in n.stateAttrs) out.tpl = HOVER_TEMPLATE;
    if (n.class) out.class = n.class;
    const id = n.attrs.id;
    if (id && !MOUNT_IDS.has(id) && (keepIds.has(id) || meaningful(id))) out.id = id;
    const display = n.views.desktop ? displayOf(n, 'desktop') : 'none';
    if (BLOCK_DISPLAY.test(display) || (display === 'none' && BLOCK_TAGS.has(n.tag))) out.b = 1;

    switch (n.tag) {
      case 'a': {
        // A bare "#" is a control that stays on the page (a script handles the click), not a link to the page itself:
        // resolved, it became "./" and the click reloaded the page.
        if (/^\s*#?\s*$/.test(n.attrs.href ?? 'x')) {
          attrs.href = '#';
          break;
        }
        const link = resolveLink(n.href ?? n.attrs.href, pageUrl);
        if (link) {
          attrs.href = link;
          if (link.page) stats.links.internal++;
          else if (link.file) {
            stats.links.notice++;
            stats.notices.set(link.url, link.reason);
          } else if (link.asset) stats.links.file++;
          else if (link.live) {
            stats.links.live++;
            stats.liveLinks.set(link.live, link.reason);
          } else if (link.external) stats.links.external++;
        }
        if (attrs.target === '_blank' && !/noopener/.test(attrs.rel ?? '')) attrs.rel = `${attrs.rel ? `${attrs.rel} ` : ''}noopener`;
        break;
      }
      case 'img': {
        const lazySrc = lazySrcOf(n);
        const src = imageFile(n, pageUrl, assetResolve);
        const srcset = srcsetRefs(n.attrs.srcset ?? n.lazy?.['data-srcset'], pageUrl, assetResolve);
        if (!src) return null; // removed earlier by dropMissingImages
        attrs.src = { asset: src };
        if (srcset.length) attrs.srcset = srcset;
        if (!n.attrs.src && lazySrc && !attrs.loading) attrs.loading = 'lazy';
        // The width it is shown at in each view: the responsive image files are made for these (assets/variants.js).
        // In a box with object-fit the picture is drawn at its own proportions: inside the box (contain: a tall logo
        // in a wide box is drawn narrower) or over it (cover: wider than the box).
        const rw = {};
        const ratio = n.natural?.[0] > 0 && n.natural?.[1] > 0 ? n.natural[0] / n.natural[1] : null;
        for (const [v, d] of Object.entries(n.views)) {
          if (!d || d.hidden || !(d.rect?.[2] > 0)) continue;
          const [w, h] = [d.rect[2], d.rect[3]];
          const fit = d.style?.['object-fit'];
          // cover: the file whose area equals the box's (speed tools judge an image by its pixels against the box's pixels;
          // the full width of the cropped picture would be a file up to twice as large).
          const drawn = ratio && h > 0 && (fit === 'contain' || fit === 'scale-down') ? Math.min(w, h * ratio) : ratio && h > 0 && fit === 'cover' ? Math.sqrt(w * h * ratio) : w;
          rw[v] = Math.round(drawn);
        }
        if (Object.keys(rw).length) out.rw = rw;
        break;
      }
      case 'source': {
        if (n.attrs.srcset) {
          const srcset = srcsetRefs(n.attrs.srcset, pageUrl, assetResolve);
          if (!srcset.length) return null;
          attrs.srcset = srcset;
        } else {
          const file = assetResolve(n.src ?? n.attrs.src, pageUrl);
          if (!file) return null;
          attrs.src = { asset: file };
        }
        break;
      }
      case 'video':
      case 'audio': {
        const file = assetResolve(n.src ?? n.attrs.src, pageUrl);
        if (file) attrs.src = { asset: file };
        else if (n.src || n.attrs.src) stats.droppedMedia.push(n.src ?? n.attrs.src);
        const poster = assetResolve(n.poster ?? n.attrs.poster, pageUrl);
        if (poster) attrs.poster = { asset: poster };
        break;
      }
      case 'iframe':
      case 'embed': {
        const src = n.src ?? n.attrs.src;
        if (src && /^https?:/.test(src) && !platformCdnHost(src)) attrs.src = src;
        break;
      }
      case 'form':
        stats.forms++;
        break;
      case 'input':
        if (/^image$/i.test(n.attrs.type ?? '')) {
          const file = assetResolve(n.attrs.src, pageUrl);
          if (file) attrs.src = { asset: file };
        }
        break;
      case 'svg': {
        // Sanitized here, so no IR (ir/site.json) and no emitted page ever holds the original markup.
        const clean = sanitizeSvg(rewriteSvg(n.svg ?? '<svg></svg>', pageUrl, assetResolve), { inline: true });
        if (!clean.svg) return null;
        out.raw = clean.svg;
        addRemoved(stats.safety.svg, clean.removed);
        if (clean.changed) stats.safety.svgChanged++;
        return out;
      }
      default:
    }
    for (const c of n.children) {
      const child = convert(c);
      if (child) out.children.push(child);
    }
    return out;
  };
  return convert(t.root);
}

/** The notice pages the links of the site need (ir/notice.js): static files, so every stack ships them. */
export function noticeFiles(site) {
  const lang = site.pages[0]?.head?.lang ?? null;
  return [...(site.resolveLink.notices ?? new Map())].map(([outPath, { url, reason }]) => ({
    path: outPath,
    content: noticePage({ outPath, url, reason, siteName: site.siteName?.value ?? null, lang }),
    notice: { url, reason },
  }));
}

/**
 * Builds the IR from a prepared site (after the latest fit pass).
 * @returns {{ ir: object, stats: object }}
 */
/**
 * @param {object} site
 * @param {{ asIs?: boolean }} [o]  asIs (exact mode): head texts are copied as they are and the stylesheet keeps every
 *   @font-face the original declares. The flag is written onto the IR, so a stack built later from ir/site.json follows it.
 */
export function buildIR(site, { asIs = false } = {}) {
  const styles = buildStyles(site.pages, { assetFile: (url) => site.assetResolve(url), asIs: asIs || Boolean(site.asIs) });
  const safety = newSafetyStats();
  const links = () => ({ internal: 0, file: 0, notice: 0, live: 0, external: 0 });
  const stats = { links: links(), liveLinks: new Map(), notices: new Map(), droppedImages: [], droppedMedia: [], forms: 0, safety };
  const pages = site.pages.map((t) => {
    const s = { links: links(), liveLinks: new Map(), notices: new Map(), droppedMedia: [], forms: 0, safety };
    const body = pageBody(t, site, s);
    for (const k of Object.keys(stats.links)) stats.links[k] += s.links[k];
    for (const [u, r] of s.liveLinks) stats.liveLinks.set(u, r);
    for (const [u, r] of s.notices) stats.notices.set(u, r);
    stats.droppedImages.push(...t.droppedImages);
    stats.droppedMedia.push(...s.droppedMedia);
    stats.forms += s.forms;
    return {
      url: t.info.url,
      path: t.info.path,
      outPath: t.info.outPath,
      slug: t.info.slug,
      views: t.views,
      head: t.head,
      html: { class: t.htmlNode.class ?? null },
      body,
      content: t.wp?.content ?? null,
      stats: { links: s.links, liveLinks: [...s.liveLinks].map(([url, reason]) => ({ url, reason })), forms: s.forms, droppedImages: t.droppedImages.length },
    };
  });

  // Only the keyframes and font faces the generated rules use.
  const animationNames = new Set();
  const families = new Set();
  for (const rule of styles.rules) {
    for (const decl of Object.values(rule.parts)) {
      for (const name of (decl['animation-name'] ?? '').split(/,\s*/)) if (name) animationNames.add(name);
      for (const f of (decl['font-family'] ?? '').split(/,\s*/)) if (f) families.add(f.replace(/^["']|["']$/g, '').toLowerCase());
    }
  }
  // An animation that starts on hover / focus (ir/motion.js) needs its keyframes too.
  for (const effect of [...(site.motion?.hover ?? []), ...(site.motion?.focus ?? [])]) {
    for (const decl of [effect.decls, ...Object.values(effect.pseudo ?? {}), ...(effect.kids ?? []).map((k) => k.decls)]) {
      for (const name of (decl?.['animation-name'] ?? '').split(/,\s*/)) if (name && name !== 'none') animationNames.add(name);
    }
  }
  // Any other motion effect (an open panel, a state, a scrolled bar, a neighbour of a hover) may name a captured
  // animation too, in `animation-name` or the `animation` shorthand: keep what it names rather than ship a dangling one.
  const motionText = site.motion ? JSON.stringify(site.motion) : '';
  const named = (name) => new RegExp(`(^|[^\\w-])${name.replace(/[^\w-]/g, '\\$&')}([^\\w-]|$)`).test(motionText);
  const keepKeyframes = (name) => asIs || site.asIs || animationNames.has(name) || (motionText && named(name));
  const ir = {
    version: IR_VERSION,
    baseUrl: site.baseUrl,
    siteName: site.siteName.value,
    breakpoints: site.breakpoints,
    ...(site.mediaBounds?.length && { mediaBounds: site.mediaBounds }),
    tokens: site.tokens,
    ...((asIs || site.asIs) && { asIs: true }),
    fontFaces: site.fontFaces.filter((f) => families.has(f.family.toLowerCase())),
    // An as-is copy keeps every @keyframes the original declared: the site's script may start one by name at runtime.
    keyframes: [...site.keyframes].filter(([name]) => keepKeyframes(name)).map(([name, css]) => ({ name, css: mapUrls(css, (u) => site.assetResolve(u)) })),
    boxSizingReset: styles.boxSizingReset,
    ...(site.motion && { motion: site.motion }),
    rules: styles.rules,
    files: [...site.files, ...noticeFiles(site)],
    pages,
  };
  return { ir, stats: { ...stats, classes: styles.classCount, rules: styles.rules.length } };
}

export { VIEW_IDS };
