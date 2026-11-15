// The inline styles a removed runtime set once the page had loaded. A framework's script often finishes a page by writing
// style attributes: the pill marking a header's current link gets its place and size (`left: 325px; width: 81px; opacity: 1`
// over the HTML's `left:0;width:0;opacity:0`, motionrepo 2026-11-15), a measured height, an entrance's end state. A page written
// without that runtime (runtimeFree.js) keeps the HTML's values for good: the pill is invisible on every page.
//
// The evidence is the as-is page itself, loaded with its runtime in a browser (readLoadedStyles): every element's style
// attribute once the page is loaded, scrolled through and back at the top, read at each of the check's widths and twice there,
// a moment apart. A value is written into the page only when it is the page's own settled state:
//   - it stays the same between the two readings (a carousel, a ticker or a running animation writes a new one every frame),
//   - it is the same at every width where the element is drawn (a width where it is not drawn - a desktop menu on a phone -
//     does not count; an element drawn nowhere is left as it is),
//   - the element is the one of the HTML: same path (the capture's `tag:n` rule), same tag, same classes.
// Anything else keeps the HTML's value, and is counted (`varies`).
import * as cheerio from 'cheerio';

/** Longest style attribute taken over, and most elements changed per page. */
export const MAX_STYLE = 4000;
export const MAX_ELEMENTS = 1000;
/** The pause between the two readings at one width. */
export const STABLE_MS = 700;

const classSet = (v) => String(v ?? '').split(/\s+/).filter(Boolean).sort().join(' ');

/** Every element of a parsed page's body by its capture path (from <body>, the n-th child element with that tag). */
export function elementsByPath($) {
  const out = new Map();
  const body = $('body')[0];
  if (!body) return out;
  const walk = (node, at) => {
    const seen = new Map();
    for (const c of node.children ?? []) {
      if (!(c.type === 'tag' || c.type === 'script' || c.type === 'style')) continue;
      const n = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, n);
      const p = `${at}>${c.name}:${n}`;
      out.set(p, c);
      walk(c, p);
    }
  };
  walk(body, 'body');
  return out;
}

/**
 * In the page: every element of the body that has a style attribute, or whose path is in `wanted` (the HTML's styled ones:
 * a runtime may also take a style away), with its tag, classes, style and whether it is drawn. Runs in the browser.
 */
export function pageStyles(wanted) {
  const want = new Set(wanted);
  const out = {};
  const walk = (node, at) => {
    const seen = new Map();
    for (const c of node.children) {
      const tag = c.localName;
      const n = (seen.get(tag) ?? 0) + 1;
      seen.set(tag, n);
      const p = `${at}>${tag}:${n}`;
      const style = c.getAttribute('style');
      if (style != null || want.has(p)) {
        out[p] = { tag, cls: (typeof c.className === 'string' ? c.className : c.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort().join(' '), style, drawn: c.getClientRects().length > 0 };
      }
      walk(c, p);
    }
  };
  if (document.body) walk(document.body, 'body');
  return out;
}

/**
 * The settled styles of the as-is page served at base + pagePath, read at each width (see the head of this file).
 * @param {(width: number) => Promise<import('playwright').Page>} openAt  opens a page at a width, loaded and scrolled; closes with page.context()
 * @returns {Promise<{ width: number, styles: Record<string, object> }[]>}
 */
export async function readLoadedStyles(openAt, widths, wanted) {
  const readings = [];
  for (const width of widths) {
    const page = await openAt(width);
    try {
      const first = await page.evaluate(pageStyles, wanted);
      await page.waitForTimeout(STABLE_MS);
      const second = await page.evaluate(pageStyles, wanted);
      const styles = {};
      for (const [p, a] of Object.entries(first)) {
        const b = second[p];
        styles[p] = b && b.style === a.style && b.tag === a.tag && b.cls === a.cls ? a : { ...a, moving: true };
      }
      readings.push({ width, styles });
    } finally {
      await page.context().close().catch(() => {});
    }
  }
  return readings;
}

/** The paths of the HTML's elements that carry a style attribute (what a runtime may have taken away). */
export function styledPaths(html) {
  const $ = cheerio.load(html);
  return [...elementsByPath($)].filter(([, el]) => el.attribs?.style != null).map(([p]) => p);
}

/**
 * What to write: for each element whose settled style differs from the HTML's, { path, tag, cls, style } (style null = no
 * attribute). Pure: the readings of readLoadedStyles against the page's HTML.
 * @returns {{ list: { path: string, tag: string, cls: string, style: string|null }[], varies: number }}
 */
export function loadedStyleChanges(html, readings) {
  const $ = cheerio.load(html);
  const els = elementsByPath($);
  const paths = new Set(readings.flatMap((r) => Object.keys(r.styles)));
  const list = [];
  let varies = 0;
  for (const p of paths) {
    const el = els.get(p);
    if (!el) continue;
    const tag = el.name;
    const cls = classSet(el.attribs?.class);
    const has = el.attribs?.style ?? null;
    const seen = readings.map((r) => r.styles[p]);
    // The same element on every reading (a runtime that swapped it is not this element any more).
    if (seen.some((s) => !s || s.tag !== tag || s.cls !== cls)) {
      if (seen.some((s) => s && s.style !== has)) varies++;
      continue;
    }
    if (seen.every((s) => s.style === has)) continue;
    const drawn = seen.filter((s) => s.drawn);
    if (!drawn.length || drawn.some((s) => s.moving) || new Set(drawn.map((s) => s.style)).size > 1) { varies++; continue; }
    const style = drawn[0].style;
    if (style === has) continue;
    if (style != null && style.length > MAX_STYLE) { varies++; continue; }
    list.push({ path: p, tag, cls, style });
    if (list.length >= MAX_ELEMENTS) break;
  }
  return { list, varies };
}

/** The page with the settled styles written (see loadedStyleChanges); an element that is not there any more is skipped. */
export function withLoadedStyles(html, list) {
  if (!list?.length) return { html, written: 0 };
  const $ = cheerio.load(html);
  const els = elementsByPath($);
  let written = 0;
  for (const c of list) {
    const el = els.get(c.path);
    if (!el || el.name !== c.tag || classSet(el.attribs?.class) !== c.cls) continue;
    if (c.style == null) $(el).removeAttr('style');
    else $(el).attr('style', c.style);
    written++;
  }
  return written ? { html: $.html(), written } : { html, written: 0 };
}
