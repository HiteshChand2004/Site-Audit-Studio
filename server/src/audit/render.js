import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { USER_AGENT } from './http.js';
import { withTimeout } from './util.js';

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

async function openPage(browser, url, { timeout = 30000 } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT, ignoreHTTPSErrors: true });
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
export async function renderHtml(browser, url) {
  const { context, page } = await openPage(browser, url, { timeout: 20000 });
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
export async function renderHome(browser, url, { globals = [] } = {}) {
  const { context, page, response, requests } = await openPage(browser, url, { timeout: 45000 });
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

    const html = await page.content();
    const cookies = (await context.cookies()).map((c) => c.name);

    let axe = null;
    let axeError = null;
    try {
      // The accessibility scan is the one slow part of this step (a heavy page on a busy machine can take minutes). It gets its
      // own limit, so when it runs out the rest of the render (DOM, requests, detection globals) is still returned, not lost.
      axe = await withTimeout(new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze(), AXE_LIMIT_MS, 'Accessibility scan');
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
      axe,
      axeError,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
