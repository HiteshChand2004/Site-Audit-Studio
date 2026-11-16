// The safe performance fixes of an as-is copy (C3): only what changes how fast a page loads, never what it shows, how it is laid
// out or what its scripts do. Every one is measured first in a real browser at 375 and 1440 px (preserve/check.js perfProbe, on
// the copy before its fixes) and then proved like every other as-is fix (preserve/stage.js fixAndProve: fixGate at both widths).
//   lcp    the image that is the Largest Contentful Paint at either width gets fetchpriority="high", loses loading="lazy" and
//          gets a preload in the head; and the largest element (any kind) shows at once: it and its ancestors that the page
//          faded or slid in at load are held at their resting opacity and transform by one rule (showLcp). That changes the
//          first moment of the page (no fade-in), so every such page is listed in plain words (`what`). It is never done to an
//          element that would change one of the motion checks: one below the first screen (a scroll reveal there), one that
//          loops or moves by itself, or one that changes under the mouse (a hover, a pointer follower)
//   lazy   an image entirely below the first screen at BOTH widths gets loading="lazy" (the gate scrolls through the page, so a
//          lazy image that would come in late or not at all shows in its pictures)
//   webp   a local PNG or JPEG shown by an <img> (its src, its srcset, its <picture>'s untyped sources, all or none per image)
//          or named in the page's own CSS is re-encoded as WebP when the new file is at most 90 % of the old one: a PNG as
//          LOSSLESS WebP when every decoded pixel is the same and it has no colour or gamma chunk a browser would apply
//          differently; when that is not smaller enough, and for every JPEG, a WebP at the lowest quality of 80 / 85 / 90 / 95
//          whose decoded pixels show NO visible difference (YIQ distance, VISIBLE_THRESHOLD 0.03: not one pixel past it).
//          Otherwise the original file stays, and why is recorded. Never animated, EXIF-turned or non-RGB files
//   css    a local stylesheet loses its whitespace and comments (esbuild, whitespace only: no rule is merged, reordered or
//          dropped), only when the browser builds the very same rules from both (cssRules, compared text for text) and every
//          page that loads it is pictured the same (preserve/stage.js minifyAndProve)
//   size   a picture whose file is wider than it is ever drawn (read at window widths 320–1920, perfProbe drawnWidths) gets WebP
//          copies at smaller widths, each with no visible difference from the file resized to that width, offered in a new
//          srcset with the file itself as the widest and a `sizes` never smaller than where it is drawn (sizesAttr): the browser
//          draws it at the same size and a sharp screen still takes the larger file (user, 2026-11-16: Lighthouse "Properly size
//          images" must be solved). Never a picture that already chooses among files, moves or changes size, or is animated.
// Never: the original's scripts (not minified, deferred, moved or removed), font-display (text would show in another font while
// the web font loads), a re-encoding with a visible difference, width / height attributes, preconnects.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { transform } from 'esbuild';
import { isScrollReveal } from '../recreate/ir/motion.js';
import { colorDelta, MAX_YIQ_DELTA } from '../recreate/verify/exact/pixels.js';

/** A local PNG is replaced only when its lossless WebP is at most this share of it. */
export const WEBP_MAX_SHARE = 0.9;
/** Below this many bytes a stylesheet is left alone (Lighthouse does not count savings this small). */
export const CSS_MIN_BYTES = 2048;
/** A stylesheet is rewritten only when it gets at least this much smaller. */
export const CSS_MIN_SAVING = 0.05;

/** The images of the static page a probe can name: (src as written, its occurrence among images with that src). */
export function staticImages($) {
  const seen = new Map();
  return $('img').toArray()
    .filter((el) => !$(el).closest('noscript, template').length && el.attribs.src)
    .map((el) => {
      const src = el.attribs.src;
      const k = seen.get(src) ?? 0;
      seen.set(src, k + 1);
      return { el, src, k, key: `${k}|${src}` };
    })
    .map((x) => ({ ...x, total: seen.get(x.src) }));
}

/**
 * What the probe allows on a page: { lcp: Set<key>, lazy: Set<key>, totals: Map<src, count[]>, open: object[] }.
 * An image is named by its src and occurrence; it is used only when the page, as the browser built it, has as many images with
 * that src as the markup does, at every width (a script that adds or swaps images makes the name ambiguous: left, reported).
 * @param {{ widths: { width: number, viewportH: number, lcp: object|null, images: object[] }[] }} probe
 */
export function planPerf(probe, pagePath) {
  const open = [];
  const lcp = new Set();
  // The largest element and its ancestors at every width, by place under <body> (showLcp).
  const shown = new Map();
  const lazyAt = probe.widths.map(() => new Set());
  const totals = new Map();
  probe.widths.forEach((w, i) => {
    if (w.lcp?.tag === 'img' && w.lcp.src != null) lcp.add(`${w.lcp.k}|${w.lcp.src}`);
    // A text or a box is shown at once (showLcp) and has nothing to load; only a picture the markup does not name stays as it is.
    else if (w.lcp && (w.lcp.tag === 'img' || w.lcp.background)) open.push({ page: pagePath, reason: 'd', detail: `The largest element on the first screen at ${w.width} px is ${w.lcp.tag === 'img' ? 'an image a script sets' : `a background picture (${w.lcp.tag})`}: its loading is left as the original has it` });
    (w.lcpChain ?? []).forEach((c, depth) => {
      if (!c.path) return;
      const key = c.path.map(([tag, i]) => `${tag}:${i}`).join('>');
      const e = shown.get(key) ?? { path: c.path, tag: c.tag, lcpTag: w.lcpChain[0].tag, text: null, seen: false, loops: false, moving: false, hoverMoves: false, scrollReveal: false, opacity: new Set(), transform: new Set(), widths: [] };
      if (depth === 0) e.text ??= c.text ?? null;
      e.seen ||= Boolean(c.seen);
      e.loops ||= Boolean(c.loops);
      e.moving ||= Boolean(c.moving);
      e.hoverMoves ||= Boolean(c.hoverMoves);
      // The motion check reads reveals at a computer's window (1440 x 900): an element that starts below its first screen there
      // is counted as a scroll reveal (ir/motion.js isScrollReveal), and showing it at once would take it out of that count.
      if (w.width >= 1024 && isScrollReveal({ trigger: { kind: 'timed' }, rect: [0, c.top] })) e.scrollReveal = true;
      e.opacity.add(String(c.opacity));
      e.transform.add(String(c.transform));
      e.widths.push(w.width);
      shown.set(key, e);
    });
    for (const img of w.images) {
      const t = totals.get(img.src) ?? [];
      t[i] = img.total;
      totals.set(img.src, t);
      const below = img.visible && img.top >= w.viewportH && img.left >= 0 && img.right <= w.width;
      if (below && !img.inScroller && !img.lazyLib && img.loading == null && img.fetchpriority == null) lazyAt[i].add(`${img.k}|${img.src}`);
    }
  });
  // Below the first screen at EVERY width, and never the largest element at any.
  const lazy = new Set([...lazyAt[0] ?? []].filter((key) => lazyAt.every((s) => s.has(key)) && !lcp.has(key)));
  // Boxes that scroll at ANY width and the keyboard cannot reach (copy/seoA11yAsIs.js fixScrollableRegions): one entry per
  // element, with the widths it scrolls at.
  const scrollers = new Map();
  for (const w of probe.widths) {
    for (const s of w.scrollers ?? []) {
      const key = s.path.map(([tag, i]) => `${tag}:${i}`).join('>');
      const seen = scrollers.get(key) ?? { ...s, widths: [] };
      seen.widths.push(w.width);
      scrollers.set(key, seen);
    }
  }
  // Pictures that may get smaller copies (fixImageSizes): named the same at every width the probe read, drawn at every window
  // width of the computer's reading (drawn), never choosing among files already, never moving or changing size, with a known
  // file width. Anything else is left as it is.
  const size = new Map();
  const drawn = probe.widths.find((w) => w.drawn)?.drawn ?? null;
  if (drawn) {
    for (const [key, points] of Object.entries(drawn)) {
      const seen = probe.widths.map((w) => w.images.find((im) => `${im.k}|${im.src}` === key));
      if (seen.some((x) => !x) || seen.some((x) => x.chooses || x.moves || x.lazyLib)) continue;
      const natural = Math.max(...seen.map((x) => x.nw || 0));
      if (!natural || points.length < 2 || points.every(([, w]) => !(w > 0))) continue;
      size.set(key, { natural, points });
    }
  }
  return { lcp, lazy, totals, open, size, widths: probe.widths.map((w) => w.width), scrollers: [...scrollers.values()], shown: [...shown.values()] };
}

/**
 * A `sizes` value no smaller than the picture is drawn at ANY window width, from its drawn widths at a few: up to the first
 * width read, the width drawn there; between two widths read, the larger of the drawn width at the upper one and the lower
 * one's grown in proportion to the window (a picture never grows faster than its window); past the last, its share of the
 * window. Too large is safe (a larger file than needed), too small would blur the picture, so every step rounds up.
 * @param {[number, number][]} points  [window width, drawn width]
 */
export function sizesAttr(points) {
  const p = [...points].filter(([vw]) => vw > 0).sort((a, b) => a[0] - b[0]);
  if (!p.length) return null;
  const parts = [`(max-width: ${p[0][0]}px) ${Math.max(1, p[0][1])}px`];
  for (let i = 1; i < p.length; i++) {
    const [lo, dLo] = p[i - 1];
    const [hi, dHi] = p[i];
    parts.push(`(max-width: ${hi}px) ${Math.max(1, Math.ceil(Math.max(dLo * (hi / lo), dHi)))}px`);
  }
  const [last, dLast] = p.at(-1);
  parts.push(`${Math.max(1, Math.ceil((dLast / last) * 100))}vw`);
  return parts.join(', ');
}

/** The widths a smaller copy of a picture may have; only those well below the file's own width are made. */
export const VARIANT_WIDTHS = [320, 480, 640, 800, 1024, 1280, 1600, 1920, 2560];
/** A smaller copy is made only below this share of the file's own width, and kept only at most WEBP_MAX_SHARE of its bytes. */
export const VARIANT_MAX_SHARE = 0.85;

/** The largest drawn width `sizes` names for a picture (the widest it may need, at one pixel per CSS pixel). */
const largestDrawn = (points) => Math.max(...points.map(([, w]) => w), 1);

/**
 * One smaller copy of a local picture, `width` pixels wide, written next to it once (memo `made`), or why there is none: the
 * file resized (lanczos3, as a browser draws it smaller), then encoded as WebP only when, decoded, not one pixel differs visibly
 * from the resized picture (visiblySameWebp), and only when it is at most WEBP_MAX_SHARE of the original file.
 */
async function variantOf(file, width, dir, made) {
  const memo = `${file}|${width}`;
  if (made.has(memo)) return made.get(memo);
  let result;
  try {
    const input = await readFile(file);
    const meta = await sharp(input).metadata();
    if ((meta.pages ?? 1) > 1) result = { skip: 'it is animated' };
    else if (meta.orientation && meta.orientation !== 1) result = { skip: 'it is turned by its EXIF orientation' };
    else if (!meta.width || width >= meta.width * VARIANT_MAX_SHARE) result = { skip: `it is ${meta.width} pixels wide: no smaller copy of ${width} is worth making` };
    else {
      let resize = sharp(input).resize({ width, kernel: 'lanczos3', withoutEnlargement: true });
      if (meta.icc) resize = resize.keepIccProfile();
      const resized = await resize.png().toBuffer();
      const webp = await visiblySameWebp(resized);
      if (!webp.data) result = { skip: webp.skip };
      else if (webp.data.length > input.length * WEBP_MAX_SHARE) result = { skip: `a ${width} px copy would be ${Math.round((webp.data.length / input.length) * 100)} % of the file` };
      else {
        const name = `${path.basename(file, path.extname(file))}.sas-w${width}-${createHash('sha256').update(webp.data).digest('hex').slice(0, 10)}.webp`;
        const target = path.join(path.dirname(file), name);
        const there = await readFile(target).catch(() => null);
        if (there && !there.equals(webp.data)) result = { skip: `${name} already exists with other content` };
        else {
          if (!there) await writeFile(target, webp.data);
          result = { name, width, file: path.relative(dir, target).split(path.sep).join('/'), from: input.length, to: webp.data.length, quality: webp.quality };
        }
      }
    }
  } catch (err) {
    result = { skip: `it could not be read (${String(err?.message ?? err).slice(0, 80)})` };
  }
  made.set(memo, result);
  return result;
}

/**
 * Smaller copies of the large pictures of one page (Lighthouse "Properly size images"). For a picture the plan allows
 * (planPerf `size`: drawn at every window width, not choosing among files, not moving), a local PNG, JPEG or WebP whose file is
 * wider than it is ever drawn: WebP copies at VARIANT_WIDTHS below its own width (each with no visible difference, variantOf),
 * offered with the file itself as the widest in a new srcset, and a `sizes` never smaller than where it is drawn (sizesAttr).
 * The browser then takes the smallest file that covers the picture at its screen density, so a sharp screen still gets the
 * larger file. src stays as it was. Only when the page names that picture as often as the probe saw it, at every width.
 */
export async function fixImageSizes($, page, dir, plan, made = new Map()) {
  const fixed = [];
  const open = [];
  if (!plan?.size?.size) return { fixed, open };
  for (const img of staticImages($)) {
    const info = plan.size.get(img.key);
    if (!info) continue;
    const a = img.el.attribs;
    if (a.srcset != null || $(img.el).closest('picture').length) continue;
    if (!(plan.totals.get(img.src) ?? []).every((t) => t === img.total)) continue;
    if (!/\.(png|jpe?g|webp)$/i.test(img.src.split(/[?#]/)[0])) continue;
    const file = localFileOf(dir, page.outPath, img.src);
    if (!file) continue;
    const need = largestDrawn(info.points);
    // From the bytes, never sharp(path): on Windows that keeps the file open and the workspace could not be removed.
    const natural = await readFile(file).then((b) => sharp(b).metadata()).then((m) => m.width ?? 0, () => 0);
    if (!natural || natural <= need) continue;
    const widths = VARIANT_WIDTHS.filter((w) => w < natural * VARIANT_MAX_SHARE && w >= Math.min(...info.points.map(([, d]) => d).filter((d) => d > 0), need));
    const variants = [];
    let why = null;
    for (const w of widths) {
      const r = await variantOf(file, w, dir, made);
      if (r.skip) why ??= r.skip;
      else variants.push(r);
    }
    if (!variants.length) {
      if (why) open.push({ page: page.path, reason: 'd', detail: `${img.src} keeps its one file (${natural} px wide, drawn at most ${need} px): ${why}` });
      continue;
    }
    const sizes = sizesAttr(info.points);
    if (!sizes) continue;
    a.srcset = [...variants.map((v) => `${webpAddress(img.src, v.name)} ${v.width}w`), `${img.src} ${natural}w`].join(', ');
    a.sizes = sizes;
    for (const v of variants) fixed.push({ field: 'img', attr: 'srcset', src: img.src, value: webpAddress(img.src, v.name), file: v.file, width: v.width, bytes: [v.from, v.to], quality: v.quality });
  }
  return { fixed, open };
}

/** The largest element in plain words, from its tag: what a page owner reads in the report. */
export function plainPart(tag) {
  if (/^h[1-6]$/.test(tag)) return 'Main heading';
  if (/^(img|picture|svg|video|canvas)$/.test(tag)) return 'Main picture';
  if (/^(p|span|blockquote|li|figcaption|strong|em)$/.test(tag)) return 'Main text';
  return 'Largest part of the first screen';
}

/** The element at a place under <body> (tag and index among the element children at each level), or null when a tag differs. */
function elementAt($, path) {
  let cur = $('body').get(0);
  for (const [tag, i] of path) {
    const kid = cur ? $(cur).children().get(i) : null;
    if (!kid || kid.tagName?.toLowerCase() !== tag) return null;
    cur = kid;
  }
  return cur;
}

/** Whether an element's own style attribute starts it hidden or out of place: an opacity below 1, or a transform. */
function startsHidden(style = '') {
  const decls = String(style).split(';').map((d) => d.split(':')).filter((d) => d.length > 1);
  return decls.some(([name, ...rest]) => {
    const prop = name.trim().toLowerCase();
    const value = rest.join(':').replace(/!important/i, '').trim();
    if (prop === 'opacity') return Number(value) < 1;
    return /^(transform|translate|scale|rotate)$/.test(prop) && value !== '' && value !== 'none';
  });
}

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The largest element shows at once: it and each ancestor the page started hidden or out of place (seen fading or sliding by the
 * probe, or hidden by its own style attribute), and that rests fully shown at every width it was read at, get data-sas-shown and
 * one rule in the head that holds them at their resting opacity (and transform, when every width rests at the same one). The
 * rule is !important, which a CSS animation, a Web Animation and a script's inline style cannot override, and `:not(:hover)`, so
 * a hover of the element's own still runs. Left as it is, with the reason (open): an element below the first screen at a
 * computer's width (counted as a scroll reveal), one that loops or moves by itself, one that changes under the mouse, one that
 * does not rest fully shown, or one the markup does not hold at that place. One fix per page, with `what` in plain words.
 */
export function showLcp($, page, plan) {
  const fixed = [];
  const open = [];
  if (!plan?.shown?.length || $('[data-sas-shown]').length) return { fixed, open };
  const rules = [];
  let what = null;
  const leave = (e, why) => open.push({ page: page.path, field: 'shown', reason: 'd', detail: `${plainPart(e.lcpTag)} still fades in on ${page.path}: ${why}` });
  for (const e of plan.shown) {
    const el = elementAt($, e.path);
    const sameText = !e.text || flat($(el).text()).startsWith(e.text.slice(0, 40));
    const hidden = e.seen || (el && startsHidden(el.attribs?.style));
    if (!hidden) continue;
    if (!el || !sameText) { leave(e, `the page's script changes it after load, so the markup does not say which element it is (<${e.tag}>)`); continue; }
    if (e.scrollReveal) { leave(e, 'it starts below the first screen, where its fade-in counts as a scroll reveal; showing it at once would take it out of that count'); continue; }
    if (e.loops || e.moving) { leave(e, 'it keeps moving by itself; holding it still would stop that motion'); continue; }
    if (e.hoverMoves) { leave(e, 'it changes when the mouse is over it; holding it still would stop that'); continue; }
    if (e.opacity.size !== 1 || ![...e.opacity][0] || Number([...e.opacity][0]) !== 1) { leave(e, 'it does not end fully shown, so there is no resting look to show at once'); continue; }
    const decls = ['opacity:1!important'];
    if (e.transform.size === 1) decls.push(`transform:${[...e.transform][0]}!important`);
    el.attribs['data-sas-shown'] = String(rules.length);
    rules.push(`[data-sas-shown="${rules.length}"]:not(:hover){${decls.join(';')}}`);
    what ??= `${plainPart(e.lcpTag)} now shows at once, no fade-in`;
  }
  if (!rules.length) return { fixed, open };
  const style = $('<style data-sas-shown></style>');
  style.text(rules.join(''));
  $('head').append(style);
  fixed.push({ field: 'shown', what, elements: rules.length, value: rules });
  return { fixed, open };
}

/** A <link rel="preload" as="image"> for the largest image, unless the head has one or a <picture> would choose another file. */
function preloadImage($, img) {
  const a = img.el.attribs;
  if ($(img.el).closest('picture').find('source').length) return false;
  const has = $('link[rel~="preload" i][as="image" i]').toArray().some((l) => l.attribs.href === a.src || (a.srcset && l.attribs.imagesrcset === a.srcset));
  if (has) return false;
  const link = $('<link>');
  link.attr({ rel: 'preload', as: 'image', href: a.src, fetchpriority: 'high' });
  if (a.srcset) link.attr('imagesrcset', a.srcset);
  if (a.srcset && a.sizes) link.attr('imagesizes', a.sizes);
  $('head').append(link);
  return true;
}

/**
 * The lcp and lazy fixes on one page's parsed markup, from its plan; `allow` says which of the two a retry makes (the other
 * leaves the markup alone).
 */
export function fixImageLoading($, page, plan, allow = { lcp: true, lazy: true }) {
  const fixed = [];
  const open = [];
  if (!plan) return { lcp: { fixed, open }, lazy: { fixed: [], open: [] } };
  const lazyFixed = [];
  const lazyOpen = [];
  for (const img of staticImages($)) {
    const live = plan.totals.get(img.src) ?? [];
    const sameCount = plan.widths.every((_, i) => live[i] === img.total);
    const a = img.el.attribs;
    if (plan.lcp.has(img.key)) {
      if (!allow.lcp) continue;
      if (!sameCount) {
        open.push({ page: page.path, reason: 'd', detail: `The largest image (${img.src}) appears ${live.join(' / ')} time(s) in the page as its scripts build it and ${img.total} in its markup: not touched` });
        continue;
      }
      const was = { fetchpriority: a.fetchpriority ?? null, loading: a.loading ?? null };
      if (a.fetchpriority !== 'high') a.fetchpriority = 'high';
      if (String(a.loading).toLowerCase() === 'lazy') delete a.loading;
      const preload = preloadImage($, img);
      if (was.fetchpriority !== 'high' || was.loading != null && a.loading == null || preload) fixed.push({ field: 'img', src: img.src, from: was, value: { fetchpriority: 'high', loading: a.loading ?? null, ...(preload && { preload: true }) } });
    } else if (allow.lazy && plan.lazy.has(img.key) && a.loading == null) {
      if (!sameCount) {
        lazyOpen.push({ page: page.path, reason: 'd', detail: `${img.src} is left without lazy loading on purpose: a script adds more images with the same address (${live.join(' / ')} in the page, ${img.total} in its markup), so the markup cannot say which one is below the first screen` });
        continue;
      }
      a.loading = 'lazy';
      lazyFixed.push({ field: 'img', src: img.src, value: 'lazy' });
    }
  }
  if (allow.lcp) {
    const shown = showLcp($, page, plan);
    fixed.push(...shown.fixed);
    open.push(...shown.open);
  }
  return { lcp: { fixed, open }, lazy: { fixed: lazyFixed, open: lazyOpen } };
}

/** The file a src names inside the copy, or null (another host, a query, a data: address, outside the copy). */
export function localFileOf(dir, pageOutPath, src) {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || /[?#]/.test(src)) return null;
  let rel;
  try {
    rel = decodeURIComponent(src);
  } catch {
    return null;
  }
  const file = rel.startsWith('/') ? path.join(dir, rel) : path.join(dir, path.dirname(pageOutPath), rel);
  const inside = path.relative(dir, file);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? file : null;
}

/** PNG chunks that make a browser draw the pixels differently from their plain values (WebP keeps none of them but ICC). */
function colourChunks(png) {
  const found = [];
  for (let i = 8; i + 8 <= png.length;) {
    const len = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    if (['gAMA', 'cHRM', 'iCCP', 'acTL'].includes(type)) found.push(type);
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return found;
}

/** A PNG larger than this many pixels is left as it is: decoding both files to compare them would cost too much memory. */
export const WEBP_MAX_PIXELS = 16e6;

/**
 * A lossless WebP of a PNG, or why there is none. Same pixels: both are decoded to RGBA and compared byte for byte.
 * @returns {Promise<{ data: Buffer, from: number } | { skip: string }>}
 */
export async function losslessWebp(png) {
  if (png.length < 8 || png.toString('latin1', 1, 4) !== 'PNG') return { skip: 'not a PNG' };
  const chunks = colourChunks(png);
  if (chunks.length) return { skip: `it carries ${chunks.join(', ')} (${chunks.includes('acTL') ? 'animated' : 'colour or gamma the browser applies'})` };
  const { width = 0, height = 0 } = await sharp(png).metadata();
  if (width * height > WEBP_MAX_PIXELS) return { skip: `it is ${width} × ${height} pixels, more than ${WEBP_MAX_PIXELS / 1e6} million` };
  const data = await sharp(png).webp({ lossless: true, effort: 6 }).toBuffer();
  if (data.length > png.length * WEBP_MAX_SHARE) return { skip: `the lossless WebP would be ${Math.round((data.length / png.length) * 100)} % of it`, size: true };
  const rgba = (b) => sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b] = await Promise.all([rgba(png), rgba(data)]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || !a.data.equals(b.data)) return { skip: 'its decoded pixels are not the same' };
  return { data, from: png.length };
}

/** Qualities tried for a WebP that is not lossless, lowest first: the first with no visible difference is kept. */
export const WEBP_QUALITIES = [80, 85, 90, 95];
/**
 * A pixel differs visibly when its YIQ distance passes this share of the largest possible. Stricter than pixelmatch's 0.1,
 * which lets compression noise through (measured 2026-11-15: a WebP of random noise had no pixel past 0.1 at quality 80, while
 * at 0.03 it had 336–5 275; a smooth photo's largest difference was 0.016 at every quality).
 */
export const VISIBLE_THRESHOLD = 0.03;

/** How many pixels of two RGBA buffers of one size differ visibly (YIQ, VISIBLE_THRESHOLD), and the largest distance. */
export function visibleDifference(a, b) {
  const limit = MAX_YIQ_DELTA * VISIBLE_THRESHOLD * VISIBLE_THRESHOLD;
  let pixels = 0;
  let max = 0;
  for (let k = 0; k < a.length; k += 4) {
    const d = Math.abs(colorDelta(a, b, k, k));
    if (d > max) max = d;
    if (d > limit) pixels++;
  }
  return { pixels, share: max / MAX_YIQ_DELTA };
}

/**
 * A WebP of a JPEG or PNG that is not lossless but shows no visible difference, or why there is none. Every quality of
 * WEBP_QUALITIES is tried, lowest first; one is kept only when, decoded, not one pixel differs visibly from the original
 * (visibleDifference: 0 pixels) and the file is at most WEBP_MAX_SHARE of it. A file a browser would draw differently from its
 * decoded pixels is left alone: animated, turned by its EXIF orientation, or not in RGB (CMYK). A colour profile goes with it.
 * @returns {Promise<{ data: Buffer, from: number, quality: number } | { skip: string }>}
 */
export async function visiblySameWebp(input) {
  const meta = await sharp(input).metadata();
  if ((meta.pages ?? 1) > 1) return { skip: 'it is animated' };
  if (meta.orientation && meta.orientation !== 1) return { skip: 'it is turned by its EXIF orientation, which a WebP would not carry' };
  if (meta.space && !['srgb', 'b-w', 'rgb', 'grey16', 'rgb16'].includes(meta.space)) return { skip: `its colours are ${meta.space}, not RGB` };
  const { width = 0, height = 0 } = meta;
  if (width * height > WEBP_MAX_PIXELS) return { skip: `it is ${width} × ${height} pixels, more than ${WEBP_MAX_PIXELS / 1e6} million` };
  const rgba = (b) => sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const original = await rgba(input);
  let tried = null;
  for (const quality of WEBP_QUALITIES) {
    let enc = sharp(input).webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true });
    if (meta.icc) enc = enc.keepIccProfile();
    const data = await enc.toBuffer();
    // A higher quality only makes the file larger: nothing above this one can be small enough either.
    if (data.length > input.length * WEBP_MAX_SHARE) return { skip: `${tried ? `${tried}; ` : ''}the WebP at quality ${quality} would be ${Math.round((data.length / input.length) * 100)} % of it` };
    const copy = await rgba(data);
    if (copy.info.width !== original.info.width || copy.info.height !== original.info.height) return { skip: 'the WebP has another size' };
    const diff = visibleDifference(original.data, copy.data);
    if (!diff.pixels) return { data, from: input.length, quality };
    tried = `at quality ${quality} ${diff.pixels} pixels differ visibly`;
  }
  return { skip: `a WebP that is not lossless would change how it looks (${tried})` };
}

/** One srcset as its candidates, each with the text around its address kept as written (descriptors, spaces, order). */
export function srcsetParts(srcset) {
  return String(srcset).split(',').map((part) => {
    const m = part.match(/^(\s*)(\S+)([\s\S]*)$/);
    return m ? { before: m[1], url: m[2], after: m[3] } : { before: part, url: '', after: '' };
  });
}
const joinSrcset = (parts) => parts.map((p) => `${p.before}${p.url}${p.after}`).join(',');

/**
 * The WebP of one local PNG or JPEG file of the copy, written next to it once (memo `made`), or why there is none: a PNG's
 * lossless WebP first; when that is not smaller enough, and for a JPEG, a WebP with no visible difference (visiblySameWebp).
 */
async function webpOf(file, dir, made) {
  let result = made.get(file);
  if (result) return result;
  const input = await readFile(file).catch(() => null);
  const failed = (err) => ({ skip: `it could not be read (${String(err?.message ?? err).slice(0, 80)})` });
  if (!input) result = { skip: 'the file is missing' };
  else if (isPng(file)) {
    result = await losslessWebp(input).catch(failed);
    if (result.size) {
      const visual = await visiblySameWebp(input).catch(failed);
      result = visual.data ? visual : { skip: `${result.skip}; ${visual.skip}` };
    }
  } else result = await visiblySameWebp(input).catch(failed);
  if (result.data) {
    const name = `${path.basename(file, path.extname(file))}.sas-${createHash('sha256').update(result.data).digest('hex').slice(0, 10)}.webp`;
    const target = path.join(path.dirname(file), name);
    // Never over a file of the copy: a name already taken must hold exactly these bytes (a retry writing it again).
    const there = await readFile(target).catch(() => null);
    if (there && !there.equals(result.data)) result = { skip: `${name} already exists with other content` };
    else {
      if (!there) await writeFile(target, result.data);
      result = { name, file: path.relative(dir, target).split(path.sep).join('/'), from: result.from, to: result.data.length, ...(result.quality && { quality: result.quality }) };
    }
  }
  made.set(file, result);
  return result;
}

const isPng = (url) => /\.png$/i.test(url);
/** The files the webp fix converts: PNG (lossless first) and JPEG (only with no visible difference). */
const isConvertible = (url) => /\.(png|jpe?g)$/i.test(url);
const webpAddress = (url, name) => url.replace(/[^/]+$/, encodeURIComponent(name));

/**
 * The webp fixes of one page. Each local PNG an <img> can show points at a lossless WebP of it written next to it
 * (`<name>.sas-<sha256:10>.webp`; the PNG stays: other pages, CSS or scripts may use it). That covers its src, every candidate
 * of its srcset and of the srcsets of its <picture>'s sources: only the files change, never srcset, sizes, media, the order or
 * the descriptors, so the browser chooses the same candidate at every width and screen density, and every candidate has the
 * very same pixels. All or none per image: when one PNG candidate cannot be converted, none of them is. A <picture> source
 * that names its type is left as the original has it (the type decides the browser's choice). PNGs in the page's own style
 * attributes and <style> blocks are converted the same way; a shared stylesheet is not touched here (one page cannot prove it).
 */
export async function fixPngImages($, page, dir, made = new Map()) {
  const fixed = [];
  const open = [];
  for (const img of staticImages($)) {
    const a = img.el.attribs;
    const picture = $(img.el).closest('picture');
    const sources = picture.length ? picture.children('source').toArray() : [];
    /** @type {{ el: any, attr: string, url: string, parts?: object[], part?: object }[]} */
    const slots = [{ el: img.el, attr: 'src', url: img.src }];
    for (const el of [img.el, ...sources]) {
      if (el.attribs.srcset == null) continue;
      const parts = srcsetParts(el.attribs.srcset);
      for (const part of parts) if (part.url) slots.push({ el, attr: 'srcset', url: part.url, parts, part });
    }
    const pngSlots = slots.filter((s) => isConvertible(s.url));
    if (!pngSlots.length) continue;
    const several = slots.length > 1;
    const leave = (why) => open.push({ page: page.path, reason: 'd', detail: `${img.src}${several ? ' and its other sizes are' : ' is'} not converted to WebP: ${why}` });
    const typed = sources.find((s) => s.attribs.type);
    if (typed) {
      leave(`a <source> of its <picture> names its type (${typed.attribs.type}), which decides the browser's choice`);
      continue;
    }
    const files = pngSlots.map((s) => localFileOf(dir, page.outPath, s.url));
    if (files.some((f) => !f)) {
      // Only reported when there is something to say about it: a lone remote PNG was never a fix of this kind.
      if (several && files.some(Boolean)) leave(`${pngSlots[files.indexOf(null)].url} is not a file of the copy`);
      continue;
    }
    const results = [];
    for (const f of files) results.push(await webpOf(f, dir, made));
    const failed = results.findIndex((r) => r.skip);
    if (failed >= 0) {
      leave(several ? `${pngSlots[failed].url}: ${results[failed].skip}` : results[failed].skip);
      continue;
    }
    pngSlots.forEach((s, i) => {
      const value = webpAddress(s.url, results[i].name);
      if (s.attr === 'src') a.src = value;
      else s.part.url = value;
      fixed.push({ field: 'img', ...(s.attr !== 'src' && { attr: 'srcset' }), src: s.url, value, file: results[i].file, bytes: [results[i].from, results[i].to], ...(results[i].quality && { quality: results[i].quality }) });
    });
    const srcsetSlots = pngSlots.filter((s) => s.attr === 'srcset');
    for (const el of new Set(srcsetSlots.map((s) => s.el))) el.attribs.srcset = joinSrcset(srcsetSlots.find((s) => s.el === el).parts);
  }

  // The page's own CSS (style attributes and <style> blocks): url() of a local PNG.
  const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+\.(?:png|jpe?g))\1\s*\)/gi;
  const inCss = async (css) => {
    let out = css;
    for (const m of [...String(css).matchAll(URL_IN_CSS)]) {
      const url = m[2].trim();
      const file = localFileOf(dir, page.outPath, url);
      if (!file) continue;
      const r = await webpOf(file, dir, made);
      if (r.skip) {
        open.push({ page: page.path, reason: 'd', detail: `${url} (a background in the page's CSS) is not converted to WebP: ${r.skip}` });
        continue;
      }
      const value = webpAddress(url, r.name);
      out = out.split(m[0]).join(m[0].replace(m[2], value));
      fixed.push({ field: 'css', src: url, value, file: r.file, bytes: [r.from, r.to], ...(r.quality && { quality: r.quality }) });
    }
    return out;
  };
  for (const el of $('[style]').toArray()) {
    if ($(el).closest('noscript, template').length || !/\.(png|jpe?g)/i.test(el.attribs.style)) continue;
    const next = await inCss(el.attribs.style);
    if (next !== el.attribs.style) el.attribs.style = next;
  }
  for (const el of $('style').toArray()) {
    const css = $(el).html() ?? '';
    if (!/\.(png|jpe?g)/i.test(css)) continue;
    const next = await inCss(css);
    if (next !== css) $(el).html(next);
  }
  return { fixed, open };
}

/** A stylesheet without its whitespace and comments; legal comments (the ones opened with a "!") stay. Nothing else is rewritten. */
export async function minifyCssWhitespace(css) {
  const { code } = await transform(css, { loader: 'css', minifyWhitespace: true, legalComments: 'inline', logLevel: 'silent' });
  return code;
}

/**
 * The rules a browser builds from a stylesheet, as text, nested rules flattened in order: two texts with the same list give the
 * same styles at every width (this is the browser's own reading, so whitespace, comments and spelling of the source do not count).
 */
export async function cssRulesOf(page, css) {
  return page.evaluate((text) => {
    const style = document.createElement('style');
    style.textContent = text;
    document.head.append(style);
    const out = [];
    const walk = (rules) => { for (const r of rules) { out.push(r.cssText); if (r.cssRules) walk(r.cssRules); } };
    walk(style.sheet?.cssRules ?? []);
    style.remove();
    return out;
  }, css);
}

/** Every text file of the copy a script, a page or a stylesheet could name a file in (sw.js and its manifest included). */
const TEXT_FILE = /\.(html?|css|m?js|json|webmanifest|svg|xml|txt)$/i;
async function textFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await textFiles(p, out);
    else if (TEXT_FILE.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Which of these names (file names, no folder) any text file of the copy still mentions, the files listed in `except` aside.
 * Used before a file the fixes wrote is removed: a name still mentioned anywhere is never removed.
 */
export async function namesStillUsed(dir, names, except = []) {
  const left = new Set(names);
  const found = new Set();
  const skip = new Set(except.map((e) => path.resolve(dir, e)));
  for (const file of await textFiles(dir)) {
    if (!left.size) break;
    if (skip.has(path.resolve(file))) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const n of [...left]) if (text.includes(n)) { found.add(n); left.delete(n); }
  }
  return found;
}

/**
 * The stylesheets that may be minified, and why the others may not. `uses`: file → the pages that loaded it in the probe (at
 * either width, however it was loaded: a link, an @import, a script). A file is a candidate only when every page that loads it
 * was measured and scrolled to its end (`complete`), no page loads it with an integrity hash, no script, data file or the service
 * worker names it (a script may read, swap or cache it by name), no HTML file outside `measured` (the outPaths the probe opened)
 * can load it, it is at least CSS_MIN_BYTES, minifying saves CSS_MIN_SAVING, and the browser reads the very same rules from both
 * texts (cssRulesOf). Nothing is written here: the caller writes, proves and puts back.
 * @returns {Promise<{ candidates: { file: string, rel: string, min: string, original: Buffer, pages: string[] }[], open: object[] }>}
 */
export async function stylesheetCandidates({ dir, uses, integrity = new Set(), complete = true, measured = new Set(), browser }) {
  const open = [];
  const candidates = [];
  if (!complete) {
    open.push({ page: null, reason: 'd', detail: 'Not every page could be measured and scrolled to its end, so which pages use each stylesheet is not known: no stylesheet is minified' });
    return { candidates, open };
  }
  const all = await textFiles(dir);
  const textOf = new Map();
  for (const file of all) textOf.set(file, await readFile(file, 'utf8').catch(() => ''));
  // Scripts and data files (sw.js and its manifest, a JSON a script reads) that name a stylesheet may read, swap or cache it.
  const scripts = all.filter((f) => /\.(m?js|json|webmanifest)$/i.test(f)).map((f) => textOf.get(f));
  // Stylesheets an HTML file of the copy that is NOT a measured page can load (named in it, or @imported from one it names, at
  // any depth): no look covers such a page, so they are never minified.
  const unmeasured = all.filter((f) => /\.html?$/i.test(f) && !measured.has(path.relative(dir, f).split(path.sep).join('/')));
  const sheets = all.filter((f) => /\.css$/i.test(f));
  const reachable = new Set(sheets.filter((s) => unmeasured.some((h) => textOf.get(h).includes(path.basename(s)))));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sheets) {
      if (reachable.has(s)) continue;
      if ([...reachable].some((r) => textOf.get(r).includes(path.basename(s)))) { reachable.add(s); grew = true; }
    }
  }
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    for (const [file, pagesOf] of uses) {
      const pages = [...pagesOf];
      const rel = path.relative(dir, file).split(path.sep).join('/');
      const name = path.basename(file);
      const leave = (why) => open.push({ page: pages[0] ?? null, reason: 'd', detail: `${rel} is not minified: ${why}` });
      if (integrity.has(file)) { leave('a page loads it with an integrity hash, which would no longer match'); continue; }
      if (reachable.has(file)) { leave('an HTML file of the copy that is not one of the measured pages can load it, and no look covers that page'); continue; }
      if (scripts.some((t) => t.includes(name))) { leave('a script or the service worker names it, and may read, swap or cache it'); continue; }
      const original = await readFile(file).catch(() => null);
      if (!original || original.length < CSS_MIN_BYTES) continue;
      const css = original.toString('utf8');
      const min = await minifyCssWhitespace(css).catch(() => null);
      if (min == null) { leave('the minifier could not read it'); continue; }
      if (Buffer.byteLength(min) > original.length * (1 - CSS_MIN_SAVING)) continue;
      const [a, b] = [await cssRulesOf(page, css), await cssRulesOf(page, min)];
      if (a.length !== b.length || a.some((r, i) => r !== b[i])) { leave('the browser reads different rules from the minified text'); continue; }
      candidates.push({ file, rel, min, original, pages });
    }
  } finally {
    await context.close();
  }
  return { candidates, open };
}

/** What every fix of C3 is, in the report's words (kept short: the report lists each one). */
export const PERF_KINDS = ['lcp', 'lazy', 'webp', 'size'];
