// The full-page picture of a live page for the visual check, taken in a state that does not depend on when it was taken.
// A page that rotates its own text, runs a carousel or a ticker changes between two screenshots taken seconds apart, so the
// visual difference measured two pictures of different moments. The picture is taken on a fresh page in which the page's own
// timers are frozen (verify/exact/freeze.js: the rotators and carousels stay on their first state), at the top of the page,
// with its CSS animations and transitions settled (animations: 'disabled'). The copy is rendered with its scripts off
// (verify/layout.js), so its first state is already the one a frozen original shows.
//
// The picture must never block a capture: it waits for domcontentloaded and a short bounded settle, not for the load event
// (a page whose load event takes longer than the limit - flexibench, 27-36 s - was failing the whole capture), under its own
// time limit. If it still does not finish, the capture takes the normal screenshot and says so (fullShotOf).
import { freezeTimers } from './exact/freeze.js';

/** Settle time before the picture: the page's own entrance effects end, and the lazy images it loads are in. */
export const SETTLE_MS = 800;
/** How long the page may take to be ready for the frozen picture (domcontentloaded), and the whole picture. */
export const FROZEN_LIMIT_MS = 45000;
/** A short extra wait for the load event: it is used when it comes in time, never waited for beyond this. */
export const LOAD_WAIT_MS = 2000;

/**
 * @param {import('playwright').Browser} browser
 * @param {string} url             the page's address on the original
 * @param {{ width: number, height?: number, dpr?: number, mobile?: boolean }} view
 * @param {{ limitMs?: number, maxHeight?: number }} [o]
 * @returns {Promise<{ png: Buffer, height: number, frozen: { intervals: number, timeouts: number } | null }>}
 */
export async function frozenFullShot(browser, url, view, { limitMs = FROZEN_LIMIT_MS, maxHeight = 8000 } = {}) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height ?? 900 },
    deviceScaleFactor: view.dpr ?? 1,
    isMobile: Boolean(view.mobile),
    hasTouch: Boolean(view.mobile),
    serviceWorkers: 'block',
  });
  let timer;
  try {
    await context.addInitScript(freezeTimers);
    const shoot = async () => {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: limitMs });
      await page.waitForLoadState('load', { timeout: LOAD_WAIT_MS }).catch(() => {});
      await page.evaluate(() => {
        document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
        return document.fonts.ready.then(() => true);
      }).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      const height = Math.max(1, Math.min(await page.evaluate(() => document.documentElement.scrollHeight), maxHeight));
      const png = await page.screenshot({
        type: 'png',
        fullPage: true,
        animations: 'disabled',
        clip: { x: 0, y: 0, width: view.width, height },
      });
      const frozen = await page.evaluate(() => (window.__sasFrozen ? { intervals: window.__sasFrozen.intervals, timeouts: window.__sasFrozen.timeouts } : null)).catch(() => null);
      return { png, height, frozen };
    };
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the frozen picture did not finish in ${Math.round(limitMs / 1000)} s`)), limitMs + LOAD_WAIT_MS + SETTLE_MS + 5000);
    });
    return await Promise.race([shoot(), limit]);
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}

/**
 * The picture a capture keeps for the visual check: the frozen one when it finishes, else the capture's own page screenshot
 * (the same clip), with the reason. Never throws because of the frozen picture.
 * @param {import('playwright').Browser} browser
 * @param {import('playwright').Page} page   the capture's page (the fallback is taken from it)
 * @param {string} url
 * @param {{ width: number, height?: number, dpr?: number, mobile?: boolean }} view
 * @param {{ maxHeight?: number, fallbackHeight: number, limitMs?: number }} o
 * @returns {Promise<{ png: Buffer, frozen: boolean, reason?: string }>}
 */
export async function fullShotOf(browser, page, url, view, { maxHeight = 8000, fallbackHeight, limitMs } = {}) {
  try {
    const shot = await frozenFullShot(browser, url, view, { maxHeight, ...(limitMs && { limitMs }) });
    return { png: shot.png, frozen: true };
  } catch (err) {
    const reason = String(err?.message ?? err).split('\n')[0].trim();
    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y: 0, width: view.width, height: Math.max(1, Math.min(fallbackHeight, maxHeight)) },
    });
    return { png, frozen: false, reason };
  }
}
