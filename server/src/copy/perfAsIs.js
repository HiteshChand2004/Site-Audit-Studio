// The safe performance fixes of an as-is copy (C3): only what changes how fast a page loads, never what it shows, how it is laid
// out or what its scripts do. Every one is measured first in a real browser at 375 and 1440 px (preserve/check.js perfProbe, on
// the copy before its fixes) and then proved like every other as-is fix (preserve/stage.js fixAndProve: fixGate at both widths).
//   lcp    the image that is the Largest Contentful Paint at either width gets fetchpriority="high", and loses loading="lazy"
//   lazy   an image entirely below the first screen at BOTH widths gets loading="lazy" (the gate scrolls through the page, so a
//          lazy image that would come in late or not at all shows in its pictures)
//   webp   a local PNG shown by an <img> is re-encoded as LOSSLESS WebP when every decoded pixel is the same, it has no colour
//          or gamma chunk a browser would apply differently, it is not animated, and the new file is at most 90 % of the old one
//   css    a local stylesheet loses its whitespace and comments (esbuild, whitespace only: no rule is merged, reordered or
//          dropped), only when the browser builds the very same rules from both (cssRules, compared text for text) and every
//          page that loads it is pictured the same (preserve/stage.js minifyAndProve)
// Never: the original's scripts (not minified, deferred, moved or removed), font-display (text would show in another font while
// the web font loads), lossy re-encoding or smaller variants (the pixels change), width / height attributes, preconnects.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { transform } from 'esbuild';

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
  const lazyAt = probe.widths.map(() => new Set());
  const totals = new Map();
  probe.widths.forEach((w, i) => {
    if (w.lcp?.tag === 'img' && w.lcp.src != null) lcp.add(`${w.lcp.k}|${w.lcp.src}`);
    else if (w.lcp) open.push({ page: pagePath, reason: 'd', detail: `The largest element on the first screen at ${w.width} px is ${w.lcp.tag === 'img' ? 'an image a script sets' : `not an <img> (${w.lcp.tag}${w.lcp.background ? ', a background picture' : ''})`}: its loading is left as the original has it` });
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
  return { lcp, lazy, totals, open, widths: probe.widths.map((w) => w.width), scrollers: [...scrollers.values()] };
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
      if (was.fetchpriority !== 'high' || was.loading != null && a.loading == null) fixed.push({ field: 'img', src: img.src, from: was, value: { fetchpriority: 'high', loading: a.loading ?? null } });
    } else if (allow.lazy && plan.lazy.has(img.key) && a.loading == null) {
      if (!sameCount) {
        lazyOpen.push({ page: page.path, reason: 'd', detail: `${img.src} is left without lazy loading on purpose: a script adds more images with the same address (${live.join(' / ')} in the page, ${img.total} in its markup), so the markup cannot say which one is below the first screen` });
        continue;
      }
      a.loading = 'lazy';
      lazyFixed.push({ field: 'img', src: img.src, value: 'lazy' });
    }
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

/**
 * A lossless WebP of a PNG, or why there is none. Same pixels: both are decoded to RGBA and compared byte for byte.
 * @returns {Promise<{ data: Buffer, from: number } | { skip: string }>}
 */
export async function losslessWebp(png) {
  if (png.length < 8 || png.toString('latin1', 1, 4) !== 'PNG') return { skip: 'not a PNG' };
  const chunks = colourChunks(png);
  if (chunks.length) return { skip: `it carries ${chunks.join(', ')} (${chunks.includes('acTL') ? 'animated' : 'colour or gamma the browser applies'})` };
  const data = await sharp(png).webp({ lossless: true, effort: 6 }).toBuffer();
  if (data.length > png.length * WEBP_MAX_SHARE) return { skip: `the WebP would be ${Math.round((data.length / png.length) * 100)} % of it` };
  const rgba = (b) => sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b] = await Promise.all([rgba(png), rgba(data)]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || !a.data.equals(b.data)) return { skip: 'its decoded pixels are not the same' };
  return { data, from: png.length };
}

/**
 * The webp fixes of one page: each <img> whose src is a local PNG (no srcset: the browser's choice is left alone) points at a
 * lossless WebP written next to it (`<name>.sas-<sha256:10>.webp`; the PNG stays, other pages, CSS or scripts may use it).
 */
export async function fixPngImages($, page, dir, made = new Map()) {
  const fixed = [];
  const open = [];
  for (const img of staticImages($)) {
    const a = img.el.attribs;
    if (a.srcset != null || $(img.el).closest('picture').length || !/\.png$/i.test(img.src)) continue;
    const file = localFileOf(dir, page.outPath, img.src);
    if (!file) continue;
    let result = made.get(file);
    if (!result) {
      const png = await readFile(file).catch(() => null);
      result = png ? await losslessWebp(png).catch((err) => ({ skip: `it could not be read (${String(err?.message ?? err).slice(0, 80)})` })) : { skip: 'the file is missing' };
      if (result.data) {
        const name = `${path.basename(file, path.extname(file))}.sas-${createHash('sha256').update(result.data).digest('hex').slice(0, 10)}.webp`;
        const target = path.join(path.dirname(file), name);
        // Never over a file of the copy: a name already taken must hold exactly these bytes (a retry writing it again).
        const there = await readFile(target).catch(() => null);
        if (there && !there.equals(result.data)) result = { skip: `${name} already exists with other content` };
        else {
          if (!there) await writeFile(target, result.data);
          result = { name, file: path.relative(dir, target).split(path.sep).join('/'), from: result.from, to: result.data.length };
        }
      }
      made.set(file, result);
    }
    if (result.skip) {
      open.push({ page: page.path, reason: 'd', detail: `${img.src} is not converted to WebP: ${result.skip}` });
      continue;
    }
    const src = img.src.replace(/[^/]+$/, encodeURIComponent(result.name));
    a.src = src;
    fixed.push({ field: 'img', src: img.src, value: src, file: result.file, bytes: [result.from, result.to] });
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
export const PERF_KINDS = ['lcp', 'lazy', 'webp'];
