// The one way a page is loaded before it is measured, used by both sides of the exact comparison: the capture visits
// the original like this, and the compare renders the copy like this. One function, so the two sides cannot drift
// apart - which is the whole point, because a difference that comes from looking at the two pages differently is
// indistinguishable from a difference in the copy.
//
// load -> 4 s -> document.fonts.ready -> scroll in 300 px steps with 150 ms pauses -> back to the top -> 800 ms ->
// the mouse at (0, 0).
//
// The steps are below one screen on purpose (the capture's own scroll-through uses 0.85 screens for the same reason):
// every element passes through the view, so lazy images load and scroll reveals run. The page is re-measured at every
// step because loading content makes it grow.
import { scrollThrough, scrollToY } from '../../capture/index.js';

/** Bumped when the recipe changes: a baseline captured by an older recipe is not comparable and is re-captured. */
export const RECIPE_VERSION = 1;
export const LOAD_WAIT_MS = 4000;
export const FONTS_WAIT_MS = 10000;
export const SCROLL_STEP_PX = 300;
export const SCROLL_PAUSE_MS = 150;
export const TOP_WAIT_MS = 800;
/** 300 px steps over a very long page: the bound that stops a page which grows for ever (infinite scroll). */
export const MAX_STEPS = 400;
export const MAX_SCROLL_MS = 180000;

/**
 * Page function: what sits in the top-left corner, and whether a hover of the page's own stylesheets can reach it.
 * The recipe leaves the mouse at (0, 0) because that is one position both sides can agree on, but a logo link often
 * lives there and would then be hovered in every shot. It is not worth avoiding - it is worth reporting.
 */
function originNote() {
  const el = document.elementFromPoint(0, 0);
  if (!el) return null;
  const chain = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) chain.push(n);
  let hover = false;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a stylesheet this page may not read; best effort is honest here
    }
    for (const rule of rules) {
      const selector = rule.selectorText;
      if (!selector || !selector.includes(':hover')) continue;
      for (const part of selector.split(',')) {
        if (!part.includes(':hover')) continue;
        const probe = part.replace(/:hover/g, '').trim();
        if (!probe) continue;
        try {
          if (chain.some((n) => n.matches(probe))) hover = true;
        } catch {
          // a selector this browser cannot match: not evidence either way
        }
      }
      if (hover) break;
    }
    if (hover) break;
  }
  return {
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    hover,
  };
}

/**
 * Loads nothing itself: the caller navigates, this settles the page the same way on both sides.
 * @param {import('playwright').Page} page
 * @param {{ width: number, height: number }} slot
 * @param {{ cap?: number, deadline?: number }} [o]  cap: the tallest page worth scrolling through
 * @returns {Promise<{ version: number, steps: number, height: number, scrollWidth: number, reachedBottom: boolean,
 *   fonts: boolean, grew: number, ms: number, stoppedBy: string|null, origin: object|null }>}
 */
export async function settleExact(page, slot, { cap = Infinity, deadline = Infinity } = {}) {
  const started = Date.now();
  const note = {
    version: RECIPE_VERSION,
    steps: 0,
    height: 0,
    scrollWidth: 0,
    reachedBottom: false,
    fonts: false,
    grew: 0,
    ms: 0,
    stoppedBy: null,
    origin: null,
  };

  await page.waitForTimeout(LOAD_WAIT_MS);
  // The fonts decide every text box, so the page is not measured while they are still swapping in.
  note.fonts = await page
    .evaluate((ms) => Promise.race([
      document.fonts.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ms)),
    ]), FONTS_WAIT_MS)
    .catch(() => false);

  const firstHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const pass = await scrollThrough(page, {
    step: SCROLL_STEP_PX,
    viewportHeight: slot.height,
    cap,
    maxSteps: MAX_STEPS,
    // Measured from the start of the recipe (the load and font waits count), as before the loop was shared.
    maxMs: MAX_SCROLL_MS - (Date.now() - started),
    deadline,
    onStep: () => page.waitForTimeout(SCROLL_PAUSE_MS),
  });
  note.steps = pass.steps;
  note.reachedBottom = pass.reachedBottom;
  note.stoppedBy = pass.stoppedBy;

  await scrollToY(page, 0);
  await page.waitForTimeout(TOP_WAIT_MS);
  await page.mouse.move(0, 0).catch(() => {});

  const size = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
  }));
  note.height = size.height;
  note.scrollWidth = size.scrollWidth;
  // How much the page grew while it was scrolled through: lazy content, and the honest reason a height read at the
  // top before scrolling is not the height of the page.
  note.grew = Math.max(0, size.height - firstHeight);
  note.origin = await page.evaluate(originNote).catch(() => null);
  note.ms = Date.now() - started;
  return note;
}
