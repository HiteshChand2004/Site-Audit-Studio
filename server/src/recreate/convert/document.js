// The as-is copy's finished pages (HTML the original's own stylesheets and scripts draw, identical to the original) converted
// into components, mechanically. One component per section of a page (the children of the body, or of the one wrapper the
// body holds), class → className, inline styles → style objects, inline SVG kept as its own element, the original's
// stylesheets and scripts kept as they are (a script tag is written with its text; the page is prerendered and never
// hydrated, so the original's scripts run as in any HTML page). The rules an attribute follows are emit/react/jsx.js's.
//
// Exactness first: the DOM React renders from the components must be the DOM the browser builds from the as-is page. Where
// React cannot write an element exactly - an inline event handler (onclick="…"), an attribute name JSX cannot carry, a value
// React drops (hidden="until-found", a javascript: address), an element React 19 moves to the head (a <meta> or <title> in the
// body, an async script) - that element is kept as the original HTML inside its component (a <RawHtml html="…"/> that the
// build unwraps) and the fallback is recorded: page, where, tag, attribute, reason. Nothing is dropped quietly.
//
// Stack-neutral: this file produces JSX text and facts; convert/next.js (and the other stacks after it) write the project.
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { BOOLEAN, declarations, jsxAttr, jsxText, propName, styleObject, svgPropName } from '../emit/react/jsx.js';
import { pascal } from '../emit/react/components.js';

/** The component that carries an element React cannot write exactly (the build unwraps the template). */
export const RAW_COMPONENT = 'RawHtml';
export const RAW_COMPONENT_SOURCE = `// An element the conversion kept as the original HTML (see KNOWN-ISSUES.md / the report for the list and the reasons).
// The markup travels base64-encoded in an inert <template>, which the after-build step unwraps (decoding it), so the
// page's DOM is the original's and no escaping rule of React can change a byte of it.
export default function ${RAW_COMPONENT}({ b64 }) {
  return <template data-sas-raw={b64} />;
}
`;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose content is text React must not escape or children it must not render: written as raw inner HTML. */
const RAW_INNER = new Set(['script', 'style', 'noscript', 'template', 'xmp', 'plaintext', 'listing', 'iframe']);
/** Elements React 19 moves into the head when they stand in the body (hoistables): kept where the original has them. */
const HOISTED_IN_BODY = new Set(['meta', 'title', 'link', 'base']);
/** Prop names React reserves: an attribute of that name cannot be written as it is. */
const RESERVED = new Set(['key', 'ref', 'children', 'dangerouslysetinnerhtml', 'suppresshydrationwarning', 'suppresscontenteditablewarning', 'defaultvalue', 'defaultchecked', 'classname', 'htmlfor', 'is']);
/** An attribute name JSX can carry as it is (a namespaced name is kept only inside SVG, which svgPropName handles). */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** Attributes React refuses a javascript: address in. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data']);
/** Wrappers the section split looks through: the body holding one of these holds the page inside it. */
const MAX_WRAPPER_DEPTH = 3;
const LANDMARK_NAMES = { header: 'SiteHeader', nav: 'SiteNav', main: 'MainContent', footer: 'SiteFooter', aside: 'Sidebar', form: 'Form' };

const isElement = (n) => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const isCustomElement = (tag) => tag.includes('-');
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Where an element stands, for a person: "body > main > div.hero > button" (ids and the first class only). */
export function whereOf(el) {
  const parts = [];
  for (let n = el; n && isElement(n) && n.name !== 'html'; n = n.parent) {
    const id = n.attribs?.id ? `#${n.attribs.id}` : '';
    const cls = !id && n.attribs?.class ? `.${n.attribs.class.trim().split(/\s+/)[0]}` : '';
    parts.unshift(`${n.name}${id}${cls}`);
  }
  return parts.join(' > ');
}

/**
 * The JSX props of an element, or why it cannot be written exactly.
 * @returns {{ props: string[], note?: string } | { fail: string, attribute?: string }}
 */
export function planAttributes(tag, attribs, { inHead = false } = {}) {
  const custom = isCustomElement(tag);
  const svgLike = tag === 'svg' || tag === 'math';
  const props = [];
  const formControl = tag === 'input' || tag === 'textarea' || tag === 'select';
  for (const [rawName, rawValue] of Object.entries(attribs)) {
    const name = rawName;
    const lower = name.toLowerCase();
    const value = rawValue ?? '';
    if (/^on[a-z]/.test(lower)) return { fail: 'an inline event handler, which React cannot write as text', attribute: name };
    if (RESERVED.has(lower) && !custom) return { fail: 'an attribute name React reserves for itself', attribute: name };
    if (URL_ATTRS.has(lower) && /^\s*javascript:/i.test(value)) return { fail: 'a javascript: address, which React blocks', attribute: name };
    if (svgLike) {
      // An SVG attribute: React's camelCase name (viewBox stays; stroke-width → strokeWidth; xlink:href → xlinkHref).
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) return { fail: 'an attribute name React cannot write', attribute: name };
      props.push(jsxAttr(tag === 'svg' ? svgPropName(name) : name, value));
      continue;
    }
    if (!VALID_NAME.test(name)) return { fail: 'an attribute name React cannot write', attribute: name };
    if (lower === 'style') {
      const decls = declarations(value).filter((d) => d.trim());
      const obj = styleObject(value);
      if (decls.some((d) => !d.includes(':')) || Object.keys(obj).length !== decls.length) {
        return { fail: 'an inline style React cannot write exactly (a repeated or malformed declaration)', attribute: name };
      }
      props.push(jsxAttr('style', obj));
      continue;
    }
    if (custom) {
      // React writes a custom element's props as the attributes they are named: the HTML names stay.
      props.push(jsxAttr(lower, value));
      continue;
    }
    if (BOOLEAN.has(lower)) {
      if (value === '' || value.toLowerCase() === lower) {
        if (lower === 'checked' && tag === 'input') props.push('defaultChecked');
        else if (lower === 'selected' && tag === 'option') continue; // the select's defaultValue says which option is chosen
        else props.push(propName(lower));
        continue;
      }
      return { fail: `a value React would drop (${name}="${value}")`, attribute: name };
    }
    if (lower === 'value' && formControl) {
      if (tag !== 'textarea') props.push(jsxAttr('defaultValue', value)); // a textarea's text is its value (see elementJsx)
      continue;
    }
    if (lower === 'class') props.push(jsxAttr('className', value));
    else if (lower === 'for') props.push(jsxAttr('htmlFor', value));
    else props.push(jsxAttr(propName(lower), value));
  }
  return { props };
}

/** The chosen options of a select, as React's defaultValue (a list when the select takes several). */
function selectDefault(el) {
  const chosen = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (!isElement(c)) continue;
      if (c.name === 'option' && 'selected' in c.attribs) chosen.push(c.attribs.value ?? textOf(c));
      else if (c.name === 'optgroup') walk(c);
    }
  };
  walk(el);
  if (!chosen.length) return null;
  return 'multiple' in el.attribs ? chosen : chosen[0];
}

const textOf = (el) => (el.children ?? []).map((c) => (c.type === 'text' ? c.data : isElement(c) ? textOf(c) : '')).join('');

/**
 * A conversion of one document.
 * @typedef {{ page: string, where: string, tag: string, attribute?: string, reason: string }} Fallback
 */
class Conversion {
  constructor($, { page, componentOf = new Map() }) {
    this.$ = $;
    this.page = page;
    this.componentOf = componentOf; // element → component name (a section rendered as <Name />)
    this.fallbacks = [];
    this.elements = 0;
    this.raw = 0;
    this.usesRaw = false;
  }

  /** The original HTML of an element, kept as it is (RawHtml). */
  rawOf(el, reason, attribute) {
    this.fallbacks.push({ page: this.page, where: whereOf(el), tag: el.name, ...(attribute && { attribute }), reason });
    this.raw += 1;
    this.usesRaw = true;
    return `<${RAW_COMPONENT} b64=${JSON.stringify(Buffer.from(this.$.html(el), 'utf8').toString('base64'))} />`;
  }

  /** The JSX of a list of nodes (adjacent texts merged, comments left out: they draw nothing and React cannot write them). */
  childrenJsx(nodes, { inHead = false } = {}) {
    const out = [];
    let text = '';
    const flush = () => { if (text) out.push(jsxText(text)); text = ''; };
    for (const n of nodes) {
      // Whitespace between the head's elements draws nothing; left out, so no two text nodes stand side by side there (the
      // document's Head would separate them with comment markers).
      if (n.type === 'text') text += inHead && !n.data.trim() ? '' : n.data;
      else if (isElement(n)) { flush(); out.push(this.elementJsx(n, { inHead })); }
      // comments, directives and cdata: nothing to draw
    }
    flush();
    return out;
  }

  /** One element as JSX, or its component, or its raw fallback. */
  elementJsx(el, { inHead = false } = {}) {
    const component = this.componentOf.get(el);
    if (component) return `<${component} />`;
    this.elements += 1;
    const tag = el.name;
    if (!inHead && HOISTED_IN_BODY.has(tag)) return this.rawOf(el, 'an element React 19 moves into the head when it stands in the body');
    if (tag === 'script' && !inHead && 'async' in el.attribs && 'src' in el.attribs) return this.rawOf(el, 'an async script, which React 19 moves to the head');
    if (!/^[a-z][a-z0-9-]*$/.test(tag) && tag !== 'svg' && tag !== 'math') return this.rawOf(el, 'an element name JSX cannot carry');
    const plan = planAttributes(tag, el.attribs, { inHead });
    if (plan.fail) return this.rawOf(el, plan.fail, plan.attribute);
    const props = [...plan.props];
    if (tag === 'select') {
      const chosen = selectDefault(el);
      if (chosen !== null) props.push(jsxAttr('defaultValue', chosen));
    }
    const open = `${tag}${props.length ? ` ${props.join(' ')}` : ''}`;
    if (VOID.has(tag)) return `<${open} />`;
    if (tag === 'textarea') {
      const value = textOf(el);
      return `<${open}${value ? ` defaultValue={${JSON.stringify(value)}}` : ''} />`;
    }
    if (tag === 'svg' || tag === 'math' || RAW_INNER.has(tag)) {
      const inner = this.$(el).html() ?? '';
      return inner ? `<${open} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(inner)} }} />` : `<${open} />`;
    }
    const kids = this.childrenJsx(el.children ?? [], { inHead });
    if (!kids.length) return `<${open} />`;
    return `<${open}>${kids.join('')}</${tag}>`;
  }
}

/** The attributes of <html> or <body>: props (an object to spread), and the ones React cannot write (set by the after-build step instead). */
export function rootAttributes(attribs) {
  const props = {};
  const raw = {};
  for (const [name, value] of Object.entries(attribs ?? {})) {
    const lower = name.toLowerCase();
    if (/^on[a-z]/.test(lower) || !VALID_NAME.test(name) || RESERVED.has(lower) || (BOOLEAN.has(lower) && value !== '' && value.toLowerCase() !== lower)) {
      raw[name] = value ?? '';
      continue;
    }
    if (lower === 'class') props.className = value;
    else if (BOOLEAN.has(lower)) props[propName(lower)] = true;
    else props[propName(lower)] = value ?? '';
  }
  return { props, raw };
}

/** The elements of a node, skipping text and comments. */
const elementChildren = (n) => (n.children ?? []).filter(isElement);

/** The element whose children are the page's sections: the body, or the one wrapper the body holds (up to a few deep). */
export function sectionHost(body) {
  let host = body;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
    const els = elementChildren(host).filter((e) => !RAW_INNER.has(e.name) && e.name !== 'svg');
    if (els.length === 1 && elementChildren(els[0]).length >= 1) host = els[0];
    else break;
  }
  return host;
}

/** A component name for a section: its landmark, else its id, else its first class, else its tag; PascalCase. */
export function sectionName(el, index) {
  const tag = el.name;
  if (LANDMARK_NAMES[tag]) return LANDMARK_NAMES[tag];
  const id = el.attribs?.id?.trim();
  if (id && /[a-z]/i.test(id)) return pascal(id);
  const cls = (el.attribs?.class ?? '').trim().split(/\s+/).find((c) => /^[a-z][a-z0-9_-]{2,}$/i.test(c) && !/^(w-|is-|has-|js-|u-|col|row|grid|flex|container|wrapper|section)$/i.test(c));
  if (cls) return pascal(cls);
  return `${pascal(tag)}${index + 1}`;
}

/**
 * The forms of a page, in facts a person can read: where the original sent each one, its fields, and whether the copy's own
 * form guard holds it (then nothing is sent to the original and the form waits for FORM_ENDPOINT).
 */
export function formsOf($, { page, pageUrl }) {
  const guarded = /sasFormGuard/.test($.html());
  let host = null;
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* no address */ }
  const forms = [];
  $('form').each((i, el) => {
    const action = (el.attribs.action ?? '').trim();
    let target = 'the same page';
    let targetHost = null;
    try {
      const u = new URL(action || '.', pageUrl || 'http://copy.invalid/');
      targetHost = u.hostname.replace(/^www\./, '');
      if (!action) target = 'the same page';
      else if (/^(mailto|tel):/i.test(action)) target = `the visitor's own mail or phone app (${action.split(':')[0]}:)`;
      else if (host && targetHost === host) target = `the original site (${targetHost}${u.pathname})`;
      else if (/^\//.test(action) || action.startsWith('.')) target = `the original site (${action})`;
      else target = `another service (${targetHost})`;
    } catch { target = `an address the copy cannot read (${action.slice(0, 60)})`; }
    const fields = [];
    let password = false;
    let file = false;
    $(el).find('input, select, textarea').each((_, f) => {
      const type = (f.attribs.type ?? '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return;
      if (type === 'password') password = true;
      if (type === 'file') file = true;
      const name = f.attribs.name || f.attribs.id || f.attribs['aria-label'] || f.attribs.placeholder || type || f.name;
      if (name && !fields.includes(name)) fields.push(name);
    });
    const label = el.attribs.id || el.attribs.name || el.attribs['aria-label'] || `form ${i + 1}`;
    forms.push({
      page, label, method: (el.attribs.method || 'get').toUpperCase(), action, target, fields, password, file, guarded,
      worksWithoutOriginal: guarded,
      note: guarded
        ? 'In the copy nothing is sent to the original: the copy\'s form guard answers every submit. Until FORM_ENDPOINT is set in sas-forms.json, a visitor sees "This form is not connected yet". Once connected, it does not depend on the original site or its platform, so it keeps working if they are shut down.'
        : `The copy sends this form where the original did (${target}). If the original site or its platform is shut down, the form stops working until it is connected elsewhere.`,
    });
  });
  return forms;
}

/**
 * Converts one as-is page.
 * @param {string} html
 * @param {object} o
 * @param {string} o.page            the page's path in the copy ("/", "/about/")
 * @param {string} [o.pageUrl]       the original's address of the page (forms)
 * @param {Record<string, string>} [o.linkMap]  same-site paths that move ("/about.html" → "/about/"): links are rewritten first
 * @param {(el: object, outer: string) => string | null} [o.sharedName]  a name for a section that is shared with other pages
 * @returns {{ page: string, lang: string|null, html: { props: string[], raw: object }, body: { props: string[], raw: object },
 *   headJsx: string, headUsesRaw: boolean, sections: { name: string, jsx: string, outer: string, hash: string, shared: boolean }[],
 *   pageJsx: string, pageUsesRaw: boolean, fallbacks: Fallback[], forms: object[], stats: { elements: number, raw: number } }}
 */
export function convertDocument(html, { page, pageUrl = null, linkMap = null, sharedName = null } = {}) {
  const $ = cheerio.load(html);
  if (linkMap && Object.keys(linkMap).length) rewriteLinks($, linkMap);
  const htmlEl = $('html').get(0);
  const headEl = $('head').get(0);
  const bodyEl = $('body').get(0);
  const forms = formsOf($, { page, pageUrl });

  // The head: every element as JSX (an element React cannot write exactly is a raw fallback, like in the body).
  const head = new Conversion($, { page });
  const headJsx = head.childrenJsx(headEl?.children ?? [], { inHead: true }).join('');

  // The sections: the children of the host, each its own component; the page component holds what is around them.
  const host = sectionHost(bodyEl);
  const componentOf = new Map();
  const taken = new Set([RAW_COMPONENT]);
  const sections = [];
  elementChildren(host).forEach((el, i) => {
    if (RAW_INNER.has(el.name) || el.name === 'svg') return; // a script or a style between sections stays in the page
    const outer = $.html(el);
    const hash = sha(outer);
    let name = sharedName?.(el, outer, hash) ?? null;
    const shared = Boolean(name);
    if (!name) {
      name = sectionName(el, i);
      for (let n = 2; taken.has(name); n++) name = `${sectionName(el, i)}${n}`;
    }
    taken.add(name);
    componentOf.set(el, name);
    sections.push({ name, el, outer, hash, shared });
  });
  for (const s of sections) {
    const c = new Conversion($, { page });
    s.jsx = c.elementJsx(s.el);
    s.fallbacks = c.fallbacks;
    s.elements = c.elements;
    s.usesRaw = c.usesRaw;
    delete s.el;
  }
  const body = new Conversion($, { page, componentOf });
  const pageJsx = body.childrenJsx(bodyEl?.children ?? []).join('');
  const fallbacks = [...head.fallbacks, ...sections.flatMap((s) => s.fallbacks), ...body.fallbacks];
  const elements = head.elements + body.elements + sections.reduce((n, s) => n + s.elements, 0);
  return {
    page,
    lang: htmlEl?.attribs?.lang ?? null,
    html: rootAttributes(htmlEl?.attribs),
    body: rootAttributes(bodyEl?.attribs),
    headJsx,
    headUsesRaw: head.usesRaw,
    sections,
    pageJsx,
    pageUsesRaw: body.usesRaw,
    fallbacks,
    forms,
    stats: { elements, raw: fallbacks.length },
  };
}

/** Rewrites same-site links whose page moved ("/about.html" → "/about/"), the query and the fragment kept. */
export function rewriteLinks($, linkMap) {
  const attrs = ['href', 'action', 'formaction'];
  $('[href], [action], [formaction]').each((_, el) => {
    for (const a of attrs) {
      const v = el.attribs[a];
      if (v == null) continue;
      const m = /^([^?#]*)([?#].*)?$/.exec(v);
      const to = linkMap[m[1]];
      if (to) el.attribs[a] = `${to}${m[2] ?? ''}`;
    }
  });
}

/**
 * Converts the pages of a copy together: a section identical on two or more pages becomes one shared component.
 * @param {{ page: string, html: string, pageUrl?: string }[]} pages
 * @param {{ linkMap?: Record<string, string> }} [o]
 * @returns {{ pages: ReturnType<typeof convertDocument>[], shared: { name: string, jsx: string, pages: string[] }[],
 *   fallbacks: Fallback[], forms: object[], stats: { pages: number, components: number, shared: number, elements: number, raw: number } }}
 */
export function convertSite(pages, { linkMap = null } = {}) {
  // First pass: which section markup appears on more than one page (by its serialized HTML).
  const seen = new Map();
  for (const p of pages) {
    const $ = cheerio.load(p.html);
    if (linkMap && Object.keys(linkMap).length) rewriteLinks($, linkMap);
    const host = sectionHost($('body').get(0));
    elementChildren(host).forEach((el, i) => {
      if (RAW_INNER.has(el.name) || el.name === 'svg') return;
      const hash = sha($.html(el));
      const entry = seen.get(hash) ?? { count: 0, name: sectionName(el, i) };
      entry.count += 1;
      seen.set(hash, entry);
    });
  }
  const sharedNames = new Map();
  const takenShared = new Set([RAW_COMPONENT]);
  for (const [hash, e] of seen) {
    if (e.count < 2) continue;
    let name = e.name;
    for (let n = 2; takenShared.has(name); n++) name = `${e.name}${n}`;
    takenShared.add(name);
    sharedNames.set(hash, name);
  }
  const sharedName = (el, outer, hash) => sharedNames.get(hash) ?? null;
  const converted = pages.map((p) => convertDocument(p.html, { page: p.page, pageUrl: p.pageUrl ?? null, linkMap, sharedName }));
  const shared = [];
  for (const [hash, name] of sharedNames) {
    const on = converted.filter((c) => c.sections.some((s) => s.hash === hash));
    const first = on[0]?.sections.find((s) => s.hash === hash);
    if (first) shared.push({ name, jsx: first.jsx, usesRaw: first.usesRaw, pages: on.map((c) => c.page) });
  }
  const own = converted.reduce((n, c) => n + c.sections.filter((s) => !s.shared).length, 0);
  return {
    pages: converted,
    shared,
    fallbacks: converted.flatMap((c) => c.fallbacks),
    forms: converted.flatMap((c) => c.forms),
    stats: {
      pages: converted.length,
      components: own + shared.length,
      shared: shared.length,
      elements: converted.reduce((n, c) => n + c.stats.elements, 0),
      raw: converted.reduce((n, c) => n + c.stats.raw, 0),
    },
  };
}
