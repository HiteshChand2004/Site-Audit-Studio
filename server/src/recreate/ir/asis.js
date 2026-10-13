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
import { VIEW_WIDTHS } from '../views.js';

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

/** The pinned reveal properties of an inline style, without their !important. */
export const unpin = (style) => String(style).replace(/(^|;)(\s*(?:opacity|transform|filter)\s*:[^;!]*?)\s*!\s*important\s*(?=;|$)/gi, '$1$2');

const newStats = () => ({
  unpinned: 0, elements: 0, dropped: 0, shadowRoots: 0, links: { internal: 0, notice: 0, file: 0, external: 0, anchor: 0 },
  missing: { images: 0, media: 0, styleUrls: 0 }, safety: { handlers: 0, scriptUrls: 0, other: 0 }, svg: { cleaned: 0, removed: null },
  excluded: 0, notices: new Map(),
});

/**
 * The body of the as-is page as IR nodes (the shape emit/walk.js describeNode reads). Every element keeps its tag,
 * class, id and attributes; `cpath` is the capture's own path of it, so exclusions (and the motion tokens) can find it.
 * @param {{ html: string, baseURI: string }} asis
 * @param {{ pageUrl: string, assetResolve: Function, resolveLink: Function, exclude?: Set<string> }} o
 */
export function asisBody(asis, { pageUrl, assetResolve, resolveLink, exclude = new Set(), fragment = null }) {
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
    // A revealed element the capture pinned (capture/reveal.js): still shown, but as an ordinary inline style, so a
    // rebuilt scroll reveal can animate it (an animation cannot move an !important value).
    if ('data-sas-pin' in attrs) {
      delete attrs['data-sas-pin'];
      if (typeof attrs.style === 'string') attrs.style = unpin(attrs.style);
      stats.unpinned++;
    }
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
  // A part of the page (`fragment` = the path its root stands for): its markup is the first element of the body.
  const bodyEl = $('body')[0];
  const fragmentEl = fragment && bodyEl ? (bodyEl.children ?? []).find((c) => c.type === 'tag' || c.type === 'script' || c.type === 'style') : null;
  const body = fragment ? (fragmentEl ? convert(fragmentEl, fragment) : null)
    : bodyEl ? convert(bodyEl, 'body') : { t: 'body', attrs: {}, children: [] };
  stats.svg.removed = svgRemoved;
  // The class list of <html>: sites style on it (a theme, a breakpoint flag).
  return { body, htmlClass: $('html').attr('class') ?? null, stats };
}

// The motion the copy rebuilds (ir/motion.js) lives in attributes the stylesheet and js/motion.js select on: hover,
// focus, reveal and loop tokens, open panels, a bar that changes once scrolled. These are carried to the same element of
// the as-is markup, found by the capture's own path. What the copy rebuilds as extra elements - the other states of a
// tab set or carousel, a card's hovered look, a message a click shows, a panel only drawn while open - is not part of
// the original markup and is counted instead (`notCarried`).
const CARRY = /^(data-motion|data-scroll-at|data-w-(one|dismiss|layer|x|stay))$/;
// Attributes that make an element switch to, or be, another state: carried only when what they point at was built.
const STATE = /^data-w-(set|i|auto|go|hrest|hv|panel|note|panel-of|note-of|hcopy)$/;
const COPY_ATTRS = { 'data-w-hcopy': 'hoverCards', 'data-w-note-of': 'notices', 'data-w-panel-of': 'panels' };
const isStateCopy = (n) => Boolean(n.tpl) || ('data-w-set' in (n.attrs ?? {}) && 'hidden' in (n.attrs ?? {}));
// What a part is decides first; a <template> (`tpl`) is only how a state or a hovered look waits to be shown.
const copyKind = (n) => COPY_ATTRS[Object.keys(COPY_ATTRS).find((k) => k in (n.attrs ?? {}))] ?? (isStateCopy(n) ? 'states' : null);

/** What a state attribute needs to exist in the copy: a set, a panel, a message, a hover card. */
function needOf(k, v, cpath) {
  const value = String(v ?? '');
  if (k === 'data-w-go') return `set:${value.split(':')[0]}`;
  if (k === 'data-w-panel') return `panel:${value}`;
  if (k === 'data-w-note') return `note:${value.split(':')[0]}`;
  if (k === 'data-w-hrest') return `card:${cpath}`;
  if (k === 'data-w-hv') return `cell:${cpath}`;
  return 'never';
}

/**
 * cpath → the motion and state attributes of the rebuilt element there, from one page of the rebuilt IR. A state
 * attribute is carried only when what it points at was built in the copy (`built`, from asisExtras): a tab that switched
 * to a state the copy does not have would empty its panel.
 */
export function carriedAttrs(irBody, cpathOf, notCarried, built = new Set()) {
  const out = new Map();
  const walk = (n) => {
    if (!n || 'text' in n) return;
    if (copyKind(n)) return; // built (or counted) by asisExtras
    const attrs = n.attrs ?? {};
    const cpath = n.sid != null ? cpathOf.get(n.sid) : null;
    const setBuilt = built.has(`set:${attrs['data-w-set']}`);
    const own = Object.entries(attrs).filter(([k, v]) => {
      if (CARRY.test(k)) return true;
      if (!STATE.test(k)) return false;
      if (k === 'data-w-set' || k === 'data-w-i' || k === 'data-w-auto') return setBuilt;
      return built.has(needOf(k, v, cpath));
    });
    if ('data-w-set' in attrs && !setBuilt) notCarried.states++;
    if (own.length && cpath) out.set(cpath, Object.fromEntries(own));
    else if (own.length) notCarried.unmapped++;
    for (const c of n.children ?? []) walk(c);
  };
  walk(irBody);
  return out;
}

/**
 * The parts the copy adds as elements of their own - the other states of a tab set or carousel, a card's hovered look, a
 * message a click shows, a panel drawn only while open - built from the original's own markup of that state
 * (capture/snapshot.js `asisHtml`), placed where the rebuilt copy places them, with the same switching attributes.
 * A part without that markup (a capture made before it was kept) is counted, and nothing that points at it is carried.
 * @param {(x: object) => object|null} build  the as-is node of a rebuilt part (its `asisHtml` converted)
 * @returns {{ placements: object[], built: Set<string> }}
 */
export function asisExtras(irBody, cpathOf, build, notCarried) {
  const placements = [];
  const sets = new Map(); // set id -> { total, ok }
  const built = new Set();
  // The rebuilt part's attributes on the built part, root and inside (by the path relative to the root).
  const transfer = (x, node) => {
    const base = x.sid != null ? cpathOf.get(x.sid) : null;
    const rel = new Map();
    const collect = (n, top) => {
      if (!n || 'text' in n) return;
      if (!top && copyKind(n)) return; // a part nested inside this one: not carried
      const p = n.sid != null ? cpathOf.get(n.sid) : null;
      const own = Object.entries(n.attrs ?? {}).filter(([k]) => CARRY.test(k) || STATE.test(k) || (top && k === 'hidden'));
      const key = top ? '' : base && p?.startsWith(`${base}>`) ? p.slice(base.length) : null;
      if (own.length && key != null) rel.set(key, Object.fromEntries(own));
      for (const c of n.children ?? []) collect(c, false);
    };
    collect(x, true);
    const rootPath = node.cpath;
    const put = (n) => {
      if (!n || 'text' in n) return;
      const key = n.cpath === rootPath ? '' : n.cpath?.startsWith(`${rootPath}>`) ? n.cpath.slice(rootPath.length) : null;
      const attrs = key != null ? rel.get(key) : null;
      if (attrs) {
        if (n.t === 'svg') carryInto({ t: 'x', children: [n] }, new Map([[n.cpath, attrs]]));
        else n.attrs = { ...n.attrs, ...attrs };
      }
      for (const c of n.children ?? []) put(c);
    };
    put(node);
    if (x.tpl) node.tpl = x.tpl;
    return node;
  };
  const walk = (parent) => {
    const kids = parent.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const x = kids[i];
      if (!x || 'text' in x) continue;
      const kind = copyKind(x);
      if (!kind) {
        walk(x);
        continue;
      }
      const made = x.asisHtml ? build(x) : null;
      const node = made && transfer(x, made);
      if (kind === 'states') {
        const id = x.attrs?.['data-w-set'] ?? x.tpl;
        const s = sets.get(id) ?? { total: 0, ok: 0 };
        s.total++;
        let a = i - 1;
        while (a >= 0 && (!kids[a] || 'text' in kids[a] || copyKind(kids[a]))) a--;
        const anchor = a >= 0 && kids[a].sid != null ? cpathOf.get(kids[a].sid) : null;
        if (node && anchor) {
          s.ok++;
          placements.push({ kind: 'after', anchor, node, set: id });
        }
        sets.set(id, s);
      } else if (kind === 'hoverCards') {
        const card = kids[i - 1];
        const cardPath = card?.sid != null ? cpathOf.get(card.sid) : null;
        const cellPath = parent.sid != null ? cpathOf.get(parent.sid) : null;
        if (node && cardPath) {
          // A card that is all its cell holds: the copy goes after it; else both go in a box that draws nothing.
          placements.push(cellPath && parent.attrs?.['data-w-hv'] != null ? { kind: 'after', anchor: cardPath, node } : { kind: 'wrap', anchor: cardPath, node });
          built.add(`card:${cardPath}`);
          if (cellPath) built.add(`cell:${cellPath}`);
        } else notCarried.hoverCards++;
      } else if (node) {
        placements.push({ kind: 'end', node });
        if (kind === 'panels') built.add(`panel:${x.attrs['data-w-panel-of']}`);
        else built.add(`note:${x.attrs['data-w-note-of']}`);
      } else notCarried[kind]++;
    }
  };
  walk(irBody);
  for (const [id, s] of sets) {
    if (s.ok === s.total) built.add(`set:${id}`);
    else notCarried.states++;
  }
  // A set that is not complete is left out whole: its other states would never be shown.
  return { placements: placements.filter((p) => !p.set || built.has(`set:${p.set}`)), built };
}

/** Puts the built parts into the as-is tree: after their anchor, around it (a hover box), or at the end of the body. */
export function placeExtras(body, placements) {
  const where = new Map();
  const index = (n, parent) => {
    if (!n || 'text' in n) return;
    if (n.cpath && !where.has(n.cpath)) where.set(n.cpath, { n, parent });
    for (const c of n.children ?? []) index(c, n);
  };
  index(body, null);
  const after = new Map(); // anchor -> nodes placed after it, in order
  let placed = 0;
  for (const p of placements) {
    if (p.kind === 'end') {
      body.children.push(p.node);
      placed++;
      continue;
    }
    const at = where.get(p.anchor);
    if (!at?.parent) continue;
    const list = at.parent.children;
    if (p.kind === 'wrap') {
      list.splice(list.indexOf(at.n), 1, { t: 'div', attrs: { 'data-w-hv': '', style: 'display: contents' }, children: [at.n, p.node] });
      placed++;
      continue;
    }
    const chain = after.get(p.anchor) ?? [at.n];
    list.splice(list.indexOf(chain[chain.length - 1]) + 1, 0, p.node);
    chain.push(p.node);
    after.set(p.anchor, chain);
    placed++;
  }
  return placed;
}

/** Puts carried attributes on the as-is nodes with the same path (motion tokens are merged, never replaced). */
export function carryInto(body, carried) {
  let placed = 0;
  const walk = (n) => {
    if (!n || 'text' in n) return;
    const attrs = n.cpath && carried.get(n.cpath);
    if (attrs) {
      const merge = (k, v, had) => (k === 'data-motion' && typeof had === 'string' ? [...new Set(`${had} ${v}`.split(/\s+/).filter(Boolean))].join(' ') : v);
      if (n.t === 'svg' && typeof n.raw === 'string') {
        // Inline SVG keeps its attributes in its own markup (emit/walk.js describeNode writes `raw` as it is).
        for (const [k, v] of Object.entries(attrs)) {
          const re = new RegExp(`^(<svg\\b[^>]*?)\\s${k}="([^"]*)"`);
          const had = re.exec(n.raw)?.[2];
          const value = String(merge(k, v, had)).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
          n.raw = had != null ? n.raw.replace(re, `$1 ${k}="${value}"`) : n.raw.replace(/^<svg\b/, `<svg ${k}="${value}"`);
        }
      } else {
        n.attrs ??= {};
        for (const [k, v] of Object.entries(attrs)) n.attrs[k] = merge(k, v, n.attrs[k]);
      }
      carried.delete(n.cpath);
      placed++;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(body);
  return { placed, lost: carried.size };
}

// A page whose script renders different markup at different widths (a phone version of a heading swapped in as the
// window narrows) has one as-is document per view. Where they agree they are one tree; where they differ, every
// version is kept in place and shown only in the width range of the views it came from (`data-sas-v`, hidden by a
// generated rule elsewhere) - the same thing such a site's own server-rendered markup does before its script runs.
const serial = (n) => JSON.stringify(n, (k, v) => (k === 'cpath' || k === 'sid' ? undefined : v));
const kindOf = (n) => ('text' in n ? '#text' : n.t);
const sameShallow = (a, b) => a.t === b.t && a.class === b.class && a.id === b.id && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

function markVariant(node, id) {
  if (node.t === 'svg' && typeof node.raw === 'string') return { ...node, raw: node.raw.replace(/^<svg\b/, `<svg data-sas-v="${id}"`) };
  return { ...node, attrs: { ...node.attrs, 'data-sas-v': id } };
}

/**
 * Merges the same position of every view's tree. `entries` = [[view, node]], widest view first.
 * @returns {object[]|null}  the nodes to put there, or null when a text differs (the parent then keeps versions)
 */
function mergeNodes(entries, mark) {
  const groups = new Map();
  for (const [view, node] of entries) {
    const key = serial(node);
    const g = groups.get(key) ?? { node, views: [] };
    g.views.push(view);
    groups.set(key, g);
  }
  if (groups.size === 1) return [entries[0][1]];
  const nodes = entries.map(([, n]) => n);
  if (nodes.some((n) => 'text' in n)) return null;
  if (nodes.every((n) => n.t !== 'svg' && sameShallow(n, nodes[0]))) {
    const kids = mergeChildren(entries.map(([v, n]) => [v, n.children ?? []]), mark);
    if (kids) return [{ ...nodes[0], children: kids }];
  }
  return [...groups.values()].map((g) => markVariant(g.node, mark(g.views)));
}

function mergeChildren(lists, mark) {
  const first = lists[0][1];
  const aligned = lists.every(([, c]) => c.length === first.length && c.every((n, i) => kindOf(n) === kindOf(first[i])));
  if (!aligned) return null;
  const out = [];
  for (let i = 0; i < first.length; i++) {
    const merged = mergeNodes(lists.map(([v, c]) => [v, c[i]]), mark);
    if (!merged) return null;
    out.push(...merged);
  }
  return out;
}

/**
 * One body from the bodies of every view (widest first). The <body> itself is never duplicated: when its children do not
 * line up, each view's children are all kept, marked, and only the widest view's loose text stays.
 * @returns {{ body: object, variants: Map<string, string[]> }}  variant id → the views it is shown at
 */
export function mergeViewBodies(bodies) {
  const variants = new Map();
  const byViews = new Map();
  const mark = (views) => {
    const key = views.join(',');
    if (!byViews.has(key)) {
      const id = `v${byViews.size + 1}`;
      byViews.set(key, id);
      variants.set(id, views);
    }
    return byViews.get(key);
  };
  if (bodies.length === 1) return { body: bodies[0][1], variants };
  const [, first] = bodies[0];
  const merged = mergeNodes(bodies, mark);
  if (merged?.length === 1 && !merged[0].attrs?.['data-sas-v']) return { body: merged[0], variants };
  // The body differs in itself or its children do not line up: keep the widest view's body, every view's children.
  const kids = mergeChildren(bodies.map(([v, b]) => [v, b.children ?? []]), mark);
  if (kids) return { body: { ...first, children: kids }, variants };
  const groups = new Map();
  for (const [view, b] of bodies) {
    const key = JSON.stringify((b.children ?? []).map(serial));
    const g = groups.get(key) ?? { children: b.children ?? [], views: [] };
    g.views.push(view);
    groups.set(key, g);
  }
  const children = [];
  [...groups.values()].forEach((g, i) => {
    const id = mark(g.views);
    for (const c of g.children) {
      if ('text' in c) {
        if (i === 0) children.push(c);
      } else children.push(markVariant(c, id));
    }
  });
  return { body: { ...first, children }, variants };
}

/**
 * The rule that shows each version only in the width range of its views. A view's range follows the breakpoints the
 * copy already uses (ir.breakpoints: the site's own where it declared them): above the next narrower view's, up to its own.
 */
export function variantCss(variants, views, breakpoints = {}) {
  if (!variants.size) return '';
  const range = (view) => {
    const i = views.indexOf(view);
    const upper = i > 0 ? breakpoints[view] : null;
    const lower = i < views.length - 1 ? breakpoints[views[i + 1]] : null;
    const parts = [lower != null && `(width > ${lower}px)`, upper != null && `(width <= ${upper}px)`].filter(Boolean);
    return parts.length ? parts.join(' and ') : null;
  };
  const rules = [];
  for (const view of views) {
    const hidden = [...variants].filter(([, at]) => !at.includes(view)).map(([id]) => `[data-sas-v="${id}"]`);
    if (!hidden.length) continue;
    const q = range(view);
    const rule = `${hidden.join(', ')} { display: none !important; }`;
    rules.push(q ? `@media ${q} {\n  ${rule}\n}` : rule);
  }
  return `/* Versions of the page the site renders at some widths only */\n${rules.join('\n')}`;
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
  const report = { pages: 0, rebuilt: [], sheets: 0, imports: 0, missingSheets: 0, cssUrls: 0, missingCssUrls: 0, elements: 0, dropped: 0, shadowRoots: 0, missing: { images: 0, media: 0, styleUrls: 0 }, links: { internal: 0, notice: 0, file: 0, external: 0, anchor: 0 }, safety: { handlers: 0, scriptUrls: 0, other: 0 }, excluded: 0, unpinned: 0, variants: { pages: 0, versions: 0 }, motion: { carried: 0, extras: 0, notCarried: { states: 0, hoverCards: 0, notices: 0, panels: 0, unmapped: 0 } } };
  const infoByOut = new Map(site.pages.map((t) => [t.info.outPath, t.info]));
  for (const page of ir.pages) {
    const info = infoByOut.get(page.outPath);
    const asis = info && (await readAsis(dir, info));
    if (!asis?.html) {
      report.rebuilt.push(page.outPath);
      continue;
    }
    const exclude = new Set(excluded.filter((e) => e.page === info.path).map((e) => e.path));
    const { body: desktopBody, htmlClass, stats } = asisBody(asis, { pageUrl: info.url, assetResolve: site.assetResolve, resolveLink: site.resolveLink, exclude });
    const css = pageSheets(asis, site.assetResolve);
    // The other views' documents, widest first: where the site's script rendered different markup there, it is kept.
    const views = (page.views?.length ? [...page.views] : ['desktop']).sort((a, b) => (VIEW_WIDTHS[b] ?? 0) - (VIEW_WIDTHS[a] ?? 0));
    const bodies = [['desktop', desktopBody]];
    for (const view of views) {
      if (view === 'desktop') continue;
      const other = await readAsis(dir, info, view);
      if (!other?.html) continue;
      bodies.push([view, asisBody(other, { pageUrl: info.url, assetResolve: site.assetResolve, resolveLink: site.resolveLink, exclude }).body]);
      // Sheets only that view had (a script that writes rules for the version it renders) come after the widest view's.
      const known = new Set(css.sheets);
      for (const text of pageSheets(other, site.assetResolve).sheets) {
        if (!known.has(text)) {
          css.sheets.push(text);
          known.add(text);
        }
      }
    }
    const merged = mergeViewBodies(bodies);
    const body = merged.body;
    if (merged.variants.size) {
      css.sheets.push(variantCss(merged.variants, bodies.map(([v]) => v), ir.breakpoints ?? {}));
      report.variants.pages++;
      report.variants.versions += merged.variants.size;
    }
    const tree = site.pages.find((t) => t.info.outPath === page.outPath);
    const cpathOf = new Map();
    const index = (n) => {
      if (!n || !n.children) return;
      if (n.sid != null && (n.cpath || n.path)) cpathOf.set(n.sid, n.cpath ?? n.path);
      n.children.forEach(index);
    };
    index(tree?.root);
    // The parts the copy adds as elements of their own, from the original markup of that state.
    const fragmentOf = (x) => asisBody({ html: x.asisHtml, baseURI: asis.baseURI }, { pageUrl: info.url, assetResolve: site.assetResolve, resolveLink: site.resolveLink, fragment: 'copy' }).body;
    const extras = asisExtras(page.body, cpathOf, fragmentOf, report.motion.notCarried);
    const carried = carriedAttrs(page.body, cpathOf, report.motion.notCarried, extras.built);
    const { placed, lost } = carryInto(body, carried);
    report.motion.carried += placed;
    report.motion.extras += placeExtras(body, extras.placements);
    report.motion.notCarried.unmapped += lost;
    report.unpinned += stats.unpinned;
    // Element ids for measuring (data-sas-id in a measurement build only), each with the capture path it stands for, so
    // the exact comparison pairs a box of the copy with the very element of the original it is.
    const cpaths = {};
    let sid = 0;
    const number = (n) => {
      if (!n || 'text' in n) return;
      n.sid = ++sid;
      if (n.cpath) cpaths[n.sid] = n.cpath;
      for (const c of n.children ?? []) number(c);
    };
    number(body);
    (site.asisCpaths ??= {})[page.outPath] = cpaths;
    page.body = body;
    page.html = { ...page.html, class: htmlClass };
    // The font preload a rebuilt page gets (fixers) names a file the site's own sheets may not ask for at all.
    if (page.head) page.head = { ...page.head, preload: [] };
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
