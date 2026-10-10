// Captures one page at the recreate views (1440 / 1024 / 768 / 375, views.js): the rendered DOM with
// computed styles (snapshot.js), the network resources it loaded, and fold + full-page screenshots.
// Output per page: capture/<slug>/<view>.json and capture/<slug>/<view>-{fold,full}.webp.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USER_AGENT } from '../../audit/http.js';
import { parallelism } from '../../audit/resources.js';
import { encode, MAX_HEIGHT, MOBILE_UA } from '../../audit/screenshots.js';
import { mapLimit } from '../../audit/util.js';
import { RECREATE_VIEWS as VIEWS } from '../views.js';
import { captureClicks } from './clicks.js';
import { captureInteractions } from './interactions.js';
import { captureLoops } from './loops.js';
import { installRevealTracker, processReveal } from './reveal.js';
import { snapshotPage } from './snapshot.js';
import { captureNotices } from './notices.js';
import { captureStates } from './states.js';
import { probeScrollStates } from './scrollstate.js';
import { FOREIGN_BUDGET_MS, foreignStyleText, harvestForeignStateRules } from './foreignCss.js';
import { shapeCounts } from './selectorShape.js';
import { attachType, probeTypography } from './typography.js';
import { attachProbe, probeViewportHeight } from './viewport.js';

// Clicking through the states of tabs / carousels / filtered lists of one page (most pages have none: no time used). The
// limit follows the work (capture/states.js, ~3 s per control) within these bounds.
const NARROW_CLICK_BUDGET_MS = 8000; // the controls of a narrow layout (its own menu button)
const NARROW_CLICK_VIEWS = ['tablet', 'mobile']; // views probed for controls the desktop layout does not have
const STATES_BUDGET_MS ={ min: 30000, max: 100000, perControl: 4000 }; // 24 carousel slides took ~51 s

export { VIEWS };
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].trim();
export const captureDir = (workspace, slug) => path.join(workspace, 'capture', slug);
// How long a page gets to fire its load event after the document arrived.
const LOAD_WAIT = 20000;
// How far down the page the scroll-through goes. The screenshot stops at MAX_HEIGHT (8000 px), but the scroll must
// not: below that nothing loaded its lazy images and no scroll-reveal fired, so a tall page was captured with its
// lower sections empty or at opacity 0. The 80-step loop in settle() is the real bound (a step is 0.85 screens).
const SCROLL_CAP = 4 * MAX_HEIGHT;

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
export async function scrollToY(page, target) {
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

async function captureView(browser, pageInfo, view, dir, { timeout, motionBudgetMs = 0, clickBudgetMs = 0, cache = null, exact = false }) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    userAgent: view.id === 'mobile' ? MOBILE_UA : USER_AGENT,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  // Static files another view (or page) of this job already loaded come from the shared cache, not from the network again.
  await cache?.attach(context);
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

  // Where the time of this view goes (ms per phase), for the report: what is worth speeding up differs from site to site.
  const timing = {};
  let mark = Date.now();
  const lap = (phase) => {
    const now = Date.now();
    timing[phase] = (timing[phase] ?? 0) + now - mark;
    mark = now;
  };

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
    lap('document');
    await page.waitForLoadState('load', { timeout: LOAD_WAIT }).catch(() => {});
    lap('load');
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    lap('idle');
    const observeReveal = view.id === 'desktop' && motionBudgetMs > 0;
    const { events: revealEvents, ...reveal } = await settle(page, view, SCROLL_CAP, { observe: observeReveal });
    lap('scroll');
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    lap('idle');

    const snapshot = await page.evaluate(snapshotPage, { exact });
    lap('snapshot');
    // Continuous motion (4b.3) is read before the screenshots: a screenshot with animations disabled cancels the infinite ones.
    let loops = null;
    let loopsError = null;
    if (observeReveal) {
      try {
        loops = await captureLoops(page);
      } catch (err) {
        loopsError = firstLine(err);
      }
    }
    lap('motion');
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
    lap('screenshots');

    // Which boxes follow the window height (full-screen heroes, boxes centred at 50 %), read with a taller window.
    let viewportProbe = null;
    try {
      const probe = await probeViewportHeight(page, view);
      viewportProbe = { height: Math.round(view.height * 1.3), nodes: attachProbe(snapshot.body, probe.changed), ms: probe.ms };
    } catch (err) {
      viewportProbe = { error: firstLine(err) };
    }
    // Text sized with the window (font-size: clamp(…, 5vw, …)): read again at a few other widths (desktop view; the other
    // views have their own widths and media queries).
    let typeProbe = null;
    let scrollProbe = null;
    if (view.id === 'desktop') {
      try {
        const probe = await probeTypography(page, view);
        typeProbe = { nodes: attachType(snapshot.body, probe.changed), ms: probe.ms };
      } catch (err) {
        typeProbe = { error: firstLine(err) };
      }
      // Bars that change their look once the page is scrolled (a header turning light past the hero).
      try {
        scrollProbe = await probeScrollStates(page, snapshot.body, view);
      } catch (err) {
        scrollProbe = { error: firstLine(err) };
      }
    }
    lap('viewport');

    // Controls only a narrow layout has (a menu button, a drawer): the click probe on the phone and the tablet view too,
    // briefly and toggles first, after everything else was read from this page (it changes it). A tablet often collapses
    // the menu into a button of its own, which neither the desktop nor the phone probe sees. The copy rebuilds what it
    // finds there (ir/motion.js, by that view's snapshot paths).
    if (NARROW_CLICK_VIEWS.includes(view.id) && clickBudgetMs > 0) {
      try {
        const clicks = await captureClicks(page, { budgetMs: NARROW_CLICK_BUDGET_MS, limit: 8 });
        await writeFile(path.join(dir, `${view.id}-clicks.json`), JSON.stringify({ version: 1, view: view.id, clicks }));
      } catch {
        // the probe of a narrow view never fails a capture
      }
      lap('clicks');
    }

    // Hover and focus effects (4b.1) and how the scroll reveals run (4b.2), on the desktop view only, after
    // everything else was captured from the page.
    let motion = null;
    if (observeReveal) {
      let found = { version: 1, view: 'desktop', hover: [], focus: [], rules: [], groups: [], stats: { rulesTotal: 0, probed: 0, ms: 0, timedOut: false } };
      let error = null;
      // The hover / focus rules of stylesheets the page may not read (a CDN-hosted design system without CORS).
      // The shared cache usually holds them already, because the browser loaded them to render the page, so this
      // normally costs no request at all. They are put into the page below and probed like any other rule.
      let foreign = { rules: [], stats: null };
      try {
        foreign = await harvestForeignStateRules(snapshot.unreadableSheets, {
          cache,
          deadline: Date.now() + FOREIGN_BUDGET_MS,
        });
      } catch {
        /* a sheet that cannot be read leaves the page exactly as it was */
      }
      try {
        found = await captureInteractions(page, {
          budgetMs: motionBudgetMs,
          ...(foreign.rules.length && { foreignCss: foreignStyleText(foreign.rules) }),
        });
      } catch (err) {
        error = firstLine(err);
      }
      // Kept with the readable ones, marked by where they came from, so nothing is counted twice and the evidence
      // says which sheet a rule was in.
      if (foreign.rules.length) found.rules = [...(found.rules ?? []), ...foreign.rules];
      // Clicks last (full-site B.1): they change the page (menus open, slides move), so nothing is read from it after them.
      let clicksError = null;
      if (clickBudgetMs > 0) {
        try {
          found.clicks = await captureClicks(page, { budgetMs: clickBudgetMs });
          // The other states of tabs, carousels and filtered lists, onto the page snapshot (capture/states.js), and short
          // messages a click shows for a moment (capture/notices.js), side by side: both only need the click probe's result;
          // the notices are read in a fresh context of their own (a first visit), never from this page, and write only
          // `body.notices` while the states write onto the snapshot's nodes. What `page` says about itself is read first.
          const fromPage = { url: page.url(), viewport: page.viewportSize(), userAgent: await page.evaluate(() => navigator.userAgent) };
          const both = Date.now();
          const [states, notices] = await Promise.allSettled([
            captureStates(page, found.clicks, snapshot.body, { budgetMs: STATES_BUDGET_MS }),
            captureNotices(page, found.clicks, snapshot.body, fromPage),
          ]);
          // Time of the two together (each also records its own `ms`).
          found.statesNoticesMs = Date.now() - both;
          const cssUrls = [];
          if (states.status === 'fulfilled') {
            const { cssUrls: urls, ...rest } = states.value;
            found.states = rest;
            cssUrls.push(...urls);
          }
          if (notices.status === 'fulfilled') {
            const { cssUrls: urls, ...rest } = notices.value;
            found.notices = rest;
            cssUrls.push(...urls);
          }
          snapshot.cssUrls = [...new Set([...(snapshot.cssUrls ?? []), ...cssUrls])];
          const failed = [states, notices].find((r) => r.status === 'rejected');
          if (failed) throw failed.reason;
        } catch (err) {
          clicksError = firstLine(err);
        }
      }
      try {
        found.reveal = processReveal(revealEvents ?? []);
        if (loops) found.loops = loops;
      } catch (err) {
        error ??= firstLine(err);
      }
      try {
        await writeFile(path.join(dir, 'motion.json'), JSON.stringify(found));
        motion = {
          hover: found.hover.length, focus: found.focus.length, rules: found.rules.length, rulesTotal: found.stats.rulesTotal, probed: found.stats.probed, notReverted: found.stats.notReverted ?? 0,
          // What shape the page's own state rules have: how many reach outside the hovered element at all, so the
          // number the copy rebuilds can be held against it (capture/selectorShape.js).
          shapes: shapeCounts(found.rules),
          // Stylesheets the page itself could not read, and what was recovered from them server-side. Until now a
          // sheet without CORS cost every state rule in it and there was no number saying so.
          unreadableSheets: snapshot.unreadableSheets?.length ?? 0,
          ...(foreign.stats && { foreign: foreign.stats }),
          ms: found.stats.ms, timedOut: found.stats.timedOut, reveal: found.reveal?.stats ?? null, loops: loops?.stats ?? null, clicks: found.clicks?.stats ?? null,
          ...((error ?? loopsError ?? clicksError) && { error: error ?? loopsError ?? clicksError }),
        };
      } catch (err) {
        motion = { error: firstLine(err) };
      }
    }

    lap('motion');

    const data = {
      view: view.id,
      viewport: { width: view.width, height: view.height, dpr: view.dpr, mobile: view.mobile },
      status: response?.status() ?? 0,
      finalUrl: page.url(),
      capturedAt: new Date().toISOString(),
      timing,
      reveal,
      viewportProbe,
      typeProbe,
      scrollProbe,
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
      timing,
      reveal,
      ...(motion && { motion }),
      resources: data.resources,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Captures one discovered page at all views, side by side. A failing view is reported and the others
 * are kept; the caller decides whether the page is usable (the desktop view is required).
 * @param {import('playwright').Browser} browser
 * @param {{ url: string, slug: string }} pageInfo  an entry from discoverPages()
 * @param {string} workspace  the recreate workspace folder
 * @param {{ timeout?: number, motionBudgetMs?: number, clickBudgetMs?: number, cache?: object, patient?: boolean }} [o]
 *   cache: the job's shared cache of static files (audit/sharedCache.js); patient: a run with no time limit, which tries a
 *   view that failed more often and also tries one that timed out (there is no remaining time for it to cost)
 * @returns {Promise<{ views: Record<string, object>, errors: { view: string, message: string }[] }>}
 */
// Load failures worth one more try: the site refused or dropped the connection, which says nothing about the page.
const REFUSED = /ERR_EMPTY_RESPONSE|ERR_CONNECTION_(RESET|CLOSED|REFUSED|ABORTED)|ERR_SOCKET_NOT_CONNECTED|ERR_HTTP2_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR/;
const RETRY_WAIT_MS = 1500;
// A view the site gave up on in time, rather than refusing: worth another try only when the run has no limit.
const TIMED_OUT = /Timeout|timed out|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i;

export async function capturePage(browser, pageInfo, workspace, { timeout = 30000, motionBudgetMs = 0, clickBudgetMs = 0, cache = null, patient = false, exact = false } = {}) {
  const dir = captureDir(workspace, pageInfo.slug);
  await mkdir(dir, { recursive: true });
  // All views side by side when the machine has the memory for four loaded pages, fewer (never under two) when it is short
  // of it: more contexts than fit make every one of them slow and the loads time out. The desktop view starts first.
  const atOnce = parallelism({ max: VIEWS.length, min: 2 });
  const results = await mapLimit(VIEWS, atOnce, (view) =>
    captureView(browser, pageInfo, view, dir, { timeout, motionBudgetMs, clickBudgetMs, cache, exact }).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })));
  const views = {};
  const errors = [];
  results.forEach((r, i) => {
    const id = VIEWS[i].id;
    if (r.status === 'fulfilled') views[id] = r.value;
    else errors.push({ view: id, message: r.reason?.message?.split('\n')[0] ?? 'Capture failed' });
  });
  // A site that drops connections (ERR_EMPTY_RESPONSE and friends) failed every view of a page at once, and the page
  // was lost although nothing was wrong with it. Those views are tried once more, one at a time and after a pause, so
  // the retry paces the site instead of hammering it. The desktop view decides whether the page is usable at all, so
  // it gets one attempt more than the others. Timeouts are not retried: they cost the step its remaining time.
  // With no time limit every view is tried again each round, four rounds, and a view that timed out is tried too:
  // nothing is lost by waiting, and a page missing a view is a page the copy cannot be measured on.
  let retried = 0;
  for (const attempt of patient ? [1, 2, 3, 4] : [1, 2]) {
    const again = errors.filter((e) => (REFUSED.test(e.message) || (patient && TIMED_OUT.test(e.message)))
      && (patient || attempt === 1 || e.view === VIEWS[0].id));
    if (!again.length) break;
    for (const e of again) {
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS * attempt));
      const view = VIEWS.find((v) => v.id === e.view);
      try {
        views[e.view] = await captureView(browser, pageInfo, view, dir, { timeout, motionBudgetMs, clickBudgetMs, cache, exact });
        errors.splice(errors.indexOf(e), 1);
        retried++;
      } catch (err) {
        e.message = firstLine(err) || e.message;
      }
    }
  }
  return { views, errors, ...(retried && { retried }) };
}
