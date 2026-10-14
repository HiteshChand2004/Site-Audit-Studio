// Motion measured on an open page (Phase 4b.8): the same three probes the capture runs on the original (scroll reveal 4b.2,
// continuous loops 4b.3, hover / focus 4b.1), in the same order, so the recreated site can be compared with the original
// with the very same yardstick (reaudit/motion.js). The page must be loaded with JavaScript on.
import { captureClicks } from './clicks.js';
import { captureInteractions } from './interactions.js';
import { settle } from './index.js';
import { captureLoops } from './loops.js';
import { measureFeeds } from './feeds.js';
import { processReveal } from './reveal.js';

/**
 * @param {import('playwright').Page} page  a loaded page at the desktop size
 * @param {{ width?: number, height?: number, budgetMs?: number, cap?: number, focus?: boolean, clickBudgetMs?: number }} [o]  `focus:
 *   false` leaves out the Tab walk (the hover probe keeps the same time); `clickBudgetMs` > 0 runs the click probe last (it
 *   changes the page), the same probe the capture ran, so what each control does can be compared with the original's.
 * @returns {Promise<{ reveal: object, loops: object, hover: object[], focus: object[], stats: object }>}
 */
export async function measureMotion(page, { width = 1440, height = 900, budgetMs = 6000, cap = 8000, focus = true, clickBudgetMs = 0 } = {}) {
  const { events } = await settle(page, { width, height }, cap, { observe: true });
  await page.waitForTimeout(300);
  const loops = await captureLoops(page);
  // What changes by itself, and how often (capture/feeds.js), measured the way the capture measured the original.
  const feeds = await measureFeeds(page).catch(() => []);
  const found = await captureInteractions(page, { budgetMs, ...(!focus && { focusStops: 0 }) });
  const clicks = clickBudgetMs > 0 ? await captureClicks(page, { budgetMs: clickBudgetMs, limit: 40 }).catch(() => null) : null;
  return { reveal: processReveal(events ?? []), loops, feeds, hover: found.hover, focus: found.focus, stats: found.stats, ...(clicks && { clicks }) };
}
