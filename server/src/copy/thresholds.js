// Thresholds for "Copy my site" (docs/COPY-MY-SITE.md §4). Each one is a number the app already uses or one measured in our runs.

/** Visual difference per page and width (verify/visualDiff.js score, 0–100). */
export const VISUAL_MIN = 65;
/** Widths the copy is checked at (the desktop and the phone of the spec). */
export const CHECK_WIDTHS = [1440, 390];
/** Page height against the original, as a share of the original's height. */
export const HEIGHT_TOLERANCE = 0.05;
/** Share of the original's paired hovers that the copy matches (end state and timing). */
export const HOVER_MIN = 0.9;
/** Share of the original's controls (clicks, FAQs, tabs) that the copy does the same way. */
export const CONTROLS_MIN = 1;
/** Lighthouse performance on the homepage (0–100); the other categories must not fall below the original's. */
export const LIGHTHOUSE_PERF_MIN = 50;
/** Lighthouse categories that must not fall below the original's (homepage). */
export const LIGHTHOUSE_NO_WORSE = ['seo', 'accessibility', 'best-practices'];

/**
 * The checks a page fails, given its measurements. An absent measurement is not a failure (it was not measured), but
 * a measurement that exists and is below the threshold is.
 * @param {object} m
 * @param {Record<string, number>} [m.visual]       visual score per width
 * @param {Record<string, number>} [m.heightRatio]  copy height / original height per width
 * @param {{ matched: number, total: number }} [m.hover]
 * @param {{ same: number, total: number }} [m.controls]
 * @param {number} [m.newConsoleErrors]             console errors the original does not have
 * @param {{ performance?: number, categories?: Record<string, number> }} [m.lighthouse]  copy, homepage (0–100)
 * @param {{ categories?: Record<string, number> }} [m.original]                         original, homepage (0–100)
 * @returns {{ check: string, width?: number, value: number, min: number }[]}
 */
export function pageProblems(m) {
  const problems = [];
  for (const width of CHECK_WIDTHS) {
    const v = m.visual?.[width];
    if (typeof v === 'number' && v < VISUAL_MIN) problems.push({ check: 'visual', width, value: v, min: VISUAL_MIN });
    const r = m.heightRatio?.[width];
    if (typeof r === 'number' && Math.abs(r - 1) > HEIGHT_TOLERANCE) problems.push({ check: 'height', width, value: r, min: 1 });
  }
  if (m.hover && m.hover.total > 0) {
    const share = m.hover.matched / m.hover.total;
    if (share < HOVER_MIN) problems.push({ check: 'hover', value: share, min: HOVER_MIN });
  }
  if (m.controls && m.controls.total > 0) {
    const share = m.controls.same / m.controls.total;
    if (share < CONTROLS_MIN) problems.push({ check: 'controls', value: share, min: CONTROLS_MIN });
  }
  if (typeof m.newConsoleErrors === 'number' && m.newConsoleErrors > 0) {
    problems.push({ check: 'console', value: m.newConsoleErrors, min: 0 });
  }
  const perf = m.lighthouse?.performance;
  if (typeof perf === 'number' && perf < LIGHTHOUSE_PERF_MIN) {
    problems.push({ check: 'lighthouse-performance', value: perf, min: LIGHTHOUSE_PERF_MIN });
  }
  for (const cat of LIGHTHOUSE_NO_WORSE) {
    const copy = m.lighthouse?.categories?.[cat];
    const original = m.original?.categories?.[cat];
    if (typeof copy === 'number' && typeof original === 'number' && copy < original) {
      problems.push({ check: `lighthouse-${cat}`, value: copy, min: original });
    }
  }
  return problems;
}
