// The warm-up scroll of an as-is page: to its bottom, the way a visitor does, however tall it is — bounded by time, never by
// a fixed height. Used by the visual check (check.js) before every picture and by the completion pass (complete.js) before
// it lists the files a page asks for.
//
// Before 2026-10-24 both scrolled to a fixed 14 000 px. A phone layout is often taller (one real homepage: 11 654 px at 1440,
// 15 681 px at 390), so everything below that line was never brought into view: its lazy images and scroll-revealed parts
// were pictured in whatever state the load left them, and the files only they ask for were never fetched. Nothing said so.

/** A visitor's wheel: this many px every SCROLL_STEP_MS (14 000 px in about 4 s). */
export const SCROLL_STEP_PX = 400;
export const SCROLL_STEP_MS = 120;
/**
 * The most time one page's scroll-through may take (a page's cost is bounded, whatever its height — the launch rule). At the
 * pace above that is about 100 000 px of page; one that keeps growing as its bottom comes into view (an endless feed) ends
 * here with `capped: true`, which the caller reports, so nothing is cut off silently.
 */
export const SCROLL_MAX_MS = 30000;

/**
 * Scrolls the page down step by step until its bottom has been on screen for one step without the page growing (a lazy part
 * or an endless list that loads at the bottom makes it taller: the scroll goes on), or until `maxMs` is spent.
 * @returns {Promise<{ height: number, steps: number, ms: number, capped: boolean }>}  height = the page's final height
 */
export async function scrollThrough(page, { maxMs = SCROLL_MAX_MS, stepPx = SCROLL_STEP_PX, stepMs = SCROLL_STEP_MS } = {}) {
  const started = Date.now();
  let steps = 0;
  let height = 0;
  for (let y = 0; ; y += stepPx) {
    const m = await page.evaluate((yy) => {
      window.scrollTo(0, yy);
      return { height: document.documentElement.scrollHeight, view: innerHeight };
    }, y);
    steps++;
    height = m.height;
    await page.waitForTimeout(stepMs);
    if (y + m.view >= m.height) {
      // The bottom has been shown for a step: a part that loads there may have grown the page; done only when it did not.
      const grown = await page.evaluate(() => document.documentElement.scrollHeight);
      if (grown <= m.height) return { height, steps, ms: Date.now() - started, capped: false };
      height = grown;
    }
    if (Date.now() - started >= maxMs) return { height, steps, ms: Date.now() - started, capped: true };
  }
}
