// Fluid typography from the window-width probe (capture/typography.js, step 3 of the "as is" fixes). A font size read at
// several widths becomes the CSS that gives the same sizes: unchanged → the captured px; following the width → a line
// `calc(A + Bvw)`; flat at the wide or narrow end → that line capped (`min()` / `max()` / `clamp()`), as sites write
// clamp(40px, 5vw, 76px). Line height and letter spacing that keep their ratio to the font size become a unitless ratio / em,
// so they follow it. General: only the measured values are used, nothing about the site.

const r = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const tolerance = (v) => Math.max(0.35, Math.abs(v) * 0.01);

/**
 * The CSS length that gives `values` (px) at window `widths`, or null when it does not change (or fits no line).
 * @param {number[]} widths
 * @param {(number|null)[]} values
 */
export function fluidLength(widths, values) {
  return fluidFit(widths, values)?.css ?? null;
}

/**
 * The fit behind fluidLength: `{ css, at(width) }` (`at` = the px the written CSS gives at a window width), or null.
 * @param {number[]} widths
 * @param {(number|null)[]} values
 */
export function fluidFit(widths, values) {
  const pts = widths.map((w, i) => [w, values[i]]).filter(([, v]) => v != null);
  if (pts.length < 3) return null;
  const vs = pts.map((p) => p[1]);
  const hiV = Math.max(...vs);
  const loV = Math.min(...vs);
  if (hiV - loV <= 0.25) return null;
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const [wi, vi] = pts[i];
      const [wj, vj] = pts[j];
      if (Math.abs(vi - vj) <= 0.25 || wi === wj) continue;
      const b = (vj - vi) / (wj - wi);
      const a = vi - b * wi;
      const line = (w) => a + b * w;
      // A cap is used only where the line would pass the value the page stopped at.
      const hi = pts.some(([w, v]) => line(w) > v + tolerance(v) && Math.abs(v - hiV) <= 0.25) ? hiV : null;
      const lo = pts.some(([w, v]) => line(w) < v - tolerance(v) && Math.abs(v - loV) <= 0.25) ? loV : null;
      const at = (w) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, line(w)));
      if (!pts.every(([w, v]) => Math.abs(at(w) - v) <= tolerance(v))) continue;
      const onLine = pts.filter(([w, v]) => Math.abs(line(w) - v) <= tolerance(v)).length;
      const caps = (hi != null) + (lo != null);
      if (!best || onLine > best.onLine || (onLine === best.onLine && caps < best.caps)) best = { a, b, hi, lo, onLine, caps };
    }
  }
  if (!best) return null;
  const vw = r(best.b * 100, 4);
  const a = r(best.a);
  const expr = Math.abs(a) < 0.05 ? `${vw}vw` : `calc(${vw}vw ${a < 0 ? '-' : '+'} ${Math.abs(a)}px)`;
  const hi = best.hi != null ? r(best.hi) : null;
  const lo = best.lo != null ? r(best.lo) : null;
  // What the written CSS gives (rounded as written), so a check at another width matches the browser.
  const at = (w) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, (Math.abs(a) < 0.05 ? 0 : a) + (vw / 100) * w));
  if (hi != null && lo != null) return { css: `clamp(${lo}px, ${expr}, ${hi}px)`, at };
  if (hi != null) return { css: `min(${expr}, ${hi}px)`, at };
  if (lo != null) return { css: `max(${lo}px, ${expr})`, at };
  return { css: expr, at };
}

const constantRatio = (a, b) => {
  if (a.some((v) => v == null) || b.some((v) => !v)) return null;
  const ratios = a.map((v, i) => v / b[i]);
  return Math.max(...ratios) - Math.min(...ratios) <= 0.012 ? r(ratios.reduce((s, x) => s + x, 0) / ratios.length, 3) : null;
};

/**
 * The fluid declarations of one element from its probe (`ty`): font-size, line-height, letter-spacing (only those that
 * change with the window or follow the font size).
 */
export function fluidType(ty) {
  if (!ty?.widths) return {};
  const out = {};
  const fs = ty['font-size'];
  const fluidFs = fluidLength(ty.widths, fs);
  if (fluidFs) out['font-size'] = fluidFs;
  const lh = ty['line-height'];
  if (lh?.every((v) => v != null)) {
    const ratio = fluidFs ? constantRatio(lh, fs) : null;
    if (ratio != null) out['line-height'] = String(ratio);
    else {
      const fluidLh = fluidLength(ty.widths, lh);
      if (fluidLh) out['line-height'] = fluidLh;
    }
  }
  const ls = ty['letter-spacing'];
  if (ls?.every((v) => v != null) && ls.some((v) => Math.abs(v) > 0.01)) {
    const ratio = fluidFs ? constantRatio(ls, fs) : null;
    if (ratio != null) out['letter-spacing'] = `${ratio}em`;
    else {
      const fluidLs = fluidLength(ty.widths, ls);
      if (fluidLs) out['letter-spacing'] = fluidLs;
    }
  }
  return out;
}

const pxOf = (v) => {
  const m = /^(-?[\d.]+)px$/.exec(String(v ?? '').trim());
  return m ? parseFloat(m[1]) : null;
};

/**
 * The fluid declarations of the desktop probe (`ty`) that still hold in a narrower view (laptop, tablet, phone): a view
 * has its own captured px, written in its media query; where the desktop's fluid size gives that same px at the view's
 * width, the fluid value is kept there too, so the text keeps following the window between the captured widths (1024 to
 * 1280 px used the laptop's px, too small for 1200). Only what matches the captured value: a site that switches to
 * another size on phones keeps its px.
 * @param {object} ty     the desktop probe
 * @param {number} width  the view's window width
 * @param {object} style  the view's captured (own) declarations
 */
export function fluidTypeAt(ty, width, style) {
  if (!ty?.widths || !width) return {};
  const fs = pxOf(style?.['font-size']);
  const fit = fs != null ? fluidFit(ty.widths, ty['font-size']) : null;
  if (!fit || Math.abs(fit.at(width) - fs) > tolerance(fs)) return {};
  const all = fluidType(ty);
  const out = { 'font-size': fit.css };
  const follows = (prop) => {
    const value = all[prop];
    const own = pxOf(style[prop]);
    if (value == null || own == null) return;
    let expected = null;
    // A ratio to the font size (unitless / em), else a fluid length of its own.
    if (/^-?[\d.]+(em)?$/.test(value)) expected = parseFloat(value) * fs;
    else expected = fluidFit(ty.widths, ty[prop])?.at(width) ?? null;
    if (expected != null && Math.abs(expected - own) <= Math.max(0.5, Math.abs(own) * 0.015)) out[prop] = value;
  };
  follows('line-height');
  follows('letter-spacing');
  return out;
}