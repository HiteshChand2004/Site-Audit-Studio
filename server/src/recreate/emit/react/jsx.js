// IR → JSX text. Everything stack-neutral (references, attributes, SVG assets) comes from walk.js; this
// file only knows how React spells things:
//   - attribute names (class → className, for → htmlFor, srcset → srcSet, …), boolean attributes,
//     `style` strings → objects, value/checked/selected → their default* props (no controlled inputs);
//   - text is written as a JS string whenever JSX would change it (JSX trims lines and decodes `&amp;`),
//     and every attribute value that is not plainly safe is written as an expression, so the markup
//     React renders is the markup the HTML emitter writes;
//   - inline SVG keeps its own element: the root's attributes become props and the (sanitized) inner
//     markup goes in dangerouslySetInnerHTML, so no wrapper element changes the layout.
import { load } from 'cheerio';
import { emitNode, keepsBreaks } from '../html.js';
import { describeNode } from '../walk.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['pre', 'textarea']);

const PROP = {
  accesskey: 'accessKey', 'accept-charset': 'acceptCharset', allowfullscreen: 'allowFullScreen', autocomplete: 'autoComplete',
  autofocus: 'autoFocus', autoplay: 'autoPlay', cellpadding: 'cellPadding', cellspacing: 'cellSpacing', charset: 'charSet',
  colspan: 'colSpan', contenteditable: 'contentEditable', controlslist: 'controlsList', crossorigin: 'crossOrigin',
  datetime: 'dateTime', disablepictureinpicture: 'disablePictureInPicture', disableremoteplayback: 'disableRemotePlayback',
  enctype: 'encType', enterkeyhint: 'enterKeyHint', fetchpriority: 'fetchPriority', for: 'htmlFor', formnovalidate: 'formNoValidate',
  frameborder: 'frameBorder', hreflang: 'hrefLang', 'http-equiv': 'httpEquiv', inputmode: 'inputMode', itemid: 'itemID',
  itemprop: 'itemProp', itemref: 'itemRef', itemscope: 'itemScope', itemtype: 'itemType', maxlength: 'maxLength', minlength: 'minLength',
  nomodule: 'noModule', novalidate: 'noValidate', playsinline: 'playsInline', readonly: 'readOnly', referrerpolicy: 'referrerPolicy',
  rowspan: 'rowSpan', spellcheck: 'spellCheck', srcdoc: 'srcDoc', srclang: 'srcLang', srcset: 'srcSet', tabindex: 'tabIndex', usemap: 'useMap',
};
// Attributes React renders from a boolean prop.
const BOOLEAN = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'disablepictureinpicture',
  'disableremoteplayback', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate',
  'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected',
]);

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** The React prop name of an HTML attribute (aria-*, data-* and unknown lowercase names stay as written). */
export function propName(name) {
  const n = name.toLowerCase();
  if (PROP[n]) return PROP[n];
  return n;
}
/** SVG attribute → React prop: hyphenated presentation attributes and namespaced ones become camelCase. */
export function svgPropName(name) {
  if (name === 'class') return 'className';
  if (/^(aria|data)-/.test(name)) return name;
  if (name.includes(':')) return camel(name.replace(':', '-'));
  return camel(name);
}

/**
 * The declarations of an inline style, split on the semicolons that separate them — never on one inside a
 * value. A data URI carries its own (`url(data:image/svg+xml;base64,…)`), and splitting on those cut the
 * declaration in half and dropped every declaration after it.
 */
export function declarations(css) {
  const s = String(css);
  const out = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth > 0) depth--;
    } else if (c === ';' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * "color: red; --x: 1" → { color: 'red', '--x': '1' } (property names camelCased, custom properties kept).
 * An `!important` stays in the value: React's server render writes it exactly as the HTML emitter does, so
 * both builds serialise the same `style` attribute. The browser drops the priority once React hydrates and
 * assigns the property, so an inline `!important` is a known limitation of the app stacks, not something to
 * rewrite here — rewriting it would make the two builds differ.
 */
export function styleObject(css) {
  const out = {};
  for (const part of declarations(css)) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key || !value) continue;
    out[key.startsWith('--') ? key : camel(key.replace(/^-ms-/, 'ms-'))] = value;
  }
  return out;
}

const SAFE_ATTR = /^[^"&\\{}<>\n\r]*$/;
const SAFE_TEXT = /^[^{}<>&\n\r]*$/;

/** An attribute `name`/`value` as JSX: a plain string when that is exact, otherwise an expression. */
function attr(name, value) {
  if (value === true) return name;
  if (typeof value === 'object') return `${name}={${JSON.stringify(value)}}`;
  return SAFE_ATTR.test(value) ? `${name}="${value}"` : `${name}={${JSON.stringify(value)}}`;
}

/** A text node as a JSX child: plain text when JSX keeps it as it is, else a string expression. */
export function jsxText(text) {
  const plain = SAFE_TEXT.test(text) && text === text.trim() && !/\s{2,}/.test(text) && text !== '';
  return plain ? text : `{${JSON.stringify(text)}}`;
}

function svgJsx(d, pad) {
  let $ = load(d.markup, { xml: { xmlMode: true } }, false);
  let root = $('svg').first();
  if (!root.length) {
    // An XML parse that finds no <svg> used to emit an empty `<svg />`: the icon disappeared from the app
    // stacks while the HTML build wrote the markup as it is. Try the lenient parser, and if there is still no
    // root, say so instead — a named failure beats a missing element nobody can trace.
    $ = load(d.markup, null, false);
    root = $('svg').first();
    if (!root.length) throw new Error(`Inline SVG without an <svg> root cannot be written as JSX: ${d.markup.slice(0, 80)}`);
  }
  const props = [];
  if (d.class) props.push(attr('className', d.class));
  for (const [name, value] of Object.entries(root.attr() ?? {})) {
    if (name === 'class') continue; // the IR class is the generated one
    props.push(name === 'style' ? attr('style', styleObject(value)) : attr(svgPropName(name), value));
  }
  const inner = $.xml(root.contents());
  if (inner.trim()) props.push(`dangerouslySetInnerHTML={{ __html: ${JSON.stringify(inner)} }}`);
  return `${pad}<svg${props.length ? ` ${props.join(' ')}` : ''} />`;
}

/** The value a <select> should start on: the `selected` option (or the first option with `selected`). */
function selectedValue(node) {
  let found = null;
  const walk = (n) => {
    if (found !== null || 'text' in n) return;
    if (n.t === 'option' && n.attrs && 'selected' in n.attrs) {
      const text = (n.children ?? []).map((c) => c.text ?? '').join('').trim();
      found = n.attrs.value ?? text;
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return found;
}

function elementProps(d, node) {
  const props = [];
  if (d.id) props.push(attr('id', d.id));
  if (d.class) props.push(attr('className', d.class));
  for (const a of d.attrs) {
    const lower = a.name.toLowerCase();
    if (lower === 'style') {
      props.push(attr('style', styleObject(a.value)));
    } else if (a.bare) {
      if (!BOOLEAN.has(lower)) props.push(attr(propName(lower), ''));
      else if (lower === 'checked') props.push('defaultChecked');
      else if (!(lower === 'selected' && node.t === 'option')) props.push(propName(lower)); // option: the select's defaultValue
    } else if (lower === 'value' && (node.t === 'input' || node.t === 'textarea' || node.t === 'select')) {
      props.push(attr('defaultValue', a.value));
    } else if (lower === 'checked' && node.t === 'input') {
      props.push('defaultChecked');
    } else {
      props.push(attr(propName(lower), a.value));
    }
  }
  if (node.t === 'select') {
    const v = selectedValue(node);
    if (v !== null) props.push(attr('defaultValue', v));
  }
  return props.filter(Boolean);
}

/** The HTML emitter's rule: whitespace-only text between block children is dropped, otherwise all are kept. */
export function visibleChildren(kids, tag, keep = false) {
  // keep: the parent keeps its line breaks (white-space: pre*). The HTML emitter leaves such text alone
  // (html.js keepsBreaks), so dropping the whitespace-only children here would lose the blank lines the
  // HTML build keeps.
  const blocky = !keep && !RAW_TEXT.has(tag) && kids.length > 0 && kids.every((c) => ('text' in c ? !c.text.trim() : c.b));
  if (blocky) return kids.filter((c) => !('text' in c));
  // Adjacent text nodes are one text node in HTML; as separate JSX lines they would be joined with a space.
  const merged = [];
  for (const c of kids) {
    const last = merged[merged.length - 1];
    if ('text' in c && last && 'text' in last) merged[merged.length - 1] = { text: last.text + c.text };
    else merged.push(c);
  }
  return merged;
}

/**
 * One IR node as JSX lines (without a trailing newline). `refs` as in walk.js. `components` maps IR nodes
 * to shared component names (recorded in `used`); children follow visibleChildren.
 */
export function jsxNode(node, refs, depth = 0, components = null, used = null, { wsByClass = null, keep = false } = {}) {
  const pad = '  '.repeat(depth);
  const component = components?.get(node);
  if (component) {
    used?.add(component);
    return `${pad}<${component} />`;
  }
  // A state the page does not start in: the same <template> as the HTML site, its content written as HTML (React renders
  // it into the template's content and leaves it alone on hydration; js/motion.js puts it in place when it is shown).
  if (node.tpl) {
    const html = emitNode(node, { refs, ids: false, inTemplate: true }, 0, false);
    return `${pad}<template data-w-tpl=${JSON.stringify(node.tpl)} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(html)} }} />`;
  }
  const d = describeNode(node, refs);
  if (d.kind === 'text') return `${pad}${jsxText(d.text)}`;
  if (d.kind === 'svg') return svgJsx(d, pad);

  const props = elementProps(d, node);
  const open = `${d.tag}${props.length ? ` ${props.join(' ')}` : ''}`;
  if (VOID.has(d.tag)) return `${pad}<${open} />`;

  if (d.tag === 'textarea') {
    const text = d.children.map((c) => c.text ?? '').join('');
    return `${pad}<${open}${text ? ` defaultValue={${JSON.stringify(text)}}` : ''} />`;
  }
  const keepHere = keepsBreaks(node, keep, wsByClass);
  const kids = visibleChildren(d.children, d.tag, keepHere);
  if (!kids.length) return `${pad}<${open} />`;
  const inner = kids.map((c) => jsxNode(c, refs, depth + 1, components, used, { wsByClass, keep: keepHere })).join('\n');
  return `${pad}<${open}>\n${inner}\n${pad}</${d.tag}>`;
}

/** An attribute as JSX (shared with emitters that write head tags as elements). */
export { attr as jsxAttr };
