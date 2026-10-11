// Responsive sweep, original side: one full-page screenshot of a page at each sweep width, taken the
// same way as the three recreate captures (settled: lazy content loaded, scroll-reveal content shown).
// The recreate captures only 1440 / 768 / 375; the layout between them rests on heuristics, so the sweep
// looks at the widths in between (and beyond) to find where the recreated layout drifts. Screenshots only,
// no DOM: the sweep measures, it never changes the capture. Output: capture/<slug>/sweep/<width>-full.webp.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { USER_AGENT } from '../../audit/http.js';
import { encode, MAX_HEIGHT, MOBILE_UA } from '../../audit/screenshots.js';
import { mapLimit } from '../../audit/util.js';
import { captureDir, settle } from './index.js';

export const SWEEP_WIDTHS = [320, 480, 600, 900, 1024, 1280, 1920];
// Contexts open at once for one page: seven Chromium contexts rendering a heavy page together is too much.
export const SWEEP_PARALLEL = 4;
/** Site boundaries the sweep will add widths for, most-used first, and the most widths it will end up with. */
export const SWEEP_BOUNDS_MAX = 3;
export const SWEEP_WIDTHS_MAX = 13;
// A boundary this close to a width already in the list adds nothing.
const NEAR = 8;

/**
 * The widths to sweep: the fixed list plus the two widths that straddle each boundary the site declares itself.
 *
 * Why the site's own boundaries matter here. The fixed widths are evenly spread, and a boundary can sit between
 * two of them - flexibench changes layout at 640, between 600 and 900 - so no swept width can tell whether the
 * copy's own breakpoint belongs above or below it. `verify/refine.js` judges breakpoints on these widths, so a
 * boundary it cannot see is a boundary it cannot get right; on flexibench that cost 12% of the page height
 * across 640-767px. Both sides of the boundary are needed, because the question is which band a width falls in.
 *
 * @param {{ value: number, rules?: number }[]} bounds  from `ir/index.js mediaBounds`
 * @returns {number[]} ascending, deduped, capped
 */
export function sweepWidths(bounds = [], base = SWEEP_WIDTHS) {
  const widths = [...base];
  const ranked = [...bounds]
    .filter((b) => Number.isFinite(b?.value) && b.value > base[0] && b.value < base[base.length - 1])
    .sort((a, b) => (b.rules ?? 0) - (a.rules ?? 0) || a.value - b.value);
  const seen = new Set();
  let taken = 0;
  for (const b of ranked) {
    const key = Math.round(b.value);
    if (seen.has(key)) continue;
    seen.add(key);
    // A boundary of 639.98 is the last width of one band and the first of the next: 639 and 640.
    const pair = [Math.floor(b.value), Math.ceil(b.value)];
    if (pair.every((w) => widths.some((x) => Math.abs(x - w) <= NEAR))) continue;
    for (const w of pair) if (!widths.includes(w)) widths.push(w);
    if (++taken >= SWEEP_BOUNDS_MAX || widths.length >= SWEEP_WIDTHS_MAX) break;
  }
  return widths.sort((a, b) => a - b).slice(0, SWEEP_WIDTHS_MAX);
}
// Below this width the sweep renders like a phone (mobile viewport handling); both sides do the same.
const MOBILE_BELOW = 600;
const LOAD_WAIT = 20000;

/** The viewport the sweep uses at `width` (original and recreate alike). */
export const sweepView = (width) => ({
  id: `w${width}`,
  width,
  height: width < MOBILE_BELOW ? 812 : 900,
  dpr: 1,
  mobile: width < MOBILE_BELOW,
});

export const sweepFile = (width) => `${width}-full.webp`;

async function captureWidth(browser, pageInfo, width, dir, timeout, cache) {
  const view = sweepView(width);
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    userAgent: view.mobile ? MOBILE_UA : USER_AGENT,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  try {
    // The page's static files were loaded by the main capture: they come from the job's shared cache.
    await cache?.attach(context);
    const started = Date.now();
    const page = await context.newPage();
    const go = () => page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout });
    await go().catch((err) => {
      if (!/timeout/i.test(err.message)) throw err;
      return go();
    });
    await page.waitForLoadState('load', { timeout: LOAD_WAIT }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    const loaded = Date.now();
    await settle(page, view, MAX_HEIGHT);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    const scrolled = Date.now();
    const size = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    }));
    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(size.height, MAX_HEIGHT)) },
    });
    await encode(png, path.join(dir, sweepFile(width)));
    // timing: ms spent loading the page, scrolling through it and taking the screenshot.
    const timing = { load: loaded - started, scroll: scrolled - loaded, screenshot: Date.now() - scrolled };
    return { width, height: size.height, scrollWidth: size.scrollWidth, file: `sweep/${sweepFile(width)}`, truncated: size.height > MAX_HEIGHT, timing };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Screenshots the original page at every sweep width. A failing width is reported and the others kept.
 * @returns {Promise<{ widths: Record<number, object>, errors: { width: number, message: string }[] }>}
 */
export async function captureSweep(browser, pageInfo, workspace, { widths = SWEEP_WIDTHS, timeout = 30000, parallel = SWEEP_PARALLEL, cache = null } = {}) {
  const dir = path.join(captureDir(workspace, pageInfo.slug), 'sweep');
  await mkdir(dir, { recursive: true });
  const results = await mapLimit(widths, Math.max(1, parallel), (width) => captureWidth(browser, pageInfo, width, dir, timeout, cache).then(
    (value) => ({ width, value }),
    (err) => ({ width, error: err?.message?.split('\n')[0] ?? 'Capture failed' }),
  ));
  const out = { widths: {}, errors: [] };
  for (const r of results) {
    if (r.value) out.widths[r.width] = r.value;
    else out.errors.push({ width: r.width, message: r.error });
  }
  return out;
}
