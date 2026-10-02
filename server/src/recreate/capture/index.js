// Captures one page at the recreate views (1440 / 1024 / 768 / 375, views.js): the rendered DOM with
// computed styles (snapshot.js), the network resources it loaded, and fold + full-page screenshots.
// Output per page: capture/<slug>/<view>.json and capture/<slug>/<view>-{fold,full}.webp.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USER_AGENT } from '../../audit/http.js';
import { encode, MAX_HEIGHT, MOBILE_UA } from '../../audit/screenshots.js';
import { RECREATE_VIEWS as VIEWS } from '../views.js';
import { captureInteractions } from './interactions.js';
import { installRevealTracker, processReveal } from './reveal.js';
import { snapshotPage } from './snapshot.js';

export { VIEWS };
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].trim();
export const captureDir = (workspace, slug) => path.join(workspace, 'capture', slug);
// How long a page gets to fire its load event after the document arrived.
const LOAD_WAIT = 20000;

// Scrolls through the page so lazy images and scroll-triggered sections load, waits for pending
// images and fonts, then returns to the top (settle, below). The scrolling is real input (the mouse
// wheel), because many sites let a script own the scroll position (smooth-scroll libraries) and undo
// programmatic scrolling: window.scrollTo alone left those pages at the top, so nothing below the
// first screen ever loaded or revealed. The wheel falls back to scrollTo when it does not move.
//
// Scroll-reveal ("appear") effects: many sites (Framer appear effects, Webflow interactions, AOS,
// GSAP ScrollTrigger) start sections at opacity 0 and show them only while they are in view; some
// hide them again when they leave. Capturing that state recreates invisible content. So while
// scrolling, every element that starts hidden (opacity ≈ 0) and is then shown by the page itself is
// recorded with the opacity / transform / filter it settles at. Back at the top, those values are
// pinned (inline !important, re-applied if the page rewrites the style) on elements that are hidden
// again and not entirely inside the first screen. Elements the page never shows (menus, dialogs) stay as they are, and
// hidden siblings stacked on the same box (carousel or tab slides) are left alone. The motion itself
// is recreated in Phase 4b.
//
// The tracker lives in reveal.js (it also records how the effects run, 4b.2).

const waitStill = async (page) => {
  // Smooth-scroll libraries animate towards the target: wait until the position stops changing.
  let y = await page.evaluate(() => scrollY);
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(80);
    const next = await page.evaluate(() => scrollY);
    if (Math.abs(next - y) < 1) break;
    y = next;
  }
  return Math.round(y);
};

/** Scrolls to `target` like a visitor (mouse wheel), else with scrollTo. Returns the new position. */
async function scrollToY(page, target) {
  const before = Math.round(await page.evaluate(() => scrollY));
  if (Math.abs(before - target) < 2) return before;
  await page.mouse.wheel(0, target - before).catch(() => {});
  let y = await waitStill(page);
  if (Math.abs(y - before) < 2) {
    await page.evaluate((t) => window.scrollTo(0, t), target);
    y = await waitStill(page);
  }
  return y;
}

/**
 * Scrolls through the page in steps below one viewport (so every element passes through the view),
 * lets the reveal tracker record each step, then returns to the top and pins revealed content.
 * @returns {Promise<{ revealed: number, pinned: number, stacked: number, scrolled: number }>}
 */
export async function settle(page, view, cap, { observe = false } = {}) {
  await page.evaluate(installRevealTracker, { observe });
  // Near the left edge: less likely over an element with its own scroll area (carousels, maps).
  await page.mouse.move(Math.min(20, view.width / 4), Math.round(view.height / 2)).catch(() => {});
  const step = Math.max(400, Math.floor(view.height * 0.85));
  let y = 0;
  let max = 0;
  let steps = 0;
  for (let i = 0; i < 80; i++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const end = Math.max(0, Math.min(height, cap) - view.height);
    if (y >= end) break;
    const next = await scrollToY(page, Math.min(y + step, end));
    if (next <= y) break; // the page does not scroll any further
    y = next;
    max = Math.max(max, y);
    await page.evaluate((n) => window.__sasReveal.dwell(n), steps++);
  }
  // Back to the top (a large wheel step, else scrollTo), then pin what was revealed.
  if ((await scrollToY(page, 0)) > 1) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitStill(page);
  }
  const stats = await page.evaluate(() => window.__sasReveal.finalize());
  return { ...stats, scrolled: max };
}

async function captureView(browser, pageInfo, view, dir, { timeout, motionBudgetMs = 0 }) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    userAgent: view.id === 'mobile' ? MOBILE_UA : USER_AGENT,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  const resources = new Map();
  const failed = [];
  context.on('response', (res) => {
    const url = res.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const req = res.request();
    const headers = res.headers();
    resources.set(url, {
      url,
      type: req.resourceType(),
      status: res.status(),
      mime: (headers['content-type'] || '').split(';')[0].trim() || null,
      bytes: Number(headers['content-length']) || null,
    });
  });
  context.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.startsWith('data:')) failed.push({ url, type: req.resourceType(), error: req.failure()?.errorText ?? 'failed' });
  });

  try {
    const page = await context.newPage();
    // The document must arrive in time; the load event (every image, tracker and embed) and a quiet
    // network only get a bounded wait. A slow third-party request must not lose the page: the
    // scroll-through below loads lazy content anyway, and pending images are awaited at the end.
    // A slow or briefly overloaded server gets one more attempt before the view is given up.
    const go = () => page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout });
    const response = await go().catch((err) => {
      if (!/timeout/i.test(err.message)) throw err;
      return go();
    });
    await page.waitForLoadState('load', { timeout: LOAD_WAIT }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const observeReveal = view.id === 'desktop' && motionBudgetMs > 0;
    const { events: revealEvents, ...reveal } = await settle(page, view, MAX_HEIGHT, { observe: observeReveal });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);

    const snapshot = await page.evaluate(snapshotPage, {});
    const fold = await page.screenshot({ type: 'png', animations: 'disabled' });
    const fullHeight = Math.max(1, Math.min(snapshot.scrollHeight, MAX_HEIGHT));
    const full = await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y: 0, width: view.width, height: fullHeight },
    });
    const [foldInfo, fullInfo] = await Promise.all([
      encode(fold, path.join(dir, `${view.id}-fold.webp`)),
      encode(full, path.join(dir, `${view.id}-full.webp`)),
    ]);

    // Hover and focus effects (4b.1) and how the scroll reveals run (4b.2), on the desktop view only, after
    // everything else was captured from the page.
    let motion = null;
    if (observeReveal) {
      let found = { version: 1, view: 'desktop', hover: [], focus: [], rules: [], groups: [], stats: { rulesTotal: 0, probed: 0, ms: 0, timedOut: false } };
      let error = null;
      try {
        found = await captureInteractions(page, { budgetMs: motionBudgetMs });
      } catch (err) {
        error = firstLine(err);
      }
      try {
        found.reveal = processReveal(revealEvents ?? []);
      } catch (err) {
        error ??= firstLine(err);
      }
      try {
        await writeFile(path.join(dir, 'motion.json'), JSON.stringify(found));
        motion = {
          hover: found.hover.length, focus: found.focus.length, rules: found.rules.length, rulesTotal: found.stats.rulesTotal, probed: found.stats.probed,
          ms: found.stats.ms, timedOut: found.stats.timedOut, reveal: found.reveal?.stats ?? null, ...(error && { error }),
        };
      } catch (err) {
        motion = { error: firstLine(err) };
      }
    }

    const data = {
      view: view.id,
      viewport: { width: view.width, height: view.height, dpr: view.dpr, mobile: view.mobile },
      status: response?.status() ?? 0,
      finalUrl: page.url(),
      capturedAt: new Date().toISOString(),
      reveal,
      ...snapshot,
      resources: [...resources.values()],
      failedRequests: failed,
      screenshots: {
        fold: { file: `${view.id}-fold.webp`, ...foldInfo },
        full: { file: `${view.id}-full.webp`, ...fullInfo, truncated: snapshot.scrollHeight > MAX_HEIGHT },
      },
    };
    await writeFile(path.join(dir, `${view.id}.json`), JSON.stringify(data));
    return {
      file: `${view.id}.json`,
      status: data.status,
      finalUrl: data.finalUrl,
      nodeCount: data.nodeCount,
      truncated: data.truncated,
      scrollHeight: data.scrollHeight,
      reveal,
      ...(motion && { motion }),
      resources: data.resources,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Captures one discovered page at all views, in parallel. A failing view is reported and the others
 * are kept; the caller decides whether the page is usable (the desktop view is required).
 * @param {import('playwright').Browser} browser
 * @param {{ url: string, slug: string }} pageInfo  an entry from discoverPages()
 * @param {string} workspace  the recreate workspace folder
 * @returns {Promise<{ views: Record<string, object>, errors: { view: string, message: string }[] }>}
 */
export async function capturePage(browser, pageInfo, workspace, { timeout = 30000, motionBudgetMs = 0 } = {}) {
  const dir = captureDir(workspace, pageInfo.slug);
  await mkdir(dir, { recursive: true });
  const results = await Promise.allSettled(VIEWS.map((view) => captureView(browser, pageInfo, view, dir, { timeout, motionBudgetMs })));
  const views = {};
  const errors = [];
  results.forEach((r, i) => {
    const id = VIEWS[i].id;
    if (r.status === 'fulfilled') views[id] = r.value;
    else errors.push({ view: id, message: r.reason?.message?.split('\n')[0] ?? 'Capture failed' });
  });
  return { views, errors };
}
