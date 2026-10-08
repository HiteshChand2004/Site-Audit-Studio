// Writes the site stylesheet (css/site.css) from the IR: design tokens, local @font-face rules, the
// reset, one rule per class, used @keyframes, then the tablet and mobile overrides. With a page, only what that
// page uses (its classes, the @font-face / @keyframes those rules name), for a stylesheet inlined in the page:
// no render-blocking request and no CSS of other pages. Custom properties nothing reads are never written
// (builders set dozens on every element; a copied element keeps them only where a var() uses them).
import { transformSync } from 'esbuild';
import { DEFAULT_BREAKPOINTS, hexColor } from '../ir/index.js';
// Every known view with rules gets its media query: saved copies from before "desktop only" keep their tablet / phone styles.
import { KNOWN_MEDIA_VIEWS as MEDIA_VIEWS } from '../views.js';
import { RESET } from '../ir/styles.js';
import { relFile } from '../ir/links.js';
import { motionCss } from './motionCss.js';

export const CSS_FILE = 'css/site.css';
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/;
const COLOR_PROPS = /(^|-)color$|^(fill|stroke)$/;

/** rgb()/rgba() inside any value → #rrggbb or rgb(r g b / a); fully transparent → transparent. */
export function tidyColors(value) {
  if (/^rgba\(\d+, \d+, \d+, 0\)$/.test(value)) return 'transparent';
  return value.replace(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/g, (all, r, g, b, a) =>
    a === undefined || a === '1' ? hexColor(`rgb(${r}, ${g}, ${b})`) : `rgb(${r} ${g} ${b} / ${a})`);
}

const SIDES = ['top', 'right', 'bottom', 'left'];
const box4 = ([t, r, b, l]) => (t === b && r === l ? (t === r ? t : `${t} ${r}`) : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`);

// margin / padding / border / border-radius shorthands, when every longhand is there and none is a CSS-wide keyword.
function compact(decl) {
  const out = { ...decl };
  const take = (names, write) => {
    const values = names.map((n) => out[n]);
    if (values.some((v) => v === undefined || CSS_WIDE.test(v) || /\s/.test(v))) return;
    names.forEach((n) => delete out[n]);
    write(values);
  };
  for (const p of ['margin', 'padding']) take(SIDES.map((s) => `${p}-${s}`), (v) => (out[p] = box4(v)));
  take(['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'], (v) => (out['border-radius'] = box4(v)));
  const border = SIDES.map((s) => [out[`border-${s}-width`], out[`border-${s}-style`], out[`border-${s}-color`]]);
  if (border.every((b) => b.every((x) => x !== undefined && !CSS_WIDE.test(x))) && border.every((b) => b.join() === border[0].join())) {
    for (const s of SIDES) for (const k of ['width', 'style', 'color']) delete out[`border-${s}-${k}`];
    out.border = border[0].join(' ');
  }
  // Otherwise per aspect: border-width / border-style / border-color when the four sides agree.
  for (const k of ['width', 'style', 'color']) {
    const names = SIDES.map((s) => `border-${s}-${k}`);
    const values = names.map((n) => out[n]);
    if (values.every((v) => v !== undefined && v === values[0] && !CSS_WIDE.test(v) && !/\s/.test(v))) {
      names.forEach((n) => delete out[n]);
      out[`border-${k}`] = values[0];
    }
  }
  return out;
}

// A shorthand reset with `revert` / `revert-layer` is written as its longhands. Both mean the same to a browser, but
// build tools that rewrite CSS do not all know these keywords on a shorthand: Next.js's postcss-flexbugs-fixes turns
// `flex: revert` into `flex: revert 1`, which is invalid, so the reset was dropped and the base value stayed (a
// flex-basis of 450px at tablet width). Longhands pass through every tool unchanged.
const LONGHANDS = { flex: ['flex-grow', 'flex-shrink', 'flex-basis'] };
const TOOL_UNSAFE = /^(revert|revert-layer)$/;

/**
 * @param {object} decl  property → value
 * @param {object} o     { tokenOf: Map<hex, name>, from: the file the CSS is written to }
 */
export function declarations(decl, { tokenOf, from, indent = '  ', usedVars = null }) {
  const lines = [];
  for (const [prop, raw] of Object.entries(compact(decl))) {
    if (usedVars && prop.startsWith('--') && !usedVars.has(prop)) continue;
    if (LONGHANDS[prop] && TOOL_UNSAFE.test(String(raw).trim())) {
      for (const longhand of LONGHANDS[prop]) lines.push(`${indent}${longhand}: ${String(raw).trim()};`);
      continue;
    }
    let value = tidyColors(String(raw)).replace(/url\("asset:([^"]+)"\)/g, (all, file) => `url("${relFile(from, `assets/${file}`)}")`);
    if (COLOR_PROPS.test(prop) && tokenOf.has(value)) value = `var(${tokenOf.get(value)})`;
    lines.push(`${indent}${prop}: ${value};`);
  }
  return lines.join('\n');
}

const block = (selector, body, indent = '') => (body ? `${indent}${selector} {\n${body}\n${indent}}` : '');

function resetCss(boxSizing) {
  const groups = new Map();
  for (const [tag, decl] of Object.entries(RESET)) {
    const key = JSON.stringify(decl);
    groups.set(key, [...(groups.get(key) ?? []), tag]);
  }
  const rules = [...groups].map(([key, tags]) => `${tags.join(', ')} { ${Object.entries(JSON.parse(key)).map(([p, v]) => `${p}: ${v};`).join(' ')} }`);
  if (boxSizing) rules.unshift('*, *::before, *::after { box-sizing: border-box; }');
  return rules.join('\n');
}

export function fontFaceCss(faces, from) {
  return faces.map((f) => {
    const src = f.src.map((s) => `url("${relFile(from, `assets/${s.asset}`)}")${s.format ? ` format("${s.format}")` : ''}`).join(', ');
    const lines = [
      `  font-family: "${f.family}";`,
      `  src: ${src};`,
      f.weight && f.weight !== 'normal' ? `  font-weight: ${f.weight};` : null,
      f.style && f.style !== 'normal' ? `  font-style: ${f.style};` : null,
      `  font-display: ${f.display && f.display !== 'auto' ? f.display : 'swap'};`,
      f.unicodeRange ? `  unicode-range: ${f.unicodeRange};` : null,
    ].filter(Boolean);
    return `@font-face {\n${lines.join('\n')}\n}`;
  }).join('\n');
}

/** Minified CSS (esbuild, no lowering), for stylesheets an emitter writes inline. */
export const minifyCssSync = (css) => transformSync(css, { loader: 'css', minify: true, legalComments: 'none', logLevel: 'silent' }).code.trim();

const VAR_REF = /var\(\s*(--[\w-]+)/g;

/** Custom properties some value reads: rules, keyframes, motion effects, inline styles and inline SVG of the pages. */
export function usedCustomProps(ir) {
  const used = new Set();
  const scan = (text) => {
    for (const m of String(text ?? '').matchAll(VAR_REF)) used.add(m[1]);
  };
  for (const r of ir.rules ?? []) for (const part of Object.values(r.parts)) for (const v of Object.values(part ?? {})) scan(v);
  for (const k of ir.keyframes ?? []) scan(k.css);
  scan(JSON.stringify(ir.motion ?? {}));
  const walk = (n) => {
    if (!n || 'text' in n) return;
    if (n.raw) scan(n.raw);
    if (typeof n.attrs?.style === 'string') scan(n.attrs.style);
    (n.children ?? []).forEach(walk);
  };
  for (const p of ir.pages ?? []) walk(p.body);
  return used;
}

/** Every class a page uses (its body, html and body elements). */
export function pageClasses(page) {
  const classes = new Set(String(page.html?.class ?? '').split(/\s+/).filter(Boolean));
  const walk = (n) => {
    if (!n || 'text' in n) return;
    for (const c of String(n.class ?? '').split(/\s+/)) if (c) classes.add(c);
    (n.children ?? []).forEach(walk);
  };
  walk(page.body);
  return classes;
}

/** Every character a page can draw: its text, attribute texts a field shows, inline SVG text and CSS `content`. */
export function pageChars(page, css = '') {
  const chars = new Set();
  const add = (s) => {
    for (const ch of String(s ?? '')) chars.add(ch.codePointAt(0));
  };
  const walk = (n) => {
    if (!n) return;
    if ('text' in n) return add(n.text);
    if (n.raw) add(n.raw.replace(/<[^>]*>/g, ' '));
    for (const k of ['value', 'placeholder']) if (typeof n.attrs?.[k] === 'string') add(n.attrs[k]);
    (n.children ?? []).forEach(walk);
  };
  walk(page.body);
  for (const m of css.matchAll(/content:\s*("([^"]*)"|'([^']*)')/g)) add((m[2] ?? m[3] ?? '').replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))));
  return chars;
}

// "U+0000-00FF, U+0131, U+0??" → [[from, to], …]
const parseRange = (text) => String(text).split(',').map((r) => r.trim().replace(/^U\+/i, '')).filter(Boolean).map((r) => {
  if (r.includes('?')) return [parseInt(r.replace(/\?/g, '0'), 16), parseInt(r.replace(/\?/g, 'F'), 16)];
  const [a, b = a] = r.split('-');
  return [parseInt(a, 16), parseInt(b, 16)];
}).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));

const WEIGHT_WORDS = { normal: 400, bold: 700 };

/** How many of the characters a face's unicode-range holds (all of them without a range). */
export function charsCovered(face, chars) {
  if (!face.unicodeRange) return chars.size;
  const ranges = parseRange(face.unicodeRange);
  if (!ranges.length) return chars.size;
  let n = 0;
  for (const c of chars) if (ranges.some(([a, b]) => c >= a && c <= b)) n++;
  return n;
}

/**
 * The @font-face rules a page's stylesheet needs: families its rules name, subsets (unicode-range) holding a character
 * the page draws, and weights / styles its rules use (400 always: text without a weight; a relative weight keeps them
 * all), each picked like the browser's weight matching. A face left out is a face the page never loads.
 */
export function pageFontFaces(faces, page, sheet) {
  const css = sheet + inlineStyles(page.body);
  const named = faces.filter((f) => css.includes(f.family));
  const chars = pageChars(page, css);
  // 400: text without a weight of its own. The copy's reset makes headings, b / strong and th inherit their weight, and
  // `inherit` / `unset` reuse a weight counted here; `revert` gives such a tag the browser's bold back.
  const weights = new Set([400]);
  if (/font-weight:\s*revert/.test(css) && hasTag(page.body, /^(h[1-6]|b|strong|th)$/)) weights.add(700);
  let anyWeight = /font-weight:\s*(bolder|lighter|var\()/.test(css);
  for (const m of css.matchAll(/font-weight:\s*([\w-]+)/g)) {
    const w = WEIGHT_WORDS[m[1]] ?? Number(m[1]);
    if (Number.isFinite(w)) weights.add(w);
  }
  for (const m of css.matchAll(/font:\s*([^;}]*)/g)) {
    for (const t of m[1].split(/\s+/)) if (/^[1-9]00$/.test(t) || t in WEIGHT_WORDS) weights.add(WEIGHT_WORDS[t] ?? Number(t));
  }
  if (/font-variation-settings/.test(css)) anyWeight = true;
  // em / i / cite… inherit their style in the copy's reset; `revert` gives them the browser's italic back.
  const italic = /font-style:\s*(italic|oblique)|font:[^;}]*\b(italic|oblique)\b/.test(css)
    || (/font-style:\s*revert/.test(css) && hasTag(page.body, /^(em|i|cite|var|dfn|address)$/));
  const range = (f) => {
    const [lo, hi = lo] = String(f.weight ?? 'normal').split(/\s+/).map((t) => WEIGHT_WORDS[t] ?? Number(t));
    return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
  };
  // Per family and style: the faces the browser's weight matching picks for a used weight (a missing 300 falls back to
  // the nearest lighter face, so that face stays).
  const keepWeight = new Set();
  const groups = new Map();
  for (const f of named) {
    const key = `${f.family}|${/italic|oblique/.test(f.style ?? '') ? 'i' : 'n'}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const list of groups.values()) {
    if (anyWeight || list.some((f) => !range(f))) {
      list.forEach((f) => keepWeight.add(f));
      continue;
    }
    for (const w of weights) {
      const lo = (f) => range(f)[0];
      const hi = (f) => range(f)[1];
      let pick = list.filter((f) => lo(f) <= w && w <= hi(f));
      if (!pick.length) {
        const below = list.filter((f) => hi(f) < w).sort((a, b) => hi(b) - hi(a));
        const above = list.filter((f) => lo(f) > w).sort((a, b) => lo(a) - lo(b));
        const near = (arr, end) => (arr.length ? arr.filter((f) => end(f) === end(arr[0])) : []);
        if (w >= 400 && w <= 500) {
          const upTo500 = above.filter((f) => lo(f) <= 500);
          pick = upTo500.length ? near(upTo500, lo) : below.length ? near(below, hi) : near(above, lo);
        } else if (w < 400) pick = below.length ? near(below, hi) : near(above, lo);
        else pick = above.length ? near(above, lo) : near(below, hi);
      }
      pick.forEach((f) => keepWeight.add(f));
    }
  }
  return named.filter((f) => {
    if (f.unicodeRange && chars.size) {
      const ranges = parseRange(f.unicodeRange);
      if (ranges.length && ![...chars].some((c) => ranges.some(([a, b]) => c >= a && c <= b))) return false;
    }
    // Italic faces of a family that has upright ones are needed only for italic text.
    if (/italic|oblique/.test(f.style ?? '') && !italic && named.some((g) => g.family === f.family && !/italic|oblique/.test(g.style ?? ''))) return false;
    return keepWeight.has(f);
  });
}

const inlineStyles = (n) => (!n || 'text' in n ? '' : `${typeof n.attrs?.style === 'string' ? `;${n.attrs.style}` : ''}${(n.children ?? []).map(inlineStyles).join('')}`);

function hasTag(n, re) {
  if (!n || 'text' in n) return false;
  if (re.test(n.tag ?? '')) return true;
  return (n.children ?? []).some((c) => hasTag(c, re));
}

/** Motion tokens a page carries: its elements' data-motion, inline SVG markup included (loops inside SVGs). */
export function pageMotionTokens(page) {
  const tokens = new Set();
  const add = (v) => {
    for (const t of String(v ?? '').split(/\s+/)) if (t) tokens.add(t);
  };
  const walk = (n) => {
    if (!n || 'text' in n) return;
    add(n.attrs?.['data-motion']);
    if (n.raw) for (const m of n.raw.matchAll(/data-motion\s*=\s*["']([^"']*)["']/g)) add(m[1]);
    (n.children ?? []).forEach(walk);
  };
  walk(page.body);
  return tokens;
}

/** The site's motion with only the hover / focus / reveal / delay / loop effects this page's elements use. */
export function pageMotion(motion, page) {
  const tokens = pageMotionTokens(page);
  const has = (e) => tokens.has(e.token);
  return {
    ...motion,
    hover: (motion.hover ?? []).filter(has),
    focus: (motion.focus ?? []).filter(has),
    reveal: (motion.reveal ?? []).filter(has),
    loops: (motion.loops ?? []).filter(has),
    delays: (motion.delays ?? []).filter((ms) => tokens.has(`d${ms}`)),
  };
}

const selectorClass = (selector) => selector.match(/^\.(-?[_a-zA-Z][\w-]*)/)?.[1] ?? null;

/**
 * The stylesheet as a string: the whole site's (css/site.css), or one page's when `page` is given (its url()s
 * relative to the page, for a <style> in its head).
 */
export function emitCss(ir, { page = null, usedVars = usedCustomProps(ir) } = {}) {
  const from = page ? page.outPath : CSS_FILE;
  const tokenOf = new Map(Object.entries(ir.tokens).map(([name, hex]) => [hex, name]));
  const opts = { tokenOf, from, usedVars };
  const classes = page && pageClasses(page);
  const rules = classes ? ir.rules.filter((r) => { const c = selectorClass(r.selector); return !c || classes.has(c); }) : ir.rules;
  const base = rules.map((r) => block(r.selector, declarations(r.parts.base, opts))).filter(Boolean);
  const media = (view) => rules
    .filter((r) => r.parts[view])
    .map((r) => block(r.selector, declarations(r.parts[view], { ...opts, indent: '    ' }), '  '))
    .filter(Boolean);

  const body = base.join('\n');
  const byView = Object.fromEntries(MEDIA_VIEWS.map((view) => [view, media(view)]));
  // Tokens are written only when a rule uses them.
  const motion = motionCss(page && ir.motion ? pageMotion(ir.motion, page) : ir.motion, opts);
  const all = [body, motion, ...MEDIA_VIEWS.flatMap((view) => byView[view])].join('\n');
  const used = Object.entries(ir.tokens).filter(([name]) => all.includes(`var(${name})`));
  // A page's stylesheet keeps the @keyframes and @font-face its rules name.
  const names = page && new Set(all.match(/[\w-]+/g));
  const keyframes = page ? ir.keyframes.filter((k) => names.has(k.name)) : ir.keyframes;
  const fontFaces = page ? pageFontFaces(ir.fontFaces, page, all) : ir.fontFaces;
  const sections = [
    `/* ${ir.siteName}: generated by Site Audit Studio from the rendered site. */`,
    used.length ? `:root {\n${used.map(([n, v]) => `  ${n}: ${v};`).join('\n')}\n}` : '',
    fontFaceCss(fontFaces, from),
    resetCss(ir.boxSizingReset),
    body,
    keyframes.map((k) => k.css.replace(/url\("asset:([^"]+)"\)/g, (all, file) => `url("${relFile(from, `assets/${file}`)}")`)).join('\n'),
    motion,
  ];
  // Widest first: each narrower media query builds on the wider ones.
  for (const view of MEDIA_VIEWS) {
    const rules = byView[view];
    if (rules.length) sections.push(`@media (max-width: ${ir.breakpoints[view] ?? DEFAULT_BREAKPOINTS[view]}px) {\n${rules.join('\n')}\n}`);
  }
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}
