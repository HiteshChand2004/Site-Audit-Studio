// The full-page picture of a live page for the visual check, taken in a state that does not depend on when it was taken.
// A page that rotates its own text, runs a carousel or a ticker changes between two screenshots taken seconds apart, so the
// visual difference measured two pictures of different moments. The picture is taken on a fresh page in which the page's own
// timers are frozen (verify/exact/freeze.js: the rotators and carousels stay on their first state), scrolled through like a
// visitor and back at the top with what the scroll revealed kept shown (capture/index.js settle), with its CSS animations and
// transitions settled (animations: 'disabled') and its reactions to the window's size held while the picture is taken. The copy
// is rendered with its scripts off (verify/layout.js), so its first state is already the one a frozen original shows, with
// every section shown.
//
// The picture must never block a capture: it waits for domcontentloaded and a short bounded settle, not for the load event
// (a page whose load event takes longer than the limit - flexibench, 27-36 s - was failing the whole capture), under its own
// time limit. If it still does not finish, the capture takes the normal screenshot and says so (fullShotOf).
import { freezeTimers, holdSizeReactions } from './exact/freeze.js';
import { settle } from '../capture/index.js';

/** Settle time before the picture: the page's own entrance effects end, and the lazy images it loads are in. */
export const SETTLE_MS = 800;
/** How long the page may take to be ready for the frozen picture (domcontentloaded), and the whole picture. */
export const FROZEN_LIMIT_MS = 45000;
/** A short extra wait for the load event: it is used when it comes in time, never waited for beyond this. */
export const LOAD_WAIT_MS = 2000;
/** The time the scroll-through may add to the picture's limit (a long page at 0.85 of a window per wheel step). */
export const SCROLL_LIMIT_MS = 60000;
/** How long the pictures and fonts the scroll-through loaded may take before the picture is taken anyway. */
export const MEDIA_WAIT_MS = 3000;

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
    await context.addInitScript(holdSizeReactions);
    const shoot = async () => {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: limitMs });
      await page.waitForLoadState('load', { timeout: LOAD_WAIT_MS }).catch(() => {});
      await page.evaluate(() => {
        document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
        return document.fonts.ready.then(() => true);
      }).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      // Scrolled through like a visitor, with the capture's own scroll-through (real wheel steps, the reveal tracker), back at
      // the top with what the scroll revealed pinned: sections that appear on scroll are in the picture, also those that
      // hide again when they leave the view. Without it everything below the first screen that waits for a scroll was blank
      // (dreamhire after 19ddc59: 38–63 % of the picture). The page's timers stay frozen, so this changes no moving part.
      const scrolled = await settle(page, { width: view.width, height: view.height ?? 900 }, maxHeight).catch((err) => ({ error: String(err?.message ?? err).split('\n')[0] }));
      // What the scroll loaded (lazy images, fonts) gets a short wait. The bound is kept here, not in the page: the page's own
      // timers of a second or more are frozen, so a timeout inside it would never fire (an image that never loads hung it).
      await Promise.race([
        page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].filter((i) => !i.complete)
          .map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))]).then(() => true)).catch(() => {}),
        new Promise((r) => setTimeout(r, MEDIA_WAIT_MS)),
      ]);
      await page.waitForTimeout(200);
      const height = Math.max(1, Math.min(await page.evaluate(() => document.documentElement.scrollHeight), maxHeight));
      // The picture grows the window to the page's height: the page's own reactions to that are held (step 1 of Copy my site).
      await page.evaluate(() => { window.__sasHoldSize = true; }).catch(() => {});
      const png = await page.screenshot({
        type: 'png',
        fullPage: true,
        animations: 'disabled',
        clip: { x: 0, y: 0, width: view.width, height },
      });
      const frozen = await page.evaluate(() => (window.__sasFrozen ? { intervals: window.__sasFrozen.intervals, timeouts: window.__sasFrozen.timeouts } : null)).catch(() => null);
      return { png, height, frozen, scrolled };
    };
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the frozen picture did not finish in ${Math.round(limitMs / 1000)} s`)), limitMs + LOAD_WAIT_MS + SETTLE_MS + SCROLL_LIMIT_MS + 5000);
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
