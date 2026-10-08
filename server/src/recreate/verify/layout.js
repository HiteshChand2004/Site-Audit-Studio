// Renders the generated site in Chromium and compares it with the capture of the original site.
// Used twice: the fit pass (generate step) adds sizes where the generated boxes are off, and the
// fidelity check (build step) scores the result. Both are rough, structure-level measures; the
// detailed visual diff comes in Phase 4b.
//
// Rendering is local only: the site is served from 127.0.0.1 (verify/server.js), every other request
// is aborted, and page JavaScript is disabled (the generated site is static HTML and CSS).
//
// Layout: every element carries data-sas-id in the measurement build, so its box can be compared
// with the captured box of the same element in the same view.
//   sizes = share of visible elements whose width and height match (±3 px or 3 % / 5 %)
//   boxes = share whose box overlaps the original by ≥ 60 % (IoU; catches vertical drift)
// Visual: both full-page screenshots scaled to 96 px wide; share of pixels within a small colour
// distance (rows only one page has count as different, so a wrong page height costs score).
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { USER_AGENT } from '../../audit/http.js';
import { launchBrowser } from '../../audit/render.js';
import { MAX_HEIGHT, MOBILE_UA } from '../../audit/screenshots.js';
import { contentBox } from '../ir/styles.js';
import { RECREATE_VIEWS as VIEWS } from '../views.js';
import { displayOf, isElement, isText } from '../ir/tree.js';
import { startSiteServer } from './server.js';
import { gotoLocal } from './goto.js';
import { optimized } from '../optimize.js';
import { scaledImage } from './visualDiff.js';

const VISUAL_WIDTH = 96;
const COLOR_TOLERANCE = 32;
export const SCORE_WEIGHTS = { sizes: 0.35, boxes: 0.25, visual: 0.4 };

/**
 * A browser that crashed or was closed under us: Chromium out of memory (`Target crashed`), or its process ended. Not a
 * slow page or a broken build: the same render in a new browser usually works.
 */
export const isBrowserCrash = (err) =>
  /Target crashed|Page crashed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(String(err?.message ?? err));

/** Launches Chromium with one browser context per view; every request outside `origin` is aborted. */
async function launchContexts(origin) {
  const browser = await launchBrowser();
  try {
    const contexts = {};
    for (const view of VIEWS) {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        deviceScaleFactor: 1,
        isMobile: view.mobile,
        hasTouch: view.mobile,
        userAgent: view.id === 'mobile' ? MOBILE_UA : USER_AGENT,
        javaScriptEnabled: false,
        serviceWorkers: 'block',
      });
      await context.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort('blockedbyclient')));
      contexts[view.id] = context;
    }
    return { browser, contexts };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Chromium plus one browser context per view, bound to a local server for `root`. `recover(generation)` replaces a crashed
 * browser with a new one (the contexts object is updated in place, so callers keep using `renderer.contexts`); renders
 * that saw the same crash share one relaunch (`generation` = the browser they used).
 */
export async function openRenderer(root) {
  const server = await startSiteServer(root);
  let launched;
  try {
    launched = await launchContexts(server.origin);
  } catch (err) {
    await server.close();
    throw err;
  }
  let pending = null;
  const renderer = {
    server,
    contexts: launched.contexts,
    generation: 0,
    recoveries: 0,
    recover: async (generation = renderer.generation) => {
      if (generation !== renderer.generation) return pending;
      pending ??= (async () => {
        await launched.browser.close().catch(() => {});
        launched = await launchContexts(server.origin);
        for (const key of Object.keys(renderer.contexts)) delete renderer.contexts[key];
        Object.assign(renderer.contexts, launched.contexts);
        renderer.recoveries++;
        renderer.generation++;
      })().finally(() => { pending = null; });
      return pending;
    },
    close: async () => {
      await pending?.catch(() => {});
      await launched.browser.close().catch(() => {});
      await server.close();
    },
  };
  return renderer;
}

/** Runs `fn(renderer)`; when the browser crashed under it, opens a new browser and runs it once more. */
export async function withBrowserRetry(renderer, fn) {
  const generation = renderer.generation ?? 0;
  try {
    return await fn(renderer);
  } catch (err) {
    if (!isBrowserCrash(err) || !renderer.recover) throw err;
    await renderer.recover(generation);
    return fn(renderer);
  }
}

// Runs in the page. Boxes are measured like the capture measures them (capture/snapshot.js rectOf):
// rotated or scaled elements by their untransformed size, centred on their bounding box.
function collectRects() {
  const rects = {};
  for (const el of document.querySelectorAll('[data-sas-id]')) {
    const r = el.getBoundingClientRect();
    const t = el instanceof HTMLElement ? getComputedStyle(el).transform : 'none';
    let box = [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
    if (t && t !== 'none' && !/^matrix\(1, 0, 0, 1, [^,]+, [^)]+\)$/.test(t)) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      box = [Math.round(r.left + r.width / 2 + scrollX - w / 2), Math.round(r.top + r.height / 2 + scrollY - h / 2), w, h];
    }
    rects[el.getAttribute('data-sas-id')] = box;
  }
  return { rects, scrollHeight: document.documentElement.scrollHeight };
}

/**
 * Makes images below the fold load (loading="lazy" images wait for a scroll that a full-page screenshot never makes)
 * and waits for them, at most `limit` ms. Without it the screenshot shows flat holes where the photos are, and the
 * recreate is scored down for pictures it does have.
 */
export async function loadLazyImages(page, limit = 6000) {
  await page.evaluate((ms) => Promise.race([
    Promise.all([...document.images].map((img) => { img.loading = 'eager'; return img.decode().catch(() => null); })),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]), limit).catch(() => {});
}

/**
 * Renders one page of the measurement build (served through `renderer.server.overrides`); after a browser crash the page is
 * rendered once more in a new browser.
 * @returns {Promise<{ rects: Record<string, number[]>, scrollHeight: number, png: Buffer|null }>}
 */
export function renderPage(renderer, outPath, viewId, options = {}) {
  return withBrowserRetry(renderer, () => renderOnce(renderer, outPath, viewId, options));
}

async function renderOnce(renderer, outPath, viewId, { screenshot = false, timeout = 15000 } = {}) {
  const page = await renderer.contexts[viewId].newPage();
  try {
    await gotoLocal(page, `${renderer.server.origin}/${outPath}`, timeout);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    if (screenshot) await loadLazyImages(page);
    const data = await page.evaluate(collectRects);
    let png = null;
    if (screenshot) {
      const width = VIEWS.find((v) => v.id === viewId).width;
      png = await page.screenshot({
        type: 'png',
        fullPage: true,
        animations: 'disabled',
        clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(data.scrollHeight, MAX_HEIGHT)) },
      });
    }
    return { ...data, png };
  } finally {
    await page.close().catch(() => {});
  }
}

const within = (a, b, abs, rel) => Math.abs(a - b) <= Math.max(abs, rel * b);
const widthOk = (r, o) => within(r[2], o[2], 3, 0.03);
const heightOk = (r, o) => within(r[3], o[3], 3, 0.05);
function iou(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = x * y;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

// A state of a tab panel / carousel the page does not start in (ir/states.js): hidden until a visitor clicks, so neither
// measured nor fixed (its boxes are those of its own state).
const stateCopy = (n) => !!n.stateAttrs && ('hidden' in n.stateAttrs || 'data-w-hcopy' in n.stateAttrs);
const visibleIn = (n, v) => {
  const d = n.views[v];
  return !stateCopy(n) && !!d && !d.hidden && d.rect[2] > 0 && d.rect[3] > 0;
};

/** Layout comparison of one page in one view. */
export function compareLayout(root, v, rects) {
  let total = 0;
  let sizes = 0;
  let boxes = 0;
  let missing = 0;
  const walk = (n) => {
    if (!isElement(n) || stateCopy(n)) return;
    if (visibleIn(n, v)) {
      total++;
      const o = n.views[v].rect;
      const r = rects[n.sid];
      if (!r || r[2] <= 0 || r[3] <= 0) missing++;
      else {
        if (widthOk(r, o) && heightOk(r, o)) sizes++;
        if (iou(r, o) >= 0.6) boxes++;
      }
    }
    if (n.tag !== 'svg') n.children.forEach(walk);
  };
  walk(root);
  const share = (k) => (total ? Math.round((k / total) * 1000) / 1000 : 1);
  return { elements: total, sizes: share(sizes), boxes: share(boxes), missing };
}

const NO_WIDTH_FIX = /^(inline|inline-block|inline-flex|inline-grid|table|table-cell|table-row|contents|none)$/;
const REPLACED = new Set(['img', 'svg', 'video', 'iframe', 'canvas', 'embed', 'object', 'input', 'select', 'textarea', 'button']);

/**
 * Adds size fixes where the generated boxes are off: widths top-down (only when the parent's
 * width already matches), min-heights bottom-up (only when every child's height matches and the
 * box came out shorter). Text boxes are left alone: a font difference is not a layout error.
 * @returns {{ widths: number, heights: number }}
 */
export function planFixes(root, v, rects) {
  let widths = 0;
  let heights = 0;
  const walk = (n, parent, parentWidthOk) => {
    if (!isElement(n) || !visibleIn(n, v)) return true;
    const o = n.views[v].rect;
    const r = rects[n.sid];
    if (!r) return true;
    const wOk = widthOk(r, o);
    const hOk = heightOk(r, o);
    let kidsOk = true;
    if (n.tag !== 'svg') for (const c of n.children) kidsOk = walk(c, n, wOk) && kidsOk;

    const directText = n.children.some((c) => isText(c) && c.text.trim());
    const display = displayOf(n, v);
    const fix = (n.fix ??= {});
    if (!wOk && parentWidthOk && parent && parent.tag !== 'html' && !REPLACED.has(n.tag) && !directText && !NO_WIDTH_FIX.test(display) && !fix[v]?.w) {
      const pd = parent.views[v];
      const pDisplay = displayOf(parent, v);
      const box = pd ? contentBox(parent, v) : null;
      const flexRow = /flex/.test(pDisplay) && !/column/.test(pd?.style['flex-direction'] ?? '');
      fix[v] = { ...fix[v], w: { px: o[2], ratio: box && box.w > 0 && !/grid/.test(pDisplay) ? o[2] / box.w : null, flex: flexRow } };
      widths++;
    }
    if (!hOk && r[3] < o[3] && kidsOk && !directText && !REPLACED.has(n.tag) && n.tag !== 'body' && !fix[v]?.mh) {
      fix[v] = { ...fix[v], mh: o[3] };
      heights++;
    }
    return hOk;
  };
  walk(root, null, true);
  return { widths, heights };
}

// The thumbnail is the visual diff's layout scale (96 px wide, no blur: the same decode), so with the image cache on
// (imageCache.js) the two comparisons of one screenshot share one decode, and an original is decoded once per job.
const thumb = (input) => (optimized('IMAGE_CACHE') ? scaledImage(input, { width: VISUAL_WIDTH, blur: 0 }) : decodeThumb(input));

async function decodeThumb(input) {
  // Read files into memory first: sharp keeps a cached handle on files it opens by path, and Windows
  // cannot rename the workspace folder while a handle is open.
  const buffer = typeof input === 'string' ? await readFile(input) : input;
  const { data, info } = await sharp(buffer).resize({ width: VISUAL_WIDTH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, height: info.height };
}

/** Rough visual similarity (0–1) of two full-page screenshots of the same view. */
export async function visualSimilarity(original, generated) {
  const [a, b] = await Promise.all([thumb(original), thumb(generated)]);
  const rows = Math.max(a.height, b.height);
  const overlap = Math.min(a.height, b.height);
  let match = 0;
  for (let i = 0; i < overlap * VISUAL_WIDTH * 3; i += 3) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d <= COLOR_TOLERANCE) match++;
  }
  return Math.round((match / (rows * VISUAL_WIDTH)) * 1000) / 1000;
}

/** 0–100 from the layout and visual shares (visual may be null when a screenshot is missing). */
export function viewScore({ sizes, boxes }, visual) {
  if (visual == null) return Math.round(((sizes * SCORE_WEIGHTS.sizes + boxes * SCORE_WEIGHTS.boxes) / (SCORE_WEIGHTS.sizes + SCORE_WEIGHTS.boxes)) * 100);
  return Math.round((sizes * SCORE_WEIGHTS.sizes + boxes * SCORE_WEIGHTS.boxes + visual * SCORE_WEIGHTS.visual) * 100);
}
