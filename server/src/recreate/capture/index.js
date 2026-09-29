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
// images and fonts, then returns to the top. Runs in the page.
async function settle(cap) {
  const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
  for (let y = 0; y < document.documentElement.scrollHeight && y < cap; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((r) => setTimeout(r, 150));
  window.scrollTo(0, 0);
  const pending = [...document.images].filter((img) => !img.complete);
  await Promise.all(pending.map((img) => new Promise((r) => {
    img.addEventListener('load', r, { once: true });
    img.addEventListener('error', r, { once: true });
    setTimeout(r, 3000);
  })));
  await document.fonts?.ready;
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
    await page.evaluate(settle, MAX_HEIGHT);
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
