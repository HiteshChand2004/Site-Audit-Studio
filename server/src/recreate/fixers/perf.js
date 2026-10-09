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
import { checkLinks } from '../../audit/linkChecker.js';
import { urlKey } from '../../audit/util.js';
import { isElement, isText } from '../ir/tree.js';
import { KNOWN_VIEWS } from '../views.js';
import { charsCovered, pageChars } from '../emit/css.js';

// The first screen of each captured view (a view missing here would count every image as "below the fold").
const FOLD = Object.fromEntries(KNOWN_VIEWS.map((v) => [v.id, v.height]));
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

// The copy has pages the analysis never read (it reads a sample; Recreate copies the whole site): their outbound links are
// checked here, with the analysis's own rules. Only a target that answers "not there" (404, 410 and other 4xx except
// login / bot walls) counts as dead; server errors and network failures are left alone (a short outage must never unlink
// good links). Bounded in time; switched off with SAS_COPY_LINK_CHECK=0 (the test suite).
const DEAD_STATUS = (s) => typeof s === 'number' && s >= 400 && s < 500 && ![401, 403, 407, 429].includes(s);

/**
 * @param {object} site  prepareSite() result (pages with trees, resolveLink)
 * @param {{ known: Map<string, object>, ms?: number, check?: Function }} o  known: targets already decided (brokenTargets)
 * @returns {Promise<Map<string, { url: string, status: number, source: string }>>}
 */
export async function deadLinks(site, { known = new Map(), ms = 60000, check = checkLinks } = {}) {
  const out = new Map();
  if (process.env.SAS_COPY_LINK_CHECK === '0') return out;
  const pages = [];
  for (const t of site.pages) {
    const links = [];
    walk(t.root, (n) => {
      if (n.tag !== 'a') return;
      const href = n.href ?? n.attrs.href;
      if (typeof href !== 'string') return;
      let u;
      try {
        u = new URL(href, t.info.url);
      } catch {
        return;
      }
      if (!/^https?:$/.test(u.protocol)) return;
      const link = site.resolveLink?.(href, t.info.url);
      if (link?.page || link?.anchor || link?.asset) return; // a page or file of the copy itself
      if (known.has(urlKey(u.href))) return;
      links.push({ href: u.href });
    });
    if (links.length) pages.push({ url: t.info.url, status: 200, facts: { links } });
  }
  if (!pages.length) return out;
  const result = await check({ pages, signal: AbortSignal.timeout(ms) }).catch(() => null);
  for (const b of result?.broken ?? []) if (DEAD_STATUS(b.status)) out.set(urlKey(b.url), { url: b.url, status: b.status, source: 'copy link check' });
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
  let unfaded = 0;
  for (const img of images) {
    if (priority.has(img)) {
      unfaded += dropEntrance(t.root, img);
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
    unfaded,
  };
}

const clips = (d) => ['overflow', 'overflow-x', 'overflow-y'].some((p) => /hidden|clip/.test(d.style?.[p] ?? '')) || /strict|paint|size/.test(d.style?.contain ?? '');
// No view shows this box: hidden, or a box of no size that clips what it holds (a builder's sprite sheet).
const neverShown = (n, own) => {
  const views = Object.values(n.views ?? {}).filter(Boolean);
  if (!views.length) return false;
  return views.every((d) => d.hidden || (own ? !(d.rect?.[2] > 0 && d.rect?.[3] > 0) : (d.rect?.[2] <= 1 || d.rect?.[3] <= 1) && clips(d)));
};

/**
 * Hidden icon sheets: inline SVGs with an id that no view shows (inside a clipping box of no size, or hidden) and that
 * nothing on the page uses (`<use href="#id">`, `url(#id)`, a link or ARIA reference to an id inside them). The page
 * draws the same; each removed SVG is DOM the browser no longer builds. Returns the number removed.
 */
export function pruneSprites(t) {
  const refs = new Set();
  const scan = (text, into = refs) => {
    // Any id, also one starting with a digit (builders write ids like "1353911669"): a reference missed here would remove
    // an icon the page shows. Colours (#aaa) only add references nothing has, which is harmless.
    for (const m of String(text).matchAll(/#([\w:.-]+)/g)) into.add(m[1]);
  };
  const idsIn = (n) => [n.attrs.id, ...[...String(n.svg ?? '').matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])];
  const scanIdList = (text) => {
    for (const id of String(text).split(/\s+/)) if (id) refs.add(id);
  };
  const candidates = [];
  const visit = (n, clipped) => {
    if (!isElement(n)) return;
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      if (typeof v !== 'string') continue;
      if (/^(for|list|form|headers|aria-[a-z]+)$/.test(k)) scanIdList(v);
      else if (v.includes('#')) scan(v);
    }
    for (const d of Object.values(n.views ?? {})) for (const v of Object.values(d?.style ?? {})) if (String(v).includes('#')) scan(v);
    if (n.tag === 'svg') {
      // A sheet's own references (a gradient of one of its icons) count only once that icon is used.
      if (n.attrs?.id && (clipped || neverShown(n, true))) {
        const own = new Set();
        scan(n.svg ?? '', own);
        candidates.push({ n, own, ids: idsIn(n) });
      } else scan(n.svg ?? '');
      return;
    }
    const hides = clipped || neverShown(n, false);
    for (const c of n.children ?? []) visit(c, hides);
  };
  visit(t.root, false);
  const used = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const c of candidates) {
      if (used.has(c) || !c.ids.some((id) => refs.has(id))) continue;
      used.add(c);
      for (const r of c.own) refs.add(r);
      grew = true;
    }
  }
  const unused = new Set(candidates.filter((c) => !used.has(c)).map((c) => c.n));
  if (!unused.size) return 0;
  const drop = (n) => {
    if (!isElement(n) || !n.children) return;
    n.children = n.children.filter((c) => !unused.has(c));
    for (const c of n.children) drop(c);
  };
  drop(t.root);
  return unused.size;
}

const MIN_LAYOUT_PART = 3; // elements: smaller parts are not worth parking
const SCRIPT_OWNED = /^data-w-(set|i|go|note|note-of|auto|hcopy|hrest|hv|one|tpl)$/;

/**
 * Parts of a layout only some window sizes show (a builder's desktop-only row, a phone-only menu button): marked
 * `data-w-lay`, so the generated script takes the ones hidden at the visitor's width out of the page after it loads and
 * puts them back when the window changes (js/motion.js). The original site's script does the same with its other
 * layouts; without script the page keeps every part, hidden by the stylesheet as before. Parts the script switches
 * (states, panels, notices, hover looks) are left alone. Returns how many parts were marked.
 */
export function markLayouts(t) {
  const views = t.views ?? Object.keys(t.root.views ?? {});
  if (views.length < 2) return 0;
  const size = (n) => (isElement(n) ? 1 + n.children.reduce((s, c) => s + size(c), 0) : 0);
  const owned = (n) => isElement(n) && (Object.keys({ ...n.attrs, ...n.stateAttrs }).some((k) => SCRIPT_OWNED.test(k) || k === 'hidden')
    || (n.motionTokens ?? []).some((tok) => /^w/.test(tok)) || n.tag === 'template' || n.children.some(owned));
  let marked = 0;
  const visit = (n) => {
    if (!isElement(n) || n.tag === 'svg' || n.tag === 'template') return;
    const shownIn = views.filter((v) => n.views?.[v] && !n.views[v].hidden);
    if (shownIn.length && shownIn.length < views.length && size(n) >= MIN_LAYOUT_PART && !owned(n)) {
      n.stateAttrs = { ...n.stateAttrs, 'data-w-lay': '' }; // generated attributes reach the IR this way (ir/index.js)
      marked++;
      return;
    }
    for (const c of n.children) visit(c);
  };
  for (const c of t.root.children ?? []) visit(c);
  return marked;
}

// Boxes that hide everything inside them (ir/states.js): a state copy, a message, a hovered look.
const HIDDEN_SUBTREE = /^data-w-(set|i|note-of|hcopy|tpl)$/;
const INVISIBLE = 0.05; // opacity at or below this: the box paints nothing a visitor can see
// A box a dropdown, dialog or carousel keeps out of sight sits out of the flow, so its own opacity of 0 is meant.
const OUT_OF_FLOW = /^(absolute|fixed)$/;

/**
 * A section the original fades in with its own script, which the capture never caught revealed, keeps `opacity: 0` from
 * the snapshot — and with no reveal of ours on it nothing ever shows it again, so it stays invisible for good (parchaa's
 * testimonials). Such a box is drawn as a visitor is meant to see it. Only a box that is clearly meant to be seen:
 * in the flow, with a size and with content, whose opacity is 0 in every view that shows it, and which nothing of ours
 * switches (no motion token, no click-switched state, notice, hover copy, parked layout or hidden box around it).
 * Returns what was made visible. Runs after applyMotion, so every box a mechanism shows already carries its token.
 */
export function showFaded(t) {
  const views = t.views ?? Object.keys(t.root.views ?? {});
  // A box the copy keeps out of sight with everything in it: a state of a tab panel / carousel, a message, a hovered
  // look, a <template>. Only these hide a whole subtree, so only these are passed down.
  const hidesAll = (n) => n.tag === 'template'
    || Object.keys({ ...n.attrs, ...n.stateAttrs }).some((k) => HIDDEN_SUBTREE.test(k) || k === 'hidden');
  // The box itself: an effect of ours already decides what it looks like (a reveal's from-state, a panel that opens).
  const switched = (n) => hidesAll(n) || (n.motionTokens?.length ?? 0) > 0;
  const content = (n) => isElement(n)
    && (n.children.some((c) => isText(c) && c.text.trim()) || /^(img|svg|video|canvas|picture)$/.test(n.tag) || n.children.some(content));
  const out = [];
  const visit = (n, owned) => {
    if (!isElement(n) || n.tag === 'template' || n.tag === 'svg') return;
    const mine = owned || switched(n);
    // Per view: the capture caught the fade at one window size and not at another, so the same box can be invisible on
    // a computer and shown on a phone.
    const faded = views.filter((v) => {
      const view = n.views?.[v];
      if (!view || view.hidden) return false;
      const { style = {}, rect = [] } = view;
      return parseFloat(style.opacity) <= INVISIBLE && !OUT_OF_FLOW.test(style.position ?? '') && rect[2] > 0 && rect[3] > 0;
    });
    if (!mine && faded.length && content(n)) {
      for (const v of faded) n.views[v].style = { ...n.views[v].style, opacity: '1' };
      out.push({ page: t.info.path, element: n.tag, field: 'opacity', from: '0', value: '1', views: faded.join(', '), source: 'the box was captured before the original faded it in, and nothing would have shown it' });
    }
    for (const c of n.children) visit(c, owned || hidesAll(n));
  };
  for (const c of t.root.children ?? []) visit(c, false);
  return out;
}

// Reveal / page-load entrance tokens (ir/motion.js): the effect, its stagger delay, replay.
const ENTRANCE = /^(rv|rl|rp|r\d+|d\d+)$/;

/**
 * The main image of the first screen shows at once: an entrance fade on it or on a box around it holds the largest
 * paint back until the fade ends (render delay of "main content shows in"). Returns how many boxes lost one.
 */
function dropEntrance(root, target) {
  const chain = [];
  const find = (n) => {
    if (n === target) return true;
    for (const c of n.children ?? []) {
      if (c && typeof c === 'object' && find(c)) {
        chain.push(c);
        return true;
      }
    }
    return false;
  };
  if (!find(root)) return 0;
  chain.push(root);
  let count = 0;
  for (const n of chain) {
    const before = n.motionTokens?.length ?? 0;
    if (!before) continue;
    n.motionTokens = n.motionTokens.filter((tok) => !ENTRANCE.test(tok));
    if (n.motionTokens.length < before) count++;
    if (!n.motionTokens.length) delete n.motionTokens;
  }
  return count;
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
    const chars = pageChars(page);
    for (const family of families) {
      const faces = ir.fontFaces.filter((f) => f.family.toLowerCase() === family && (!f.style || f.style === 'normal') && f.src.length);
      // The subset holding most of the page's text (a Latin face, not a Cyrillic one), then the weight nearest 400.
      const cover = new Map(faces.map((f) => [f, charsCovered(f, chars)]));
      const face = faces.sort((a, b) => cover.get(b) - cover.get(a) || Math.abs(Number(a.weight || 400) - 400) - Math.abs(Number(b.weight || 400) - 400))[0];
      if (face && !cover.get(face) && chars.size) continue;
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
