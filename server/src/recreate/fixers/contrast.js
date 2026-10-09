// Text colour contrast (axe `color-contrast`, WCAG 2 AA): text whose colour is too close to its background gets the
// smallest change that passes — its colour mixed toward black or white (whichever reaches the ratio), so the hue and the
// look stay as close to the original as possible. Only text that fails is changed.
//   1. The page the analysis scanned (the homepage): the elements its axe run found too faint, with the colours axe
//      measured in a real browser. Decorative text (aria-hidden, or a faint watermark laid over the layout) is drawn by
//      CSS (`::before { content }`) instead: it looks as designed and is no longer page text.
//   2. Every other text, from the captured styles, per view: the background is the nearest one behind the text
//      (semi-transparent ones blended, element opacity applied like a browser does). Text over a picture or a gradient,
//      and text nearly the colour of what seems behind it (something the styles do not show is really behind it), is left.
// Large text (24 px, or 18.66 px bold) needs 3:1, other text 4.5:1.
import { load } from 'cheerio';
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
const css = ([r, g, b]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

/**
 * The smallest mix of one side toward black or white that reaches `need`, with how far it had to move (`t`, 0–1).
 * `side` 'text' moves the text colour (drawn at `alpha`) over the fixed background `other`; 'background' moves the
 * background under the fixed text colour `other`.
 */
function bestMix(from, other, need, alpha, side) {
  const reached = (c) => (side === 'text' ? ratio(over(c, other, alpha), other) : ratio(over(other, c, alpha), c));
  if (reached(from) >= need) return null;
  let best = null;
  for (const target of [[0, 0, 0], [255, 255, 255]]) {
    if (reached(mix(from, target, 1)) < need) continue;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (reached(mix(from, target, mid)) >= need) hi = mid;
      else lo = mid;
    }
    if (!best || hi < best.t) best = { t: hi, color: mix(from, target, hi) };
  }
  return best;
}

/** The smallest mix of `fg` toward black or white that reaches `need` against `bg` (fg drawn at `alpha`), or null. */
export function passingColor(fg, bg, need, alpha = 1) {
  return bestMix(fg, bg, need, alpha, 'text')?.color ?? null;
}

// Moving the text further than this turns the design upside down (white button text ends up almost black): then the
// background is darkened instead, and where that is not safe the case is left for a person.
const MAX_TEXT_SHIFT = 0.5;

/**
 * The box whose own background colour the text is read on, when darkening (or lightening) that one box is safe: it is
 * the only layer behind the text, and every piece of text drawn on it has this same colour, so one change fixes them
 * all and spoils none. A box holding text of its own colours (a card with a heading in another colour) is not touched.
 * Subtrees with their own opaque background are left out: their text sits on that one, not on this box.
 */
/**
 * For a finding the audit measured (which carries colours, not boxes): the nearest box at or above the text that paints
 * exactly the background axe measured, when darkening it is safe (sharedBackdrop). The desktop view decides.
 */
function backdropOf(node, ancestors, bg, fg) {
  const chain = [node, ...[...ancestors].reverse()];
  for (let k = 0; k < chain.length; k++) {
    const own = parseColor(chain[k].views?.desktop?.style?.['background-color']);
    if (!own || own[3] === 0) continue;
    if (own[3] < 1 || own.join() !== bg.join()) return null; // a stack of layers, or not the colour axe read
    const above = k === 0 ? [...ancestors] : ancestors.slice(0, Math.max(0, ancestors.length - k));
    return sharedBackdrop(node, [own], chain[k], above, 'desktop', fg);
  }
  return null;
}

function sharedBackdrop(node, layers, bgNode, bgAncestors, v, fg) {
  if (layers.length !== 1 || !bgNode?.views?.[v]) return null;
  const same = (c) => c && c[0] === fg[0] && c[1] === fg[1] && c[2] === fg[2] && c[3] === fg[3];
  let ok = true;
  const visit = (n, ancestors) => {
    if (!ok || !isElement(n)) return;
    if (n !== bgNode) {
      const own = parseColor(n.views?.[v]?.style?.['background-color']);
      if (own && own[3] >= 1) return; // its text is read on its own background
    }
    if (ownText(n) && !same(parseColor(inherited(n, ancestors, v, 'color') ?? 'rgb(0, 0, 0)'))) ok = false;
    for (const c of n.children) visit(c, [...ancestors, n]);
  };
  visit(bgNode, bgAncestors);
  return ok ? bgNode : null;
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

const textOf = (n) => n.children.filter(isText).map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
const classesOf = (cls) => String(cls ?? '').split(/\s+/).filter(Boolean).sort().join(' ');
const hexToRgb = (hex) => parseColor(String(hex ?? '').trim().length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex);

/**
 * The original's own accessibility scan (axe, a real browser) of the page: the text it found too faint, with the colours it
 * measured. { tag, text, classes, fg, bg, need, ratio, hidden } per element. Exported for tests.
 */
export function axeContrastFindings(axe) {
  const rule = (axe?.violations ?? []).find((r) => r.id === 'color-contrast');
  const out = [];
  for (const node of rule?.nodes ?? []) {
    const data = node.any?.find((a) => a.id === 'color-contrast')?.data ?? node.any?.[0]?.data;
    const $ = load(node.html ?? '', null, false);
    const el = $.root().children().first();
    const fg = hexToRgb(data?.fgColor);
    const bg = hexToRgb(data?.bgColor);
    if (!el.length || !fg || !bg) continue;
    out.push({
      tag: el[0].name?.toLowerCase(),
      text: el.text().replace(/\s+/g, ' ').trim(),
      classes: classesOf(el.attr('class')),
      fg,
      bg,
      need: Number(data.expectedContrastRatio?.toString().replace(/:1$/, '')) || NORMAL,
      ratio: Number(data.contrastRatio) || 0,
      hidden: el.attr('aria-hidden') === 'true',
    });
  }
  return out;
}

// Decorative text (hidden from assistive technology, or a faint watermark laid over the layout): drawn by CSS instead
// (`::before { content }`), so it looks as designed and is no longer page text that has to be readable.
function toPseudo(n, text) {
  const content = `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  for (const view of Object.values(n.views ?? {})) if (view) view.before = { content, style: { ...(view.before?.style ?? {}) } };
  n.children = n.children.filter((c) => !isText(c));
  n.attrs = { ...n.attrs, 'aria-hidden': 'true' };
}

/**
 * @param {{ root: object, htmlNode?: object, info: { path: string } }} t  a merged page tree (mutated)
 * @param {{ axe?: object[] }} [o]  axeContrastFindings() of this page's original, when the analysis scanned it
 * @returns {{ fixed: object[], open: object[] }}
 */
export function fixContrast(t, { axe = [] } = {}) {
  const fixed = [];
  const open = [];
  const pending = [...axe];
  const walk = (n, ancestors) => {
    if (!isElement(n)) return;
    if (ownText(n)) {
      const text = textOf(n);
      const i = pending.findIndex((f) => f.tag === n.tag && f.text === text && f.classes === classesOf(n.attrs?.class));
      if (i >= 0) measured(n, ancestors, pending.splice(i, 1)[0], text);
      else check(n, ancestors);
    }
    n.children.forEach((c) => walk(c, [...ancestors, n]));
  };
  // An element the original's scan measured: its real colours decide (no guessing what is behind it).
  const measured = (n, ancestors, f, text) => {
    const position = n.views?.desktop?.style?.position ?? '';
    if (f.hidden || (f.ratio < 1.6 && /absolute|fixed/.test(position))) {
      toPseudo(n, text);
      fixed.push({ page: t.info.path, element: n.tag, field: 'decorative-text', value: text.slice(0, 60), source: `decorative text (contrast ${f.ratio}) drawn by CSS` });
      return;
    }
    const want = f.need + MARGIN;
    const textOpt = bestMix(f.fg, f.bg, want, 1, 'text');
    // As in check(): rather than turning the text almost black, darken the one box it is read on when that is safe.
    const box = backdropOf(n, ancestors, f.bg, f.fg);
    const backdrop = box ? bestMix(f.bg, f.fg, want, 1, 'background') : null;
    if (backdrop && (!textOpt || backdrop.t < textOpt.t)) {
      for (const view of Object.values(box.views ?? {})) {
        if (view && parseColor(view.style?.['background-color'])?.join() === f.bg.join()) view.style = { ...view.style, 'background-color': css(backdrop.color) };
      }
      fixed.push({ page: t.info.path, element: box.tag, field: 'background-color', from: css(f.bg), value: css(backdrop.color), source: `contrast ${f.ratio} → ${ratio(over(f.fg, backdrop.color, 1), backdrop.color).toFixed(2)} behind ${css(f.fg)} text (measured by the audit)` });
      return;
    }
    if (!textOpt) return;
    if (textOpt.t > MAX_TEXT_SHIFT) {
      open.push({ page: t.info.path, element: n.tag, detail: `Light text on a background nearly as light (contrast ${f.ratio}, measured by the audit): only a new colour for one of them reads well, which is a design choice` });
      return;
    }
    const better = textOpt.color;
    for (const view of Object.values(n.views ?? {})) if (view) view.style = { ...view.style, color: css(better) };
    fixed.push({ page: t.info.path, element: n.tag, field: 'color', from: css(f.fg), value: css(better), source: `contrast ${f.ratio} → ${ratio(better, f.bg).toFixed(2)} on ${css(f.bg)} (measured by the audit)` });
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
      let bgNode = null;
      let bgAncestors = [];
      const chain = [n, ...[...ancestors].reverse(), ...(t.htmlNode ? [t.htmlNode] : [])];
      for (const x of chain) {
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
          if (c[3] >= 1) {
            bgNode = x;
            // The ancestors of the box that paints the background, so inherited colours inside it can be read.
            // chain is [n, parent, grandparent, …], so the box at chain index k is ancestors[length − k].
            const k = chain.indexOf(x);
            bgAncestors = k === 0 ? [...ancestors] : ancestors.slice(0, Math.max(0, ancestors.length - k));
            break;
          }
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
      const need = large ? LARGE : NORMAL;
      const alpha = fg[3] * (opacity > 0 ? opacity : 1);
      const now = ratio(over(fg, bg, alpha), bg);
      // Only text that fails; and text nearly the colour of what seems to be behind it is left alone: then what is really
      // behind it is something the styles do not show (an overlay, a layer below), and a guess would spoil the design.
      if (now >= need || now < 1.6) continue;
      const want = need + MARGIN;
      const text = bestMix(fg, bg, want, alpha, 'text');
      // White text on a mid-tone brand colour (a button) only passes once it is almost black, which throws the design
      // away. Darkening that one box instead is a far smaller change and keeps the text as designed, so whichever side
      // moves less wins.
      const box = sharedBackdrop(n, layers, bgNode, bgAncestors, v, fg);
      const backdrop = box ? bestMix(bg, fg, want, alpha, 'background') : null;
      const pick = backdrop && (!text || backdrop.t < text.t) ? 'background' : text ? 'text' : null;
      if (!pick) continue;
      if (pick === 'background') {
        const bview = box.views[v];
        bview.style = { ...bview.style, 'background-color': css(backdrop.color) };
        changed ??= { page: t.info.path, element: box.tag, field: 'background-color', from: css(bg), value: css(backdrop.color), source: `contrast ${now.toFixed(2)} → ${ratio(over(fg, backdrop.color, alpha), backdrop.color).toFixed(2)} behind ${css(fg)} text` };
        continue;
      }
      if (text.t > MAX_TEXT_SHIFT) {
        open.push({ page: t.info.path, element: n.tag, detail: `Light text on a background nearly as light (contrast ${now.toFixed(2)}): only a new colour for one of them reads well, which is a design choice` });
        continue;
      }
      // Written as the colour it is seen as (alpha folded into it).
      const shown = over(text.color, bg, alpha);
      view.style = { ...view.style, color: css(shown) };
      changed ??= { page: t.info.path, element: n.tag, field: 'color', from: css(fg), value: css(shown), source: `contrast ${now.toFixed(2)} → ${ratio(shown, bg).toFixed(2)} on ${css(bg)}` };
    }
    if (changed) fixed.push(changed);
  };
  walk(t.root, []);
  return { fixed, open };
}
