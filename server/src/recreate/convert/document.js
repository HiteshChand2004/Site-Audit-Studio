// The as-is copy's finished pages (HTML the original's own stylesheets and scripts draw, identical to the original) converted
// into components, mechanically. One component per section of a page (header, hero, each content part, footer — found inside
// the wrappers a builder or an app nests the page in: planSections), class → className, inline styles → style objects, inline SVG kept as its own element, the original's
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
// page's DOM is the original's and no escaping rule of React can change a byte of it. A comment of the page travels the same
// way (the comment prop): React cannot write one, and a site rendered with React reads its comments back as hydration markers.
export default function ${RAW_COMPONENT}({ b64, comment }) {
  if (comment !== undefined) return <template data-sas-comment={comment} />;
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
const ROLE_NAMES = { banner: 'SiteHeader', navigation: 'SiteNav', contentinfo: 'SiteFooter', complementary: 'Sidebar', main: 'MainContent' };

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
    // An inline style is an object on every element, <svg> and <math> included: React refuses a style written as text
    // (the build stops), and a builder often styles its SVG wrappers inline.
    if (lower === 'style') {
      const decls = declarations(value).filter((d) => d.trim());
      const obj = styleObject(value);
      if (decls.some((d) => !d.includes(':')) || Object.keys(obj).length !== decls.length) {
        return { fail: 'an inline style React cannot write exactly (a repeated or malformed declaration)', attribute: name };
      }
      props.push(jsxAttr('style', obj));
      continue;
    }
    if (svgLike) {
      // An SVG attribute: React's camelCase name (viewBox stays; stroke-width → strokeWidth; xlink:href → xlinkHref).
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) return { fail: 'an attribute name React cannot write', attribute: name };
      props.push(jsxAttr(tag === 'svg' ? svgPropName(name) : name, value));
      continue;
    }
    if (!VALID_NAME.test(name)) return { fail: 'an attribute name React cannot write', attribute: name };
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

  /** A comment of the page, kept as it is (RawHtml writes it; the build step turns it back into the comment). Not a fallback. */
  commentJsx(data) {
    this.comments = (this.comments ?? 0) + 1;
    this.usesRaw = true;
    // A JS string in braces: a JSX attribute string has no escapes, so a quote or a line break in the comment would end it.
    return `<${RAW_COMPONENT} comment={${JSON.stringify(data)}} />`;
  }

  /** The original HTML of an element, kept as it is (RawHtml). */
  rawOf(el, reason, attribute) {
    this.fallbacks.push({ page: this.page, where: whereOf(el), tag: el.name, ...(attribute && { attribute }), reason });
    this.raw += 1;
    this.usesRaw = true;
    return `<${RAW_COMPONENT} b64=${JSON.stringify(Buffer.from(this.$.html(el), 'utf8').toString('base64'))} />`;
  }

  /**
   * The JSX of a list of nodes (adjacent texts merged). Comments are kept, byte for byte: they draw nothing, but a site rendered
   * with React marks its server-rendered parts with them (<!--$-->, <!--/$-->), and its own script, finding them gone, gives up
   * on the page it was sent and draws it again (found on a live site: the largest paint 7.9 s late on a phone, loops lost).
   */
  childrenJsx(nodes, { inHead = false } = {}) {
    const out = [];
    let text = '';
    const flush = () => { if (text) out.push(jsxText(text)); text = ''; };
    for (const n of nodes) {
      // Whitespace between the head's elements draws nothing; left out, so no two text nodes stand side by side there (the
      // document's Head would separate them with comment markers).
      if (n.type === 'text') text += inHead && !n.data.trim() ? '' : n.data;
      else if (isElement(n)) { flush(); out.push(this.elementJsx(n, { inHead })); }
      else if (n.type === 'comment') { flush(); out.push(this.commentJsx(n.data)); }
      // directives and cdata: nothing to draw
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

/** A name a person wrote, not one a builder or a CSS-in-JS tool generated (framer-1x2y3z, css-9f8e7d, a long hex run). */
const readable = (name) => /[a-z]{3}/i.test(name) && !/^(framer|css|sc|jsx|svelte|astro|tw|chakra|mui|emotion)-|[0-9a-f]{6,}|\d{3,}|[a-z]\d[a-z]\d/i.test(name);

/** The visible text of an element (scripts and styles left out), white space folded; joined as written, since a builder that sets
 * each word or letter in a span of its own keeps the spaces in the text. */
const rawText = (el) => (el.children ?? []).map((k) => (k.type === 'text' ? k.data : isElement(k) && !RAW_INNER.has(k.name) ? rawText(k) : '')).join('');
const plainText = (el) => rawText(el).replace(/\s+/g, ' ').trim();

/**
 * A component name for a section, PascalCase: its landmark (tag or role), else "Hero" for the part holding the page's main heading
 * (`hero`, given by planSections), else its id, else its first heading's words, else its first class, else its tag and place.
 * Generated ids and classes (builder hashes) are passed over, so a builder page is named from what it says.
 */
export function sectionName(el, index, { hero = false } = {}) {
  const tag = el.name;
  if (LANDMARK_NAMES[tag]) return LANDMARK_NAMES[tag];
  const role = ROLE_NAMES[el.attribs?.role?.trim()];
  if (role) return role;
  if (hero) return 'Hero';
  const id = el.attribs?.id?.trim();
  if (id && readable(id)) return pascal(id);
  const heading = firstHeading(el);
  const words = heading ? plainText(heading).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).slice(0, 3) : [];
  if (words.length) return pascal(words.join(' '));
  // No heading: a part that holds the site's navigation, header or footer is named after it (a builder wraps them in boxes).
  const inner = firstLandmark(el);
  if (inner) return inner;
  const cls = (el.attribs?.class ?? '').trim().split(/\s+/).find((c) => /^[a-z][a-z0-9_-]{2,}$/i.test(c) && readable(c) && !/^(w-|is-|has-|js-|u-|col|row|grid|flex|container|wrapper|section)$/i.test(c));
  if (cls) return pascal(cls);
  return `${tag === 'div' ? 'Section' : pascal(tag)}${index + 1}`;
}

/** The name of the first navigation, header, footer or sidebar inside an element (tag or role), or null. */
function firstLandmark(el) {
  for (const k of el.children ?? []) {
    if (!isElement(k) || RAW_INNER.has(k.name) || k.name === 'svg') continue;
    const name = LANDMARK_NAMES[k.name] ?? ROLE_NAMES[k.attribs?.role?.trim()];
    if (name && name !== 'MainContent' && name !== 'Form') return name;
    const found = firstLandmark(k);
    if (found) return found;
  }
  return null;
}

/** Parts that are one section by what they are: never split further. */
const WHOLE_SECTION = new Set(['header', 'footer', 'nav', 'aside', 'section', 'article', 'form', 'ul', 'ol', 'dl', 'table', 'figure', 'details', 'dialog']);
const HEADING = /^h[1-6]$/;
/** What draws something a person sees, beside text. */
const DRAWN = new Set(['img', 'picture', 'video', 'canvas', 'svg', 'iframe', 'input', 'button', 'select', 'textarea', 'object', 'embed']);
/** A wrapper holding at least this share of the page's elements is worth looking inside. */
export const SPLIT_SHARE = 0.3;
/** How deep the split looks through wrappers (a builder nests a page in a handful, an app in a few more). */
const MAX_SPLIT_DEPTH = 12;

function firstHeading(el) {
  for (const k of el.children ?? []) {
    if (!isElement(k) || RAW_INNER.has(k.name) || k.name === 'svg') continue;
    if (HEADING.test(k.name)) return k;
    const h = firstHeading(k);
    if (h) return h;
  }
  return null;
}

/**
 * The page's sections — header, hero, each content part, footer — found inside the wrappers a builder (Framer, Webflow, Wix…) or an
 * app nests the page in, from what the page is, never from a builder's names:
 *   - a landmark (header, footer, nav, aside, section, article, a list, a form, the role of one) is one section, never split;
 *   - a wrapper holding one visible part is looked through;
 *   - a large wrapper (≥ SPLIT_SHARE of the page's elements) whose parts carry their own headings, or are large themselves, is split
 *     into them — unless it is one section with a title of its own (a heading before its parts) or a list (parts of one shape);
 *   - what draws nothing (a stray <link>, a script, an empty box) is never a section: it stays in the page around them.
 * Only which elements become components is decided here: every element, its order and every wrapper stay as they are.
 * @returns {{ el: object, hero: boolean }[]}
 */
export function planSections(body) {
  if (!body) return [];
  const sizes = new Map();
  const size = (el) => {
    if (!sizes.has(el)) sizes.set(el, 1 + elementChildren(el).reduce((t, k) => t + size(k), 0));
    return sizes.get(el);
  };
  const total = size(body);
  const draws = (el) => DRAWN.has(el.name)
    || (!RAW_INNER.has(el.name) && (el.children ?? []).some((k) => (k.type === 'text' && k.data.trim()) || (isElement(k) && draws(k))));
  const candidate = (el) => !RAW_INNER.has(el.name) && !VOID.has(el.name) && !HOISTED_IN_BODY.has(el.name) && el.name !== 'svg' && draws(el);
  const role = (el) => el.attribs?.role?.trim();
  const landmark = (el) => WHOLE_SECTION.has(el.name) || (Boolean(ROLE_NAMES[role(el)]) && role(el) !== 'main');
  const shape = (el) => `${el.name}|${(el.attribs?.class ?? '').trim().split(/\s+/).sort().join('.')}|${elementChildren(el).length}`;
  const substantial = (el) => size(el) >= Math.max(5, total * 0.05);
  // A list: three or more parts, most of one shape, not each a real share of the page (sections may share one class too).
  const isList = (kids) => {
    if (kids.length < 3 || kids.every(substantial)) return false;
    const counts = new Map();
    for (const k of kids) counts.set(shape(k), (counts.get(shape(k)) ?? 0) + 1);
    return Math.max(...counts.values()) >= Math.ceil(kids.length * 0.6);
  };
  // A section with a title of its own: its first part is a heading, or a small box holding only a heading (and a line under it).
  const titled = (kids) => HEADING.test(kids[0].name) || (size(kids[0]) <= 4 && Boolean(firstHeading(kids[0])));
  const split = (el, depth, top) => {
    const kids = elementChildren(el).filter(candidate);
    if (!kids.length) return top ? [] : [el];
    if (!top && (landmark(el) || depth >= MAX_SPLIT_DEPTH)) return [el];
    // A wrapper around one box that holds parts of its own: look through it (never down to a lone heading or line).
    if (kids.length === 1) return elementChildren(kids[0]).some(candidate) ? split(kids[0], depth + 1, false) : top ? kids : [el];
    if (!top) {
      const headed = kids.filter((k) => firstHeading(k) || landmark(k)).length;
      const large = kids.filter(substantial).length;
      if (size(el) < total * SPLIT_SHARE || isList(kids) || titled(kids) || (headed < 2 && large < 2)) return [el];
    }
    return kids.flatMap((k) => split(k, depth + 1, false));
  };
  const parts = split(body, 0, true);
  // The hero: the part that holds the page's main heading, when it is not a landmark of its own.
  const findH1 = (n) => { for (const k of elementChildren(n)) { if (k.name === 'h1') return k; const f = findH1(k); if (f) return f; } return null; };
  const h1 = findH1(body);
  const holds = (el) => { for (let n = h1; n; n = n.parent) if (n === el) return true; return false; };
  return parts.map((el) => ({ el, hero: Boolean(h1) && holds(el) && !landmark(el) && !LANDMARK_NAMES[el.name] }));
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
 * @returns {{ page: string, lang: string|null, html: { props: string[], raw: object }, prolog: string|null, body: { props: string[], raw: object },
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
  const componentOf = new Map();
  const taken = new Set([RAW_COMPONENT]);
  const sections = [];
  planSections(bodyEl).forEach(({ el, hero }, i) => {
    const outer = $.html(el);
    const hash = sha(outer);
    let name = sharedName?.(el, outer, hash) ?? null;
    const shared = Boolean(name);
    if (!name) {
      const base = sectionName(el, i, { hero });
      name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
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
    prolog: prologOf(html),
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

/**
 * The comments between the doctype and <html> (a builder's banner, a publish date), exactly as written with the white space
 * around them, or null when there are none. No parser keeps them (they belong to no element), and React renders from <html> down,
 * so the stack writes them back in front of <html> after its build.
 */
export function prologOf(html) {
  const m = /^﻿?\s*(?:<!doctype[^>]*>)?((?:\s|<!--[\s\S]*?-->)*)<html[\s>]/i.exec(String(html ?? ''));
  return m && m[1].includes('<!--') ? m[1] : null;
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
    planSections($('body').get(0)).forEach(({ el, hero }, i) => {
      const hash = sha($.html(el));
      const entry = seen.get(hash) ?? { count: 0, name: sectionName(el, i, { hero }) };
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
