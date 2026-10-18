// The full-page picture of a live page for the visual check, taken in a state that does not depend on when it was taken.
// A page that rotates its own text, runs a carousel or a ticker changes between two screenshots taken seconds apart, so the
// visual difference measured two pictures of different moments. The picture is taken on a fresh page in which the page's own
// timers are frozen (verify/exact/freeze.js: the rotators and carousels stay on their first state), at the top of the page,
// with its CSS animations and transitions finished or held in their end state (animations: 'disabled'). The copy is rendered
// with its scripts off (verify/layout.js), so its first state is already the one a frozen original shows.
import { freezeTimers } from './exact/freeze.js';

/** Settle time before the picture: the page's own entrance effects end, and the lazy images it loads are in. */
export const SETTLE_MS = 800;

/**
 * @param {import('playwright').Browser} browser
 * @param {string} url             the page's address on the original
 * @param {{ width: number, height?: number, dpr?: number, mobile?: boolean }} view
 * @param {{ timeout?: number, maxHeight?: number }} [o]
 * @returns {Promise<{ png: Buffer, height: number, frozen: { intervals: number, timeouts: number } | null }>}
 */
export async function frozenFullShot(browser, url, view, { timeout = 30000, maxHeight = 8000 } = {}) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height ?? 900 },
    deviceScaleFactor: view.dpr ?? 1,
    isMobile: Boolean(view.mobile),
    hasTouch: Boolean(view.mobile),
    serviceWorkers: 'block',
  });
  try {
    await context.addInitScript(freezeTimers);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout });
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
  } finally {
    await context.close().catch(() => {});
  }
}
