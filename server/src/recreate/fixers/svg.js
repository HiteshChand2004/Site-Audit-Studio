// SVG sanitizer for the recreated site: downloaded SVG files (assets/) and inline SVG in the IR.
//
// The markup is parsed (htmlparser2 in XML mode) and written out again from an allowlist, so what
// the browser parses is always well-formed and escaped by us:
// - only drawing, text, paint-server, filter and animation elements are kept; <script>,
//   <foreignObject>, <iframe>, <metadata>, editor namespaces and anything unknown are dropped with
//   their content;
// - on* event attributes, xml:base and editor-namespaced attributes are dropped;
// - javascript:/vbscript: values are dropped wherever they appear;
// - references (href, xlink:href, url(...) in attributes, style="" and <style>) may only point to a
//   fragment (#id), a local asset (inline SVG: "asset:<file>") or an embedded raster image
//   (data:image/png|jpeg|gif|webp|avif). Everything else is an external reference and is dropped;
// - animations that target href or event attributes are dropped (<set attributeName="href" ...>);
// - @import is removed from <style>;
// - comments, processing instructions and DOCTYPE (entity declarations) are dropped.
import { load } from 'cheerio';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'switch', 'view', 'a',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'image',
  'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'stop', 'style',
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting',
  'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset', 'fepointlight',
  'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath',
]);
const ANIMATIONS = new Set(['animate', 'animatemotion', 'animatetransform', 'set']);
const HREF = new Set(['href', 'xlink:href']);
const ATTR_NAME = /^[a-zA-Z_][\w:.-]*$/;
const KEPT_PREFIX = /^(xlink|xml|xmlns):/i;
const SCRIPT_URL = /(java|vb|live)script:/i;
const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i;
// Links inside an SVG (<a href>) navigate like HTML links; these targets are fine.
const SAFE_LINK = /^(https?:|mailto:|tel:|#|\/|\.|[\w-]+(\/|\.|$))/i;

const compact = (v) => String(v).replace(/[\u0000- \u007f-\u009f]+/g, '');

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A reference an SVG may keep: a fragment, a local asset (inline only) or an embedded raster image. */
function localRef(value, inline) {
  const v = compact(value);
  return v.startsWith('#') || (inline && /^asset:[\w./-]+(#[\w.:-]*)?$/.test(v)) || RASTER_DATA.test(v);
}

/**
 * CSS inside an SVG (<style> text or a style attribute): @import removed, url() that is not local
 * becomes none, script URLs and legacy script hooks removed. Returns the CSS and what was dropped.
 */
export function sanitizeSvgCss(css, { inline = false } = {}) {
  let external = 0;
  let scripts = 0;
  let out = String(css)
    .replace(/@import\b[^;]*;?/gi, () => (external++, ''))
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, q, url) => {
      if (localRef(url, inline)) return all;
      if (SCRIPT_URL.test(compact(url))) scripts++;
      else external++;
      return 'none';
    });
  out = out.replace(/(expression\s*\(|-moz-binding|(?<![\w-])behavior\s*:)/gi, () => (scripts++, '/**/'));
  if (SCRIPT_URL.test(compact(out))) {
    scripts++;
    out = out.replace(/(java|vb|live)\s*script\s*:/gi, '');
  }
  return { css: out, external, scripts };
}

function newStats() {
  return { scripts: 0, handlers: 0, scriptUrls: 0, external: 0, elements: 0 };
}

function cleanAttrs(tag, attribs, inline, stats) {
  const out = [];
  for (const [name, value] of Object.entries(attribs ?? {})) {
    const lname = name.toLowerCase();
    if (/^on/i.test(lname)) {
      stats.handlers++;
      continue;
    }
    if (!ATTR_NAME.test(name) || lname === 'xml:base' || (lname.includes(':') && !KEPT_PREFIX.test(lname))) continue;
    if (SCRIPT_URL.test(compact(value))) {
      stats.scriptUrls++;
      continue;
    }
    if (HREF.has(lname) || lname === 'src') {
      const ok = tag === 'a' ? SAFE_LINK.test(compact(value)) || localRef(value, inline) : localRef(value, inline);
      if (!ok) {
        stats.external++;
        continue;
      }
    }
    let v = value;
    if (lname === 'style' || /url\(/i.test(v)) {
      const r = sanitizeSvgCss(v, { inline });
      stats.external += r.external;
      stats.scriptUrls += r.scripts;
      if (lname !== 'style' && (r.external || r.scripts)) continue; // fill="url(https://…)" → default paint
      v = r.css;
    }
    out.push([name, v]);
  }
  return out;
}

function serialize(node, inline, stats) {
  if (node.type === 'text') return escText(node.data);
  if (node.type === 'cdata') return (node.children ?? []).map((c) => escText(c.data ?? '')).join('');
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return ''; // comments, directives
  const tag = node.name.toLowerCase();
  if (tag === 'script') {
    stats.scripts++;
    return '';
  }
  if (!ELEMENTS.has(tag)) {
    stats.elements++;
    return '';
  }
  if (ANIMATIONS.has(tag)) {
    const target = compact(Object.entries(node.attribs ?? {}).find(([k]) => k.toLowerCase() === 'attributename')?.[1] ?? '').toLowerCase();
    if (HREF.has(target) || target.startsWith('on') || target === 'style') {
      stats.elements++;
      return '';
    }
  }
  const attrs = cleanAttrs(tag, node.attribs, inline, stats);
  let inner;
  if (tag === 'style') {
    const text = (node.children ?? []).map((c) => (c.type === 'cdata' ? (c.children ?? []).map((x) => x.data).join('') : c.data ?? '')).join('');
    const r = sanitizeSvgCss(text, { inline });
    stats.external += r.external;
    stats.scriptUrls += r.scripts;
    inner = escText(r.css);
  } else {
    inner = (node.children ?? []).map((c) => serialize(c, inline, stats)).join('');
  }
  const open = `<${node.name}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}`;
  return inner ? `${open}>${inner}</${node.name}>` : `${open}/>`;
}

/**
 * @param {string} markup   an SVG document (file) or an <svg> element (inline, from the capture)
 * @param {{ inline?: boolean }} [opts]  inline: the SVG sits in an HTML page and may reference
 *   local assets as "asset:<file>" (the emitter turns them into relative paths)
 * @returns {{ svg: string|null, removed: object, changed: boolean }}  svg is null when the input has no <svg> root
 */
export function sanitizeSvg(markup, { inline = false } = {}) {
  const stats = newStats();
  // Inline SVG comes from outerHTML, which writes a non-breaking space as the HTML entity.
  const source = String(markup ?? '').replace(/&nbsp;/g, '&#160;');
  const $ = load(source, { xml: { xmlMode: true, decodeEntities: true } });
  const root = $.root()[0].children.find((n) => n.type === 'tag' && n.name.toLowerCase() === 'svg');
  if (!root) return { svg: null, removed: stats, changed: true };
  let svg = serialize(root, inline, stats);
  if (!inline) {
    // A standalone file needs its namespaces to render as SVG.
    if (!/^<svg\b[^>]*\sxmlns="/.test(svg)) svg = svg.replace(/^<svg\b/, `<svg xmlns="${SVG_NS}"`);
    if (/\sxlink:[\w-]+="/.test(svg) && !/^<svg\b[^>]*\sxmlns:xlink="/.test(svg)) svg = svg.replace(/^<svg\b/, `<svg xmlns:xlink="${XLINK_NS}"`);
  }
  const changed = Object.values(stats).some((n) => n > 0);
  return { svg, removed: stats, changed };
}

/** Adds the counts of one sanitizer run to a running total. */
export function addRemoved(total, removed) {
  for (const [k, n] of Object.entries(removed)) total[k] = (total[k] ?? 0) + n;
  return total;
}

export const emptyRemoved = newStats;
