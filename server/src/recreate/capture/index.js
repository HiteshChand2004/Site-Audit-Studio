// Captures one page at the three recreate breakpoints (1440 / 768 / 375): the rendered DOM with
// computed styles (snapshot.js), the network resources it loaded, and fold + full-page screenshots.
// Output per page: capture/<slug>/<view>.json and capture/<slug>/<view>-{fold,full}.webp.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USER_AGENT } from '../../audit/http.js';
import { encode, MAX_HEIGHT, MOBILE_UA, VIEWS } from '../../audit/screenshots.js';
import { snapshotPage } from './snapshot.js';

export { VIEWS };
export const captureDir = (workspace, slug) => path.join(workspace, 'capture', slug);

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
// In the page: installs window.__sasReveal { dwell(), finalize() } (the reveal tracker).
function installRevealTracker() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HIDDEN = 0.05;
  const seenHidden = new Set();
  const revealed = new Map(); // element → { opacity, transform, filter } once it settles visible
  const last = new Map(); // element → "opacity|transform|filter" at the previous sample

  const state = (cs) => `${cs.opacity}|${cs.transform}|${cs.filter}`;
  // CSS transitions and Web Animations (which most builders use for appear effects) are finished at
  // once, so the element is read in its end state; polling alone can read a frame mid-animation.
  const finish = (el) => {
    for (const a of el.getAnimations?.() ?? []) {
      if (a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime)) continue;
      try {
        a.finish();
      } catch { /* not finishable */ }
    }
  };
  // Samples tracked elements (all elements when `full`); returns true when none of them changed.
  const sample = (full) => {
    let stable = true;
    const els = full ? document.body?.getElementsByTagName('*') ?? [] : [...seenHidden];
    for (const el of els) {
      if (seenHidden.has(el)) finish(el);
      const cs = getComputedStyle(el);
      const opacity = parseFloat(cs.opacity);
      if (opacity < HIDDEN) {
        seenHidden.add(el);
        continue;
      }
      if (!seenHidden.has(el)) continue;
      const s = state(cs);
      const settled = last.get(el) === s; // same state as the previous sample: not mid-animation
      if (!settled) stable = false;
      last.set(el, s);
      const prev = revealed.get(el);
      if (settled && (!prev || opacity >= prev.opacity - 0.01)) revealed.set(el, { opacity, transform: cs.transform, filter: cs.filter });
    }
    return stable;
  };

  // After each scroll step: let observers fire, then wait only while revealed elements are still
  // animating (at most 1.5 s); pages without reveal effects move on at once.
  const dwell = async () => {
    await sleep(150);
    let changing = !sample(true);
    const until = Date.now() + 1500;
    while (changing && Date.now() < until) {
      await sleep(120);
      changing = !sample(false);
    }
  };
  sample(true);
  window.__sasReveal = { dwell, finalize: () => finalize() };

  // Back at the top: pin the revealed state on elements that are hidden again below the first screen.
  const finalize = async () => {
    await sleep(300);
    const candidates = [];
    for (const [el, final] of revealed) {
      if (!el.isConnected || final.opacity < HIDDEN) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // Entirely in the first screen: what the visitor sees now (a hidden element there is more likely
      // a carousel or timed effect). One that crosses the fold is re-hidden by a scroll trigger.
      if (r.top >= 0 && r.bottom <= window.innerHeight) continue;
      if (parseFloat(cs.opacity) < final.opacity - 0.05 || cs.transform !== final.transform || cs.filter !== final.filter) {
        candidates.push({ el, final, rect: [r.left, r.top, r.width, r.height] });
      }
    }
    const overlap = (a, b) => {
      const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
      const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
      return x * y > 0.5 * Math.min(a[2] * a[3], b[2] * b[3]);
    };
    const stacked = new Set();
    for (const a of candidates) {
      for (const b of candidates) {
        if (a !== b && a.el.parentElement === b.el.parentElement && a.rect[2] * a.rect[3] > 0 && overlap(a.rect, b.rect)) stacked.add(a.el);
      }
    }
    const pinned = candidates.filter((c) => !stacked.has(c.el));
    const pin = ({ el, final }) => {
      el.style.setProperty('opacity', String(final.opacity), 'important');
      el.style.setProperty('transform', final.transform, 'important');
      el.style.setProperty('filter', final.filter, 'important');
      finish(el); // the change starts the site's own transition; jump to its end
    };
    pinned.forEach(pin);
    const byEl = new Map(pinned.map((c) => [c.el, c]));
    // Some runtimes write the style again (for example when the element leaves the view).
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        const c = byEl.get(rec.target);
        if (c && rec.target.style.getPropertyPriority('opacity') !== 'important') pin(c);
      }
    });
    for (const c of pinned) observer.observe(c.el, { attributes: true, attributeFilter: ['style'] });
  
    const pending = [...document.images].filter((img) => !img.complete);
    await Promise.all(pending.map((img) => new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
      setTimeout(r, 3000);
    })));
    await document.fonts?.ready;
    return { revealed: revealed.size, pinned: pinned.length, stacked: stacked.size };
  };
}

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
async function settle(page, view, cap) {
  await page.evaluate(installRevealTracker);
  // Near the left edge: less likely over an element with its own scroll area (carousels, maps).
  await page.mouse.move(Math.min(20, view.width / 4), Math.round(view.height / 2)).catch(() => {});
  const step = Math.max(400, Math.floor(view.height * 0.85));
  let y = 0;
  let max = 0;
  for (let i = 0; i < 80; i++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const end = Math.max(0, Math.min(height, cap) - view.height);
    if (y >= end) break;
    const next = await scrollToY(page, Math.min(y + step, end));
    if (next <= y) break; // the page does not scroll any further
    y = next;
    max = Math.max(max, y);
    await page.evaluate(() => window.__sasReveal.dwell());
  }
  // Back to the top (a large wheel step, else scrollTo), then pin what was revealed.
  if ((await scrollToY(page, 0)) > 1) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitStill(page);
  }
  const stats = await page.evaluate(() => window.__sasReveal.finalize());
  return { ...stats, scrolled: max };
}

async function captureView(browser, pageInfo, view, dir, { timeout }) {
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
    const response = await page.goto(pageInfo.url, { waitUntil: 'load', timeout });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const reveal = await settle(page, view, MAX_HEIGHT);
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
export async function capturePage(browser, pageInfo, workspace, { timeout = 30000 } = {}) {
  const dir = captureDir(workspace, pageInfo.slug);
  await mkdir(dir, { recursive: true });
  const results = await Promise.allSettled(VIEWS.map((view) => captureView(browser, pageInfo, view, dir, { timeout })));
  const views = {};
  const errors = [];
  results.forEach((r, i) => {
    const id = VIEWS[i].id;
    if (r.status === 'fulfilled') views[id] = r.value;
    else errors.push({ view: id, message: r.reason?.message?.split('\n')[0] ?? 'Capture failed' });
  });
  return { views, errors };
}
