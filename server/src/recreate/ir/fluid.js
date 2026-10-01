// Fluid type (Phase 4b.6.2). The IR writes a font size per breakpoint (px at 1440, at 768 and at 375).
// Many sites scale their type smoothly with the viewport instead (vw units, clamp()); between the
// captured widths the stepped px values then drift from the original. When the three captured values
// of a rule lie on one straight line over the viewport width, the rule is written as a single
//   clamp(min, calc(a + b vw), max)
// that reproduces the captured values exactly at 375 / 768 / 1440 and interpolates between them.
// Whether it is used at all is decided by the responsive sweep (verify/refine.js): the fluid
// stylesheet has to score better against the original than the stepped one.
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 };
const PROPS = ['font-size', 'line-height'];
// Values on the line within max(0.5 px, 2 % of the range) count as collinear: wide enough for rounding,
// too narrow for a design that steps at a breakpoint.
const MIN_RANGE = 2;
const PX = /^(-?\d+(?:\.\d+)?)px$/;
const round = (n) => Math.round(n * 1000) / 1000;

/** The value a property has at each view after the media query cascade (mobile inherits tablet's override). */
function effective(parts, prop) {
  const d = parts.base?.[prop];
  const t = parts.tablet?.[prop] ?? d;
  const m = parts.mobile?.[prop] ?? t;
  return { d, t, m };
}

/**
 * The fluid form of one property, or null when its three values are not px values on one line.
 * @returns {{ value: string, min: number, max: number }|null}
 */
export function fluidValue({ d, t, m }) {
  const px = [d, t, m].map((v) => PX.exec(String(v ?? ''))?.[1]);
  if (px.some((v) => v === undefined)) return null;
  const [D, T, M] = px.map(Number);
  const range = D - M;
  if (Math.abs(range) < MIN_RANGE) return null;
  const expected = M + range * ((WIDTHS.tablet - WIDTHS.mobile) / (WIDTHS.desktop - WIDTHS.mobile));
  if (Math.abs(T - expected) > Math.max(0.5, 0.02 * Math.abs(range))) return null;
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
export function applyFluidType(rules) {
  let changed = 0;
  const properties = {};
  const out = rules.map((rule) => {
    let parts = null;
    for (const prop of PROPS) {
      const fluid = fluidValue(effective(rule.parts, prop));
      if (!fluid) continue;
      parts ??= { ...rule.parts, base: { ...rule.parts.base } };
      parts.base[prop] = fluid.value;
      for (const view of ['tablet', 'mobile']) {
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
