// As-is capture (exact mode): the page the browser ended up with and the stylesheets as the site wrote them, so an exact
// copy can keep the original's own CSS instead of rebuilding it from computed px values. A rebuild sees one px value per
// captured width and has to guess the rule behind it (clamp(), vh, calc(), a media query between two captured widths);
// the site's own rules need no guessing at any width.
//
// What is kept, per view (capture/<slug>/<view>-asis.json):
// - `html`: the rendered document after the scroll-through (open shadow roots as declarative shadow DOM), with the
//   site's scripts and <noscript> taken out - the copy never runs the original's JavaScript. Every stylesheet owner
//   (<link rel=stylesheet>, <style>) carries `data-sas-sheet="<index into sheets>"`, so the copy can put each sheet
//   back where it was, in the same cascade order.
// - `sheets`: every stylesheet in document order - <link>, <style>, the document's constructed sheets, @import children -
//   with its media, whether it is disabled, and its text: the network body as written when the browser fetched it
//   (`raw`), the <style> text when it still matches what the browser parsed, else the CSSOM serialisation (`cssom`, what
//   CSS-in-JS libraries leave: an empty <style> filled with insertRule).
// - `refs`: every file the page and its sheets point at (images, every srcset candidate, posters, media, icons, fonts,
//   css url()), so the assets step downloads them and the copy can point at local files.
// Nothing here identifies a site, a framework or a class name.
import { load } from 'cheerio';
import { linkedFileKind } from '../assets/collect.js';

export const ASIS_VERSION = 1;
/** One stylesheet body kept from the network: larger ones fall back to the browser's serialisation. */
export const MAX_SHEET_BYTES = 8 * 1024 * 1024;
export const asisFile = (viewId) => `${viewId}-asis.json`;

/**
 * Keeps the text of every stylesheet response of a browser context (call before the page is opened).
 * @returns {{ bodies: Map<string, string>, settled: () => Promise<void> }}
 */
export function recordSheetBodies(context) {
  const bodies = new Map();
  const pending = new Set();
  context.on('response', (res) => {
    if (res.request().resourceType() !== 'stylesheet' || res.status() >= 400) return;
    const job = res.body().then((buf) => {
      if (buf.length <= MAX_SHEET_BYTES) bodies.set(res.url(), buf.toString('utf8'));
    }, () => {}).finally(() => pending.delete(job));
    pending.add(job);
  });
  return { bodies, settled: () => Promise.all([...pending]).then(() => {}) };
}

/** Page function: the rendered document and its stylesheets in cascade order (see the header). */
export function readAsIs() {
  const sheets = [];
  const index = new Map();
  const readRules = (sheet) => {
    try {
      return sheet.cssRules;
    } catch {
      return null; // cross-origin without CORS: the network body stands in
    }
  };
  const serialize = (rules) => [...rules].map((r) => r.cssText).join('\n');
  const visit = (sheet, from, parent) => {
    if (!sheet || index.has(sheet)) return;
    const i = sheets.length;
    index.set(sheet, i);
    const rules = readRules(sheet);
    const entry = {
      from,
      href: sheet.href || null,
      media: sheet.media ? sheet.media.mediaText : '',
      disabled: Boolean(sheet.disabled),
      readable: Boolean(rules),
      rules: rules ? rules.length : null,
      ...(parent != null && { parent }),
    };
    sheets.push(entry);
    const node = sheet.ownerNode;
    if (from === 'style' && node && rules) {
      // The text as written, when it is still what the browser has: a script that called insertRule (CSS-in-JS) leaves a
      // <style> whose text says less than its rules, and then only the CSSOM tells the truth.
      const raw = node.textContent || '';
      let same = false;
      try {
        const probe = new CSSStyleSheet();
        probe.replaceSync(raw); // @import is ignored here, so imports are left out of both sides
        same = serialize([...probe.cssRules]) === serialize([...rules].filter((r) => r.type !== CSSRule.IMPORT_RULE));
      } catch {
        same = false;
      }
      if (same) entry.text = raw;
      else entry.cssom = serialize(rules);
    } else if (rules && !sheet.href) {
      entry.cssom = serialize(rules); // a constructed sheet has no text but its rules
    } else if (rules) {
      entry.cssomRules = rules.length; // a fetched sheet: its network body is the text (server side)
    }
    if (node && node.setAttribute && (from === 'link' || from === 'style')) node.setAttribute('data-sas-sheet', String(i));
    for (const rule of rules ? [...rules] : []) {
      if (rule.type === CSSRule.IMPORT_RULE) visit(rule.styleSheet, 'import', i);
    }
  };
  for (const sheet of document.styleSheets) visit(sheet, sheet.ownerNode && sheet.ownerNode.tagName === 'STYLE' ? 'style' : 'link', null);
  for (const sheet of document.adoptedStyleSheets || []) visit(sheet, 'adopted', null);
  // <style> / <link> elements with no sheet at all (a disabled alternate, a media list the browser dropped) stay in the
  // markup as they are.

  // Open shadow roots serialise as declarative shadow DOM; what they adopt has no markup and is counted.
  const roots = [];
  let shadowAdopted = 0;
  let closedHosts = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) {
      roots.push(el.shadowRoot);
      shadowAdopted += (el.shadowRoot.adoptedStyleSheets || []).length;
    } else if (customElements.get(el.localName)) closedHosts++;
  }
  const root = document.documentElement;
  const inner = typeof root.getHTML === 'function' ? root.getHTML({ shadowRoots: roots }) : root.innerHTML;
  for (const el of document.querySelectorAll('[data-sas-sheet]')) el.removeAttribute('data-sas-sheet');

  return {
    version: 1,
    url: location.href,
    baseURI: document.baseURI,
    doctype: document.doctype ? document.doctype.name : null,
    htmlAttrs: [...root.attributes].map((a) => [a.name, a.value]),
    inner,
    sheets,
    stats: {
      nodes: document.getElementsByTagName('*').length,
      shadowRoots: roots.length,
      shadowAdopted,
      closedHosts,
      canvases: document.getElementsByTagName('canvas').length,
    },
  };
}

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The document as one HTML string, without the site's scripts and <noscript> (the copy never runs them, and a browser
 * with scripting on never renders <noscript>). Structured data stays: it is data, not code.
 * @returns {{ html: string, removed: { scripts: number, noscript: number, handlers: number } }}
 */
export function documentHtml(read) {
  const attrs = read.htmlAttrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join('');
  const $ = load(`${read.doctype ? `<!DOCTYPE ${read.doctype}>` : ''}<html${attrs}>${read.inner}</html>`);
  const scripts = $('script').filter((_, el) => !/^application\/(ld\+)?json$/i.test($(el).attr('type') ?? ''));
  const removed = { scripts: scripts.length, noscript: $('noscript').length, handlers: 0 };
  scripts.remove();
  $('noscript').remove();
  // Script preloads point at files the copy will not have.
  $('link[rel~="modulepreload"], link[rel~="preload"][as="script"], link[rel~="prefetch"][as="script"]').remove();
  return { html: $.html(), removed };
}

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi;
const ICON_REL = /(^|\s)(icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/i;
const MEDIA_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|wav|m4a|aac|flac)(\?|#|$)/i;

const absolute = (url, base) => {
  const value = String(url ?? '').trim();
  if (!value || /^(data|blob|javascript|about|mailto|tel):/i.test(value) || value.startsWith('#')) return null;
  try {
    const u = new URL(value, base);
    return /^https?:$/.test(u.protocol) ? u.href.replace(/#.*$/, '') : null;
  } catch {
    return null;
  }
};

/** Every URL in a srcset, not just one: which candidate loads depends on the width and pixel ratio of whoever looks. */
// Parsed the way the HTML standard does: a URL runs to the next white space (it may hold commas - CDN resize options do),
// trailing commas end it, and its descriptors run to the next comma outside parentheses.
export function srcsetUrls(value) {
  const s = String(value ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    const start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    const ended = /,$/.test(url);
    url = url.replace(/,+$/, '');
    if (url) out.push(url);
    if (ended) continue;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth = Math.max(0, depth - 1);
      else if (s[i] === ',' && depth === 0) break;
    }
  }
  return out;
}

/** The text a sheet entry stands for: the body as written, else what the browser parsed. */
export const sheetText = (sheet) => sheet.raw ?? sheet.text ?? sheet.cssom ?? null;

/** url() references of a stylesheet text: font sources (inside @font-face) and everything else. */
export function cssRefs(text, base) {
  const out = [];
  const fontSpans = [...String(text ?? '').matchAll(FONT_FACE)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of String(text ?? '').matchAll(CSS_URL)) {
    const url = absolute(m[2], base);
    if (!url) continue;
    const inFace = fontSpans.some(([a, b]) => m.index >= a && m.index < b);
    out.push({ url, kind: inFace ? 'font' : MEDIA_EXT.test(url) ? 'media' : 'image', from: inFace ? 'asis-font-face' : 'asis-css' });
  }
  return out;
}

/**
 * Every file the as-is page needs, deduplicated: the markup's images (each srcset candidate), media, posters, icons,
 * SVG references, inline style url(), linked documents of the site, and every url() of every sheet.
 * @returns {{ url: string, kind: string, from: string }[]}
 */
export function asisRefs({ html, baseURI, sheets }) {
  const $ = load(html);
  const base = absolute($('base[href]').attr('href'), baseURI) ?? baseURI;
  const found = new Map();
  const add = (value, kind, from, b = base) => {
    const url = absolute(value, b);
    if (url && !found.has(url)) found.set(url, { url, kind, from });
  };
  $('img[src], input[type="image" i][src]').each((_, el) => add($(el).attr('src'), 'image', 'asis-img'));
  $('img[srcset], source[srcset]').each((_, el) => srcsetUrls($(el).attr('srcset')).forEach((u) => add(u, 'image', 'asis-srcset')));
  $('video[src], audio[src], video source[src], audio source[src]').each((_, el) => add($(el).attr('src'), 'media', 'asis-media'));
  $('video[poster]').each((_, el) => add($(el).attr('poster'), 'image', 'asis-poster'));
  $('link[href]').each((_, el) => {
    const rel = $(el).attr('rel') ?? '';
    const as = $(el).attr('as') ?? '';
    if (ICON_REL.test(rel)) add($(el).attr('href'), 'icon', 'asis-icon');
    else if (/(^|\s)preload(\s|$)/i.test(rel) && /^(image|font)$/i.test(as)) add($(el).attr('href'), as.toLowerCase(), 'asis-preload');
  });
  $('image, use, feImage').each((_, el) => {
    const href = $(el).attr('href') ?? $(el).attr('xlink:href');
    if (href && !href.startsWith('#')) add(href.replace(/#.*$/, ''), 'image', 'asis-svg');
  });
  $('[style]').each((_, el) => { for (const r of cssRefs($(el).attr('style'), base)) add(r.url, r.kind, 'asis-style'); });
  $('a[href], area[href]').each((_, el) => {
    const url = absolute($(el).attr('href'), base);
    const kind = url && linkedFileKind(url);
    if (kind && new URL(url).host.replace(/^www\./, '') === new URL(baseURI).host.replace(/^www\./, '')) add(url, kind, 'asis-link');
  });
  for (const sheet of sheets) {
    for (const r of cssRefs(sheetText(sheet), sheet.href ?? base)) add(r.url, r.kind, r.from, sheet.href ?? base);
  }
  return [...found.values()];
}

/**
 * Reads the page as-is and writes capture/<slug>/<view>-asis.json. Run right after the snapshot, before any probe
 * hovers, clicks or resizes the page.
 * @param {import('playwright').Page} page
 * @param {{ bodies: Map<string,string>, settled: () => Promise<void> }} recorder  recordSheetBodies() of the context
 * @returns {Promise<{ data: object, summary: object }>}
 */
export async function captureAsIs(page, recorder) {
  const read = await page.evaluate(readAsIs);
  await recorder.settled();
  const { html, removed } = documentHtml(read);
  let fromNetwork = 0;
  let missing = 0;
  for (const sheet of read.sheets) {
    if (!sheet.href || sheet.from === 'adopted') continue;
    const raw = recorder.bodies.get(sheet.href);
    if (raw != null) {
      sheet.raw = raw;
      fromNetwork++;
    } else if (!sheet.readable) {
      missing++; // neither the network nor the CSSOM has it: the assets step's stylesheet fetch is the last resort
    }
  }
  // A readable fetched sheet whose body did not arrive still has its rules.
  const unbodied = read.sheets.filter((s) => s.href && s.readable && s.raw == null);
  if (unbodied.length) {
    const texts = await page.evaluate((hrefs) => hrefs.map((href) => {
      const sheet = [...document.styleSheets].find((s) => s.href === href);
      try {
        return sheet ? [...sheet.cssRules].map((r) => r.cssText).join('\n') : null;
      } catch {
        return null;
      }
    }), unbodied.map((s) => s.href)).catch(() => []);
    unbodied.forEach((s, i) => { if (texts[i] != null) s.cssom = texts[i]; });
  }
  const refs = asisRefs({ html, baseURI: read.baseURI, sheets: read.sheets });
  const data = { version: ASIS_VERSION, url: read.url, baseURI: read.baseURI, html, sheets: read.sheets, refs, removed, stats: read.stats };
  const summary = {
    sheets: read.sheets.length,
    fromNetwork,
    cssom: read.sheets.filter((s) => s.cssom != null && s.raw == null).length,
    missing,
    refs: refs.length,
    bytes: html.length,
    removed,
    ...read.stats,
  };
  return { data, summary };
}
