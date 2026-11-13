// The checks of a packaged copy, the same for every stack and for the plain copy (the HTML stack's rules, extended to the
// pages of a site). A copy is checked against its original, page by page:
//   offline    a cold first visit (fresh context, no service worker yet) makes no request off the copy's own server;
//              responses of 400 or more are listed by address; console errors are recorded
//   visual     full-page screenshots against the original at 1440 and 390 px (raw pixel difference)
//   controls   every visible button / summary / [aria-expanded] / tab is clicked on both sides; the page changes the same way?
//              a control the original shows that the copy does not is "excluded by rule" when it is a fixed-position widget
//              whose third-party script the lift excluded; otherwise it is "missing"
//   hovers     the first links and buttons: does a hover change colour or background on both sides the same way?
//   forms      every form is filled with a test value and submitted: nothing may leave the copy; its note is recorded
// It measures; it never changes the copy. Browser-heavy: one page at a time.
import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { AxeBuilder } from '@axe-core/playwright';
import { exactDiffMany } from '../../verify/exact/pixels.js';
import { scriptCandidates } from './extract.js';
import { readRecordIndex, classifyScripts, recordBodyReader } from '../scripts.js';
import { freezePage, freezeTimers, holdSizeReactions } from '../../verify/exact/freeze.js';
import { MAX_HEIGHT } from '../../../audit/screenshots.js';
import { scrollThrough } from './scroll.js';
import { HOLD_FORMS } from './complete.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The third-party hosts the lift excluded by rule (trackers, chat widgets, the builder's editor): from the capture's record. */
export async function excludedHostsOf(captureRoot, originalUrl) {
  const dir = path.join(captureRoot, '.network');
  if (!(await stat(path.join(dir, 'index.json')).then(() => true, () => false))) return [];
  const siteHost = new URL(originalUrl).hostname.replace(/^www\./, '');
  const index = await readRecordIndex(dir);
  const classes = await classifyScripts(index, recordBodyReader(dir), { origin: originalUrl });
  return [...new Set(scriptCandidates(classes, siteHost).filter((s) => s.status === 'excluded').map((s) => new URL(s.url).hostname))];
}

/**
 * Opens the page and scrolls it to its bottom the way a visitor does (the lazy parts load), then back to the top. Bounded by
 * time, not height (scroll.js): a phone layout is often taller than the 14 000 px this stopped at before 2026-10-24.
 * @returns {Promise<{ height: number, steps: number, ms: number, capped: boolean }>}  capped: the page kept growing past the cap
 */
export async function openAndScroll(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(1500);
  const scrolled = await scrollThrough(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  return scrolled;
}

/**
 * Brings a page (its context already has `freezeTimers`) to the state the visual check pictures: opened and scrolled, then a
 * warm-up — a cold first load still brings fonts and images in while the picture is taken (one run in five was 14 % off) —
 * so it is loaded once more with its files cached, its fonts settled, and its animations frozen.
 */
export async function settleFrozen(page, url) {
  await openAndScroll(page, url);
  await page.reload({ waitUntil: 'load' });
  const scrolled = await openAndScroll(page, url);
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
  await freezePage(page);
  await page.waitForTimeout(400);
  return scrolled;
}

export { holdSizeReactions };

/** The full-page picture with the page's size reactions held (see holdSizeReactions; the context must have it). */
async function fullShot(page) {
  await page.evaluate(() => { window.__sasHoldSize = true; });
  return page.screenshot({ fullPage: true, type: 'png' });
}

/**
 * A context whose requests off the copy's own server are refused and recorded; the copy's own requests continue. The copy's
 * form guard holds every form in it (HOLD_FORMS), so a check never sends a form of another service anywhere.
 */
export async function isolated(browser, viewport, base, outside) {
  const context = await browser.newContext(viewport);
  await context.addInitScript(HOLD_FORMS);
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  return context;
}

export async function offlineCheck(browser, base, pagePath = '/') {
  const outside = [];
  const errors = [];
  const failed = [];
  const context = await isolated(browser, { viewport: { width: 1440, height: 900 } }, base, outside);
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(base, '')}`); });
    await openAndScroll(page, `${base}${pagePath}`);
    const sw = await page.evaluate(() => (navigator.serviceWorker?.controller ? 'controlled' : 'not controlled')).catch(() => 'n/a');
    return { external: [...new Set(outside)], errors, failed: [...new Set(failed)], serviceWorker: sw };
  } finally {
    await context.close();
  }
}

/** The window of the visual check at a width: a phone below 600 px. */
export const viewOf = (width) => {
  const mobile = width < 600;
  return { viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile };
};

/**
 * The pictures of several sides, taken in rounds: in each round every side gets a fresh context (frozen the same way — timers,
 * carousels and rotators stop on their first state, CSS animations are settled — warmed up, size reactions held) and all of
 * them are shot at the same moment, so a difference between sides is the page's, not the clock's. Rounds run one after
 * another, so at most one context per side is open at a time: a whole-site run on a small computer never opens six pages at
 * once. A side with `base` is the copy (requests off it are refused); without one it is the original, asked as a visitor.
 * @param {{ base?: string|null, url: string, errors?: string[] }[]} sides  `errors` collects that side's console errors;
 *   `scrollCapped` is set on a side whose page kept growing past the warm-up scroll's time cap in any round (reported, so a
 *   picture of a page that was never fully scrolled is not passed off as one of the whole page)
 * @returns {Promise<Buffer[][]>}  shots[side][round], PNGs
 */
export async function pictureRounds(browser, opts, sides, rounds = NOISE_SHOTS) {
  const shots = sides.map(() => []);
  for (let round = 0; round < rounds; round++) {
    const open = [];
    try {
      for (const s of sides) {
        const context = s.base ? await isolated(browser, opts, s.base, []) : await browser.newContext(opts);
        await context.addInitScript(freezeTimers);
        await context.addInitScript(holdSizeReactions);
        const page = await context.newPage();
        if (s.errors) {
          page.on('pageerror', (e) => s.errors.push(`pageerror: ${e.message.slice(0, 160)}`));
          page.on('console', (m) => { if (m.type() === 'error') s.errors.push(`console: ${m.text().slice(0, 160)}`); });
        }
        open.push({ context, page, url: s.url });
      }
      const settled = await Promise.all(open.map((o) => settleFrozen(o.page, o.url)));
      settled.forEach((r, i) => { if (r?.capped) sides[i].scrollCapped = true; });
      const taken = await Promise.all(open.map((o) => fullShot(o.page)));
      taken.forEach((png, i) => shots[i].push(png));
      // A side's own reading of its page (the "problem gone?" axe rules, Step 5c): in the first round, after the picture, in the
      // page already open; one side at a time. No page is opened for it.
      if (round === 0) {
        for (const [i, o] of open.entries()) {
          if (sides[i].inspect) sides[i].inspected = await sides[i].inspect(o.page).catch((err) => ({ error: String(err?.message ?? err).split('\n')[0].slice(0, 160) }));
        }
      }
    } finally {
      for (const o of open) await o.context.close().catch(() => {});
    }
  }
  return shots;
}

/**
 * The copy against the live original at one width, with the gate's own arithmetic (gateVerdict: one implementation for every
 * "is this the same picture" question): the copy on one side, the original on the other, each pictured NOISE_SHOTS times in
 * rounds. `diffPct` is the share of the compared pixels that differ in EVERY copy-vs-original pairing outside the places either
 * page moves by itself (the thresholds score it: copy/checks.js); `rawDiffPct` is the plain difference of the first pair, what a
 * one-picture check reports; `inNoisePct` what differed only sometimes or inside the noise map (reported, never judged).
 * (Before 2026-10-23 this compared ONE pair with the scoring threshold 0.1: a change of 23 levels on grey read 0, and a page
 * with a part that moves by itself gave another number on every run. Measured in copy-visual-check.test.js.)
 * @param {{ keepOriginal?: boolean }} [o]  keepOriginal: the original's pictures (PNGs) are returned as `originalShots`, so they
 *   can be kept as the page's baseline for a later check made when the original does not answer
 */
export async function visualCheck(browser, base, copyUrl, originalUrl, width, { keepOriginal = false } = {}) {
  const sides = [{ base, url: copyUrl }, { url: originalUrl }];
  const [copyShots, originalShots] = await pictureRounds(browser, viewOf(width), sides);
  const v = await gateVerdict(copyShots, originalShots);
  return {
    width, copyHeight: v.heights[1], originalHeight: v.heights[0], shots: NOISE_SHOTS,
    ...(sides.some((s) => s.scrollCapped) && { scrollCapped: true }),
    diffPct: v.widthMismatch ? null : v.changedPct, rawDiffPct: v.widthMismatch ? null : v.diffPct,
    inNoisePct: v.inNoisePct, noiseShare: v.noiseShare, changedPx: v.changedPx, inNoisePx: v.inNoisePx,
    ...(keepOriginal && { originalShots }),
  };
}

/** How many pictures the gate takes of each side (fixed, unfixed): every pair on one side shows where the page moves by itself. */
export const NOISE_SHOTS = 3;
/** The noise map is widened by this many blocks (8 px each) around every place the page moved by itself. */
export const NOISE_MARGIN_BLOCKS = 1;
/**
 * The ruler's colour threshold for the gate (exactDiff's `threshold`; its default 0.1 is pixelmatch's, used where a copy is
 * scored against its original). Proving a page UNCHANGED needs a finer one: at 0.05 a brightness step of about 13 / 255 on grey
 * counts (#f0f0f0 on white does; #f5f5f5 on white, 10 levels, does not — that is the limit).
 */
export const GATE_THRESHOLD = 0.05;
/**
 * How much decoded picture (RGBA bytes) one verdict may hold. Each picture takes part in three comparisons, so it is decoded
 * once and kept for them; a picture past this budget is read band by band in every comparison, as exactDiff does on its own.
 * Same pixels either way: only the time changes (three 1440 x 11 654 pictures a side are about 400 MB).
 */
// (Light 3: gateVerdict no longer holds decoded pictures; it reads every picture once, band by band, with exactDiffMany. Kept
// exported for callers that still decode a picture whole with decodePicture.)
export const DECODED_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Are a page's fixes invisible? The fixed copy and the same copy before its fixes, both local, are opened and pictured the same
 * way (frozen, warmed up, size reactions held) at 1440, with the console errors of each. One ruler for every picture in the
 * app (verify/exact/pixels.js exactDiff: perceptual colour distance, antialiased edges set aside, every pixel counted).
 * Each side is pictured NOISE_SHOTS times. Wherever two pictures of the SAME side differ, the page moves by itself (a random
 * particle, a clock, text typed by a script) — the noise map, in 8 px blocks, widened by NOISE_MARGIN_BLOCKS. A change the fixes
 * cause is in the same place on every load; noise is not. So a block is a visible change only when it differs in EVERY
 * fixed-vs-unfixed pairing (the i-th picture of each side) and lies outside the noise map. Fixes are invisible only with no such
 * pixel, the same width and height, and no console error the unfixed page does not have; otherwise they are undone
 * (docs/COPY-MY-SITE.md §5, reason d). What differs only sometimes, or inside the noise map, cannot be proven either way: it is
 * counted (inNoisePx) and reported, never silently passed as "no change".
 * (Measured on nyaayai: one load of its own unfixed page against another differed by 17 px outside a three-picture noise map, so
 * a single fixed-vs-unfixed comparison read noise as a change; the every-pairing rule is what separates the two.)
 * (Before 2026-10-23: a share of the whole page against max(0.01 %, 2 × noise), with a 24-level colour cut and the share
 * rounded to 0.01 % — it could not see a 30 x 30 px change on a tall page, or any pale change at all.)
 */
/** How long one axe reading of the gate may take before it counts as "could not read". */
export const AXE_GATE_MS = 30000;

/** How many elements fail each of these axe rules in the page as it is now (rule → count). Only these rules run. */
export async function axeCounts(page, rules) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`axe did not finish in ${AXE_GATE_MS / 1000} s`)), AXE_GATE_MS); });
  try {
    const r = await Promise.race([new AxeBuilder({ page }).withRules(rules).analyze(), limit]);
    return Object.fromEntries(rules.map((id) => [id, r.violations.find((v) => v.id === id)?.nodes.length ?? 0]));
  } finally {
    clearTimeout(timer);
  }
}

/** The widths every as-is fix is proved invisible at: a phone first (touch, mobile mode), then a computer. */
export const GATE_WIDTHS = [375, 1440];

/**
 * The proof at every width of GATE_WIDTHS, each with the same rounds and console-error check: invisible only when every width
 * is. A change at one width decides (the next is not rendered); the top-level fields are the failing width's, else the last
 * one's, as callers have always read them; `views` holds each width's verdict.
 */
/**
 * The pictures of the page before its fixes, kept on disk for the checks that follow (one fix proof looks at the same unfixed
 * page again and again: every group alone, then together). Kept per page and width with the console errors of their loads and
 * whether a load was not scrolled to its end. On disk, not in memory: three full-page pictures per width of 100 pages would not
 * fit. `clear()` removes the folder.
 * @param {string} dir
 */
export function beforePictures(dir) {
  /** @type {Map<string, { files: string[], errors: string[], scrollCapped: boolean }>} */
  const index = new Map();
  let n = 0;
  return {
    /** @param {string} key */
    async get(key) {
      const e = index.get(key);
      if (!e) return null;
      const shots = await Promise.all(e.files.map((f) => readFile(f))).catch(() => null);
      return shots ? { shots, errors: e.errors, scrollCapped: e.scrollCapped } : null;
    },
    /** @param {string} key @param {{ shots: Buffer[], errors: string[], scrollCapped: boolean }} v */
    async set(key, { shots, errors, scrollCapped }) {
      await mkdir(dir, { recursive: true });
      const id = n++;
      const files = await Promise.all(shots.map(async (png, i) => {
        const f = path.join(dir, `${id}-${i}.png`);
        await writeFile(f, png);
        return f;
      }));
      index.set(key, { files, errors: [...errors], scrollCapped: Boolean(scrollCapped) });
    },
    get size() { return index.size; },
    async clear() {
      index.clear();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function fixGate(browser, fixedBase, unfixedBase, pagePath, { widths = GATE_WIDTHS, axeRules = null, axeBefore = null, parallel = false, before = null } = {}) {
  // parallel: every width pictured at the same time (the same rounds and the same verdict per width; every width is rendered,
  // and the first failing one in the order of `widths` decides). Else one width after the other, stopping at the first change.
  // before (beforePictures): the unfixed page's pictures of an earlier look are reused, so only the fixed page is opened (user,
  // 2026-11-13: the unchanged page was pictured again for every look). A look that finds a change with kept pictures is made
  // again with both pages opened now, and its pictures replace the kept ones: kept pictures never decide a change on their own.
  const one = async (width) => {
    const key = `${pagePath}|${width}`;
    const kept = before && (!axeRules?.length || axeBefore?.has(key)) ? await before.get(key) : null;
    if (kept) {
      const fixedErrors = [];
      const fixedSide = { base: fixedBase, url: `${fixedBase}${pagePath}`, errors: fixedErrors, ...(axeRules?.length && { inspect: (page) => axeCounts(page, axeRules) }) };
      const [fixedShots] = await pictureRounds(browser, viewOf(width), [fixedSide]);
      const verdict = await gateVerdict(fixedShots, kept.shots);
      const newErrors = [...new Set(fixedErrors)].filter((e) => !kept.errors.some((u) => u.includes(e)));
      const invisible = verdict.changedPx === 0 && !verdict.sizeChanged && newErrors.length === 0;
      if (invisible) {
        let axe;
        if (axeRules?.length) {
          const b = axeBefore.get(key);
          const after = fixedSide.inspected;
          axe = b?.error || after?.error ? { width, error: b?.error ?? after?.error } : { width, before: b, after };
        }
        return { width, ...verdict, newErrors, invisible, beforeReused: true, ...((fixedSide.scrollCapped || kept.scrollCapped) && { scrollCapped: true }), ...(axe && { axe }) };
      }
    }
    return fresh(width, key);
  };
  const fresh = async (width, key) => {
    const fixedErrors = [];
    const unfixedErrors = [];
    // axeRules: these axe rules are read on both sides in the visit the gate makes anyway (the unfixed side once per page and
    // width: axeBefore caches it, keyed by path and width). The view gets axe { width, before, after } (rule → elements failing).
    const cached = axeBefore?.get(`${pagePath}|${width}`);
    const read = axeRules?.length ? (page) => axeCounts(page, axeRules) : null;
    const sides = [
      { base: fixedBase, url: `${fixedBase}${pagePath}`, errors: fixedErrors, ...(read && { inspect: read }) },
      { base: unfixedBase, url: `${unfixedBase}${pagePath}`, errors: unfixedErrors, ...(read && !cached && { inspect: read }) },
    ];
    const [fixedShots, unfixedShots] = await pictureRounds(browser, viewOf(width), sides);
    if (before) await before.set(key, { shots: unfixedShots, errors: unfixedErrors, scrollCapped: Boolean(sides[1].scrollCapped) }).catch(() => {});
    const verdict = await gateVerdict(fixedShots, unfixedShots);
    // A console error of the fixed page that no load of the unfixed page had.
    const newErrors = [...new Set(fixedErrors)].filter((e) => !unfixedErrors.some((u) => u.includes(e)));
    const invisible = verdict.changedPx === 0 && !verdict.sizeChanged && newErrors.length === 0;
    let axe;
    if (read) {
      const unfixedAxe = cached ?? sides[1].inspected;
      if (!cached && unfixedAxe && !unfixedAxe.error) axeBefore?.set(`${pagePath}|${width}`, unfixedAxe);
      const after = sides[0].inspected;
      axe = unfixedAxe?.error || after?.error ? { width, error: unfixedAxe?.error ?? after?.error } : { width, before: unfixedAxe, after };
    }
    // scrollCapped: a side was never scrolled to its end (reported; the speed fixes count such a look as not conclusive).
    return { width, ...verdict, newErrors, invisible, ...(sides.some((s) => s.scrollCapped) && { scrollCapped: true }), ...(axe && { axe }) };
  };
  const views = [];
  if (parallel) views.push(...await Promise.all(widths.map(one)));
  else {
    for (const width of widths) {
      const v = await one(width);
      views.push(v);
      if (!v.invisible) break;
    }
  }
  const failed = views.find((v) => !v.invisible);
  return { path: pagePath, ...(failed ?? views.at(-1)), width: failed?.width ?? null, views, invisible: views.length > 0 && !failed };
}

/**
 * Where a page's images are and which element is its Largest Contentful Paint, measured on the copy BEFORE its fixes at every
 * width of GATE_WIDTHS, the way the gate opens it (same window, phone mode below 600 px, nothing off the copy's own server).
 * Read once the page has loaded and rested, scrolled to the top: what a visitor sees first. An image is named as the markup
 * names it (its src attribute as written, and its occurrence among images with that src), so copy/perfAsIs.js can find it in
 * the HTML; `total` is how many images with that src the page holds as its scripts built it. `styles` are the stylesheets of the
 * copy the page loaded, however (a link, an @import, a script), as paths on the copy's server; `integrity` the ones a <link>
 * loads with an integrity hash; `scrolled` whether the page was scrolled to its end; `scrollers` the boxes that scroll and the
 * keyboard cannot reach (axe scrollable-region-focusable), read in the same visit (no extra page load).
 * @returns {Promise<{ path: string, widths: { width: number, viewportH: number, lcp: object|null, images: object[], styles: string[], integrity: string[], scrollers: object[], scrolled: boolean }[] }>}
 */
export async function perfProbe(browser, base, pagePath, { widths = GATE_WIDTHS, parallel = false } = {}) {
  // parallel: every width measured at the same time (one context each, same browser), else one after the other. Same reading.
  const one = async (width) => {
    const opts = viewOf(width);
    const context = await isolated(browser, opts, base, []);
    try {
      await context.addInitScript(() => {
        window.__sasLcp = null;
        try {
          new PerformanceObserver((list) => { const e = list.getEntries().at(-1); if (e) window.__sasLcp = e; })
            .observe({ type: 'largest-contentful-paint', buffered: true });
        } catch { /* no LCP in this browser: none is named */ }
      });
      const page = await context.newPage();
      const styles = new Set();
      page.on('response', (r) => { if (r.request().resourceType() === 'stylesheet' && r.url().startsWith(base)) styles.add(new URL(r.url()).pathname); });
      await page.goto(`${base}${pagePath}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 0));
      const read = await page.evaluate(() => {
        const nameOf = (img) => {
          const src = img.getAttribute('src');
          if (src == null) return { src: null, k: 0, total: 0 };
          const same = [...document.images].filter((i) => i.getAttribute('src') === src);
          return { src, k: same.indexOf(img), total: same.length };
        };
        const scroller = (el) => {
          for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
            const s = getComputedStyle(p);
            if ((/(auto|scroll|hidden)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1)
              || (/(auto|scroll|hidden)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1)) return true;
          }
          return false;
        };
        const images = [...document.images].filter((img) => img.getAttribute('src') != null).map((img) => {
          const r = img.getBoundingClientRect();
          const s = getComputedStyle(img);
          return {
            ...nameOf(img),
            top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left, right: r.right,
            visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && img.checkVisibility?.({ opacityProperty: false }) !== false,
            inScroller: scroller(img),
            lazyLib: img.getAttributeNames().some((n) => /^(data-src|data-srcset|data-lazy|data-lazy-src|data-original|data-bg)$/.test(n)),
            loading: img.getAttribute('loading'), fetchpriority: img.getAttribute('fetchpriority'),
          };
        });
        const e = window.__sasLcp;
        const el = e?.element ?? null;
        const lcp = el ? (el.tagName === 'IMG'
          ? { tag: 'img', ...nameOf(el) }
          : { tag: el.tagName.toLowerCase(), background: Boolean(e.url) }) : null;
        const integrity = [...document.querySelectorAll('link[rel~="stylesheet"][integrity]')].map((l) => { try { return new URL(l.href).pathname; } catch { return null; } }).filter(Boolean);
        // axe scrollable-region-focusable's test (axe-core 4.13 getScroll(el, 13)): a box whose content is more than 13 px larger
        // than it on an axis whose overflow is auto or scroll, that the keyboard cannot reach (it and everything in it out of the
        // tab order). Named by its place under <body> (tag and index among the element children at each level) with its id and
        // class, so copy/seoA11yAsIs.js finds the same element in the HTML or leaves it.
        const tabbable = (e) => e.tabIndex >= 0 && !e.disabled;
        const scrollers = [];
        for (const el of document.querySelectorAll('body *')) {
          if (scrollers.length >= 24) break;
          if (/^(select|textarea)$/i.test(el.tagName)) continue;
          const overX = el.scrollWidth > el.clientWidth + 13;
          const overY = el.scrollHeight > el.clientHeight + 13;
          if (!overX && !overY) continue;
          const s = getComputedStyle(el);
          if (!((overX && /^(auto|scroll)$/.test(s.overflowX)) || (overY && /^(auto|scroll)$/.test(s.overflowY)))) continue;
          if (tabbable(el) || el.isContentEditable || [...el.querySelectorAll('*')].some(tabbable)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0) || s.visibility === 'hidden') continue;
          const path = [];
          for (let e = el; e && e !== document.body; e = e.parentElement) path.unshift([e.tagName.toLowerCase(), [...e.parentElement.children].indexOf(e)]);
          scrollers.push({ path, id: el.getAttribute('id'), cls: el.getAttribute('class'), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) });
        }
        return { viewportH: window.innerHeight, lcp, images, integrity, scrollers };
      });
      // Then down the page as a visitor scrolls (scroll.js), so a stylesheet a script loads on the way is known too. `scrolled`
      // is false when that failed or stopped at its time cap: the list of stylesheets may then be short.
      const scroll = await scrollThrough(page).catch(() => null);
      return { width, ...read, styles: [...styles], scrolled: Boolean(scroll && !scroll.capped) };
    } finally {
      await context.close();
    }
  };
  const out = [];
  if (parallel) out.push(...await Promise.all(widths.map(one)));
  else for (const width of widths) out.push(await one(width));
  return { path: pagePath, widths: out };
}

/** The lines a click added to a page's text and the lines it removed (each line counted as often as it appears). */
export function textDelta(before, after) {
  const left = String(before ?? '').split('\n');
  const added = String(after ?? '').split('\n').filter((line) => {
    const i = left.indexOf(line);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
  return { added, removed: left };
}

/**
 * Do the links the anchors fix gave a role (copy/seoA11yAsIs.js: role="button" on the fixed side, not on the unfixed one) still
 * do what they did? A role is ARIA only, but the page's own script or CSS may select on it: this is the proof that it does not.
 * At every width each such link is clicked on both sides, each on a freshly loaded page: the same when the click adds and
 * removes the same lines of the page's text on both (textDelta: what each side already showed cancels out, so the fixed side's
 * own hidden link text does not count), leaves both at the same address, and brings no console error the unfixed side's click
 * did not. Whether the text changed is not enough: a script that reacts to the role by doing something more changes it too.
 * A link drawn on neither side at a width cannot be clicked there (counted in notShown). Not frozen, on purpose: a click that
 * opens something after a timer must be seen; a page whose text moves by itself can therefore read as different, which drops
 * the fix (never keeps one wrongly).
 * @returns {Promise<{ same: boolean, clicked: number, notShown: number, differs: object[] }>}
 */
export async function anchorClicks(browser, fixedBase, unfixedBase, pagePath, { widths = GATE_WIDTHS } = {}) {
  const differs = [];
  let clicked = 0;
  let notShown = 0;
  for (const width of widths) {
    const sides = [fixedBase, unfixedBase].map((base) => ({ base, url: `${base}${pagePath}`, errors: [] }));
    const contexts = [];
    try {
      const pages = [];
      for (const s of sides) {
        const context = await isolated(browser, viewOf(width), s.base, []);
        contexts.push(context);
        const page = await context.newPage();
        page.on('pageerror', (e) => s.errors.push(`pageerror: ${e.message.slice(0, 160)}`));
        page.on('console', (m) => { if (m.type() === 'error') s.errors.push(`console: ${m.text().slice(0, 160)}`); });
        pages.push(page);
      }
      const withRole = (page) => page.evaluate(() => [...document.querySelectorAll('a')].flatMap((a, i) => (a.getAttribute('role') === 'button' ? [i] : [])));
      await Promise.all(pages.map((page, k) => page.goto(sides[k].url, { waitUntil: 'load', timeout: 120000 })));
      const [fixedRoles, unfixedRoles] = await Promise.all(pages.map(withRole));
      for (const i of fixedRoles.filter((i) => !unfixedRoles.includes(i))) {
        const outcome = [];
        for (const [k, page] of pages.entries()) {
          await page.goto(sides[k].url, { waitUntil: 'load', timeout: 120000 });
          await page.waitForTimeout(800);
          const link = page.locator('a').nth(i);
          if (!(await link.isVisible().catch(() => false))) {
            outcome.push({ shown: false });
            continue;
          }
          const errorsBefore = sides[k].errors.length;
          const before = await page.evaluate(() => document.body.innerText);
          await link.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(700);
          const after = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          outcome.push({ shown: true, changed: before !== after, delta: textDelta(before, after), at: page.url().replace(sides[k].base, ''), errors: sides[k].errors.slice(errorsBefore) });
        }
        const [f, u] = outcome;
        if (!f.shown && !u.shown) {
          notShown++;
          continue;
        }
        clicked++;
        const newErrors = f.shown ? f.errors.filter((e) => !(u.errors ?? []).some((x) => x.includes(e))) : [];
        const sameChange = f.shown && u.shown ? JSON.stringify(f.delta) === JSON.stringify(u.delta) : true;
        if (f.shown !== u.shown || !sameChange || f.at !== u.at || newErrors.length) {
          const brief = (o) => ({ shown: o.shown, changed: o.changed, at: o.at, ...(o.delta && { added: o.delta.added.slice(0, 3), removed: o.delta.removed.slice(0, 3) }) });
          differs.push({ width, index: i, fixed: brief(f), unfixed: brief(u), newErrors });
        }
      }
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
    }
  }
  return { same: differs.length === 0, clicked, notShown, differs };
}

/**
 * The picture arithmetic of every "is this the same picture" question in the app (the fix gate, the as-is visual check, the
 * baseline check), apart from the browser so it is testable on its own: the noise map from every pair of pictures of the SAME
 * side (either side), then the blocks that differ in every side-A-vs-side-B pairing outside that map.
 * @param {Buffer[]} fixedShots  side A (the fixed page, or the copy): PNGs (a single Buffer is taken as one picture)
 * @param {Buffer[]} unfixedShots  side B (the unfixed page, or the original): PNGs; with one picture only, the noise map comes
 *   from side A alone (a saved baseline has no second picture)
 * @param {{ threshold?: number }} [o]  the ruler's colour threshold (GATE_THRESHOLD)
 */
export async function gateVerdict(fixedShots, unfixedShots, { threshold = GATE_THRESHOLD } = {}) {
  const fixedList = Buffer.isBuffer(fixedShots) ? [fixedShots] : fixedShots;
  if (Buffer.isBuffer(unfixedShots)) unfixedShots = [unfixedShots];
  // Every comparison of the verdict at once, each picture decoded once and read band by band (Light 3: exactDiffMany holds only
  // the band in hand of each picture, where the whole decoded pictures were held before). Same pairs, same order, same results.
  const pictures = [];
  const indexOf = (png) => {
    let i = pictures.indexOf(png);
    if (i < 0) i = pictures.push(png) - 1;
    return i;
  };
  const same = [];
  for (const side of [fixedList, unfixedShots]) {
    for (let i = 0; i < side.length; i++) for (let j = i + 1; j < side.length; j++) same.push([indexOf(side[i]), indexOf(side[j])]);
  }
  const cross = fixedList.map((png, i) => [indexOf(unfixedShots[i % unfixedShots.length]), indexOf(png)]);
  const results = await exactDiffMany(pictures, [...same, ...cross], { threshold });
  const pairs = results.slice(0, same.length);
  const crosses = results.slice(same.length);
  const change = crosses[0];
  const { cols, rows } = change.blocks;
  // A block counts as changed only when every pairing shows it (the smallest count of them, so a change is never over-stated).
  const counts = new Uint32Array(cols * rows);
  for (let i = 0; i < counts.length; i++) counts[i] = Math.min(...crosses.map((c) => (c.blocks.cols === cols ? c.blocks.counts[i] ?? 0 : 0)));
  const sometimes = new Uint32Array(cols * rows); // what differed in at least one pairing: reported, never dropped
  for (let i = 0; i < sometimes.length; i++) sometimes[i] = Math.max(...crosses.map((c) => (c.blocks.cols === cols ? c.blocks.counts[i] ?? 0 : 0)));
  // Noise map: every block where any two unfixed pictures differ, widened by NOISE_MARGIN_BLOCKS. A page that changes height
  // or width between its own loads cannot be compared block by block: all of it is noise then.
  const unstable = pairs.some((p) => p.widthMismatch || p.heights[0] !== p.heights[1]);
  const noisy = new Uint8Array(cols * rows);
  if (unstable) noisy.fill(1);
  else {
    for (const p of pairs) {
      const c = p.blocks.counts;
      for (let i = 0; i < c.length && i < noisy.length; i++) {
        if (!c[i]) continue;
        const bx = i % p.blocks.cols;
        const by = Math.floor(i / p.blocks.cols);
        for (let y = by - NOISE_MARGIN_BLOCKS; y <= by + NOISE_MARGIN_BLOCKS; y++) {
          for (let x = bx - NOISE_MARGIN_BLOCKS; x <= bx + NOISE_MARGIN_BLOCKS; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) noisy[y * cols + x] = 1;
        }
      }
    }
  }
  let changedPx = 0;
  let inNoisePx = 0;
  for (let i = 0; i < sometimes.length; i++) {
    if (!sometimes[i]) continue;
    if (!noisy[i] && counts[i]) changedPx += counts[i];
    else inNoisePx += sometimes[i];
  }
  const noiseBlocks = noisy.reduce((n, v) => n + v, 0);
  const pct = (px) => (change.compared ? Math.round((px / change.compared) * 1e6) / 1e4 : 0);
  return {
    changedPx, // pixels that differ where the page does not move by itself: > 0 means a visible change
    inNoisePx, // pixels that differ where it does: cannot be judged, reported
    changedPct: pct(changedPx), // the same two as a share of the compared pixels, to 4 decimals of a percent
    inNoisePct: pct(inNoisePx),
    noiseShare: Math.round((noiseBlocks / (cols * rows || 1)) * 1e4) / 1e2, // % of the page that moves by itself
    noisePct: Math.max(0, ...pairs.map((p) => p.commonPct)),
    diffPct: change.commonPct, // the whole difference of the first pairing, for the report line
    heights: change.heights, // [side B, side A]
    widthMismatch: crosses.some((c) => c.widthMismatch),
    sizeChanged: crosses.some((c) => c.widthMismatch || c.heights[0] !== c.heights[1]),
  };
}

/** Clicks each control in turn on a fresh load; records whether the page's text changed and whether the control is fixed. */
export async function clickProfile(browser, base, url, isCopy) {
  const outside = [];
  const context = isCopy ? await isolated(browser, { viewport: { width: 1440, height: 900 } }, base, outside) : await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    const page = await context.newPage();
    const selector = 'button, summary, [aria-expanded], [role="tab"]';
    await openAndScroll(page, url);
    const count = Math.min(await page.locator(selector).count(), 24);
    for (let i = 0; i < count; i++) {
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      await page.waitForTimeout(800);
      const el = page.locator(selector).nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) { results.push({ i, visible: false }); continue; }
      const label = (await el.innerText().catch(() => '')).trim().slice(0, 40) || (await el.getAttribute('aria-label').catch(() => '')) || '';
      const fixed = await el.evaluate((e) => {
        for (let p = e; p; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true;
        return false;
      }).catch(() => false);
      const before = await page.evaluate(() => document.body.innerText);
      await el.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => document.body.innerText);
      results.push({ i, visible: true, label, fixed, changed: before !== after });
    }
  } finally {
    await context.close();
  }
  return results;
}

export async function hoverProfile(browser, base, url, isCopy) {
  const outside = [];
  const context = isCopy ? await isolated(browser, { viewport: { width: 1440, height: 900 } }, base, outside) : await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    const page = await context.newPage();
    await openAndScroll(page, url);
    const selector = 'a, button';
    const count = Math.min(await page.locator(selector).count(), 20);
    for (let i = 0; i < count; i++) {
      const el = page.locator(selector).nth(i);
      if (!(await el.isVisible().catch(() => false))) { results.push({ i, visible: false }); continue; }
      const style = () => page.evaluate((s) => {
        const e = document.querySelectorAll(s.q)[s.i];
        if (!e) return null;
        const c = getComputedStyle(e);
        return [c.color, c.backgroundColor, c.textDecorationLine, c.opacity, c.transform].join('|');
      }, { q: selector, i });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(350);
      const rest = await style();
      await el.hover({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(700);
      const hovered = await style();
      await page.mouse.move(0, 0);
      results.push({ i, visible: true, changed: rest !== hovered });
    }
  } finally {
    await context.close();
  }
  return results;
}

/**
 * Submits every form of a page with a test value. Nothing may leave the copy: any request off its server is refused and
 * counted here. The note the form shows afterwards is recorded.
 */
export async function formCheck(browser, base, url) {
  const outside = [];
  const context = await isolated(browser, { viewport: { width: 1440, height: 900 } }, base, outside);
  const forms = [];
  let count = 0;
  try {
    const page = await context.newPage();
    await openAndScroll(page, url);
    count = await page.locator('form').count();
    for (let i = 0; i < count; i++) {
      const form = page.locator('form').nth(i);
      const fields = form.locator('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea');
      const n = await fields.count();
      for (let j = 0; j < n; j++) {
        const field = fields.nth(j);
        if (!(await field.isVisible().catch(() => false))) continue;
        const type = (await field.getAttribute('type')) ?? '';
        await field.fill(type === 'email' ? 'check@example.test' : 'Test value').catch(() => {});
      }
      const before = outside.length;
      await form.locator('button[type=submit], input[type=submit], button:not([type])').first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const note = await form.locator('[data-sas-form-note]').textContent().catch(() => null);
      forms.push({ i, fields: n, attempts: outside.length - before, note: note?.trim() ?? null });
    }
  } finally {
    await context.close();
  }
  return { count, forms, outsideAttempts: outside.length };
}

const summarize = (rs) => ({ visible: rs.filter((r) => r.visible).length, changed: rs.filter((r) => r.changed).length });

/** The controls the original shows that the copy does not, split into missing and excluded by rule. */
export function controlGaps(copy, original, excludedHosts) {
  const copyLabels = new Set(copy.filter((r) => r.visible).map((r) => r.label));
  const missing = original.filter((o) => o.visible && !copyLabels.has(o.label));
  const excluded = missing.filter((o) => o.fixed && excludedHosts.length > 0);
  return {
    missing: missing.filter((o) => !excluded.includes(o)).map((o) => ({ label: o.label, fixed: o.fixed })),
    excludedByRule: excluded.map((o) => ({ label: o.label || '(icon)', why: 'a fixed-position widget; its third-party script is excluded by rule', hosts: excludedHosts })),
  };
}

/**
 * Checks each page of a copy against its original.
 * @param {object} o
 * @param {import('playwright').Browser} o.browser
 * @param {string} o.base  the copy's address (its server, no trailing slash)
 * @param {{ path: string, url: string }[]} o.pages  the copy's page paths and the original's addresses of the same pages
 * @param {string[]} o.excludedHosts  third-party hosts the lift excluded by rule
 * @param {(msg: string) => void} [o.log]
 */
/**
 * Whether the original answers at all, asked once per job (the checks never ask it again, and nothing retries it: the site may
 * rate-limit a burst of requests). A repack does not depend on this: without it the checks use the saved capture.
 */
export async function probeOriginal(url, { timeoutMs = 15000 } = {}) {
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) }).then(() => true, () => false);
}

/**
 * The copy's screenshot at 1440 against the saved capture's full-page screenshot of the original (the baseline from the first
 * capture). Used when the original is not reachable: the copy is then compared with what the original was when it was captured.
 */
/**
 * The copy against saved pictures of the original, with the same arithmetic as the live check (gateVerdict): the copy is
 * pictured NOISE_SHOTS times, so its own noise is mapped; the saved side has as many pictures as were kept (the capture's one,
 * or the original's own three from an earlier live check).
 * @param {Buffer|string|(Buffer|string)[]} baselinePng  the picture(s) (bytes or files)
 * @param {{ width?: number, kind?: 'capture'|'original' }} [o]
 *   kind 'original': the original's own pictures from an earlier visual check (same window, frozen the same way: as good as the
 *   live original at the time they were taken); 'capture': the capture's full-page picture (desktop only, up to MAX_HEIGHT, taken
 *   without the scroll-through, so effects that wait for a scroll may be missing from it — the less reliable of the two)
 */
export async function baselineVisual(browser, base, copyUrl, baselinePng, { width = 1440, kind = 'capture' } = {}) {
  // The copy is pictured the way the live check pictures it (frozen, warmed up, in rounds), so the two sources measure the same thing.
  const [shots] = await pictureRounds(browser, viewOf(width), [{ base, url: copyUrl }]);
  // Read into memory: sharp keeps a file open while it is given a path, which blocks the folder's removal on Windows.
  const saved = [];
  for (const b of [baselinePng].flat()) saved.push(Buffer.isBuffer(b) ? b : await readFile(b));
  const b = await sharp(saved[0]).metadata();
  const own = await sharp(shots[0]).metadata();
  // The saved picture may be a different size: the copy is brought to its width before the pixels are compared.
  const sameShots = own.width === b.width ? shots : await Promise.all(shots.map((s) => sharp(s).resize({ width: b.width }).png().toBuffer()));
  const same = own.width === b.width ? own : await sharp(sameShots[0]).metadata();
  // The capture's full-page picture stops at MAX_HEIGHT: a picture that tall is the top of a page that may be taller, so the
  // original's height is unknown and only the rows the picture has are compared (a copy 8289 px tall against an 8000 px
  // picture is not 3.6 % taller than its original).
  const capped = kind === 'capture' && b.height >= MAX_HEIGHT && same.height > b.height;
  const v = await gateVerdict(sameShots, saved);
  return {
    width,
    copyHeight: same.height,
    originalHeight: capped ? null : b.height,
    ...(capped && { comparedHeight: b.height, capped: true }),
    shots: NOISE_SHOTS,
    savedShots: saved.length,
    diffPct: v.changedPct,
    rawDiffPct: v.diffPct,
    inNoisePct: v.inNoisePct,
    noiseShare: v.noiseShare,
    changedPx: v.changedPx,
    inNoisePx: v.inNoisePx,
    source: kind === 'original' ? 'saved original picture' : 'saved capture',
  };
}

/** Runs `task` for every item, at most `size` at once, each started in the items' order. */
export async function inPool(items, size, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/** A page's saved pictures: { capture?, 1440?, 390? } (a width's entry may hold several); a bare picture (bytes or a file) is the capture's. */
const savedPictures = (b) => (!b ? {} : Buffer.isBuffer(b) || typeof b === 'string' ? { capture: b } : b);

/**
 * @param {object} o
 * @param {Record<string, Buffer|string|{ capture?: Buffer|string, 1440?: Buffer|string|(Buffer|string)[], 390?: Buffer|string|(Buffer|string)[] }>} [o.baselines]
 *   per page path: the capture's picture and / or the original's own pictures from an earlier check, per width
 * @param {(pagePath: string, width: number, pngs: Buffer[]) => Promise<void>|void} [o.onOriginalPicture]  receives the original's
 *   pictures (NOISE_SHOTS of them) of every live comparison, to be kept as that page's baseline
 * @param {number} [o.pagesAtOnce]  pages checked side by side (each pictures its two widths at once); the report keeps page order
 */
export async function checkCopy({ browser, base, pages, excludedHosts = [], log = () => {}, originalReachable = true, baselines = {}, htmlBase = null, onOriginalPicture = null, pagesAtOnce = 1 }) {
  const report = { pages: [], forms: 0, needsAPerson: [], originalReachable };
  const done = new Map();
  const checkPage = async (p) => {
    const copyUrl = `${base}${p.path}`;
    const one = { path: p.path, original: p.url };
    one.offline = await offlineCheck(browser, base, p.path).then((r) => ({ ...r, path: p.path }));
    log(`offline ${p.path} ${JSON.stringify(one.offline).slice(0, 200)}`);
    // The original is asked only while it answers. A check of it that fails (the probe passed, the page then did not load) is
    // recorded as "not compared" with its reason; the copy's own checks still run. A repack never fails on the original.
    let reason = originalReachable ? null : 'the original did not answer';
    const asOriginal = async (label, fn) => {
      if (reason) return null;
      try {
        return await fn();
      } catch (err) {
        reason = `${label} did not load: ${String(err?.message ?? err).split('\n')[0].slice(0, 160)}`;
        log(`original ${p.path}: ${reason}`);
        return null;
      }
    };
    const saved = savedPictures(baselines[p.path]);
    // Both widths at once (a page and its phone layout are independent); the results stay in width order.
    const byWidth = await Promise.all([1440, 390].map(async (width) => {
      const visual = [];
      const v = await asOriginal(`${p.url} at ${width}`, () => visualCheck(browser, base, copyUrl, p.url, width, { keepOriginal: Boolean(onOriginalPicture) }));
      if (v) {
        const { originalShots, ...measured } = v;
        if (originalShots) await onOriginalPicture(p.path, width, originalShots);
        visual.push(measured);
        log(`visual ${p.path} ${JSON.stringify(measured)}`);
      } else if (saved[width]) {
        // The original is not compared: the copy is compared with the original's own picture from an earlier check at this width.
        visual.push(await baselineVisual(browser, base, copyUrl, saved[width], { width, kind: 'original' }));
        log(`visual ${p.path} ${JSON.stringify(visual.at(-1))}`);
      } else if (width === 1440 && saved.capture) {
        // Else, on the desktop, with the capture's own picture of the page (less reliable: see baselineVisual).
        visual.push(await baselineVisual(browser, base, copyUrl, saved.capture, { width, kind: 'capture' }));
        log(`visual ${p.path} ${JSON.stringify(visual.at(-1))}`);
      } else if (htmlBase) {
        // The original is not compared and there is no saved picture: the copy is compared with its own Plain HTML base
        // (the same copy rendered as plain files), so the check does not skip the page.
        const v2 = await visualCheck(browser, base, copyUrl, `${htmlBase}${p.path}`, width);
        visual.push({ ...v2, source: 'plain-html base' });
        log(`visual ${p.path} ${JSON.stringify(visual.at(-1))}`);
      } else {
        visual.push({ width, diffPct: null, note: `original not reachable: ${reason}${width === 1440 ? ' and no saved capture' : ''}` });
      }
      return visual;
    }));
    one.visual = byWidth.flat();
    // The controls and hovers of both sides at once: each profile has its own context, so none sees another's clicks.
    const [copyClicks, origClicks, copyHover, origHover] = await Promise.all([
      clickProfile(browser, base, copyUrl, true),
      asOriginal('controls', () => clickProfile(browser, base, p.url, false)),
      hoverProfile(browser, base, copyUrl, true),
      asOriginal('hovers', () => hoverProfile(browser, base, p.url, false)),
    ]);
    if (origClicks) {
      const mismatch = [];
      for (let i = 0; i < Math.max(copyClicks.length, origClicks.length); i++) {
        const a = copyClicks[i];
        const b = origClicks[i];
        if (a?.visible && b?.visible && Boolean(a.changed) !== Boolean(b.changed)) mismatch.push({ i, copy: a.changed, original: b.changed, label: b.label });
      }
      one.controls = { copy: summarize(copyClicks), original: summarize(origClicks), mismatch, ...controlGaps(copyClicks, origClicks, excludedHosts) };
    } else {
      one.controls = { copy: summarize(copyClicks), original: null, mismatch: [], note: `original not reachable: ${reason}` };
    }
    if (origHover) {
      const hm = [];
      for (let i = 0; i < Math.max(copyHover.length, origHover.length); i++) {
        const a = copyHover[i];
        const b = origHover[i];
        if (a?.visible && b?.visible && Boolean(a.changed) !== Boolean(b.changed)) hm.push({ i, copy: a.changed, original: b.changed });
      }
      one.hovers = { copy: summarize(copyHover), original: summarize(origHover), mismatch: hm };
    } else {
      one.hovers = { copy: summarize(copyHover), original: null, mismatch: [], note: `original not reachable: ${reason}` };
    }
    one.forms = await formCheck(browser, base, copyUrl);
    done.set(p, one);
    log(`page ${p.path} done${reason ? ` (original: ${reason})` : ''}`);
  };
  await inPool(pages, pagesAtOnce, checkPage);
  for (const p of pages) {
    const one = done.get(p);
    report.forms += one.forms.count;
    report.pages.push(one);
  }
  return report;
}

/** The copy's HTML forms, counted from its documents (the number a person must connect). */
export async function formsInCopy(copyDir, entries) {
  let count = 0;
  for (const entry of entries) {
    const html = await readFile(path.join(copyDir, entry), 'utf8').catch(() => '');
    count += (html.match(/<form[\s>]/gi) ?? []).length;
  }
  return count;
}
