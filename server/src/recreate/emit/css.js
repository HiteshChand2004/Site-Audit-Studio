// Writes the site stylesheet (css/site.css) from the IR: design tokens, local @font-face rules, the
// reset, one rule per class, used @keyframes, then the tablet and mobile overrides.
import { DEFAULT_BREAKPOINTS, hexColor } from '../ir/index.js';
import { MEDIA_VIEWS } from '../views.js';
import { RESET } from '../ir/styles.js';
import { relFile } from '../ir/links.js';

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
export function declarations(decl, { tokenOf, from, indent = '  ' }) {
  const lines = [];
  for (const [prop, raw] of Object.entries(compact(decl))) {
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

/** The whole stylesheet as a string. */
export function emitCss(ir) {
  const from = CSS_FILE;
  const tokenOf = new Map(Object.entries(ir.tokens).map(([name, hex]) => [hex, name]));
  const opts = { tokenOf, from };
  const base = ir.rules.map((r) => block(r.selector, declarations(r.parts.base, opts))).filter(Boolean);
  const media = (view) => ir.rules
    .filter((r) => r.parts[view])
    .map((r) => block(r.selector, declarations(r.parts[view], { ...opts, indent: '    ' }), '  '))
    .filter(Boolean);

  const body = base.join('\n');
  const byView = Object.fromEntries(MEDIA_VIEWS.map((view) => [view, media(view)]));
  // Tokens are written only when a rule uses them.
  const all = [body, ...MEDIA_VIEWS.flatMap((view) => byView[view])].join('\n');
  const used = Object.entries(ir.tokens).filter(([name]) => all.includes(`var(${name})`));
  const sections = [
    `/* ${ir.siteName}: generated by Site Audit Studio from the rendered site. */`,
    used.length ? `:root {\n${used.map(([n, v]) => `  ${n}: ${v};`).join('\n')}\n}` : '',
    fontFaceCss(ir.fontFaces, from),
    resetCss(ir.boxSizingReset),
    body,
    ir.keyframes.map((k) => k.css.replace(/url\("asset:([^"]+)"\)/g, (all, file) => `url("${relFile(from, `assets/${file}`)}")`)).join('\n'),
  ];
  // Widest first: each narrower media query builds on the wider ones.
  for (const view of MEDIA_VIEWS) {
    const rules = byView[view];
    if (rules.length) sections.push(`@media (max-width: ${ir.breakpoints[view] ?? DEFAULT_BREAKPOINTS[view]}px) {\n${rules.join('\n')}\n}`);
  }
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}
