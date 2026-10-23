// Turns the as-is copy's own checks (recreate/behavior/preserve/check.js checkCopy) into the per-page measurements the
// thresholds judge (docs/COPY-MY-SITE.md §4). The check measures pixels, so a visual score is an explicit rule:
// score = 100 − 10 × (percent of pixels that differ). An as-is copy is identical where it is right; 5 % different is a fail.
// `diffPct` is the share that differs in every pairing of several pictures per side, outside the places either page moves by
// itself (the gate's arithmetic, check.js gateVerdict); what differed only sometimes or in a moving part is carried in `noise`.
import { pageProblems } from './thresholds.js';

/** Visual score from the pixel difference of the copy against the original (percent). */
export const visualScoreOf = (diffPct) => (typeof diffPct === 'number' ? Math.max(0, Math.min(100, 100 - 10 * diffPct)) : null);

/** The view widths the thresholds use, mapped from the checks' widths. */
const WIDTH_KEYS = { 1440: 1440, 390: 390 };

/**
 * @param {object} page   one entry of report.checks.pages
 * @param {object} [lighthouse]   { performance, categories } of the homepage copy, and the original's categories
 * @returns {{ path: string, visual: Record<string, number|null>, height: Record<string, number>, controls: { same: number, total: number } | null, hovers: { matched: number, total: number } | null, console: number, problems: object[], note?: string }}
 */
export function pageChecksOf(page, lighthouse = null) {
  const visual = {};
  const height = {};
  const noise = {};
  for (const v of page.visual ?? []) {
    const key = WIDTH_KEYS[v.width];
    if (!key) continue;
    visual[key] = v.note ? null : visualScoreOf(v.diffPct);
    if (typeof v.copyHeight === 'number' && typeof v.originalHeight === 'number' && v.originalHeight > 0) {
      height[key] = v.copyHeight / v.originalHeight;
    }
    // What the score leaves out, kept beside it: the plain one-pair difference, the share that could not be judged (it moved by
    // itself or showed only sometimes), how much of the page moves by itself, and how many pictures per side were taken.
    if (!v.note && typeof v.rawDiffPct === 'number') {
      noise[key] = { raw: v.rawDiffPct, inNoise: v.inNoisePct ?? 0, share: v.noiseShare ?? 0, shots: v.shots ?? 1 };
    }
  }
  let controls = null;
  if (page.controls?.original) {
    const total = page.controls.original.visible ?? 0;
    const gaps = (page.controls.missing?.length ?? 0) + (page.controls.mismatch?.length ?? 0);
    controls = total > 0 ? { same: Math.max(0, total - gaps), total } : null;
  }
  let hovers = null;
  if (page.hovers?.original) {
    const total = page.hovers.original.visible ?? 0;
    const diff = page.hovers.mismatch?.length ?? 0;
    hovers = total > 0 ? { matched: Math.max(0, total - diff), total } : null;
  }
  const consoleErrors = page.offline?.errors?.length ?? 0;
  const measures = { visual, heightRatio: height, controls, hover: hovers, newConsoleErrors: consoleErrors, lighthouse: lighthouse?.copy, original: lighthouse?.original };
  return {
    path: page.path,
    visual,
    ...(Object.keys(noise).length && { noise }),
    height,
    controls,
    hovers,
    console: consoleErrors,
    problems: pageProblems(measures),
    ...(!Object.keys(visual).length && { note: 'no visual check (the original did not answer and no capture was saved)' }),
  };
}

/**
 * @param {object[]} pages    report.checks.pages
 * @param {object} [lighthouse]  { copy: { performance, categories }, original: { categories } } for the homepage
 */
export function copyChecksOf(pages, lighthouse = null) {
  return pages.map((p, i) => pageChecksOf(p, i === 0 ? lighthouse : null));
}
