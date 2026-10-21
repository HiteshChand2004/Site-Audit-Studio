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
import { stat, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { pixelDiffPct } from './render.js';
import { scriptCandidates } from './extract.js';
import { readRecordIndex, classifyScripts, recordBodyReader } from '../scripts.js';
import { freezePage, freezeTimers, holdSizeReactions } from '../../verify/exact/freeze.js';
import { MAX_HEIGHT } from '../../../audit/screenshots.js';

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

/** Opens the page and scrolls it the way a visitor does (the lazy parts load). */
export async function openAndScroll(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(1500);
  for (let y = 0; y < 14000; y += 400) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
}

/**
 * Brings a page (its context already has `freezeTimers`) to the state the visual check pictures: opened and scrolled, then a
 * warm-up — a cold first load still brings fonts and images in while the picture is taken (one run in five was 14 % off) —
 * so it is loaded once more with its files cached, its fonts settled, and its animations frozen.
 */
export async function settleFrozen(page, url) {
  await openAndScroll(page, url);
  await page.reload({ waitUntil: 'load' });
  await openAndScroll(page, url);
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
  await freezePage(page);
  await page.waitForTimeout(400);
}

export { holdSizeReactions };

/** The full-page picture with the page's size reactions held (see holdSizeReactions; the context must have it). */
async function fullShot(page) {
  await page.evaluate(() => { window.__sasHoldSize = true; });
  return page.screenshot({ fullPage: true, type: 'png' });
}

async function rgbOf(buf) {
  const img = sharp(buf);
  const { width, height } = await img.metadata();
  const raw = await img.removeAlpha().raw().toBuffer();
  return { raw, width, height };
}

/** A context whose requests off the copy's own server are refused and recorded; the copy's own requests continue. */
async function isolated(browser, viewport, base, outside) {
  const context = await browser.newContext(viewport);
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
const viewOf = (width) => {
  const mobile = width < 600;
  return { viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile };
};

/**
 * @param {{ keepOriginal?: boolean }} [o]  keepOriginal: the original's picture (PNG) is returned as `originalShot`, so it can be kept
 *   as the page's baseline for a later check made when the original does not answer
 */
export async function visualCheck(browser, base, copyUrl, originalUrl, width, { keepOriginal = false } = {}) {
  const opts = viewOf(width);
  const outside = [];
  const copy = await isolated(browser, opts, base, outside);
  const original = await browser.newContext(opts);
  try {
    // Both sides are frozen the same way before either picture is taken: timers (carousels, tickers, rotators) stop on their
    // first state and CSS animations are settled. Then both are shot at the same moment, so the difference is the page's.
    for (const c of [copy, original]) {
      await c.addInitScript(freezeTimers);
      await c.addInitScript(holdSizeReactions);
    }
    const cp = await copy.newPage();
    const op = await original.newPage();
    await Promise.all([settleFrozen(cp, copyUrl), settleFrozen(op, originalUrl)]);
    const [shotA, shotB] = await Promise.all([fullShot(cp), fullShot(op)]);
    const a = await rgbOf(shotA);
    const b = await rgbOf(shotB);
    return {
      width, copyHeight: a.height, originalHeight: b.height, diffPct: a.width === b.width ? pixelDiffPct(a.raw, b.raw) : null,
      ...(keepOriginal && { originalShot: shotB }),
    };
  } finally {
    await copy.close();
    await original.close();
  }
}

/** The least difference (percent of pixels) a fixed page may show against its unfixed self: a changed word is more than this. */
export const FIX_GATE_FLOOR_PCT = 0.01;

/**
 * Are a page's fixes invisible? The fixed copy and the same copy before its fixes, both local, are opened and pictured the same
 * way (frozen, warmed up, size reactions held) at 1440, with the console errors of each; the unfixed page is pictured twice, so
 * the page's own noise (a random particle, a clock) is measured rather than assumed. Fixes whose picture differs from the
 * unfixed one by more than max(FIX_GATE_FLOOR_PCT, 2 × that noise), change the height, or bring a console error the unfixed
 * page does not have are not invisible (docs/COPY-MY-SITE.md §5: reverted, reason d). A whole fixed share would let a new
 * word through (one title written into a page is ~0.1 % of it).
 */
export async function fixGate(browser, fixedBase, unfixedBase, pagePath) {
  const opts = viewOf(1440);
  const sides = [];
  try {
    for (const base of [fixedBase, unfixedBase, unfixedBase]) {
      const context = await isolated(browser, opts, base, []);
      await context.addInitScript(freezeTimers);
      await context.addInitScript(holdSizeReactions);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
      sides.push({ context, page, errors, url: `${base}${pagePath}` });
    }
    await Promise.all(sides.map((s) => settleFrozen(s.page, s.url)));
    const [a, b, c] = await Promise.all(sides.map(async (s) => rgbOf(await fullShot(s.page))));
    const diffPct = a.width === b.width ? pixelDiffPct(a.raw, b.raw) : 100;
    const noisePct = b.width === c.width && b.height === c.height ? pixelDiffPct(b.raw, c.raw) : 100;
    const allowedPct = Math.max(FIX_GATE_FLOOR_PCT, 2 * noisePct);
    const [fixed, unfixed, unfixedAgain] = sides.map((s) => s.errors);
    const newErrors = fixed.filter((e) => !unfixed.includes(e) && !unfixedAgain.includes(e));
    return {
      path: pagePath, diffPct, noisePct, allowedPct, heights: [a.height, b.height], newErrors,
      invisible: diffPct <= allowedPct && a.height === b.height && newErrors.length === 0,
    };
  } finally {
    for (const s of sides) await s.context.close();
  }
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
 * The copy against a saved picture of the original.
 * @param {Buffer|string} baselinePng  the picture (bytes or a file)
 * @param {{ width?: number, kind?: 'capture'|'original' }} [o]
 *   kind 'original': the original's own picture from an earlier visual check (same window, frozen the same way: as good as the
 *   live original at the time it was taken); 'capture': the capture's full-page picture (desktop only, up to MAX_HEIGHT, taken
 *   without the scroll-through, so effects that wait for a scroll may be missing from it — the less reliable of the two)
 */
export async function baselineVisual(browser, base, copyUrl, baselinePng, { width = 1440, kind = 'capture' } = {}) {
  const outside = [];
  const copy = await isolated(browser, viewOf(width), base, outside);
  try {
    // The copy is pictured the way the live check pictures it (frozen, warmed up), so the two sources measure the same thing.
    await copy.addInitScript(freezeTimers);
    await copy.addInitScript(holdSizeReactions);
    const cp = await copy.newPage();
    await settleFrozen(cp, copyUrl);
    const shot = await fullShot(cp);
    const a = await rgbOf(shot);
    // Read into memory: sharp keeps a file open while it is given a path, which blocks the folder's removal on Windows.
    const img = sharp(Buffer.isBuffer(baselinePng) ? baselinePng : await readFile(baselinePng));
    const meta = await img.metadata();
    const b = { raw: await img.removeAlpha().raw().toBuffer(), width: meta.width, height: meta.height };
    // The saved picture may be a different size: the copy is brought to its width before the pixels are compared.
    const same = a.width === b.width ? a : await rgbOf(await sharp(shot).resize({ width: b.width }).png().toBuffer());
    // The capture's full-page picture stops at MAX_HEIGHT: a picture that tall is the top of a page that may be taller, so the
    // original's height is unknown and only the rows the picture has are compared (a copy 8289 px tall against an 8000 px
    // picture is not 3.6 % taller than its original).
    const capped = kind === 'capture' && b.height >= MAX_HEIGHT && same.height > b.height;
    return {
      width,
      copyHeight: same.height,
      originalHeight: capped ? null : b.height,
      ...(capped && { comparedHeight: b.height, capped: true }),
      diffPct: pixelDiffPct(same.raw, b.raw),
      source: kind === 'original' ? 'saved original picture' : 'saved capture',
    };
  } finally {
    await copy.close();
  }
}

/** A page's saved pictures: { capture?, 1440?, 390? }; a bare picture (bytes or a file) is the capture's, as before. */
const savedPictures = (b) => (!b ? {} : Buffer.isBuffer(b) || typeof b === 'string' ? { capture: b } : b);

/**
 * @param {object} o
 * @param {Record<string, Buffer|string|{ capture?: Buffer|string, 1440?: Buffer|string, 390?: Buffer|string }>} [o.baselines]
 *   per page path: the capture's picture and / or the original's own pictures from an earlier check, per width
 * @param {(pagePath: string, width: number, png: Buffer) => Promise<void>|void} [o.onOriginalPicture]  receives the original's
 *   picture of every live comparison, to be kept as that page's baseline
 */
export async function checkCopy({ browser, base, pages, excludedHosts = [], log = () => {}, originalReachable = true, baselines = {}, htmlBase = null, onOriginalPicture = null }) {
  const report = { pages: [], forms: 0, needsAPerson: [], originalReachable };
  for (const p of pages) {
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
    one.visual = [];
    const saved = savedPictures(baselines[p.path]);
    for (const width of [1440, 390]) {
      const v = await asOriginal(`${p.url} at ${width}`, () => visualCheck(browser, base, copyUrl, p.url, width, { keepOriginal: Boolean(onOriginalPicture) }));
      if (v) {
        const { originalShot, ...measured } = v;
        if (originalShot) await onOriginalPicture(p.path, width, originalShot);
        one.visual.push(measured);
        log(`visual ${p.path} ${JSON.stringify(measured)}`);
      } else if (saved[width]) {
        // The original is not compared: the copy is compared with the original's own picture from an earlier check at this width.
        one.visual.push(await baselineVisual(browser, base, copyUrl, saved[width], { width, kind: 'original' }));
        log(`visual ${p.path} ${JSON.stringify(one.visual.at(-1))}`);
      } else if (width === 1440 && saved.capture) {
        // Else, on the desktop, with the capture's own picture of the page (less reliable: see baselineVisual).
        one.visual.push(await baselineVisual(browser, base, copyUrl, saved.capture, { width, kind: 'capture' }));
        log(`visual ${p.path} ${JSON.stringify(one.visual.at(-1))}`);
      } else if (htmlBase) {
        // The original is not compared and there is no saved picture: the copy is compared with its own Plain HTML base
        // (the same copy rendered as plain files), so the check does not skip the page.
        const v2 = await visualCheck(browser, base, copyUrl, `${htmlBase}${p.path}`, width);
        one.visual.push({ ...v2, source: 'plain-html base' });
        log(`visual ${p.path} ${JSON.stringify(one.visual.at(-1))}`);
      } else {
        one.visual.push({ width, diffPct: null, note: `original not reachable: ${reason}${width === 1440 ? ' and no saved capture' : ''}` });
      }
    }
    const copyClicks = await clickProfile(browser, base, copyUrl, true);
    const origClicks = await asOriginal('controls', () => clickProfile(browser, base, p.url, false));
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
    const copyHover = await hoverProfile(browser, base, copyUrl, true);
    const origHover = await asOriginal('hovers', () => hoverProfile(browser, base, p.url, false));
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
    report.forms += one.forms.count;
    report.pages.push(one);
    log(`page ${p.path} done${reason ? ` (original: ${reason})` : ''}`);
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
