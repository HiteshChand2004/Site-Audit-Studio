// Semantic class names for the recreated site. Original class names are only used as hints, and only
// when they read like a human wrote them: builder classes (the `cleanup.classPatterns` of every
// detection rule: framer-*, w-*, wp-*, sqs-*, ...), hashed CSS-in-JS names (css-1x2y3z, sc-bdVaJa)
// and utility classes (Tailwind and friends) are never copied. Otherwise the name comes from the
// element's role (site-header, nav, title, button, ...) prefixed with its nearest named block
// ("hero-title", "feature-text").
import { RULES } from '../../detection/engine.js';

export const PLATFORM_CLASS_PATTERNS = RULES.flatMap((r) => r.cleanup?.classPatterns ?? []).map((p) => new RegExp(p, 'i'));

const HASHED = [
  /^(css|sc|jsx|emotion|styled|svelte|astro|tw|chakra|mantine|mui|makeStyles|jss)-/i,
  /^_/,
  /(^|[-_])[a-z]*\d[a-z\d]*[A-Z]|[A-Z][a-z]*\d/, // mixed case with digits: bdVa9Ja, x3Fq
  /(^|[-_])(?=[a-z\d]*\d)(?=[a-z\d]*[a-z])[a-z\d]{5,}$/i, // trailing random segment with digits: 1x2y3z
  /\d{3,}/,
];
// Utility classes and visibility helpers describe one declaration, not a thing.
const UTILITY = /[:[\]/.!@%#]|^-|^(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|min-h|max-h|gap|space-[xy]|text|font|bg|border|rounded|shadow|flex|grid|col|cols|row|rows|items|justify|content|self|place|order|z|top|left|right|bottom|inset|opacity|leading|tracking|col-span|row-span|d|is|has|u)-/;
const VISIBILITY = /(^|-)(hidden|visible|show|hide|only|sr|screen-reader|visually)(-|$)|(-|^)(desktop|tablet|phone|mobile|lg|md|sm|xs|xl)$/i;
const GENERIC = new Set(['container', 'wrapper', 'wrap', 'inner', 'outer', 'content', 'block', 'element', 'item', 'row', 'col', 'column', 'clearfix', 'group', 'active', 'current', 'selected', 'open', 'is-active', 'js', 'no-js']);

/** True when an original class name or id is meaningful enough to reuse. */
export function meaningful(token) {
  if (!token || token.length < 2 || token.length > 32) return false;
  if (!/^[a-z][a-z0-9]*([-_]{1,2}[a-z0-9]+)*$/i.test(token)) return false;
  if (PLATFORM_CLASS_PATTERNS.some((re) => re.test(token))) return false;
  if (HASHED.some((re) => re.test(token))) return false;
  if (UTILITY.test(token) || VISIBILITY.test(token)) return false;
  return true;
}

export const kebab = (s) => s.replace(/([a-z\d])([A-Z])/g, '$1-$2').replace(/[_]+/g, '-').replace(/-{2,}/g, '-').toLowerCase();

/** The first meaningful original class name, as kebab-case ("hero__title" → "hero-title"). */
export function originalName(attrs = {}) {
  for (const token of String(attrs.class ?? '').split(/\s+/)) {
    if (meaningful(token) && !GENERIC.has(token.toLowerCase())) return kebab(token);
  }
  return null;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const ROLES = {
  nav: 'nav', main: 'main', aside: 'sidebar', section: 'section', article: 'article', p: 'text', img: 'image',
  picture: 'picture', ul: 'list', ol: 'list', li: 'item', button: 'button', form: 'form', input: 'field', textarea: 'field',
  select: 'field', label: 'label', figure: 'figure', figcaption: 'caption', video: 'video', audio: 'audio', iframe: 'embed',
  span: 'text', blockquote: 'quote', table: 'table', tr: 'row', td: 'cell', th: 'cell', strong: 'strong', em: 'em',
  small: 'small', hr: 'divider', dl: 'list', dt: 'term', dd: 'detail', canvas: 'canvas', time: 'time', address: 'address',
};

/**
 * The name hint for an element (before uniqueness is handled).
 * @param {object} node   merged node
 * @param {object} info   { depth, display, block (nearest named ancestor), buttonLike, iconSize }
 * @returns {{ name: string, isBlock: boolean }}  isBlock: the name can prefix its descendants
 */
export function nameHint(node, info) {
  const own = originalName(node.attrs);
  if (own) return { name: own, isBlock: true };
  const { tag } = node;
  if (tag === 'html') return { name: 'site', isBlock: false };
  if (tag === 'body') return { name: 'page', isBlock: false };
  if (tag === 'header') return info.topLevel ? { name: 'site-header', isBlock: true } : { name: prefix(info.block, 'header'), isBlock: true };
  if (tag === 'footer') return info.topLevel ? { name: 'site-footer', isBlock: true } : { name: prefix(info.block, 'footer'), isBlock: true };
  if (tag === 'nav') return { name: info.block === 'site-header' ? 'main-nav' : prefix(info.block, 'nav'), isBlock: true };
  if (tag === 'main') return { name: 'main', isBlock: false };
  let role;
  if (HEADINGS.has(tag)) role = tag === 'h1' || tag === 'h2' ? 'title' : 'heading';
  else if (tag === 'a') role = info.buttonLike ? 'button' : 'link';
  else if (tag === 'svg') role = info.iconSize ? 'icon' : 'graphic';
  else if (ROLES[tag]) role = ROLES[tag];
  else if (/flex/.test(info.display)) role = info.row ? 'row' : 'stack';
  else if (/grid/.test(info.display)) role = 'grid';
  else role = 'box';
  const isBlock = tag === 'section' || tag === 'article' || tag === 'aside' || tag === 'form' || tag === 'figure';
  return { name: prefix(info.block, role), isBlock };
}

function prefix(block, role) {
  if (!block) return role;
  if (block === role || block.endsWith(`-${role}`)) return block === role ? role : `${block}-${role}`;
  // "site-header" + "nav" reads better as "header-nav".
  return `${block.replace(/^site-/, '')}-${role}`;
}

/**
 * Hands out unique class names: one class per distinct style signature. Two elements with the same
 * signature share a class; a name already used for another signature gets a number ("title-2").
 */
export class ClassNamer {
  constructor() {
    this.bySignature = new Map();
    this.used = new Set();
  }

  name(hint, signature) {
    const known = this.bySignature.get(signature);
    if (known) return known;
    const base = hint.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'box';
    let name = /^[a-z]/.test(base) ? base : `c-${base}`;
    for (let i = 2; this.used.has(name); i++) name = `${base}-${i}`;
    this.used.add(name);
    this.bySignature.set(signature, name);
    return name;
  }
}
