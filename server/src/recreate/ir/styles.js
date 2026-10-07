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
import { BLOCK_TAGS, deepText, displayOf, isElement, isText, VIEW_IDS } from './tree.js';
import { ClassNamer, nameHint } from './names.js';
import { fluidType, fluidTypeAt } from './typography.js';
import { VIEW_WIDTHS } from '../views.js';

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

// The width of one column of a grid (its captured px tracks, or n equal tracks of repeat(n, …) / 1fr lists), or null when
// the columns differ in width (the item's own column is then not known).
function gridColumnWidth(pStyle, contentW) {
  const value = String(pStyle['grid-template-columns'] ?? '').trim();
  if (!value || value === 'none' || value.includes('[')) return null;
  const gap = num(pStyle['column-gap']);
  const rep = /^repeat\(\s*(\d+)\s*,\s*(minmax\(\s*0(px)?\s*,\s*1fr\s*\)|1fr)\s*\)$/.exec(value);
  let tracks;
  if (rep) tracks = Array(Number(rep[1])).fill(null);
  else {
    tracks = value.split(/\s+(?![^(]*\))/);
    const pxs = tracks.map(px);
    if (pxs.every((t) => t != null)) return pxs.every((t) => Math.abs(t - pxs[0]) <= 1) ? pxs[0] : null;
    if (!tracks.every((t) => /^(1fr|minmax\(\s*0(px)?\s*,\s*1fr\s*\))$/.test(t))) return null;
  }
  const n = tracks.length;
  return n > 0 && contentW > 0 ? (contentW - gap * (n - 1)) / n : null;
}

// Badges, chips, labels and icon buttons: small, and narrower than their parent.
const isSmallBox = (w, h, ratio) => w <= 400 && h <= 200 && (ratio == null || ratio < 0.95);

const lineHeightPx = (fontSize, lineHeight) => (!lineHeight || lineHeight === 'normal' ? fontSize * 1.2 : px(lineHeight) ?? parseFloat(lineHeight) * fontSize);

// An inherited property of `node` in view `v`: its own captured value, else the nearest ancestor's (captured styles are
// diffs against the parent for inherited properties).
const inheritedValue = (node, chain, v, prop) => {
  for (const n of [node, ...[...chain].reverse()]) {
    const value = n.views?.[v]?.style?.[prop];
    if (value != null) return value;
  }
  return null;
};
const inheritedPx = (node, chain, v, prop, dflt) => px(inheritedValue(node, chain, v, prop)) ?? dflt;

// Height of the content box: padding and borders are not lines of text (a 40 px button with 14 px
// text is one line).
const contentHeight = (d) => d.rect[3]
  - num(d.style['padding-top']) - num(d.style['padding-bottom']) - num(d.style['border-top-width']) - num(d.style['border-bottom-width']);

/**
 * True when text inside `node` wrapped in view `v`: an element with its own text has a content box
 * taller than about 1.6 lines. Inherited font-size / line-height come from the nearest element that
 * sets them (captured styles are diffs against the parent for inherited properties).
 */
export function wrapsText(node, v, chain = []) {
  let fontSize = null;
  let lineHeight = null;
  for (const n of [...chain, node].reverse()) {
    const s = n.views[v]?.style ?? {};
    fontSize ??= px(s['font-size']);
    lineHeight ??= s['line-height'] ?? null;
  }
  const walk = (n, fs, lh) => {
    const d = n.views[v];
    if (!d || d.hidden) return false;
    const f = px(d.style['font-size']) ?? fs;
    const l = d.style['line-height'] ?? lh;
    if (n.children.some((c) => isText(c) && c.text.trim()) && contentHeight(d) > 1.6 * lineHeightPx(f, l)) return true;
    return n.tag !== 'svg' && n.children.some((c) => isElement(c) && walk(c, f, l));
  };
  return walk(node, fontSize ?? 16, lineHeight);
}

/**
 * Width of the containing block of an absolutely positioned (or fixed) box in view `v`: the viewport for a fixed box
 * and when no ancestor is positioned, else the padding box of the nearest positioned ancestor.
 */
/** Whether chain[pi] (the parent) is an item of a flex or grid container in view `v` (ancestors with display: contents skipped). */
function isFlexOrGridItem(chain, pi, v) {
  let gi = pi - 1;
  while (gi > 0 && chain[gi].views[v] && displayOf(chain[gi], v) === 'contents') gi--;
  const g = chain[gi];
  if (!g?.views[v]) return false;
  return /flex|grid/.test(g.views[v].style.display ?? displayOf(g, v));
}

function containingWidth(chain, v, position) {
  const viewport = chain[0]?.views[v]?.rect[2] ?? 0;
  if (position === 'fixed') return viewport;
  for (let i = chain.length - 1; i > 0; i--) {
    const d = chain[i].views[v];
    if (!d || d.hidden) continue;
    if (/^(relative|absolute|fixed|sticky)$/.test(d.style.position ?? '')) {
      return d.rect[2] - num(d.style['border-left-width']) - num(d.style['border-right-width']);
    }
  }
  return viewport;
}

/**
 * Height of the containing block of an absolutely positioned (or fixed) box in view `v`, at the captured window height
 * and at the taller one of the window-height probe (capture/viewport.js): [captured, probed]. The window itself when no
 * ancestor is positioned (`windowHeights`, null when unknown).
 */
function containingHeights(chain, v, position, windowHeights) {
  if (position !== 'fixed') {
    for (let i = chain.length - 1; i > 0; i--) {
      const d = chain[i].views[v];
      if (!d || d.hidden) continue;
      if (/^(relative|absolute|fixed|sticky)$/.test(d.style.position ?? '')) {
        const borders = num(d.style['border-top-width']) + num(d.style['border-bottom-width']);
        const [a, b] = d.vp?.h ?? [d.rect[3], d.rect[3]];
        return [a - borders, b - borders];
      }
    }
  }
  return windowHeights;
}

/**
 * A length that follows the window height: `a` at window height h1, `b` at h2 → `Ndvh` or `calc(Ndvh ± Cpx)`.
 * Null when the change is not a steady share of the window (content that merely grew).
 */
export function followWindow(a, b, [h1, h2]) {
  const k = (b - a) / (h2 - h1);
  if (!(k >= 0.05 && k <= 2)) return null;
  const share = Math.round(k * 1000) / 10;
  const c = a - (share / 100) * h1;
  if (Math.abs(b - ((share / 100) * h2 + c)) > 2) return null;
  const unit = `${share}dvh`;
  return Math.abs(c) <= 1.5 ? unit : `calc(${unit} ${c < 0 ? '-' : '+'} ${round(Math.abs(c))}px)`;
}

const TRANSLATE = /^matrix\(1, 0, 0, 1, ([-\d.e]+), ([-\d.e]+)\)$/;

/**
 * Screen-size-independent sizes and offsets (applied last, over the px values above). A capture reads everything in px
 * at one window size, so a full-screen hero (min-height: 100vh) came out as 900 px and a box centred with
 * `top: 50%; left: 50%; transform: translate(-50%, -50%)` as `top: 450px; left: 720px`, right on a 1440 × 900 screen
 * only. Two kinds of evidence, both general:
 *   - the centring idiom: an inset at half the containing block with a translate of minus half the own size;
 *   - the window-height probe (`d.vp`): what changed when the window got taller - a min-height or height that is a
 *     share of the window becomes dvh, an inset that is a share of its containing block becomes %, an inset that did
 *     not move is the anchor, and a box held by two fixed insets gets no px height.
 */
export function viewportStyle(style, node, v, chain) {
  const d = node.views[v];
  const position = d.style.position ?? 'static';
  const abs = position === 'absolute' || position === 'fixed';
  const [, , w, h] = d.rect;
  const size = sizer(node, d.style);
  const vp = d.vp;

  if (abs && !REPLACED.has(node.tag)) {
    const m = TRANSLATE.exec(d.style.transform ?? '');
    if (m) {
      const [tx, ty] = [parseFloat(m[1]), parseFloat(m[2])];
      const cbW = containingWidth(chain, v, position);
      const cbH = containingHeights(chain, v, position, vp?.vh ?? null)?.[0] ?? 0;
      const left = px(d.style.left);
      const top = px(d.style.top);
      const centreX = left != null && cbW > 0 && Math.abs(left - cbW / 2) <= 1 && w > 0 && Math.abs(tx + w / 2) <= 1;
      const centreY = top != null && cbH > 0 && h > 0 && Math.abs(top - cbH / 2) <= 1 && Math.abs(ty + h / 2) <= 1;
      if (centreX) {
        style.left = '50%';
        delete style.right;
        // Without the right inset the box would shrink to its content in the room right of the middle: it keeps its
        // width (100 % when it sits at its max-width, a capped full width; else the px, never wider than the room).
        if (!style.width && w > 0) {
          const maxW = px(style['max-width']);
          if (maxW != null && Math.abs(maxW - size.w(w)) <= 1) style.width = '100%';
          else {
            // One line of text (a centred message, a badge): as wide as its text, never a px width a slightly wider
            // rendering of the same text would wrap in.
            const oneLine = deepText(node).trim() && !wrapsText(node, v, chain);
            style.width = oneLine ? 'max-content' : `${Math.ceil(size.w(w))}px`;
            style['max-width'] ??= '100%';
          }
        }
      }
      if (centreY) {
        style.top = '50%';
        delete style.bottom;
      }
      if (centreX || centreY) style.transform = `translate(${centreX ? '-50%' : `${round(tx)}px`}, ${centreY ? '-50%' : `${round(ty)}px`})`;
    }
  }

  if (!vp) return style;
  const [h1, h2] = vp.vh;
  const heightChanged = Math.abs(vp.h[0] - vp.h[1]) > 1.5;

  if (abs && vp.top && vp.bottom && style.top !== '50%') {
    const cb = containingHeights(chain, v, position, vp.vh) ?? [0, 0];
    const kind = ([a, b]) => {
      if (a == null || b == null) return null;
      if (Math.abs(a - b) <= 1) return { value: `${round(a)}px`, stable: true };
      if (cb[0] > 0 && cb[1] > 0 && Math.abs(cb[0] - cb[1]) > 1.5 && Math.abs(a / cb[0] - b / cb[1]) <= 0.003) return { value: pct(a / cb[0]) };
      return null;
    };
    const t = kind(vp.top);
    const b = kind(vp.bottom);
    if (t?.stable && b?.stable && heightChanged) {
      // Held by both insets: the height comes from them, on every screen.
      style.top = t.value;
      style.bottom = b.value;
      if (px(style.height) != null) delete style.height;
    } else {
      const anchor = t?.stable ? ['top', t] : b?.stable ? ['bottom', b] : t ? ['top', t] : b ? ['bottom', b] : null;
      if (anchor) {
        style[anchor[0]] = anchor[1].value;
        delete style[anchor[0] === 'top' ? 'bottom' : 'top'];
      }
    }
  }

  if (vp.mh) {
    const value = followWindow(vp.mh[0], vp.mh[1], [h1, h2]);
    if (value) {
      style['min-height'] = value;
      // The px height the capture guessed for a box without in-flow content would cap it at the captured screen.
      if (px(style.height) != null) delete style.height;
    }
  } else if (heightChanged && !(abs && style.top && style.bottom && style.height == null)) {
    const value = followWindow(size.h(vp.h[0]), size.h(vp.h[1]), [h1, h2]);
    if (value) {
      if (px(style.height) != null) style.height = value;
      if (px(style['min-height']) != null) style['min-height'] = value;
    }
  }
  return style;
}

/**
 * Fluid text declarations of a node in view `v` (capture/typography.js probes the desktop view only): the desktop's fluid
 * values, and in a narrower view the ones that give that view's captured px at its width (ir/typography.js fluidTypeAt).
 */
function fluidDecls(node, v) {
  const d = node.views[v];
  if (v === 'desktop') return d?.ty ? fluidType(d.ty) : {};
  const ty = node.views.desktop?.ty;
  return ty && d ? fluidTypeAt(ty, VIEW_WIDTHS[v], d.style) : {};
}

/**
 * The declarations of one node in one view, with sizing hints (@w, @rw, @fw) that are resolved
 * across views afterwards.
 */
export function normalizeView(node, v, chain, opts) {
  const d = node.views[v];
  const style = { ...d.style };
  const [x, , w, h] = d.rect;
  // The layout parent: display: contents wrappers (builder variant wrappers) generate no box, so
  // the element is laid out by the nearest ancestor that does.
  let pi = chain.length - 1;
  while (pi > 0 && chain[pi].views[v] && displayOf(chain[pi], v) === 'contents') pi--;
  const parent = chain[pi];
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
  // Text sized with the window (capture/typography.js): px minimums taken from its size at the captured width would keep
  // the box at that size on other screens (a headline line 76 px tall where the text has shrunk to 68).
  const fluidText = Boolean(fluidDecls(node, v)['font-size']);

  if (/grid/.test(display)) {
    const box = contentBox(node, v);
    const gap = num(style['column-gap']);
    if (style['grid-template-columns']) style['grid-template-columns'] = gridTracks(style['grid-template-columns'], box.w, gap);
    // Computed rows are the heights of the content, so they are left to the content, except rows collapsed to nothing:
    // that is a closed panel (an accordion answer at grid-template-rows: 0fr), and without it the panel shows open.
    const rows = (style['grid-template-rows'] ?? '').trim().split(/\s+/).filter(Boolean);
    if (rows.length && rows.every((r) => /^0(\.0+)?px$/.test(r)) && node.children.some(isElement)) style['grid-template-rows'] = rows.map(() => '0fr').join(' ');
    else delete style['grid-template-rows'];
  }

  if (position === 'absolute' || position === 'fixed') {
    // Captured boxes are layout sizes, also for rotated or scaled elements (capture/snapshot.js), so
    // an absolutely positioned box keeps its size whatever its transform; without it, a rotated or
    // floating tile shrinks to its content.
    const sized = true;
    const cbW = containingWidth(chain, v, position);
    let fullWidth = false;
    for (const [a, b, prop, value] of [['left', 'right', 'width', size.w(w)], ['top', 'bottom', 'height', size.h(h)]]) {
      const va = px(style[a]);
      const vb = px(style[b]);
      if (va != null && vb != null && Math.abs(va) <= 1 && Math.abs(vb) <= 1) {
        // Stretched: inset 0. A size another view sets (a centred 410 px box on desktop) must not carry over through the
        // cascade, else the fit pass pins this view at its captured px (a card's dark layer stopped short of the card).
        const sizedElsewhere = Object.entries(node.views).some(([k, od]) => k !== v && od && (od.style.position ?? 'static') === position
          && !(Math.abs(px(od.style[a]) ?? 99) <= 1 && Math.abs(px(od.style[b]) ?? 99) <= 1));
        if (sizedElsewhere && !REPLACED.has(node.tag)) style[prop] = 'auto';
        continue;
      }
      // A box that fills the width between its two insets (a fixed header with a margin on each side) is stretched
      // by them: with a px width it would overflow on every screen narrower than the captured one. The browser reports
      // both insets of every absolute box, so this alone says nothing: an inset that moves between the captured views
      // (right 370 px at 1440, 566 at 1024 for a 340 px card) belongs to a box of its own width, which keeps it.
      const insetsMove = Object.entries(node.views).some(([k, od]) => {
        if (k === v || !od || (od.style.position ?? 'static') !== position) return false;
        const oa = px(od.style[a]);
        const ob = px(od.style[b]);
        return oa != null && ob != null && (Math.abs(oa - va) > 2 || Math.abs(ob - vb) > 2);
      });
      if (prop === 'width' && va != null && vb != null && cbW > 0 && !REPLACED.has(node.tag) && Math.abs(cbW - va - vb - w) <= 1.5 && !insetsMove) continue;
      if (va != null && vb != null) delete style[Math.abs(va) <= Math.abs(vb) ? b : a];
      if (sized && value > 0 && !REPLACED.has(node.tag)) {
        // A box as wide as its containing block stays that wide on other screens: anchored at its left edge, or centred
        // (left: 50% with a translate back by half its size - a hero picture as wide as the window).
        const centred = va != null && cbW > 0 && Math.abs(va - cbW / 2) <= 1.5 && /translate|matrix/.test(style.transform ?? '');
        const full = prop === 'width' && cbW > 0 && value / cbW >= 0.995 && value / cbW <= 1.005
          && (centred || ((va == null || Math.abs(va) <= 1) && (vb == null || Math.abs(vb) <= 1)));
        if (full) fullWidth = true;
        // Its height then follows from its own aspect ratio (a px height would keep the captured window's size).
        if (prop === 'height' && fullWidth && style['aspect-ratio'] && style['aspect-ratio'] !== 'auto') continue;
        style[prop] = full ? '100%' : `${value}px`;
      }
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
      // Filling a parent stretched over its own frame (absolute, top and bottom at 0): the picture takes that height, which
      // follows the frame on every screen (a hero background 712 px tall in an 880 px frame at 1265).
      const pAbs = /^(absolute|fixed)$/.test(pd.style.position ?? '');
      const pStretchedY = pAbs && Math.abs(px(pd.style.top) ?? 99) <= 1 && Math.abs(px(pd.style.bottom) ?? 99) <= 1;
      if (style.height !== 'auto' && pStretchedY && pBox.h > 0 && Math.abs(h - pBox.h) <= 1 && Math.abs(w - pBox.w) <= 1) style.height = '100%';
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
  } else if (!fix?.w && /flex|grid/.test(pDisplay) && (position === 'static' || position === 'relative') && w > 0
    && !REPLACED.has(node.tag) && !FORM_CONTROL.has(node.tag) && display !== 'contents') {
    // A flex or grid item sized by its content (flex row: no flex-grow; flex column: not stretched;
    // grid: justify-self other than stretch) had a definite width (builders set width: 50%, 100% or
    // px on it), which the capture leaves out. Without it the item shrinks or grows to its content:
    // text stops wrapping and pushes siblings out, or an image frame collapses to 0.
    let contentSized;
    if (/grid/.test(pDisplay)) {
      const justifySelf = style['justify-self'] && !/^(auto|normal)$/.test(style['justify-self']) ? style['justify-self'] : pd.style['justify-items'] ?? 'normal';
      contentSized = !/^(normal|stretch|legacy)$/.test(justifySelf);
    } else {
      const row = !/column/.test(pd.style['flex-direction'] ?? '');
      const alignSelf = style['align-self'] && style['align-self'] !== 'auto' ? style['align-self'] : pd.style['align-items'] ?? 'normal';
      contentSized = row ? !(parseFloat(style['flex-grow'] ?? '0') > 0) : !/^(normal|stretch)$/.test(alignSelf);
    }
    // Hinted in every view where it holds text; applied when the text wraps in any view, or when the
    // item is a flex row around a zero-basis growing child (flex: 1 0 0): browsers size such a row
    // from that basis, so without a width it shrinks to its min-content width (one word per line).
    const zeroBasisRow = /flex/.test(display) && !/column/.test(style['flex-direction'] ?? '') && node.children.some((c) => {
      const cs = c.views?.[v]?.style;
      return cs && !c.views[v].hidden && parseFloat(cs['flex-grow'] ?? '0') > 0 && /^0(px|%)?$/.test(cs['flex-basis'] ?? '');
    });
    // An item that fills its parent's width keeps doing so (width: 100%): a content-sized ancestor
    // would otherwise leave the percentages of its descendants nothing to resolve against.
    const ratio = ratioOf(w);
    const fills = ratio != null && ratio >= 0.995 && ratio <= 1.005;
    // A grid item as wide as its column (a card at justify-self: start with width: 100% in the builder): it fills its cell
    // at every width, not the captured px (product cards stayed 397 px in 528 px columns at 1265).
    const gridCol = /grid/.test(pDisplay) ? gridColumnWidth(pd.style, pBox.w) : null;
    const cell = gridCol != null && gridCol > 0 && Math.abs(size.w(w) - gridCol) <= 1.5 && !fills;
    // Without text (icon boxes, image frames) the content cannot size the item reliably: an SVG or
    // image at width: 100% inside it falls back to its default size (300 px for SVG). Keep the width.
    const text = deepText(node).trim();
    if (contentSized) style['@cw'] = { px: size.w(w), ratio, cell, text: !!text, wraps: !text || fills || cell || zeroBasisRow || wrapsText(node, v, chain) };
    // A content-sized item with text can still have a fixed size larger than its text (a 22 px badge
    // around 6 px letters, a 52 px label): minimums restore it without ever cutting or wrapping text.
    // Only small boxes that do not fill their parent: a minimum on a large container would keep it
    // from shrinking between the captured widths.
    if (contentSized && text && h > 0 && isSmallBox(w, h, ratio) && !fluidText) {
      const minW = Math.floor(size.w(w)) - 1;
      const minH = Math.round(size.h(h));
      if (minW > 0 && !style['min-width']) style['min-width'] = `${minW}px`;
      if (minH > 0 && !style.height && !style['min-height']) style['min-height'] = `${minH}px`;
    }
    // An item of a flex column that stretches its items, yet narrower than the column: it had a width of its own (a
    // button at width: fit-content). Without it the copy stretched it across the column (a 140 px button became 319 px).
    const column = /flex/.test(pDisplay) && /column/.test(pd.style['flex-direction'] ?? '');
    if (column && !contentSized && !style.width && w > 0) {
      const room = pBox.w - num(style['margin-left']) - num(style['margin-right']);
      const maxW = px(style['max-width']);
      const capped = maxW != null && Math.abs(maxW - size.w(w)) <= 1; // its own max-width already makes it narrower
      if (room > 0 && w < room - 2 && !capped) {
        style.width = text && !wrapsText(node, v, chain) ? 'fit-content' : `min(${Math.round(size.w(w))}px, 100%)`;
      }
    }
  }

  // Inline-level boxes (badges, chips, avatars, labels) often have a fixed size larger than their
  // text; without it they shrink to the text. Minimums restore it and can never cut or wrap content
  // (the width one pixel under the captured one, so boxes sharing a line never overflow it).
  if (/^inline-(block|flex|grid)$/.test(display) && !REPLACED.has(node.tag) && !FORM_CONTROL.has(node.tag) && !fluidText
    && (position === 'static' || position === 'relative') && w > 0 && h > 0 && !fix?.w && isSmallBox(w, h, ratioOf(w))) {
    const minW = Math.floor(size.w(w)) - 1;
    const minH = Math.round(size.h(h));
    if (minW > 0 && !style.width && !style['min-width']) style['min-width'] = `${minW}px`;
    if (minH > 0 && !style.height && !style['min-height']) style['min-height'] = `${minH}px`;
  }

  const elements = node.children.filter(isElement);
  const hasText = node.children.some((c) => isText(c) && c.text.trim());
  // Children that take up space in this view (absolutely positioned or hidden ones do not). A
  // display: contents wrapper has no box: its own children count in its place.
  const flowChildren = (n) => n.children.filter(isElement).flatMap((c) => {
    const cd = c.views[v];
    if (!cd || cd.hidden || /^(absolute|fixed)$/.test(cd.style.position ?? '')) return [];
    if (displayOf(c, v) === 'contents') return [...flowChildren(c), ...(c.children.some((t) => isText(t) && t.text.trim()) ? [c] : [])];
    return [c];
  });
  const inFlow = flowChildren(node);
  // A closed panel (height: 0; overflow: hidden - an accordion answer, a collapsed menu): the capture leaves heights
  // out, so without this the content shows open. A parent of no height holds the collapse itself (grid rows at 0fr).
  if (h <= 1 && !REPLACED.has(node.tag) && display !== 'inline' && /^(hidden|clip)$/.test(style['overflow-y'] ?? '')
    && (inFlow.length || hasText) && (pd.rect?.[3] ?? 0) > 1 && !style['max-height']) {
    style.height = '0px';
  }
  // A small box holding one line of text but taller than that line (a numbered circle, a badge, a fixed-height chip): its
  // height was set, and without it the box shrinks to the line (a 26 px circle became a 26 × 17 oval). A minimum, so text is
  // never cut. One line: the text fits the content width at an average glyph width.
  if (hasText && !fluidText && !inFlow.length && !REPLACED.has(node.tag) && !FORM_CONTROL.has(node.tag) && display !== 'inline' && h > 0 && w > 0
    && isSmallBox(w, h, ratioOf(w)) && !style.height && !style['min-height']) {
    const fontSize = inheritedPx(node, chain, v, 'font-size', 16);
    const line = lineHeightPx(fontSize, inheritedValue(node, chain, v, 'line-height'));
    const padY = num(style['padding-top']) + num(style['padding-bottom']) + num(style['border-top-width']) + num(style['border-bottom-width']);
    const padX = num(style['padding-left']) + num(style['padding-right']) + num(style['border-left-width']) + num(style['border-right-width']);
    const oneLine = deepText(node).trim().length * fontSize * 0.62 <= Math.max(0, w - padX);
    if (oneLine && h - (line + padY) > 4) style['min-height'] = `${size.h(h)}px`;
  }
  if (!REPLACED.has(node.tag) && !FORM_CONTROL.has(node.tag) && display !== 'inline' && h > 0) {
    if (!inFlow.length && !hasText) {
      // An empty box (divider, colour block, image holder) only has the size it was given. Builders
      // often place the image of a frame absolutely (inset 0) inside it: the frame is empty too.
      // An absolute box held by both insets of an axis at 0 (a dark layer over a card) takes that size from its containing
      // block: a px size would keep the captured card's size on other screens.
      const absBox = position === 'absolute' || position === 'fixed';
      const atZero = (k) => style[k] != null && Math.abs(px(style[k]) ?? 99) <= 1;
      const stretchedX = absBox && atZero('left') && atZero('right');
      const stretchedY = absBox && atZero('top') && atZero('bottom');
      // A box as wide as its containing block with an aspect ratio of its own gets its height from that ratio.
      const ratioSized = style.width === '100%' && style['aspect-ratio'] && style['aspect-ratio'] !== 'auto';
      if (!style.height && !stretchedY && !ratioSized) style.height = `${size.h(h)}px`;
      if (stretchedX) {
        // nothing: the insets size it
      } else if (!style.width && !style['@w'] && !BLOCK_PARENT.has(pDisplay) && w > 0) style['@rw'] = { px: size.w(w), ratio: ratioOf(w) };
      // An empty box that is all its parent holds, where that parent is itself a flex / grid item (a logo frame in the list
      // item of a ticker row): the parent's size comes from this box, so without its own px width both shrink to 0 as
      // soon as the row is fuller than the screen (logos vanished).
      else if (!style.width && !style['@w'] && w > 0 && BLOCK_PARENT.has(pDisplay) && Math.abs(w - pBox.w) <= 1 && isFlexOrGridItem(chain, pi, v)) {
        style.width = `${size.w(w)}px`;
        style['flex-shrink'] ??= '0';
      }
    } else if (elements.length && !hasText && !style['min-height'] && !style.height) {
      let bottom = 0;
      for (const c of elements) {
        const cd = c.views[v];
        if (!cd || cd.hidden || cd.rect[3] <= 0) continue;
        const cp = cd.style.position;
        if (cp === 'absolute' || cp === 'fixed') continue;
        bottom = Math.max(bottom, cd.rect[1] + cd.rect[3] + Math.max(0, num(cd.style['margin-bottom'])));
      }
      let extent = bottom - d.rect[1] + num(style['padding-bottom']) + num(style['border-bottom-width']);
      // A flex column can spread its children (space-between, center, end): the last child then sits
      // at the bottom edge although the content is shorter. Its content is the sum of the children.
      if (/flex/.test(display) && /column/.test(style['flex-direction'] ?? '') && inFlow.length) {
        const sum = inFlow.reduce((n, c) => {
          const cd = c.views[v];
          return n + cd.rect[3] + Math.max(0, num(cd.style['margin-top'])) + Math.max(0, num(cd.style['margin-bottom']));
        }, 0);
        extent = Math.min(extent, sum + num(style['row-gap']) * (inFlow.length - 1)
          + num(style['padding-top']) + num(style['padding-bottom']) + num(style['border-top-width']) + num(style['border-bottom-width']));
      }
      if (bottom > 0 && h - extent > 8 && h > extent * 1.05) style['min-height'] = `${size.h(h)}px`;
    }
  }

  if (fix?.w) style['@fw'] = { ...fix.w, px: size.w(fix.w.px), ratio: fix.w.ratio == null ? null : fix.w.ratio * (size.w(fix.w.px) / fix.w.px) };
  if (fix?.mh && !(px(style['min-height']) >= size.h(fix.mh))) style['min-height'] = `${size.h(fix.mh)}px`;
  // Text sized with the window (capture/typography.js): the fluid value instead of the px of the captured width.
  Object.assign(style, fluidDecls(node, v));
  return viewportStyle(style, node, v, chain);
}

/**
 * Resolves the sizing hints of one node across its views (mutates the declarations).
 * @w (a block narrower than its parent) and @fw (a fit-pass width) become a percentage when the
 * ratio to the parent is the same in every view, else a px value. @rw (images, SVG, fields) is
 * 100% when the element fills its parent, else px.
 */
export function resolveHints(decls, present, tag) {
  // @cw: a content-sized flex item with text. When its text wraps in any view it had a definite
  // width: `width` in every hinted view (a percentage when the ratio holds everywhere), never only
  // max-width, which cannot stop a flex container from shrinking to its min-content width.
  const cw = present.filter((v) => decls[v]?.['@cw']);
  if (cw.length) {
    const apply = cw.some((v) => decls[v]['@cw'].wraps);
    const ratios = cw.map((v) => decls[v]['@cw'].ratio);
    const pxs = cw.map((v) => decls[v]['@cw'].px);
    // The same px in every view is a fixed size (an icon box), not a share of the parent. With a single captured view
    // (a capture made while only desktop was on) nothing says the width is a share of the parent: the captured px is kept.
    const single = present.length === 1;
    const fixed = single || (cw.length > 1 && Math.max(...pxs) - Math.min(...pxs) <= 1);
    const consistent = !fixed && cw.length === present.length && ratios.every((r) => r != null && Number.isFinite(r) && r > 0)
      && Math.max(...ratios) - Math.min(...ratios) <= 0.01;
    // An item wider than its parent on purpose (a marquee track, a scroller) must not be clamped.
    const overflows = ratios.some((r) => r != null && r > 1.01);
    const allCells = cw.every((v) => decls[v]['@cw'].cell || (decls[v]['@cw'].ratio >= 0.995 && decls[v]['@cw'].ratio <= 1.005));
    for (const v of cw) {
      const hint = decls[v]['@cw'];
      delete decls[v]['@cw'];
      if (!apply || decls[v].width) continue;
      // One view: an item exactly as wide as its parent still fills it.
      if (single && hint.ratio >= 0.995 && hint.ratio <= 1.005) decls[v].width = '100%';
      // As wide as its grid column in this view: it fills its cell (a percentage of a grid item is of its grid area).
      // Only when it does so in every view and its width changes between them (a fixed-size logo tile that happens to be
      // as wide as its fixed column keeps its px).
      else if (hint.cell && hint.text && allCells && !single && !fixed) decls[v].width = '100%';
      else if (consistent) decls[v].width = hint.ratio >= 0.995 && hint.ratio <= 1.005 ? '100%' : pct(hint.ratio);
      // Filling its parent in this view (a card in a one-column grid at laptop width) while the views differ otherwise:
      // it keeps filling it between the captured widths instead of staying at the captured px (cards too narrow at 1200).
      else if (!fixed && hint.ratio >= 0.995 && hint.ratio <= 1.005) decls[v].width = '100%';
      else {
        // Text gets a pixel of slack: the same label can measure a fraction wider here than in the
        // original, and a width cut to the pixel would wrap it onto a second line.
        decls[v].width = `${hint.text ? Math.ceil(hint.px) + 1 : Math.round(hint.px)}px`;
        if (!overflows) decls[v]['max-width'] ??= '100%';
      }
    }
  }
  for (const key of ['@w', '@rw', '@fw']) {
    const hinted = present.filter((v) => decls[v]?.[key]);
    if (!hinted.length) continue;
    const ratios = hinted.map((v) => decls[v][key].ratio);
    // One captured view (a capture made while only desktop was on): a single ratio is no evidence of a share of the parent, so the px is
    // kept (a 40 px icon must not become 2.78 %); an element that fills its parent still gets 100 %.
    const single = present.length === 1;
    const consistentRatios = hinted.length === present.length && ratios.every((r) => r != null && Number.isFinite(r) && r > 0)
      && Math.max(...ratios) - Math.min(...ratios) <= 0.01;
    for (const v of hinted) {
      const hint = decls[v][key];
      delete decls[v][key];
      const full = hint.ratio != null && hint.ratio >= 0.995 && hint.ratio <= 1.005;
      const consistent = consistentRatios && (!single || full);
      const pxValue = `${Math.round(hint.px)}px`;
      if (key === '@rw') {
        decls[v].width = full ? '100%' : pxValue;
        // Never wider than the parent: a px width taken from one captured view overflows on a narrower screen.
        if (!full && /^(img|video|iframe|input|select|textarea|button)$/.test(tag)) decls[v]['max-width'] = '100%';
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

// The capture keeps only values that differ from the default, and a border side of width 0 looks like the default. A side
// with a border style but no width would then get the browser's "medium" (3 px): a builder's 1 px divider on one side of a
// ::after drew a full box. Such sides are written as 0 px.
export function fillBorderWidths(decl) {
  if (!decl || decl.border != null || decl['border-width'] != null) return decl;
  // border-style shorthand: 1 value = all sides, 2 = top/bottom + right/left, 3 = top + right/left + bottom, 4 = each.
  const v = String(decl['border-style'] ?? '').split(/\s+/).filter(Boolean);
  const short = v.length ? [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]] : [];
  ['top', 'right', 'bottom', 'left'].forEach((side, i) => {
    const style = decl[`border-${side}-style`] ?? short[i];
    if (style && style !== 'none' && style !== 'hidden' && decl[`border-${side}-width`] == null) decl[`border-${side}-width`] = '0px';
  });
  return decl;
}

const pseudoDecl = (p, assetFile) => (p ? fillBorderWidths({ content: mapUrls(p.content, assetFile), ...p.style }) : null);
const isEmpty = (parts) => !parts || (!Object.keys(parts.base).length && !parts.laptop && !parts.tablet && !parts.mobile);

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
    for (const v of pageViews) decls[v] = node.views[v] ? fillBorderWidths(normalizeView(node, v, chain, o)) : null;
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
