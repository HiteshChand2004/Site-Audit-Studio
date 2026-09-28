// Rendered screenshots of the homepage at the three recreate breakpoints (1440 / 768 / 375).
// Used as the OLD preview when the site cannot be framed, and later for visual diffs (Phase 4b).
// Each view gets a first-screen ("fold") shot and a full-page shot capped at MAX_HEIGHT CSS px.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { USER_AGENT } from './http.js';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 SiteAuditStudio/0.3';

export const VIEWS = [
  { id: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  { id: 'tablet', width: 768, height: 1024, dpr: 1, mobile: true },
  { id: 'mobile', width: 375, height: 812, dpr: 2, mobile: true },
];

// 8000 CSS px × DPR 2 = 16000 px, which stays under WebP's 16383 px limit.
const MAX_HEIGHT = 8000;
const WEBP = { quality: 75, effort: 4 };

export const SCREEN_FILE = /^(desktop|tablet|mobile)-(fold|full)\.webp$/;
export const screensDir = (analysisDir) => path.join(analysisDir, 'screens');

async function encode(png, file) {
  const info = await sharp(png).webp(WEBP).toFile(file);
  return { width: info.width, height: info.height, bytes: info.size };
}

async function captureView(browser, url, view, dir, timeout) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    userAgent: view.id === 'mobile' ? MOBILE_UA : USER_AGENT,
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Scroll through once so lazy images and scroll-triggered sections render, then return to the top.
    const pageHeight = await page.evaluate(async (cap) => {
      const step = Math.max(400, window.innerHeight);
      for (let y = 0; y < document.documentElement.scrollHeight && y < cap; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
      await document.fonts?.ready;
      return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    }, MAX_HEIGHT);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);

    const fold = await page.screenshot({ type: 'png', animations: 'disabled' });
    const fullHeight = Math.min(pageHeight, MAX_HEIGHT);
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
 * Captures all views in parallel with one shared browser. A failing view is reported, the rest are kept.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string} analysisDir  data/projects/<id>/audit/<analysisId>
 * @returns {Promise<{ capturedAt: string, views: Record<string, object>, errors: {view:string, message:string}[] }>}
 */
export async function captureScreenshots(browser, url, analysisDir, { timeout = 30000 } = {}) {
  const dir = screensDir(analysisDir);
  await mkdir(dir, { recursive: true });
  const results = await Promise.allSettled(VIEWS.map((view) => captureView(browser, url, view, dir, timeout)));
  const views = {};
  const errors = [];
  results.forEach((r, i) => {
    const id = VIEWS[i].id;
    if (r.status === 'fulfilled') views[id] = r.value;
    else errors.push({ view: id, message: r.reason?.message?.split('\n')[0] ?? 'Screenshot failed' });
  });
  return { capturedAt: new Date().toISOString(), views, errors };
}
