// Text colour contrast (axe `color-contrast`, WCAG 2 AA): text whose colour is too close to its background gets the
// smallest change that passes — its colour mixed toward black or white (whichever reaches the ratio), so the hue and the
// look stay as close to the original as possible. Per captured view, on the element that holds the text, from the
// captured styles: the background is the nearest one behind the text (semi-transparent ones blended, element opacity
// applied like a browser does). Text over a picture or a gradient is left as it is and listed: its background is not one
// colour, and a person has to judge it. Large text (24 px, or 18.66 px bold) needs 3:1, other text 4.5:1.
import { isElement, isText } from '../ir/tree.js';

const NORMAL = 4.5;
const LARGE = 3;
const MARGIN = 0.08; // a little above the line, so rounding in the browser never lands below it

const RGB = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;

export function parseColor(value) {
  const m = RGB.exec(String(value ?? '').trim());
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  if (/^transparent$/i.test(String(value ?? '').trim())) return [0, 0, 0, 0];
  return null;
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top, bottom, alpha = top[3]) => [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)).concat(1);
const mix = (c, target, t) => [0, 1, 2].map((i) => Math.round(c[i] + (target[i] - c[i]) * t)).concat(1);
const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

/** The smallest mix of `fg` toward black or white that reaches `need` against `bg` (fg drawn at `alpha`), or null. */
export function passingColor(fg, bg, need, alpha = 1) {
  const shown = (c) => over(c, bg, alpha);
  if (ratio(shown(fg), bg) >= need) return null;
  let best = null;
  for (const target of [[0, 0, 0], [255, 255, 255]]) {
    if (ratio(shown(mix(fg, target, 1)), bg) < need) continue;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (ratio(shown(mix(fg, target, mid)), bg) >= need) hi = mid;
      else lo = mid;
    }
    if (!best || hi < best.t) best = { t: hi, color: mix(fg, target, hi) };
  }
  return best?.color ?? null;
}

const px = (v) => parseFloat(String(v ?? '')) || 0;
const ownText = (n) => n.children.some((c) => isText(c) && c.text.trim());
// What a value of this property is for this element in this view: its own, else the nearest ancestor's (inherited).
const inherited = (n, ancestors, v, prop) => {
  for (const x of [n, ...[...ancestors].reverse()]) {
    const value = x.views?.[v]?.style?.[prop];
    if (value !== undefined && value !== 'inherit') return value;
  }
  return undefined;
};

/**
 * @param {{ root: object, htmlNode?: object, info: { path: string } }} t  a merged page tree (mutated)
 * @returns {{ fixed: object[], open: object[] }}
 */
export function fixContrast(t) {
  const fixed = [];
  const open = [];
  const walk = (n, ancestors) => {
    if (!isElement(n)) return;
    if (ownText(n)) check(n, ancestors);
    n.children.forEach((c) => walk(c, [...ancestors, n]));
  };
  const check = (n, ancestors) => {
    let changed = null;
    for (const [v, view] of Object.entries(n.views ?? {})) {
      if (!view || view.hidden || !(view.rect?.[2] > 0)) continue;
      const fill = inherited(n, ancestors, v, '-webkit-text-fill-color');
      if (fill && !/currentcolor/i.test(fill)) continue; // gradient or clipped text: drawn by its background
      const fg = parseColor(inherited(n, ancestors, v, 'color') ?? 'rgb(0, 0, 0)');
      if (!fg || fg[3] === 0) continue;
      // Behind the text: own and ancestors' backgrounds, nearest first, until an opaque one.
      let bg = null;
      const layers = [];
      let picture = false;
      let opacity = 1;
      for (const x of [n, ...[...ancestors].reverse(), ...(t.htmlNode ? [t.htmlNode] : [])]) {
        const s = x.views?.[v]?.style ?? {};
        if (s.opacity !== undefined) opacity *= parseFloat(s.opacity);
        if (s['background-image'] && s['background-image'] !== 'none') {
          picture = true;
          break;
        }
        if (x !== n && (x.tag === 'img' || x.tag === 'video' || x.tag === 'canvas' || x.tag === 'svg')) {
          picture = true;
          break;
        }
        const c = parseColor(s['background-color']);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      if (picture) {
        if (!open.some((o) => o.page === t.info.path)) open.push({ page: t.info.path, element: n.tag, detail: 'Text over a picture or gradient: its contrast was left for a person to check' });
        continue;
      }
      bg = [255, 255, 255, 1];
      for (const c of layers.reverse()) bg = over(c, bg);
      const size = px(inherited(n, ancestors, v, 'font-size')) || 16;
      const weight = parseInt(inherited(n, ancestors, v, 'font-weight') ?? '400', 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = (large ? LARGE : NORMAL) + MARGIN;
      const alpha = fg[3] * (opacity > 0 ? opacity : 1);
      const better = passingColor(fg, bg, need, alpha);
      if (!better) continue;
      // An alpha colour keeps its alpha; the mix decides the shown colour (mixing already accounts for alpha).
      view.style = { ...view.style, color: css(better) };
      changed ??= { page: t.info.path, element: n.tag, field: 'color', from: css(fg), value: css(better), source: `contrast ${ratio(over(fg, bg, alpha), bg).toFixed(2)} → ${ratio(over(better, bg, alpha), bg).toFixed(2)} on ${css(bg)}` };
    }
    if (changed) fixed.push(changed);
  };
  walk(t.root, []);
  return { fixed, open };
}
