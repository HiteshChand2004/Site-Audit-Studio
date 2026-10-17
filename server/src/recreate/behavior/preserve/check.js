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

export async function visualCheck(browser, base, copyUrl, originalUrl, width) {
  const mobile = width < 600;
  const opts = { viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile };
  const outside = [];
  const copy = await isolated(browser, opts, base, outside);
  const original = await browser.newContext(opts);
  try {
    const cp = await copy.newPage();
    await openAndScroll(cp, copyUrl);
    const op = await original.newPage();
    await openAndScroll(op, originalUrl);
    const a = await rgbOf(await cp.screenshot({ fullPage: true, type: 'png' }));
    const b = await rgbOf(await op.screenshot({ fullPage: true, type: 'png' }));
    return { width, copyHeight: a.height, originalHeight: b.height, diffPct: a.width === b.width ? pixelDiffPct(a.raw, b.raw) : null };
  } finally {
    await copy.close();
    await original.close();
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
export async function checkCopy({ browser, base, pages, excludedHosts = [], log = () => {} }) {
  const report = { pages: [], forms: 0, needsAPerson: [] };
  for (const p of pages) {
    const copyUrl = `${base}${p.path}`;
    const one = { path: p.path, original: p.url };
    one.offline = await offlineCheck(browser, base, p.path).then((r) => ({ ...r, path: p.path }));
    log(`offline ${p.path} ${JSON.stringify(one.offline).slice(0, 200)}`);
    one.visual = [];
    for (const width of [1440, 390]) {
      one.visual.push(await visualCheck(browser, base, copyUrl, p.url, width));
      log(`visual ${p.path} ${JSON.stringify(one.visual.at(-1))}`);
    }
    const copyClicks = await clickProfile(browser, base, copyUrl, true);
    const origClicks = await clickProfile(browser, base, p.url, false);
    const mismatch = [];
    for (let i = 0; i < Math.max(copyClicks.length, origClicks.length); i++) {
      const a = copyClicks[i];
      const b = origClicks[i];
      if (a?.visible && b?.visible && Boolean(a.changed) !== Boolean(b.changed)) mismatch.push({ i, copy: a.changed, original: b.changed, label: b.label });
    }
    one.controls = { copy: summarize(copyClicks), original: summarize(origClicks), mismatch, ...controlGaps(copyClicks, origClicks, excludedHosts) };
    const copyHover = await hoverProfile(browser, base, copyUrl, true);
    const origHover = await hoverProfile(browser, base, p.url, false);
    const hm = [];
    for (let i = 0; i < Math.max(copyHover.length, origHover.length); i++) {
      const a = copyHover[i];
      const b = origHover[i];
      if (a?.visible && b?.visible && Boolean(a.changed) !== Boolean(b.changed)) hm.push({ i, copy: a.changed, original: b.changed });
    }
    one.hovers = { copy: summarize(copyHover), original: summarize(origHover), mismatch: hm };
    one.forms = await formCheck(browser, base, copyUrl);
    report.forms += one.forms.count;
    report.pages.push(one);
    log(`page ${p.path} done`);
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
