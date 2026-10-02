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

async function captureWidth(browser, pageInfo, width, dir, timeout) {
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
    const page = await context.newPage();
    const go = () => page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout });
    await go().catch((err) => {
      if (!/timeout/i.test(err.message)) throw err;
      return go();
    });
    await page.waitForLoadState('load', { timeout: LOAD_WAIT }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await settle(page, view, MAX_HEIGHT);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
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
    return { width, height: size.height, scrollWidth: size.scrollWidth, file: `sweep/${sweepFile(width)}`, truncated: size.height > MAX_HEIGHT };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Screenshots the original page at every sweep width. A failing width is reported and the others kept.
 * @returns {Promise<{ widths: Record<number, object>, errors: { width: number, message: string }[] }>}
 */
export async function captureSweep(browser, pageInfo, workspace, { widths = SWEEP_WIDTHS, timeout = 30000, parallel = SWEEP_PARALLEL } = {}) {
  const dir = path.join(captureDir(workspace, pageInfo.slug), 'sweep');
  await mkdir(dir, { recursive: true });
  const results = await mapLimit(widths, Math.max(1, parallel), (width) => captureWidth(browser, pageInfo, width, dir, timeout).then(
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
