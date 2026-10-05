// Colour contrast (full-site D.2; user decision: fix with the smallest change, listed for review). Text whose colour does
// not stand out enough from the colour behind it (WCAG 2 AA: 4.5:1, or 3:1 for large text - 24 px, or 18.66 px bold) gets a
// darker (on a light background) or lighter (on a dark one) shade of the same hue, only as far as needed. The colour behind
// the text is the nearest solid background of its ancestors (semi-transparent ones blended); text over an image or a
// gradient cannot be judged from the styles and is left alone (listed as open). Runs on the merged trees before the styles
// are built, on every view the node has; captured styles are diffs (colour inherited from the parent unless set).
import { isElement, isText } from '../ir/tree.js';

const AA = 4.5;
const AA_LARGE = 3;
const MARGIN = 0.15; // a little above the line: rounding in the browser must not drop it below

/** 'rgb(1, 2, 3)' / 'rgba(1, 2, 3, 0.5)' / '#abc' → [r, g, b, a] or null. */
export function parseColor(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  return null;
}

const blend = (fg, bg) => {
  const a = fg[3] ?? 1;
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
};
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function toHsl([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function toRgb([h, s, l]) {
  if (!s) return [l, l, l].map((x) => Math.round(x * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((x) => Math.round(x * 255));
}
const hex = (rgb) => `#${rgb.slice(0, 3).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/**
 * The closest colour of the same hue that reaches `target` against `bg`: lightness moved away from the background.
 * @returns {number[]} rgb
 */
export function fixColor(fg, bg, target) {
  const [h, s, l] = toHsl(fg);
  const darker = luminance(bg) > 0.18;
  let lo = darker ? 0 : l;
  let hi = darker ? l : 1;
  let best = toRgb([h, s, darker ? 0 : 1]);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const rgb = toRgb([h, s, mid]);
    if (contrast(rgb, bg) >= target) {
      best = rgb;
      if (darker) lo = mid;
      else hi = mid;
    } else if (darker) hi = mid;
    else lo = mid;
  }
  return best;
}

const ownText = (n) => n.children.some((c) => isText(c) && c.text.trim());
const contains = (a, b) => isElement(a) && a.children.some((c) => c === b || contains(c, b));

/**
 * Fixes the text colours of one page tree. @returns {{ fixed: object[], open: object[] }}
 * @param {{ root: object, info: { path: string } }} tree
 */
export function fixContrast(tree) {
  const fixed = [];
  const open = [];
  const seen = new Set();
  const views = Object.keys(tree.root.views ?? { desktop: 1 });
  const MEDIA = new Set(['img', 'picture', 'video', 'canvas', 'svg', 'iframe']);
  for (const view of views) {
    // Pictures anywhere on the page: text whose centre lies on one (a hero photo behind a heading, positioned as a sibling)
    // has that picture behind it, not the background colour of its ancestors.
    const media = [];
    const collect = (n) => {
      if (!isElement(n)) return;
      const v = n.views?.[view];
      if (!v || v.hidden) return;
      const bgImage = v.style?.['background-image'] && v.style['background-image'] !== 'none';
      if ((MEDIA.has(n.tag) || bgImage) && v.rect?.[2] > 0 && v.rect?.[3] > 0) media.push({ node: n, rect: v.rect });
      n.children.forEach(collect);
    };
    collect(tree.root);
    const onPicture = (n, rect) => {
      const cx = rect[0] + rect[2] / 2;
      const cy = rect[1] + rect[3] / 2;
      return media.some((m) => m.node !== n && !contains(n, m.node) && cx >= m.rect[0] && cx <= m.rect[0] + m.rect[2] && cy >= m.rect[1] && cy <= m.rect[1] + m.rect[3]);
    };
    const walk = (n, ctx) => {
      if (!isElement(n)) return;
      const v = n.views?.[view];
      if (!v) return;
      const style = v.style ?? {};
      const color = parseColor(style.color) ?? ctx.color;
      const size = parseFloat(style['font-size']) || ctx.size;
      const weight = Number(style['font-weight']) || ctx.weight;
      let bg = ctx.bg;
      const own = parseColor(style['background-color']);
      if (style['background-image'] && style['background-image'] !== 'none') bg = null; // an image or a gradient: unknown
      else if (own && own[3] > 0 && bg) bg = blend(own, bg);
      else if (own && own[3] >= 1) bg = own;
      const next = { color, size, weight, bg };
      const shown = !v.hidden && v.rect?.[2] > 0 && v.rect?.[3] > 0;
      if (shown && ownText(n) && color) {
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const target = large ? AA_LARGE : AA;
        const sample = n.children.filter(isText).map((c) => c.text).join(' ').trim().slice(0, 60);
        if (!bg || onPicture(n, v.rect)) {
          if (!seen.has(n)) open.push({ page: tree.info.path, tag: n.tag, text: sample, reason: 'text over an image or gradient' });
        } else {
          const fg = blend(color, bg);
          const ratio = contrast(fg, bg);
          if (ratio < target) {
            const better = fixColor(fg, bg, target + MARGIN);
            const value = hex(better);
            v.style = { ...style, color: value };
            next.color = [...better, 1];
            if (!seen.has(n)) fixed.push({ page: tree.info.path, tag: n.tag, text: sample, from: style.color ?? hex(fg), to: value, background: hex(bg), before: Math.round(ratio * 100) / 100, after: Math.round(contrast(better, bg) * 100) / 100 });
          }
        }
        seen.add(n);
      }
      for (const c of n.children) walk(c, next);
    };
    // The page starts on the <html> element's colours (a dark site often sets them there, not on <body>), else the
    // browser's: black text on white. A background image on <html> means the colour behind the text is unknown.
    const html = tree.htmlNode?.views?.[view]?.style ?? {};
    const htmlBg = parseColor(html['background-color']);
    const start = {
      color: parseColor(html.color) ?? [0, 0, 0, 1],
      size: parseFloat(html['font-size']) || 16,
      weight: Number(html['font-weight']) || 400,
      bg: html['background-image'] && html['background-image'] !== 'none' ? null : htmlBg && htmlBg[3] > 0 ? blend(htmlBg, [255, 255, 255, 1]) : [255, 255, 255, 1],
    };
    walk(tree.root, start);
  }
  return { fixed, open };
}
