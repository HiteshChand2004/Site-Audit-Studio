import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { USER_AGENT } from './http.js';
import { withTimeout } from './util.js';
import { readSiteTypeEvidence } from '../detection/siteType.js';
import { freezePage } from '../recreate/verify/exact/freeze.js';

const VIEWPORT = { width: 1440, height: 900 };
const AXE_LIMIT_MS = 40000;

/**
 * @param {{ proxy?: string }} [opts]  egress proxy URL (security/egressProxy.js). Playwright also
 *   sends localhost traffic through it, so every connection is checked by the SSRF guard.
 */
export async function launchBrowser({ proxy } = {}) {
  return chromium.launch({ headless: true, ...(proxy && { proxy: { server: proxy } }) });
}

// Records WebGL context creation, which a DOM snapshot alone cannot reveal.
function installProbes() {
  window.__sasWebgl = false;
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
    if (/webgl/i.test(String(type))) window.__sasWebgl = true;
    return original.call(this, type, ...args);
  };
}

/** How long the axe step waits at most for the visible text to hold still, and how often it looks. */
export const TEXT_STILL_MAX_MS = 3000;
const TEXT_STILL_STEP_MS = 150;

/**
 * Page function: what the text of the page looks like right now - for each element with text of its own (first 5000), its
 * colour and how see-through it is (its opacity times its ancestors'), as one string.
 */
function textLook() {
  const seen = new Map();
  const eff = (el) => {
    if (!el || el.nodeType !== 1) return 1;
    if (seen.has(el)) return seen.get(el);
    const o = Number(getComputedStyle(el).opacity) * eff(el.parentElement);
    seen.set(el, o);
    return o;
  };
  const out = [];
  for (const el of document.body?.querySelectorAll('*') ?? []) {
    if (out.length >= 5000) break;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    out.push(`${Math.round(eff(el) * 100)}|${getComputedStyle(el).color}`);
  }
  return out.join(';');
}

/**
 * Waits until the page's text holds still (two looks TEXT_STILL_STEP_MS apart agree), at most `maxMs`.
 * @returns {Promise<{ still: boolean, waitedMs: number }>}
 */
export async function waitTextStill(page, { maxMs = TEXT_STILL_MAX_MS, stepMs = TEXT_STILL_STEP_MS } = {}) {
  const started = Date.now();
  let prev = await page.evaluate(textLook);
  while (Date.now() - started < maxMs) {
    await page.waitForTimeout(stepMs);
    const next = await page.evaluate(textLook);
    if (next === prev) return { still: true, waitedMs: Date.now() - started };
    prev = next;
  }
  return { still: false, waitedMs: Date.now() - started };
}

/**
 * Page function: from now on, an animation or transition that ends is finished as soon as it starts, on an element the page
 * puts in (checked on the next frame, so one waiting out its delay counts too) or on one that starts moving; animations that
 * never end (loops, spinners) keep running. Nothing already on the page is touched.
 */
export function settleNewAnimations() {
  const finish = (el, subtree) => {
    for (const a of el?.getAnimations?.({ subtree }) ?? []) {
      const t = a.effect?.getComputedTiming?.();
      if (t && Number.isFinite(t.endTime)) { try { a.finish(); } catch { /* a paused one at no time: left */ } }
    }
  };
  const event = (e) => finish(e.target, false);
  document.addEventListener('animationstart', event, true);
  document.addEventListener('transitionrun', event, true);
  new MutationObserver((ms) => {
    const added = ms.flatMap((m) => [...m.addedNodes].filter((n) => n.nodeType === 1));
    if (added.length) requestAnimationFrame(() => { for (const n of added) finish(n, true); });
  }).observe(document.body ?? document.documentElement, { subtree: true, childList: true });
}

// cache: the job's shared cache of static files (sharedCache.js); a file another context already loaded is not downloaded again.
async function openPage(browser, url, { timeout = 30000, cache = null } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT, ignoreHTTPSErrors: true });
  await cache?.attach(context);
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.addInitScript(installProbes);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await waitSettled(page);
  return { context, page, response, requests };
}

/**
 * Waits for a page to be loaded, but only as long as it is worth it. The document is already there; the `load` event
 * (every image, font, tracker and embed) and a quiet network only get a bounded wait, so one slow third-party request
 * cannot use up the time of the whole step (the page content is what the audit needs, not the last pixel of a tracker).
 */
export async function waitSettled(page, { loadMs = 10000, idleMs = 4000 } = {}) {
  const loaded = await page.waitForLoadState('load', { timeout: loadMs }).then(() => true, () => false);
  // A request that kept the load event from firing keeps the network busy too: waiting for it to go quiet would only add time.
  if (loaded) await page.waitForLoadState('networkidle', { timeout: idleMs }).catch(() => {});
}

// Lightweight render used by the crawler for client-rendered pages.
// scale: SAS_TIMEOUT_SCALE (audit/index.js analyzeTiming), more time for every wait on a slow machine.
export async function renderHtml(browser, url, { cache = null, scale = 1 } = {}) {
  const { context, page } = await openPage(browser, url, { timeout: 20000 * scale, cache });
  try {
    return { html: await page.content() };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Full homepage render: rendered DOM, network requests, cookies, detection globals, forms,
 * iframes, WebGL use, plus an axe-core accessibility run on the same page.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {{ globals?: string[] }} [opts]  window paths to test, e.g. "Shopify" or "__NEXT_DATA__"
 */
export async function renderHome(browser, url, { globals = [], cache = null, scale = 1, freezeForAxe = true } = {}) {
  const { context, page, response, requests } = await openPage(browser, url, { timeout: 45000 * scale, cache });
  try {
    // Scroll once so lazy-loaded sections and widgets initialise.
    await page.evaluate(async () => {
      const step = Math.max(400, window.innerHeight);
      for (let y = 0; y < document.body.scrollHeight && y < 20000; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

    const snapshot = await page.evaluate((names) => {
      const lookup = (path) => {
        try {
          return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), window) !== undefined;
        } catch {
          return false;
        }
      };
      return {
        foundGlobals: names.filter(lookup),
        // React holds the page: hydrateRoot / createRoot mark their container (__reactContainer$…), and every element React
        // drew carries __reactFiber$… — true for any React site in a real browser, whatever its bundle is named.
        reactRoot: [document, document.documentElement, document.body, document.getElementById('root'), document.getElementById('__next'), document.body?.firstElementChild]
          .some((n) => n && Object.keys(n).some((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'))),
        textLength: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
        webgl: Boolean(window.__sasWebgl),
        canvasCount: document.querySelectorAll('canvas').length,
        scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
        iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean),
        forms: [...document.forms].map((f) => ({
          action: f.getAttribute('action') ? f.action : '',
          method: (f.getAttribute('method') || 'get').toLowerCase(),
          hasPassword: Boolean(f.querySelector('input[type="password"]')),
          hasEmail: Boolean(f.querySelector('input[type="email"], input[name*="email" i]')),
          hasSearch: Boolean(f.querySelector('input[type="search"], input[name="s"], input[name="q"]')),
          hasTextarea: Boolean(f.querySelector('textarea')),
          fields: f.querySelectorAll('input:not([type="hidden"]), textarea, select').length,
        })),
      };
    }, globals);

    // Whether the page is drawn on a canvas rather than in the DOM (detection/siteType.js).
    const siteTypeEvidence = await page.evaluate(readSiteTypeEvidence).catch(() => null);
    const html = await page.content();
    const cookies = (await context.cookies()).map((c) => c.name);

    // Fade-ins started by the scroll above are still running for a moment: text caught half-faded reads as low contrast.
    // The scan waits (bounded) for animations that end; endless ones (loops, spinners) are not waited for.
    await page.evaluate(async () => {
      const ending = document.getAnimations().filter((a) => {
        const t = a.effect?.getComputedTiming?.();
        return a.playState === 'running' && t && Number.isFinite(t.endTime) && t.endTime < 10000;
      });
      await Promise.race([Promise.all(ending.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
    }).catch(() => {});
    // A fade a script drives frame by frame (Framer's runtime, most animation libraries) is no Web Animation, so the wait
    // above does not see it: Parchaa's texts were scanned at 45-90 % opacity and read as low contrast. The scan also waits
    // until the visible text holds still, at most TEXT_STILL_MAX_MS; at the cap (a slider or a ticker that never stops)
    // it scans the page as it is.
    if (freezeForAxe) await waitTextStill(page).catch(() => null);
    // Then every animation and transition still running is stopped the way the exact comparison stops them (repeating ones
    // at their start and paused, one-shots finished), in this page, with no extra load. A pulse or a blink is otherwise read
    // at whatever moment the scan lands on: a badge caught at the dim end of its pulse reads ~1:1 on one side and fine on the
    // other. renderHome is the axe step of both sides (Analyze for the original, the re-check for the copy), so both are
    // frozen alike. Nothing else is touched: the page is closed after the scan, and the motion checks, the look gate and
    // Lighthouse open their own pages.
    if (freezeForAxe) await freezePage(page).catch(() => null);
    // The page's timers keep running: a part that changes by itself (a feed adding a row every few seconds) puts in new
    // elements that fade in while axe scans, and a row caught half-faded reads as low contrast (flexibench: #c9c9c9). From
    // now on, every animation or transition that ends is finished as it starts; endless ones are left running.
    if (freezeForAxe) await page.evaluate(settleNewAnimations).catch(() => null);

    let axe = null;
    let axeError = null;
    try {
      // The accessibility scan is the one slow part of this step (a heavy page on a busy machine can take minutes). It gets its
      // own limit, so when it runs out the rest of the render (DOM, requests, detection globals) is still returned, not lost.
      axe = await withTimeout(new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze(), AXE_LIMIT_MS * scale, 'Accessibility scan');
    } catch (err) {
      axeError = err.message;
    }

    return {
      finalUrl: page.url(),
      status: response?.status() ?? 0,
      headers: response ? await response.allHeaders() : {},
      html,
      requests,
      cookies,
      ...snapshot,
      siteTypeEvidence,
      axe,
      axeError,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
