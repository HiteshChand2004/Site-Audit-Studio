// Fluid type (Phase 4b.6.2). The IR writes a font size per breakpoint (px at 1440, 1024, 768 and 375).
// Many sites scale their type smoothly with the viewport instead (vw units, clamp()); between the
// captured widths the stepped px values then drift from the original. When the three captured values
// of a rule (four with the laptop view) lie on one straight line over the viewport width, the rule is written as a single
//   clamp(min, calc(a + b vw), max)
// that reproduces the captured values exactly at 375 / 768 / 1440 and interpolates between them.
// Whether it is used at all is decided by the responsive sweep (verify/refine.js): the fluid
// stylesheet has to score better against the original than the stepped one.
import { VIEW_WIDTHS as WIDTHS } from '../views.js';
const PROPS = ['font-size', 'line-height'];
// Values on the line within max(0.5 px, 2 % of the range) count as collinear: wide enough for rounding,
// too narrow for a design that steps at a breakpoint.
const MIN_RANGE = 2;
const PX = /^(-?\d+(?:\.\d+)?)px$/;
const round = (n) => Math.round(n * 1000) / 1000;

/** The value a property has at each view after the media query cascade (each view builds on the wider one). */
function effective(parts, prop) {
  const d = parts.base?.[prop];
  const l = parts.laptop?.[prop] ?? d;
  const t = parts.tablet?.[prop] ?? l;
  const m = parts.mobile?.[prop] ?? t;
  return { d, l, t, m };
}

/**
 * The fluid form of one property, or null when its three values are not px values on one line.
 * @returns {{ value: string, min: number, max: number }|null}
 */
export function fluidValue({ d, l, t, m }, { laptop = false } = {}) {
  const px = [d, t, m, ...(laptop ? [l] : [])].map((v) => PX.exec(String(v ?? ''))?.[1]);
  if (px.some((v) => v === undefined)) return null;
  const [D, T, M, L] = px.map(Number);
  const range = D - M;
  if (Math.abs(range) < MIN_RANGE) return null;
  const onLine = (value, width) => Math.abs(value - (M + range * ((width - WIDTHS.mobile) / (WIDTHS.desktop - WIDTHS.mobile)))) <= Math.max(0.5, 0.02 * Math.abs(range));
  if (!onLine(T, WIDTHS.tablet) || (laptop && !onLine(L, WIDTHS.laptop))) return null;
  const slope = range / (WIDTHS.desktop - WIDTHS.mobile); // px per px of viewport width
  const a = round(M - WIDTHS.mobile * slope);
  const b = round(slope * 100);
  const [lo, hi] = D >= M ? [M, D] : [D, M];
  return { value: `clamp(${lo}px, calc(${a}px + ${b}vw), ${hi}px)`, min: lo, max: hi };
}

/**
 * Rules with fluid type where the captured values allow it. The input is not modified.
 * @param {{ selector: string, parts: object }[]} rules
 * @returns {{ rules: object[], changed: number, properties: Record<string, number> }}
 */
export function applyFluidType(rules, { laptop = false } = {}) {
  let changed = 0;
  const properties = {};
  const out = rules.map((rule) => {
    let parts = null;
    for (const prop of PROPS) {
      const fluid = fluidValue(effective(rule.parts, prop), { laptop });
      if (!fluid) continue;
      parts ??= { ...rule.parts, base: { ...rule.parts.base } };
      parts.base[prop] = fluid.value;
      for (const view of ['laptop', 'tablet', 'mobile']) {
        if (!parts[view] || !(prop in parts[view])) continue;
        const { [prop]: dropped, ...rest } = parts[view];
        if (Object.keys(rest).length) parts[view] = rest;
        else delete parts[view];
      }
      properties[prop] = (properties[prop] ?? 0) + 1;
    }
    if (!parts) return rule;
    changed++;
    return { ...rule, parts };
  });
  return { rules: out, changed, properties };
}

// Phone shrink: the mobile styles are captured at 375 px, and a screen narrower than that (320 px phones) gets
// the same px sizes. Large type that does not wrap (a one-line heading, a button label) then runs out of the
// screen, where the original's type scales down with the viewport. Large font sizes of the mobile styles are
// written as min(X px, Y vw): the captured size at 375 px and above, proportionally smaller below. Like fluid
// type it is only used when the responsive sweep scores it better (verify/refine.js).
const SHRINK_FROM = 24; // px; smaller type stays legible and is left alone
const shrinkValue = (v) => {
  const m = PX.exec(String(v ?? ''));
  if (!m || Number(m[1]) < SHRINK_FROM) return null;
  return `min(${m[1]}px, ${round((Number(m[1]) / WIDTHS.mobile) * 100)}vw)`;
};

/**
 * Rules with the large font sizes of the phone view as min(px, vw). The input is not modified.
 * @returns {{ rules: object[], changed: number }}
 */
export function applyPhoneShrink(rules) {
  let changed = 0;
  const out = rules.map((rule) => {
    const { m } = effective(rule.parts, 'font-size');
    const value = shrinkValue(m);
    if (!value) return rule;
    changed++;
    return { ...rule, parts: { ...rule.parts, mobile: { ...rule.parts.mobile, 'font-size': value } } };
  });
  return { rules: out, changed };
}
