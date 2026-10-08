// The stack-neutral half of every emitter. The IR holds references ({asset}, {page,hash}, {anchor},
// {live}, {external}) and structured head fields; this module resolves them and describes nodes and
// head tags as plain data, so an emitter only decides how to write them (HTML text, JSX, metadata).
//
// An emitter supplies the references' targets through `refs`:
//   refs.assetHref(file)        URL of assets/<file> from the page being written
//   refs.pageHref(outPath)      URL of another recreated page (folders keep their "/about/" form)
//   refs.fileHref(path)         URL of a generated static file of the site (a notice page); default: root-relative
//   refs.stylesheetHref()       URL of the shared stylesheet, or null when the stack imports it
//   refs.useAsset(file)         called for every asset the page uses (the writer copies those)
import { relFile, relPage } from '../ir/links.js';
import { MOUNT_IDS } from '../ir/names.js';
import { CSS_FILE } from './css.js';

/** References of a plain relative-path site (the HTML emitter, and any emitter that writes files). */
export function relativeRefs(outPath, useAsset = () => true) {
  return {
    outPath,
    useAsset,
    assetHref: (file) => relFile(outPath, `assets/${file}`),
    pageHref: (target) => relPage(outPath, target),
    fileHref: (target) => relPage(outPath, target),
    stylesheetHref: () => relFile(outPath, CSS_FILE),
  };
}

/** Root-relative URL of a static file of the site: "login/index.html" → "/login/" (the app stacks serve from the root). */
export const rootFileHref = (file) => (file === 'index.html' ? '/' : file.endsWith('/index.html') ? `/${file.slice(0, -'index.html'.length)}` : `/${file}`);

/** One IR attribute value → its string; asset references are reported through refs.useAsset. */
export function refValue(value, refs) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((c) => `${(refs.useAsset(c.asset), refs.assetHref(c.asset))}${c.d ? ` ${c.d}` : ''}`).join(', ');
  }
  if (value.asset) return refs.useAsset(value.asset) && refs.assetHref(value.asset);
  if (value.page) return refs.pageHref(value.page) + (value.hash ?? '');
  if (value.file) return (refs.fileHref ?? rootFileHref)(value.file) + (value.hash ?? '');
  if (value.anchor) return value.anchor;
  if (value.live) return value.live;
  if (value.external) return value.external;
  return '';
}

// A value-less attribute is a boolean attribute, except these, which are meaningful when empty.
const EMPTY_OK = new Set(['alt', 'value']);

/**
 * One IR node as data:
 *   { kind: 'text', text }
 *   { kind: 'svg', markup (asset references resolved), class, sid }
 *   { kind: 'element', tag, id, class, attrs: [{ name, value, bare }], sid, children, block }
 * `class` is the generated class string; `sid` is the measurement id (the fit pass only); `bare` marks
 * a boolean attribute; `children` are IR nodes, described by the caller as it walks them.
 */
export function describeNode(node, refs) {
  if ('text' in node) return { kind: 'text', text: node.text };
  if (node.t === 'svg') {
    const markup = node.raw.replace(/asset:([^"#]+)/g, (all, file) => (refs.useAsset(file), refs.assetHref(file)));
    return { kind: 'svg', markup, class: node.class, sid: node.sid };
  }
  const attrs = [];
  for (const [name, v] of Object.entries(node.attrs ?? {})) {
    const value = refValue(v, refs);
    attrs.push({ name, value, bare: value === '' && !EMPTY_OK.has(name) });
  }
  // A framework's mount id saved in an older IR (ir/names.js MOUNT_IDS) is not written either.
  return { kind: 'element', tag: node.t, id: MOUNT_IDS.has(node.id) ? undefined : node.id, class: node.class, attrs, sid: node.sid, children: node.children ?? [], block: Boolean(node.b) };
}

/**
 * The head of a page as ordered tag descriptors: { tag, attrs: [[name, value | null]], text?, jsonLd?, role? }.
 * `role: 'stylesheet'` marks the shared stylesheet link (omitted when refs.stylesheetHref() is null);
 * `jsonLd` tags carry the raw JSON for the emitter to serialise safely (see safeJsonLd).
 */
export function headTags(page, refs) {
  const h = page.head;
  const tags = [
    { tag: 'meta', attrs: [['charset', 'utf-8']] },
    { tag: 'meta', attrs: [['name', 'viewport'], ['content', 'width=device-width, initial-scale=1']] },
  ];
  if (h.title) tags.push({ tag: 'title', attrs: [], text: h.title });
  if (h.description) tags.push({ tag: 'meta', attrs: [['name', 'description'], ['content', h.description]] });
  tags.push({ tag: 'link', attrs: [['rel', 'canonical'], ['href', h.canonical]] });
  for (const m of h.meta) tags.push({ tag: 'meta', attrs: [m.property ? ['property', m.property] : ['name', m.name], ['content', m.content]] });
  for (const a of h.alternates) {
    if (/^https?:\/\//i.test(a.href)) tags.push({ tag: 'link', attrs: [['rel', 'alternate'], ['hreflang', a.hreflang], ['href', a.href]] });
  }
  for (const i of h.icons) {
    refs.useAsset(i.asset);
    const attrs = [['rel', i.rel], ['href', refs.assetHref(i.asset)]];
    if (i.sizes) attrs.push(['sizes', i.sizes]);
    if (i.type) attrs.push(['type', i.type]);
    tags.push({ tag: 'link', attrs });
  }
  for (const p of h.preload ?? []) {
    refs.useAsset(p.asset);
    const attrs = [['rel', 'preload'], ['href', refs.assetHref(p.asset)], ['as', p.as]];
    if (p.type) attrs.push(['type', p.type]);
    if (p.as === 'font') attrs.push(['crossorigin', null]); // null: a bare attribute
    tags.push({ tag: 'link', attrs });
  }
  const sheet = refs.stylesheetHref();
  if (sheet) tags.push({ tag: 'link', attrs: [['rel', 'stylesheet'], ['href', sheet]], role: 'stylesheet' });
  for (const json of h.jsonLd) tags.push({ tag: 'script', attrs: [['type', 'application/ld+json']], jsonLd: json });
  return tags;
}

/**
 * Structured data as compact JSON that cannot end the script element early: parsed and written
 * again, with <, > and & as \u escapes. Invalid JSON-LD is left out (null).
 */
const JSON_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' };
export function safeJsonLd(json) {
  try {
    return JSON.stringify(JSON.parse(json)).replace(/[<>&]/g, (c) => JSON_ESCAPES[c]);
  } catch {
    return null;
  }
}
