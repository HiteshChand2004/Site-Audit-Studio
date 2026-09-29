// Turns the captured computed-style diffs of the merged tree into stylesheet rules: one class per
// distinct style, a desktop base and tablet / mobile overrides (desktop-first media queries).
//
// Captured diffs are relative (inherited properties vs the parent, others vs the tag's browser
// default), so a property missing in a later view is written as `inherit` or `revert`. A small
// reset (RESET) makes the browser's own styles for links, headings and form controls inherit, which
// keeps "same as parent" true in the generated page.
//
// Computed styles lose authored intent (every length is in px and element width/height are not
// captured at all), so the captured boxes are used to put back what matters for layout:
// - centred blocks (equal horizontal margins) → margin auto + max-width;
// - blocks narrower than their parent → width as a % (when the ratio is the same in every view) or max-width;
// - images, SVG, video and iframes get their rendered size; empty boxes keep their size;
// - absolutely positioned boxes keep one anchor per axis plus their size;
// - px grid tracks that fill the container become fr tracks;
// - containers taller than their content keep a min-height.
import { BLOCK_TAGS, displayOf, isElement, isText, VIEW_IDS } from './tree.js';
import { ClassNamer, nameHint } from './names.js';

// Must match the inherited set of capture/snapshot.js.
export const INHERITED = new Set([
  'color', 'cursor', 'direction', 'font-family', 'font-feature-settings', 'font-kerning', 'font-size', 'font-stretch',
  'font-style', 'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-weight',
  'hyphens', 'letter-spacing', 'line-height', 'list-style-image', 'list-style-position', 'list-style-type',
  'overflow-wrap', 'quotes', 'tab-size', 'text-align', 'text-align-last', 'text-indent', 'text-rendering',
  'text-shadow', 'text-transform', 'text-wrap', 'visibility', 'white-space', 'white-space-collapse', 'word-break',
  'word-spacing', 'writing-mode', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
  '-webkit-font-smoothing', 'accent-color', 'caret-color', 'paint-order', 'fill', 'stroke', 'stroke-width',
]);

const FORM_FONT = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'color', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'text-shadow', 'text-align', 'text-rendering'];
const inherit = (...props) => Object.fromEntries(props.map((p) => [p, 'inherit']));
/** Browser styles that break "same as the parent"; written as the stylesheet's reset. */
export const RESET = {
  a: { color: 'inherit', 'text-decoration-line': 'none', cursor: 'inherit' },
  ...Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((t) => [t, inherit('font-size', 'font-weight')])),
  ...Object.fromEntries(['b', 'strong'].map((t) => [t, inherit('font-weight')])),
  ...Object.fromEntries(['em', 'i', 'cite', 'var', 'dfn', 'address'].map((t) => [t, inherit('font-style')])),
  ...Object.fromEntries(['code', 'kbd', 'samp', 'tt'].map((t) => [t, inherit('font-family', 'font-size')])),
  pre: inherit('font-family', 'font-size', 'white-space-collapse'),
  ...Object.fromEntries(['small', 'sub', 'sup', 'big'].map((t) => [t, inherit('font-size')])),
  th: inherit('font-weight', 'text-align'),
  ...Object.fromEntries(['button', 'input', 'select', 'textarea', 'optgroup'].map((t) => [t, inherit(...FORM_FONT)])),
  mark: inherit('color'),
  table: inherit('border-spacing', 'text-indent'),
  caption: inherit('text-align'),
  center: inherit('text-align'),
  ...Object.fromEntries(['ul', 'ol', 'menu'].map((t) => [t, inherit('list-style-type')])),
  hr: inherit('color'),
};

export const fallback = (prop, tag) => RESET[tag]?.[prop] ?? (INHERITED.has(prop) ? 'inherit' : 'revert');

const REPLACED = new Set(['img', 'svg', 'video', 'iframe', 'canvas', 'embed', 'object']);
const BLOCK_PARENT = new Set(['block', 'flow-root', 'list-item']);
const BLOCK_LEVEL = new Set(['block', 'flex', 'grid', 'flow-root', 'list-item']);
const UA_PADDING_LEFT = { ul: 40, ol: 40, menu: 40, dir: 40 };
const UA_MARGIN_X = { blockquote: [40, 40], figure: [40, 40], dd: [40, 0], body: [8, 8] };
const URL_PROPS = ['background-image', 'mask-image', '-webkit-mask-image', 'list-style-image', 'border-image-source'];
// 'text-decoration' is a shorthand Chrome also lists; the captured longhands carry the same information.
const DROP = new Set(['will-change', 'text-decoration']);
const FORM_CONTROL = new Set(['input', 'select', 'textarea']);
// Tags whose browser default is border-box (so a missing box-sizing diff means border-box).
const UA_BORDER_BOX = new Set(['button', 'select', 'meter', 'progress']);
const BORDER_BOX_INPUT = /^(button|submit|reset|image|checkbox|radio|color|file|range)$/i;

export const px = (value) => (typeof value === 'string' && /^-?[\d.]+px$/.test(value) ? parseFloat(value) : null);
const num = (value, dflt = 0) => px(value) ?? dflt;
const round = (n) => Math.round(n * 100) / 100;
export const pct = (ratio) => `${round(ratio * 100)}%`;

/** Replaces url(...) with local asset placeholders ("asset:images/x.png"); unknown files become `none`. */
export function mapUrls(value, assetFile) {
  if (!value || !value.includes('url(')) return value;
  return value.replace(/url\((['"]?)(.*?)\1\)/g, (all, q, url) => {
    if (url.startsWith('data:')) return all;
    const file = assetFile(url);
    return file ? `url("asset:${file}")` : 'none';
  });
}

export function contentBox(node, v) {
  const d = node.views[v];
  const s = d.style;
  const [x, y, w, h] = d.rect;
  const pl = num(s['padding-left'], UA_PADDING_LEFT[node.tag] ?? 0);
  const pr = num(s['padding-right']);
  const bl = num(s['border-left-width']);
  const br = num(s['border-right-width']);
  return { x: x + pl + bl, y, w: w - pl - pr - bl - br, h };
}

const uaBorderBox = (node) => UA_BORDER_BOX.has(node.tag) || (node.tag === 'input' && BORDER_BOX_INPUT.test(node.attrs.type ?? ''));

/**
 * Box sizes from a captured (border-box) rect in the units width/height/min-height use for this
 * element: the same with border-box, minus padding and border with content-box.
 */
function sizer(node, s) {
  if ((s['box-sizing'] ?? (uaBorderBox(node) ? 'border-box' : 'content-box')) === 'border-box') return { w: (w) => w, h: (h) => h };
  const dx = num(s['padding-left'], UA_PADDING_LEFT[node.tag] ?? 0) + num(s['padding-right']) + num(s['border-left-width']) + num(s['border-right-width']);
  const dy = num(s['padding-top']) + num(s['padding-bottom']) + num(s['border-top-width']) + num(s['border-bottom-width']);
  return { w: (w) => Math.max(0, w - dx), h: (h) => Math.max(0, h - dy) };
}

const isTranslateOnly = (t) => !t || t === 'none' || /^matrix\(1, 0, 0, 1, [-\d.e]+, [-\d.e]+\)$/.test(t);

// px grid tracks that exactly fill the container were fractions of it.
function gridTracks(value, contentW, gap) {
  if (!value || value === 'none' || value.includes('[')) return value;
  const tracks = value.split(/\s+/).map(px);
  if (tracks.some((t) => t == null) || !tracks.length) return value;
  const total = tracks.reduce((a, b) => a + b, 0) + gap * (tracks.length - 1);
  if (Math.abs(total - contentW) > 2) return value;
  const min = Math.min(...tracks);
  if (min <= 0) return value;
  if (tracks.every((t) => Math.abs(t - tracks[0]) <= 1)) return tracks.length === 1 ? 'minmax(0, 1fr)' : `repeat(${tracks.length}, minmax(0, 1fr))`;
  return tracks.map((t) => `minmax(0, ${round(t / min)}fr)`).join(' ');
}

/**
 * The declarations of one node in one view, with sizing hints (@w, @rw, @fw) that are resolved
 * across views afterwards.
 */
export function normalizeView(node, v, chain, opts) {
  const d = node.views[v];
  const style = { ...d.style };
  const [x, , w, h] = d.rect;
  const parent = chain[chain.length - 1];
  const pd = parent?.views[v];
  const display = style.display ?? displayOf(node, v);
  const position = style.position ?? 'static';
  const size = sizer(node, d.style);

  for (const p of DROP) delete style[p];
  if (style['view-transition-name'] === 'root') delete style['view-transition-name']; // the browser's value for <html>
  for (const p of URL_PROPS) if (style[p]) style[p] = mapUrls(style[p], opts.assetFile);

  if (opts.boxSizingReset) {
    if (style['box-sizing'] === 'border-box') delete style['box-sizing'];
    else if (!style['box-sizing'] && !REPLACED.has(node.tag) && !uaBorderBox(node)) style['box-sizing'] = 'content-box';
  }
  if (position === 'relative' || position === 'static') {
    for (const side of ['top', 'right', 'bottom', 'left']) if (position === 'static' || style[side] === '0px') delete style[side];
  }
  if (display === 'none' || display === 'contents' || !pd) return style;

  const pBox = contentBox(parent, v);
  const pDisplay = pd.style.display ?? displayOf(parent, v);
  const ratioOf = (bw) => (pBox.w > 0 ? size.w(bw) / pBox.w : null);

  if (/grid/.test(display)) {
    const box = contentBox(node, v);
    const gap = num(style['column-gap']);
    if (style['grid-template-columns']) style['grid-template-columns'] = gridTracks(style['grid-template-columns'], box.w, gap);
    delete style['grid-template-rows'];
  }

  if (position === 'absolute' || position === 'fixed') {
    const sized = isTranslateOnly(style.transform);
    for (const [a, b, prop, value] of [['left', 'right', 'width', size.w(w)], ['top', 'bottom', 'height', size.h(h)]]) {
      const va = px(style[a]);
      const vb = px(style[b]);
      if (va != null && vb != null && Math.abs(va) <= 1 && Math.abs(vb) <= 1) continue; // stretched: inset 0
      if (va != null && vb != null) delete style[Math.abs(va) <= Math.abs(vb) ? b : a];
      if (sized && value > 0 && !REPLACED.has(node.tag)) style[prop] = `${value}px`;
    }
  }

  const fix = node.fix?.[v];
  if (REPLACED.has(node.tag) && w > 0) {
    const aw = Number(node.attrs.width);
    const ah = Number(node.attrs.height);
    if (!(node.tag === 'img' && Math.abs(aw - w) <= 1 && Math.abs(ah - h) <= 1)) {
      style['@rw'] = { px: size.w(w), ratio: ratioOf(w) };
      const [nw, nh] = node.natural ?? [];
      style.height = node.tag === 'img' && nw > 0 && nh > 0 && Math.abs(w / h - nw / nh) / (nw / nh) < 0.02 ? 'auto' : `${size.h(h)}px`;
    }
  } else if (FORM_CONTROL.has(node.tag) && w > 0 && !/^(hidden|checkbox|radio)$/i.test(node.attrs.type ?? '')) {
    // Form fields keep their rendered width; their height comes from font and padding.
    style['@rw'] = { px: size.w(w), ratio: ratioOf(w) };
  } else if (!fix?.w && node.tag !== 'body' && BLOCK_LEVEL.has(display) && BLOCK_PARENT.has(pDisplay)
    && (position === 'static' || position === 'relative') && (style.float ?? 'none') === 'none' && w > 0) {
    const [uaL, uaR] = UA_MARGIN_X[node.tag] ?? [0, 0];
    const ml = num(style['margin-left'], uaL);
    const mr = num(style['margin-right'], uaR);
    const maxW = style['max-width'];
    const ratio = ratioOf(w);
    const limitedBy = (maxW && px(maxW) != null && Math.abs(px(maxW) - size.w(w)) <= 1) || (maxW?.endsWith('%') && ratio != null && Math.abs(parseFloat(maxW) / 100 - ratio) < 0.01);
    if (ml > 0 && Math.abs(ml - mr) <= 1 && Math.abs(x - (pBox.x + ml)) <= 2) {
      style['margin-left'] = 'auto';
      style['margin-right'] = 'auto';
      if (!limitedBy) style['@w'] = { px: size.w(w), ratio };
    } else if (w < pBox.w - ml - mr - 2 && !limitedBy) {
      style['@w'] = { px: size.w(w), ratio };
    } else if (ml === 0 && mr === 0 && px(maxW) != null && px(maxW) >= size.w(w) && Math.abs(w - pBox.w) <= 1) {
      // Full width because the parent is narrower than max-width: auto margins render the same and
      // keep the rule identical to the views where the block is centred.
      style['margin-left'] = 'auto';
      style['margin-right'] = 'auto';
    }
  }

  const elements = node.children.filter(isElement);
  const hasText = node.children.some((c) => isText(c) && c.text.trim());
  if (!REPLACED.has(node.tag) && !FORM_CONTROL.has(node.tag) && display !== 'inline' && h > 0) {
    if (!elements.length && !hasText) {
      // An empty box (divider, colour block, image holder) only has the size it was given.
      if (!style.height) style.height = `${size.h(h)}px`;
      if (!style.width && !style['@w'] && !BLOCK_PARENT.has(pDisplay) && w > 0) style['@rw'] = { px: size.w(w), ratio: ratioOf(w) };
    } else if (elements.length && !hasText && !style['min-height'] && !style.height) {
      let bottom = 0;
      for (const c of elements) {
        const cd = c.views[v];
        if (!cd || cd.hidden || cd.rect[3] <= 0) continue;
        const cp = cd.style.position;
        if (cp === 'absolute' || cp === 'fixed') continue;
        bottom = Math.max(bottom, cd.rect[1] + cd.rect[3] + Math.max(0, num(cd.style['margin-bottom'])));
      }
      const extent = bottom - d.rect[1] + num(style['padding-bottom']) + num(style['border-bottom-width']);
      if (bottom > 0 && h - extent > 8 && h > extent * 1.05) style['min-height'] = `${size.h(h)}px`;
    }
  }

  if (fix?.w) style['@fw'] = { ...fix.w, px: size.w(fix.w.px), ratio: fix.w.ratio == null ? null : fix.w.ratio * (size.w(fix.w.px) / fix.w.px) };
  if (fix?.mh && !(px(style['min-height']) >= size.h(fix.mh))) style['min-height'] = `${size.h(fix.mh)}px`;
  return style;
}

/**
 * Resolves the sizing hints of one node across its views (mutates the declarations).
 * @w (a block narrower than its parent) and @fw (a fit-pass width) become a percentage when the
 * ratio to the parent is the same in every view, else a px value. @rw (images, SVG, fields) is
 * 100% when the element fills its parent, else px.
 */
export function resolveHints(decls, present, tag) {
  for (const key of ['@w', '@rw', '@fw']) {
    const hinted = present.filter((v) => decls[v]?.[key]);
    if (!hinted.length) continue;
    const ratios = hinted.map((v) => decls[v][key].ratio);
    const consistent = hinted.length === present.length && ratios.every((r) => r != null && Number.isFinite(r) && r > 0)
      && Math.max(...ratios) - Math.min(...ratios) <= 0.01;
    for (const v of hinted) {
      const hint = decls[v][key];
      delete decls[v][key];
      const full = hint.ratio != null && hint.ratio >= 0.995 && hint.ratio <= 1.005;
      const pxValue = `${Math.round(hint.px)}px`;
      if (key === '@rw') {
        decls[v].width = full ? '100%' : pxValue;
        if (!full && /^(img|video|iframe)$/.test(tag)) decls[v]['max-width'] = '100%';
        continue;
      }
      const value = consistent ? (full ? '100%' : pct(hint.ratio)) : pxValue;
      if (key === '@w') {
        if (consistent) decls[v].width = value;
        else decls[v]['max-width'] = value;
      } else if (hint.flex) decls[v].flex = `0 1 ${value}`;
      else decls[v].width = value;
    }
  }
}

/**
 * Base + overrides from per-view declarations. A view where the element does not exist hides it.
 * @param {Record<string, object|null>} decls  per view; null = the element is not in that view
 * @param {string[]} pageViews  the views captured for the page
 * @param {string} tag
 * @param {string} [hideProp]  'display' for elements, 'content' for pseudo-elements
 */
export function cascade(decls, pageViews, tag, hideProp = 'display') {
  const firstPresent = pageViews.map((v) => decls[v]).find(Boolean);
  if (!firstPresent) return null;
  let prev = decls.desktop ?? { ...firstPresent, [hideProp]: 'none' };
  const parts = { base: prev };
  for (const v of VIEW_IDS.slice(1)) {
    if (!pageViews.includes(v)) continue;
    const cur = decls[v] ?? { ...prev, [hideProp]: 'none' };
    const over = {};
    for (const p of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
      const a = prev[p] ?? fallback(p, tag);
      const b = cur[p] ?? fallback(p, tag);
      if (a !== b) over[p] = b;
    }
    if (Object.keys(over).length) parts[v] = over;
    prev = cur;
  }
  return parts;
}

const pseudoDecl = (p, assetFile) => (p ? { content: mapUrls(p.content, assetFile), ...p.style } : null);
const isEmpty = (parts) => !parts || (!Object.keys(parts.base).length && !parts.tablet && !parts.mobile);

/**
 * Computes rules and class names for every page tree. Sets `node.class` on elements that need one.
 * @param {{ root: object, views: string[] }[]} pages
 * @param {{ assetFile: (url:string)=>string|null }} opts
 * @returns {{ rules: { selector: string, parts: object }[], boxSizingReset: boolean, classCount: number }}
 */
export function buildStyles(pages, opts) {
  // Most sites set `* { box-sizing: border-box }`; write that once instead of on every element.
  let withBorderBox = 0;
  let elements = 0;
  const countBox = (n) => {
    if (!isElement(n)) return;
    const s = n.views.desktop?.style;
    if (s) {
      elements++;
      if (s['box-sizing'] === 'border-box') withBorderBox++;
    }
    n.children.forEach(countBox);
  };
  pages.forEach((p) => countBox(p.root));
  const boxSizingReset = elements > 0 && withBorderBox / elements >= 0.5;
  const o = { ...opts, boxSizingReset };

  const namer = new ClassNamer();
  const rules = new Map();
  const walk = (node, chain, pageViews, ctx) => {
    delete node.class;
    const present = pageViews.filter((v) => node.views[v]);
    const decls = {};
    for (const v of pageViews) decls[v] = node.views[v] ? normalizeView(node, v, chain, o) : null;
    resolveHints(decls, present, node.tag);
    const parts = cascade(decls, pageViews, node.tag);
    const pseudo = {};
    for (const which of ['before', 'after']) {
      const pd = {};
      for (const v of pageViews) pd[v] = pseudoDecl(node.views[v]?.[which], o.assetFile);
      if (Object.values(pd).some(Boolean)) pseudo[which] = cascade(pd, pageViews, 'span', 'content');
    }

    const desktop = node.views.desktop ?? node.views[present[0]];
    const display = desktop?.style.display ?? displayOf(node, present[0] ?? 'desktop');
    const hint = nameHint(node, {
      topLevel: ctx.topLevel,
      block: ctx.block,
      display,
      row: !/column/.test(desktop?.style['flex-direction'] ?? ''),
      buttonLike: node.tag === 'a' && !!desktop && ['background-color', 'padding-top', 'border-top-width'].some((p) => desktop.style[p] && desktop.style[p] !== 'rgba(0, 0, 0, 0)' && desktop.style[p] !== '0px'),
      iconSize: !!desktop && desktop.rect[2] <= 48 && desktop.rect[3] <= 48,
    });
    if (!isEmpty(parts) || Object.keys(pseudo).length) {
      const signature = JSON.stringify([parts, pseudo]);
      node.class = namer.name(hint.name, signature);
      if (!rules.has(node.class)) {
        rules.set(node.class, { selector: `.${node.class}`, parts });
        for (const [which, pp] of Object.entries(pseudo)) if (pp) rules.set(`${node.class}::${which}`, { selector: `.${node.class}::${which}`, parts: pp });
      }
    }
    const next = {
      block: hint.isBlock ? hint.name : ctx.block,
      topLevel: ctx.topLevel && !['section', 'article', 'aside', 'header', 'footer', 'nav'].includes(node.tag),
    };
    if (node.tag !== 'svg') for (const c of node.children) if (isElement(c)) walk(c, [...chain, node], pageViews, next);
  };
  for (const page of pages) walk(page.htmlNode ?? page.root, [], page.views, { block: null, topLevel: true });

  return { rules: [...rules.values()], boxSizingReset, classCount: namer.used.size };
}

export { BLOCK_TAGS };
