// Exact mode, original CSS: the page the capture kept as-is (capture/asis.js) as IR nodes, and the site's own stylesheets
// as the page's CSS. The rebuilt classes and their px values are not used: the original's classes stay on the original's
// elements and the original's rules style them, at every width, in the cascade order the site had.
//
// What changes on the way, and only this:
// - references: images, media, fonts and url() point at the downloaded files; links to pages of the copy at those pages,
//   other same-site links at a local notice page (ir/links.js), never the live site; a file that could not be
//   downloaded is left out and counted, never linked live;
// - safety: the same attribute guard and SVG sanitizer as every other copy (fixers/html.js, fixers/svg.js); @import is
//   inlined (its media / supports / layer kept as blocks), so the CSS never asks for another file;
// - the parts of the page that are not the site (ir/exclude.js, by the capture's own element paths).
// Nothing here names a site, a framework or a class.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { asisFile, sheetText } from '../capture/asis.js';
import { platformCdnHost } from '../assets/cdn.js';
import { guardAttributes } from '../fixers/html.js';
import { addRemoved, sanitizeSvg } from '../fixers/svg.js';
import { noticeFiles } from './index.js';
import { relFile } from './links.js';

// Never part of a page's markup in the copy: active content, what the head already writes, and the stylesheet owners
// (their CSS is written separately, in the same order).
const DROP = new Set(['script', 'noscript', 'object', 'applet', 'frame', 'frameset', 'base', 'meta', 'link', 'style', 'title', 'template']);
// The element path rule of the capture (capture/snapshot.js): elements of these tags are not counted.
const PATH_SKIP = new Set(['script', 'noscript', 'style', 'template', 'link', 'meta', 'head', 'title', 'base']);
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
const MISSING_URL = 'url("data:,")';

/** srcset → [{ url, d }], parsed as the HTML standard does (a URL may hold commas; descriptors end at a comma). */
export function srcsetEntries(value) {
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
    if (ended) {
      if (url) out.push({ url, d: '' });
      continue;
    }
    const from = i;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth = Math.max(0, depth - 1);
      else if (s[i] === ',' && depth === 0) break;
    }
    if (url) out.push({ url, d: s.slice(from, i).trim() });
  }
  return out;
}

/**
 * url() of a CSS text pointed at the downloaded files (`url("asset:<file>")`, resolved per stack by the emitters);
 * one that was not downloaded becomes an empty image rather than a request to the original.
 */
export function localizeCss(text, base, assetResolve, counts = { urls: 0, missing: 0 }) {
  return String(text ?? '').replace(CSS_URL, (all, q, url) => {
    const value = url.trim();
    if (!value || /^data:/i.test(value) || value.startsWith('#')) return all;
    counts.urls++;
    const file = assetResolve(value, base);
    if (file) return `url("asset:${file}")`;
    counts.missing++;
    return MISSING_URL;
  });
}

// The condition part of an @import (after its URL): layer, supports() and a media list, in that order.
function importBlocks(rest) {
  let s = rest.trim();
  const open = [];
  const layer = /^layer(?:\(([^)]*)\))?/i.exec(s);
  if (layer) {
    open.push(`@layer${layer[1] ? ` ${layer[1].trim()}` : ''} {`);
    s = s.slice(layer[0].length).trim();
  }
  const supports = /^supports\(/i.exec(s);
  if (supports) {
    let depth = 0;
    let end = supports[0].length - 1;
    for (; end < s.length; end++) {
      if (s[end] === '(') depth++;
      else if (s[end] === ')' && --depth === 0) break;
    }
    open.push(`@supports (${s.slice(supports[0].length, end)}) {`);
    s = s.slice(end + 1).trim();
  }
  if (s && !/^all$/i.test(s)) open.push(`@media ${s} {`);
  return open;
}

const wrap = (text, open) => (open.length ? `${open.join(' ')}\n${text}\n${'}'.repeat(open.length)}` : text);
const IMPORT = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)([^;]*);/gi;

/**
 * The CSS of one page: every sheet in cascade order, @import children inlined where they stood, a sheet's own media
 * list kept as a block, url() local. Disabled sheets are left out (the browser did not apply them).
 * @returns {{ sheets: string[], stats: { sheets: number, missing: number, urls: number, missingUrls: number, imports: number } }}
 */
export function pageSheets(asis, assetResolve) {
  const all = asis.sheets ?? [];
  const counts = { urls: 0, missing: 0 };
  const stats = { sheets: 0, missing: 0, imports: 0 };
  const children = new Map();
  all.forEach((s, i) => {
    if (s.parent != null) children.set(s.parent, [...(children.get(s.parent) ?? []), i]);
  });
  const textOf = (i, seen = new Set()) => {
    const s = all[i];
    const raw = sheetText(s);
    if (raw == null || seen.has(i)) {
      stats.missing++;
      return '';
    }
    seen.add(i);
    const base = s.href ?? asis.baseURI;
    const kids = [...(children.get(i) ?? [])];
    // Each @import is replaced by its child sheet (they come in the order the rules stand), wrapped in its condition.
    const body = raw.replace(/@charset\s+[^;]+;/gi, '').replace(IMPORT, (all, q1, u1, q2, u2, rest) => {
      const child = kids.shift();
      stats.imports++;
      return child == null ? '' : wrap(textOf(child, seen), importBlocks(rest));
    });
    return localizeCss(body, base, assetResolve, counts);
  };
  const sheets = [];
  all.forEach((s, i) => {
    if (s.parent != null || s.disabled) return;
    const media = s.media && !/^all$/i.test(s.media.trim()) ? s.media : null;
    const text = textOf(i);
    stats.sheets++;
    if (text.trim()) sheets.push(media ? wrap(text, [`@media ${media} {`]) : text);
  });
  return { sheets, stats: { ...stats, urls: counts.urls, missingUrls: counts.missing } };
}

// Inline SVG keeps its classes and style (the site's CSS selects on them); only its references change.
function localizeSvg(markup, pageUrl, assetResolve) {
  return markup.replace(/\s((?:xlink:)?href)="([^"#][^"]*)"/g, (all, name, url) => {
    if (/^data:/i.test(url)) return all;
    const file = assetResolve(url.replace(/#.*$/, ''), pageUrl);
    return file ? ` ${name}="asset:${file}${url.includes('#') ? url.slice(url.indexOf('#')) : ''}"` : '';
  }).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (all, q, url) => {
    if (/^(data:|#)/i.test(url.trim())) return all;
    const file = assetResolve(url.trim(), pageUrl);
    return file ? `url("asset:${file}")` : MISSING_URL;
  });
}

const newStats = () => ({
  elements: 0, dropped: 0, shadowRoots: 0, links: { internal: 0, notice: 0, file: 0, external: 0, anchor: 0 },
  missing: { images: 0, media: 0, styleUrls: 0 }, safety: { handlers: 0, scriptUrls: 0, other: 0 }, svg: { cleaned: 0, removed: null },
  excluded: 0, notices: new Map(),
});

/**
 * The body of the as-is page as IR nodes (the shape emit/walk.js describeNode reads). Every element keeps its tag,
 * class, id and attributes; `cpath` is the capture's own path of it, so exclusions (and the motion tokens) can find it.
 * @param {{ html: string, baseURI: string }} asis
 * @param {{ pageUrl: string, assetResolve: Function, resolveLink: Function, exclude?: Set<string> }} o
 */
export function asisBody(asis, { pageUrl, assetResolve, resolveLink, exclude = new Set() }) {
  const $ = load(asis.html);
  const stats = newStats();
  const base = $('base[href]').attr('href') ? new URL($('base[href]').attr('href'), asis.baseURI).href : asis.baseURI;
  const svgRemoved = {};
  const convert = (el, cpath) => {
    if (el.type === 'text') return { text: el.data };
    if (el.type !== 'tag' && el.type !== 'script' && el.type !== 'style') return null;
    const tag = el.name.toLowerCase();
    if (DROP.has(tag)) {
      if (tag === 'template' && el.attribs?.shadowrootmode) stats.shadowRoots++;
      if (tag !== 'link' && tag !== 'style' && tag !== 'meta' && tag !== 'title') stats.dropped++;
      return null;
    }
    if (exclude.has(cpath)) {
      stats.excluded++;
      return null;
    }
    stats.elements++;
    const attrs = { ...el.attribs };
    const cls = attrs.class;
    const id = attrs.id;
    delete attrs.class;
    delete attrs.id;
    const hadHref = attrs.href != null;
    guardAttributes(attrs, stats.safety);
    // A link whose href was code (javascript:…) is still drawn as a link (:link styles, the hand cursor): it keeps a
    // harmless one rather than turning into plain text.
    if ((tag === 'a' || tag === 'area') && hadHref && attrs.href == null) attrs.href = '#';
    if (typeof attrs.style === 'string' && /url\(/i.test(attrs.style)) {
      const counts = { urls: 0, missing: 0 };
      attrs.style = { css: localizeCss(attrs.style, base, assetResolve, counts) };
      stats.missing.styleUrls += counts.missing;
    }
    const out = { t: tag, cpath, attrs, children: [] };
    if (cls) out.class = cls;
    if (id) out.id = id;

    if (tag === 'svg') {
      const clean = sanitizeSvg(localizeSvg($.html(el), base, assetResolve), { inline: true });
      if (!clean.svg) return null;
      if (clean.changed) stats.svg.cleaned++;
      addRemoved(svgRemoved, clean.removed);
      // The root's class travels on the node, as in every IR (each stack writes it its own way: class / className).
      let rootClass = null;
      const raw = clean.svg.replace(/^<svg\b([^>]*)>/, (all, a) => `<svg${a.replace(/\sclass="([^"]*)"/, (m, c) => { rootClass = c; return ''; })}>`);
      return { t: 'svg', cpath, raw, ...(rootClass && { class: rootClass }) };
    }
    const asset = (name, kind) => {
      if (!attrs[name]) return;
      const file = assetResolve(attrs[name], base);
      if (file) attrs[name] = { asset: file };
      else {
        delete attrs[name];
        stats.missing[kind]++;
      }
    };
    const srcset = () => {
      if (!attrs.srcset) return;
      const list = srcsetEntries(attrs.srcset).map((c) => ({ asset: assetResolve(c.url, base), ...(c.d && { d: c.d }) }));
      const kept = list.filter((c) => c.asset);
      stats.missing.images += list.length - kept.length;
      if (kept.length) attrs.srcset = kept;
      else delete attrs.srcset;
    };
    switch (tag) {
      case 'a':
      case 'area': {
        const href = attrs.href;
        if (href == null) break;
        if (/^\s*#?\s*$/.test(href)) {
          attrs.href = '#';
          stats.links.anchor++;
          break;
        }
        let abs = null;
        try {
          abs = new URL(href, base).href;
        } catch {
          // not a URL: dropped below
        }
        const link = abs && resolveLink(abs, pageUrl);
        if (!link) attrs.href = '#';
        else {
          attrs.href = link;
          if (link.page) stats.links.internal++;
          else if (link.file) {
            stats.links.notice++;
            stats.notices.set(link.url, link.reason);
          } else if (link.asset) stats.links.file++;
          else if (link.anchor) stats.links.anchor++;
          else stats.links.external++;
        }
        if (attrs.target === '_blank' && !/noopener/.test(attrs.rel ?? '')) attrs.rel = `${attrs.rel ? `${attrs.rel} ` : ''}noopener`;
        break;
      }
      case 'img':
        asset('src', 'images');
        srcset();
        break;
      case 'source':
        if (attrs.srcset) srcset();
        else asset('src', 'media');
        break;
      case 'video':
      case 'audio':
        asset('src', 'media');
        asset('poster', 'images');
        break;
      case 'input':
        if (/^image$/i.test(attrs.type ?? '')) asset('src', 'images');
        break;
      case 'iframe':
      case 'embed':
        // A frame of another site stays that site's (as in every copy); one from the builder's own host does not.
        if (!(attrs.src && /^https?:/i.test(attrs.src) && !platformCdnHost(attrs.src))) delete attrs.src;
        break;
      default:
    }
    const index = {};
    for (const child of el.children ?? []) {
      let childPath = null;
      if (child.type === 'tag' || child.type === 'script' || child.type === 'style') {
        const t = child.name.toLowerCase();
        if (!PATH_SKIP.has(t)) {
          index[t] = (index[t] ?? 0) + 1;
          childPath = `${cpath}>${t}:${index[t]}`;
        }
      }
      const node = convert(child, childPath);
      if (node) out.children.push(node);
    }
    return out;
  };
  const bodyEl = $('body')[0];
  const body = bodyEl ? convert(bodyEl, 'body') : { t: 'body', attrs: {}, children: [] };
  stats.svg.removed = svgRemoved;
  // The class list of <html>: sites style on it (a theme, a breakpoint flag).
  return { body, htmlClass: $('html').attr('class') ?? null, stats };
}

/** Reads one page's as-is capture: the desktop one (the others are kept for comparison). Null when there is none. */
export async function readAsis(dir, info, view = 'desktop') {
  return readFile(path.join(dir, 'capture', info.slug, asisFile(view)), 'utf8').then(JSON.parse, () => null);
}

/**
 * Turns the IR of an exact copy into its as-is form, in place: every page's body becomes the original's markup, the
 * rebuilt rules give way to the site's own stylesheets, and what those already declare (fonts, keyframes, tokens) is not
 * written twice. Pages without an as-is capture are left as rebuilt and named in the result.
 * @param {object} ir  from buildIR
 * @param {{ dir: string, site: object, excluded?: { page: string, path: string }[] }} o
 * @returns {Promise<object>} report.generate.asis
 */
export async function applyAsIs(ir, { dir, site, excluded = [] }) {
  const sheets = new Map(); // hash → css text (with url("asset:…"))
  const report = { pages: 0, rebuilt: [], sheets: 0, imports: 0, missingSheets: 0, cssUrls: 0, missingCssUrls: 0, elements: 0, dropped: 0, shadowRoots: 0, missing: { images: 0, media: 0, styleUrls: 0 }, links: { internal: 0, notice: 0, file: 0, external: 0, anchor: 0 }, safety: { handlers: 0, scriptUrls: 0, other: 0 }, excluded: 0 };
  const infoByOut = new Map(site.pages.map((t) => [t.info.outPath, t.info]));
  for (const page of ir.pages) {
    const info = infoByOut.get(page.outPath);
    const asis = info && (await readAsis(dir, info));
    if (!asis?.html) {
      report.rebuilt.push(page.outPath);
      continue;
    }
    const exclude = new Set(excluded.filter((e) => e.page === info.path).map((e) => e.path));
    const { body, htmlClass, stats } = asisBody(asis, { pageUrl: info.url, assetResolve: site.assetResolve, resolveLink: site.resolveLink, exclude });
    const css = pageSheets(asis, site.assetResolve);
    page.body = body;
    page.html = { ...page.html, class: htmlClass };
    page.asis = css.sheets.map((text) => {
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
      sheets.set(hash, text);
      return hash;
    });
    report.pages++;
    report.sheets += css.stats.sheets;
    report.imports += css.stats.imports;
    report.missingSheets += css.stats.missing;
    report.cssUrls += css.stats.urls;
    report.missingCssUrls += css.stats.missingUrls;
    report.elements += stats.elements;
    report.dropped += stats.dropped;
    report.shadowRoots += stats.shadowRoots;
    report.excluded += stats.excluded;
    for (const k of Object.keys(report.missing)) report.missing[k] += stats.missing[k];
    for (const k of Object.keys(report.links)) report.links[k] += stats.links[k];
    for (const k of Object.keys(report.safety)) report.safety[k] += stats.safety[k];
  }
  if (!report.pages) return report;
  ir.asis = { sheets: Object.fromEntries(sheets) };
  report.distinctSheets = sheets.size;
  // Links of the original markup may need notice pages the rebuilt pages did not (the resolver recorded them).
  ir.files = [...ir.files.filter((f) => !f.notice), ...noticeFiles(site)];
  // The site's own sheets declare these; the rebuilt copies of them would only compete. A page that had no as-is
  // capture keeps the rebuilt rules (emit/css.js gives an as-is page its own sheets only).
  if (!report.rebuilt.length) {
    ir.rules = [];
    ir.fontFaces = [];
    ir.keyframes = [];
    ir.tokens = {};
    ir.boxSizingReset = false;
  }
  return report;
}

/** The CSS of one page of an as-is copy (or of every page, in first-seen order, for the shared stylesheet). */
export function asisCss(ir, { page = null, from }) {
  const order = [];
  const seen = new Set();
  for (const p of page ? [page] : ir.pages) {
    for (const hash of p.asis ?? []) {
      if (!seen.has(hash)) {
        seen.add(hash);
        order.push(hash);
      }
    }
  }
  return order.map((hash) => ir.asis.sheets[hash]
    .replace(/url\("asset:([^"]+)"\)/g, (all, file) => `url("${relFile(from, `assets/${file}`)}")`)).join('\n');
}
