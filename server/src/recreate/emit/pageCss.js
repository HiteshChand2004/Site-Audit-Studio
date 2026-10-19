// The stylesheet of one page (full-site D.6): one shared css/site.css made every page download every rule of the site
// (Lighthouse: "Reduce unused CSS") and blocked rendering ("Eliminate render-blocking resources"). Now each page of the
// plain-HTML build carries only the rules it uses: inline in its <head> when that is small (no request at all), else the
// rules of the first screen inline and the rest in css/pages/<page>.css linked at the end of <body> (not render-blocking).
// The app stacks keep one stylesheet: their bundler links it.
//
// A rule is kept when the page has every class and motion / widget token its selector names (classes the generated
// script sets at run time count as present); element rules, :root, @font-face and the at-rules around kept rules stay;
// @keyframes only when a kept rule names it.

export const INLINE_MAX = 40000; // characters of compact CSS inlined in a page's head
export const FOLD_PX = 1000; // the first screen, for the inlined part of a large page's rules
const RUNTIME_CLASSES = new Set(['js-motion', 'is-in', 'w-open', 'w-shut']);

/** Classes and tokens a set of IR nodes uses. @param {object} root IR body node @param {(n) => boolean} [only] */
export function usedBy(root, only = () => true) {
  const used = { classes: new Set(), tokens: new Set() };
  const walk = (n) => {
    if (!n || !n.t) return;
    if (only(n)) {
      for (const c of String(n.class ?? '').split(/\s+/)) if (c) used.classes.add(c);
      for (const key of ['data-motion', 'data-w']) for (const tok of String(n.attrs?.[key] ?? '').split(/\s+/)) if (tok) used.tokens.add(tok);
    }
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return used;
}

/** The top-level blocks of a stylesheet: [{ prelude, body }] (body null for a statement like @charset). */
function blocks(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (i >= n) break;
    let j = i;
    let quote = null;
    while (j < n && (quote || (css[j] !== '{' && css[j] !== ';'))) {
      if (quote) {
        if (css[j] === '\\') j++;
        else if (css[j] === quote) quote = null;
      } else if (css[j] === '"' || css[j] === "'") quote = css[j];
      j++;
    }
    const prelude = css.slice(i, j).trim();
    if (css[j] === ';' || j >= n) {
      if (prelude) out.push({ prelude, body: null });
      i = j + 1;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    quote = null;
    while (k < n && depth) {
      const ch = css[k];
      if (quote) {
        if (ch === '\\') k++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      k++;
    }
    out.push({ prelude, body: css.slice(j + 1, k - 1) });
    i = k;
  }
  return out;
}

const CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;
const TOKEN = /\[data-(?:motion|w)~=["']?([^"'\]]+)["']?\]/g;

const IS_TOKEN = /^\[data-(?:motion|w)~=/;

function selectorUsed(sel, used) {
  // Attribute selectors other than the tokens, and quoted text, cannot name a class.
  const plain = sel.replace(/\[[^\]]*\]/g, (m) => (IS_TOKEN.test(m) ? m : '')).replace(/"[^"]*"|'[^']*'/g, '');
  for (const m of plain.matchAll(CLASS)) if (!used.classes.has(m[1]) && !RUNTIME_CLASSES.has(m[1])) return false;
  for (const m of sel.matchAll(TOKEN)) if (!used.tokens.has(m[1])) return false;
  return true;
}

function filterBlocks(list, used) {
  const out = [];
  for (const b of list) {
    if (b.body === null) {
      out.push(`${b.prelude};`);
      continue;
    }
    if (b.prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(b.prelude)?.[1]?.toLowerCase();
      if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container') {
        const inner = filterBlocks(blocks(b.body), used);
        if (inner.length) out.push(`${b.prelude}{${inner.join('')}}`);
      } else out.push(`${b.prelude}{${b.body}}`);
      continue;
    }
    const selectors = b.prelude.split(/,(?![^(]*\))/).map((s) => s.trim());
    if (selectors.some((s) => selectorUsed(s, used))) out.push(`${b.prelude}{${b.body}}`);
  }
  return out;
}

/** Collapses the generated stylesheet's layout whitespace (it holds no multi-line strings). */
// Quoted text (content: "…", font names, url("…")) is left exactly as it is.
const compact = (css) => css
  .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
  .map((part, i) => (i % 2 ? part : part.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, ' ').replace(/\s*([{};])\s*/g, '$1')))
  .join('')
  .trim();

/**
 * The rules of a stylesheet that a page uses, compact.
 * @param {string} css  the whole stylesheet (emitCss), its url()s already relative to where this CSS will live
 * @param {{ classes: Set<string>, tokens: Set<string> }} used
 */
export function pageCss(css, used) {
  const kept = filterBlocks(blocks(css), used);
  // @keyframes only when a kept rule names them.
  const text = kept.filter((r) => !/^@(-webkit-)?keyframes/i.test(r)).join('');
  const out = kept.filter((r) => {
    const m = /^@(?:-webkit-)?keyframes\s+([^\s{]+)/i.exec(r);
    return !m || new RegExp(`(animation(-name)?\\s*:[^;}]*\\b)${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  });
  return compact(out.join('\n'));
}
