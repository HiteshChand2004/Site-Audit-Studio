// The viewports an exact copy is measured at. One list, used by both sides: the capture visits the original at every
// slot and the compare renders the copy at the same ones, so a difference can never come from the two sides being
// looked at differently (the same rule the width sweep already follows with capture/sweep.js sweepView).
//
// Twelve widths a real visitor arrives at, plus a short window (1440x600, where a page that relies on viewport height
// shows it), plus 1 px either side of the breakpoints the site itself declares - the one place where a layout decision
// actually happens, and where a copy that chose its breakpoint a pixel differently shows up at once.
//
// The site's own breakpoints are bounded on purpose: a stylesheet with forty media queries would otherwise double the
// run. The ones that carry the most rules win, and every one left out is named in the report rather than dropped
// quietly (report.exact.slots.rejected).
import { mediaBounds } from '../../ir/index.js';

/** Widths every exact run measures, whatever the site declares. */
export const FIXED_WIDTHS = [320, 360, 375, 390, 414, 430, 768, 810, 1024, 1280, 1440, 1920];
/** A window that is wide but short: pages sized in vh look different here and nowhere else. */
export const SHORT_WINDOW = { width: 1440, height: 600 };
// Real device heights, so a page that fills the first screen is judged against a screen that exists.
const HEIGHTS = {
  320: 812, 360: 812, 375: 812, 390: 844, 414: 896, 430: 932, 768: 1024, 810: 1080, 1024: 768, 1280: 800, 1440: 900, 1920: 1080,
};
/** Below this a slot is emulated as a phone (touch, and the device pixel ratio phones really have). */
export const PHONE_BELOW = 768;
/** Below this, and not a phone, a slot is emulated as a tablet. */
export const TABLET_BELOW = 1024;
export const PHONE_DPR = 3;
export const TABLET_DPR = 2;
// Two slots closer than this measure the same layout twice.
export const SLOT_MERGE_PX = 8;
/** Breakpoints of the site taken per site (the stylesheet is shared), so at most twice this many extra slots. */
export const MAX_BREAKPOINT_SLOTS = 4;
/** Widths outside this are nobody's screen. */
export const RANGE = [320, 1920];

const heightFor = (width) => HEIGHTS[width]
  ?? (width < PHONE_BELOW ? 812 : width < TABLET_BELOW ? 1024 : width < 1280 ? 768 : width < 1920 ? 900 : 1080);

/**
 * One slot. `mobile` / `hasTouch` / `dpr` go to both sides of the comparison: the device pixel ratio decides which
 * `srcset` candidate a browser loads, so the two sides must agree on it or a different image file is compared.
 */
export function slotFor(width, { height, origin = 'fixed', bound = null } = {}) {
  const h = height ?? heightFor(width);
  const phone = width < PHONE_BELOW;
  const tablet = !phone && width < TABLET_BELOW;
  return {
    id: height && height !== heightFor(width) ? `${width}x${h}` : String(width),
    width,
    height: h,
    dpr: phone ? PHONE_DPR : tablet ? TABLET_DPR : 1,
    mobile: phone || tablet,
    hasTouch: phone || tablet,
    origin,
    ...(bound !== null && { bound }),
  };
}

/**
 * The boundaries worth measuring either side of, most rules first.
 * @param {{ condition: string, rules?: number }[]|string[]} queries  the capture's `mediaRules` (with counts) or its
 *   `mediaQueries` (strings, older captures)
 * @returns {{ kept: {value:number, condition:string, rules:number}[], rejected: {bound:number, condition:string, reason:string}[] }}
 */
export function pickBounds(queries, { max = MAX_BREAKPOINT_SLOTS } = {}) {
  const rejected = [];
  // One boundary may be written twice (max-width: 767.98px and min-width: 768px are the same decision): the rule
  // counts of both belong to it.
  const byValue = new Map();
  for (const b of mediaBounds(queries)) {
    const key = Math.floor(b.value);
    const seen = byValue.get(key);
    if (seen) {
      seen.rules += b.rules;
      continue;
    }
    byValue.set(key, { value: b.value, condition: b.condition, rules: b.rules });
  }
  const candidates = [...byValue.values()].sort((a, b) => b.rules - a.rules || a.value - b.value);
  const kept = [];
  for (const c of candidates) {
    const edge = Math.floor(c.value);
    if (edge < RANGE[0] || edge >= RANGE[1]) {
      rejected.push({ bound: c.value, condition: c.condition, reason: 'outside-range' });
      continue;
    }
    const near = kept.find((k) => Math.abs(Math.floor(k.value) - edge) < SLOT_MERGE_PX);
    if (near) {
      rejected.push({ bound: c.value, condition: c.condition, reason: `merged-into-${Math.floor(near.value)}` });
      continue;
    }
    if (kept.length >= max) {
      rejected.push({ bound: c.value, condition: c.condition, reason: 'over-cap' });
      continue;
    }
    kept.push(c);
  }
  return { kept, rejected };
}

/**
 * Every slot of an exact run, in the order they are measured (widest first, so a page's widest layout is seen before
 * the narrow ones it falls back to).
 * @param {{ mediaRules?: object[], mediaQueries?: string[], max?: number }} [o]  what the capture recorded
 * @returns {{ slots: object[], rejected: object[], bounds: object[] }}
 */
export function exactSlots({ mediaRules = [], mediaQueries = [], max = MAX_BREAKPOINT_SLOTS } = {}) {
  const slots = FIXED_WIDTHS.map((w) => slotFor(w));
  slots.push(slotFor(SHORT_WINDOW.width, { height: SHORT_WINDOW.height }));

  const { kept, rejected } = pickBounds(mediaRules.length ? mediaRules : mediaQueries, { max });
  for (const bound of kept) {
    const edge = Math.floor(bound.value);
    // The layout changes between these two widths. A side that is already a fixed slot is not measured twice: the
    // pair is still complete, because that slot carries the same width.
    for (const width of [edge, edge + 1]) {
      if (slots.some((s) => s.width === width && s.height === heightFor(width))) continue;
      slots.push(slotFor(width, { origin: 'breakpoint', bound: bound.value }));
    }
  }
  slots.sort((a, b) => b.width - a.width || b.height - a.height);
  return { slots, rejected, bounds: kept };
}
