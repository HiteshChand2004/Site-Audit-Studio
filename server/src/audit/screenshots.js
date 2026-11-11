// Rendered screenshots of the homepage at the three recreate breakpoints (1440 / 768 / 375).
// Used as the OLD preview when the site cannot be framed, and later for visual diffs (Phase 4b).
// Each view gets a first-screen ("fold") shot and a full-page shot capped at MAX_HEIGHT CSS px.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { USER_AGENT } from './http.js';
import { waitSettled } from './render.js';
import { mapLimit } from './util.js';

export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 Remastly/0.3';

export const VIEWS = [
  { id: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  { id: 'tablet', width: 768, height: 1024, dpr: 1, mobile: true },
  { id: 'mobile', width: 375, height: 812, dpr: 2, mobile: true },
];

// 8000 CSS px × DPR 2 = 16000 px, which stays under WebP's 16383 px limit.
export const MAX_HEIGHT = 8000;
// How long each step of the scroll-through stays put (ms): long enough for a reveal that waits for its element to be in view.
const SCROLL_DWELL_MS = 250;
const WEBP = { quality: 75, effort: 4 };

export const SCREEN_FILE = /^(desktop|tablet|mobile)-(fold|full)\.webp$/;
export const screensDir = (analysisDir) => path.join(analysisDir, 'screens');

export async function encode(png, file) {
  // Encoded in memory and written by Node: sharp cannot open a path longer than Windows' 260 characters, which a page
  // with a long URL reaches inside the data folder (found on panscience.xyz); Node's own file functions can.
  const { data, info } = await sharp(png).webp(WEBP).toBuffer({ resolveWithObject: true });
  await writeFile(file, data);
  return { width: info.width, height: info.height, bytes: info.size };
}

/** Scrolls to the top and waits until the page is there (≤ 2 s): a smooth-scroll library can override one jump. */
async function backToTop(page) {
  await page.evaluate(async () => {
    const started = Date.now();
    do {
      window.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 100));
    } while (window.scrollY > 0 && Date.now() - started < 2000);
  }).catch(() => {});
}

async function captureView(browser, url, view, dir, timeout, cache) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    userAgent: view.id === 'mobile' ? MOBILE_UA : USER_AGENT,
    ignoreHTTPSErrors: true,
  });
  try {
    await cache?.attach(context);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await waitSettled(page, { loadMs: 10000, idleMs: 4000 });

    // Scroll through once so lazy images and scroll-triggered sections render, then return to the top. Steps below one
    // window, so every element passes through the view, and a dwell at each: a reveal that waits for its element to stay
    // in view (or a throttled scroll handler) never fired at 100 ms per window, which left whole sections blank.
    const pageHeight = await page.evaluate(async ({ cap, dwell }) => {
      const step = Math.max(400, Math.floor(window.innerHeight * 0.85));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let y = 0; y < document.documentElement.scrollHeight && y < cap; y += step) {
        // "instant": a page with `scroll-behavior: smooth` would otherwise still be gliding when the next step comes.
        window.scrollTo({ top: y, behavior: 'instant' });
        await wait(dwell);
      }
      // Entrances started on the way down end before the shot (finite animations and transitions only, bounded).
      const ending = (document.getAnimations?.() ?? []).filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime));
      await Promise.race([Promise.all(ending.map((a) => a.finished.catch(() => {}))), wait(1500)]);
      await document.fonts?.ready;
      return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    }, { cap: MAX_HEIGHT, dwell: SCROLL_DWELL_MS });
    await backToTop(page);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    // Again right before the shots: a smooth-scroll script may still have been gliding, and a full-page shot draws a
    // sticky bar wherever the page is scrolled to (a menu bar across the middle of the picture, a gap at its top).
    await backToTop(page);

    // animations "allow": "disabled" resets running animations to their start, which stacks every word of a
    // cycling headline (or every slide of a rotating banner) on top of each other. The screenshot shows the
    // frame a visitor would see at this moment instead.
    const fold = await page.screenshot({ type: 'png', animations: 'allow' });
    const fullHeight = Math.min(pageHeight, MAX_HEIGHT);
    const full = await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'allow',
      clip: { x: 0, y: 0, width: view.width, height: fullHeight },
    });

    const [foldInfo, fullInfo] = await Promise.all([
      encode(fold, path.join(dir, `${view.id}-fold.webp`)),
      encode(full, path.join(dir, `${view.id}-full.webp`)),
    ]);
    return {
      viewport: { width: view.width, height: view.height, dpr: view.dpr },
      pageHeight,
      truncated: pageHeight > MAX_HEIGHT,
      fold: { file: `${view.id}-fold.webp`, ...foldInfo },
      full: { file: `${view.id}-full.webp`, ...fullInfo },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Captures the views with one shared browser. A failing view is reported, the rest are kept.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string} analysisDir  data/projects/<id>/audit/<analysisId>
 * @param {{ timeout?: number, parallel?: number, deadline?: number, cache?: object }} [o]  parallel: views captured at once; deadline (ms since
 *   epoch): a view not finished by then is given up and reported, so the views already taken are returned in time; cache: the
 *   job's shared cache of static files (sharedCache.js)
 * @returns {Promise<{ capturedAt: string, views: Record<string, object>, errors: {view:string, message:string}[] }>}
 */
export async function captureScreenshots(browser, url, analysisDir, { timeout = 30000, parallel = VIEWS.length, deadline = Infinity, cache = null } = {}) {
  const dir = screensDir(analysisDir);
  await mkdir(dir, { recursive: true });
  const inTime = (capture) => {
    if (!Number.isFinite(deadline)) return capture;
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Not captured within the time limit of the screenshots step.')), Math.max(0, deadline - Date.now()));
    });
    capture.catch(() => {}); // a view given up may still fail later (its browser is closed)
    return Promise.race([capture, late]).finally(() => clearTimeout(timer));
  };
  // `parallel` views at a time: all three side by side when the machine has room, one after the other when memory is short.
  const results = await mapLimit(VIEWS, Math.max(1, parallel), (view) =>
    (Date.now() >= deadline ? Promise.reject(new Error('Not captured within the time limit of the screenshots step.')) : inTime(captureView(browser, url, view, dir, timeout, cache)))
      .then((value) => ({ value }), (reason) => ({ reason })));
  const views = {};
  const errors = [];
  results.forEach((r, i) => {
    const id = VIEWS[i].id;
    if (r.value) views[id] = r.value;
    else errors.push({ view: id, message: r.reason?.message?.split('\n')[0] ?? 'Screenshot failed' });
  });
  return { capturedAt: new Date().toISOString(), views, errors };
}
