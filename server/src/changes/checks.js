// @ts-check
// The checks of a change: the same page read before (the base folder) and after (the change's folder), and the changed page
// opened in a real browser with its own scripts running, on a server of its own on this computer (every other address is
// refused), with a picture on a computer and a phone. The score is the share of page checks that pass.
import * as cheerio from 'cheerio';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startSiteServer } from '../recreate/verify/server.js';
import { runtimesOf, withoutRuntime } from '../recreate/convert/runtime.js';
import { pageFile, readText, writeFresh } from './site.js';

const LINKS_MAX = 200;

/** @typedef {{ id: string, label: string, pass: boolean | null, detail?: string }} PageCheck */

/**
 * The page checks of one page file (no browser).
 * @param {string} root @param {string} rel
 * @returns {Promise<PageCheck[]>}
 */
export async function pageChecks(root, rel) {
  const html = await readText(root, rel);
  const $ = cheerio.load(html);
  const title = $('head title').first().text().replace(/\s+/g, ' ').trim();
  const desc = ($('head meta[name="description"]').attr('content') ?? '').trim();
  const h1 = $('h1').length;
  const imgs = $('img');
  const noAlt = imgs.filter((_, el) => $(el).attr('alt') === undefined).length;
  // links to the site's own pages and files
  const hrefs = new Set();
  $('a[href]').each((_, el) => {
    const h = ($(el).attr('href') ?? '').trim();
    if (!h || h.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(h) || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return;
    hrefs.add(h.replace(/[?#].*$/, ''));
  });
  const here = `/${rel}`.replace(/[^/]*$/, '');
  let broken = [];
  for (const h of [...hrefs].slice(0, LINKS_MAX)) {
    if (!h) continue;
    const target = h.startsWith('/') ? h : path.posix.normalize(`${here}${h}`);
    const found = (await pageFile(root, target)) ?? ((await stat(path.join(root, target.replace(/^\/+/, ''))).catch(() => null))?.isFile() ? target : null);
    if (!found) broken.push(h);
  }
  broken = broken.slice(0, 10);
  return [
    { id: 'title', label: 'Title is 10–60 characters', pass: title.length >= 10 && title.length <= 60, detail: `${title.length} characters` },
    { id: 'description', label: 'Description is 50–160 characters', pass: desc.length >= 50 && desc.length <= 160, detail: desc ? `${desc.length} characters` : 'none' },
    { id: 'h1', label: 'One first heading', pass: h1 === 1, detail: `${h1} found` },
    { id: 'lang', label: 'Page language is set', pass: Boolean(($('html').attr('lang') ?? '').trim()) },
    { id: 'alt', label: 'Every picture has a description', pass: noAlt === 0, detail: noAlt ? `${noAlt} of ${imgs.length} without` : `${imgs.length} pictures` },
    { id: 'canonical', label: 'Canonical address is set', pass: $('head link[rel="canonical"]').length > 0 },
    { id: 'viewport', label: 'Phone layout (viewport) is set', pass: $('head meta[name="viewport"]').length > 0 },
    { id: 'links', label: 'Links to the site\'s own pages exist', pass: broken.length === 0, detail: broken.length ? `missing: ${broken.join(', ')}` : `${hrefs.size} checked` },
  ];
}

/** 0–100: the share of checks that pass (null checks left out). @param {PageCheck[] | null} checks */
export const scoreOf = (checks) => {
  const counted = (checks ?? []).filter((c) => c.pass !== null);
  return counted.length ? Math.round((counted.filter((c) => c.pass).length / counted.length) * 100) : null;
};

const norm = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Opens the page with its own scripts, looks for the texts the change wrote, and takes two pictures.
 * @param {string} root @param {string} pagePath @param {string[]} expect @param {string} shotsDir
 * @returns {Promise<{ found: string[], missing: string[], errors: string[], shots: { desktop?: string, phone?: string } }>}
 */
export async function renderCheck(root, pagePath, expect, shotsDir, { launch = () => chromium.launch() } = {}) {
  const server = await startSiteServer(root);
  const browser = await launch();
  /** @type {string[]} */
  const errors = [];
  /** @type {{ desktop?: string, phone?: string }} */
  const shots = {};
  let found = [];
  let missing = [];
  try {
    await mkdir(shotsDir, { recursive: true });
    for (const [name, viewport, mobile] of /** @type {const} */ ([['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]])) {
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
      // Only this site, on this computer: nothing reaches the internet while checking.
      await context.route('**/*', (route) => (route.request().url().startsWith(server.origin) ? route.continue() : route.abort()));
      const page = await context.newPage();
      page.on('pageerror', (e) => { if (errors.length < 10) errors.push(String(e.message).slice(0, 200)); });
      await page.goto(`${server.origin}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2500);
      // Scrolled through like a visitor first: parts a site fades in as they come into view are shown, then back to the top.
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
      for (let y = 0; y < Math.min(pageHeight, 12000); y += Math.round(viewport.height * 0.6)) {
        await page.mouse.wheel(0, Math.round(viewport.height * 0.6));
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(700);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(400);
      if (name === 'desktop') {
        const text = norm(await page.evaluate(() => document.body?.innerText ?? ''));
        found = expect.filter((t) => text.includes(norm(t)));
        missing = expect.filter((t) => !text.includes(norm(t)));
      }
      const png = await page.screenshot({ fullPage: true, clip: undefined, timeout: 30000 }).catch(() => page.screenshot({ timeout: 30000 }));
      const file = path.join(shotsDir, `${name}.webp`);
      const img = sharp(png);
      const meta = await img.metadata();
      const height = Math.min(meta.height ?? 0, 4000);
      await img.extract({ left: 0, top: 0, width: meta.width ?? viewport.width, height: height || viewport.height }).webp({ quality: 70 }).toFile(file);
      shots[name] = `${name}.webp`;
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
  return { found, missing, errors, shots };
}

/** What the design check reads on one page, after scrolling through it like a visitor. */
async function readDesign(page) {
  return page.evaluate(() => {
    const root = document.querySelector('main') ?? document.body;
    const sigOf = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].sort().join('.')}`;
    const parts = [...root.children].filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'].includes(el.tagName) && el.getBoundingClientRect().height > 0).map(sigOf);
    const typeOf = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      return { font: c.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase(), size: Math.round(parseFloat(c.fontSize)), color: c.color, weight: c.fontWeight };
    };
    const pictures = [...document.images].filter((img) => img.getBoundingClientRect().width > 8).map((img) => ({
      src: img.currentSrc || img.src, loaded: img.complete && img.naturalWidth > 0, natural: img.naturalWidth, shown: Math.round(img.getBoundingClientRect().width),
    }));
    return { parts, type: { h1: typeOf('h1'), h2: typeOf('main h2, h2'), p: typeOf('main p, p') }, pictures, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
}

/**
 * The design check (like Growth OS's): the changed page beside a page of the site it was made like (`neighbour`), on a
 * computer and a phone. Same kinds of parts, the same type for headings and text, pictures that load and are not blown up,
 * nothing wider than a phone. Rows for the change's checks (no "before": the page is compared with its neighbour).
 * @param {string} root @param {string} pagePath @param {string} neighbour
 * @returns {Promise<PageCheck[]>}
 */
export async function designCheck(root, pagePath, neighbour, { launch = () => chromium.launch() } = {}) {
  const server = await startSiteServer(root);
  const browser = await launch();
  const read = async (/** @type {string} */ p, viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(server.origin) ? route.continue() : route.abort()));
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}${p}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
      for (let y = 0; y < Math.min(h, 12000); y += Math.round(viewport.height * 0.6)) {
        await page.mouse.wheel(0, Math.round(viewport.height * 0.6));
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(700);
      return await readDesign(page);
    } finally {
      await context.close();
    }
  };
  try {
    const desk = { width: 1440, height: 900 };
    const phone = { width: 390, height: 844 };
    const mine = await read(pagePath, desk, false);
    const theirs = await read(neighbour, desk, false);
    const minePhone = await read(pagePath, phone, true);
    const known = new Set(theirs.parts);
    const foreign = mine.parts.filter((x) => !known.has(x));
    const sameType = ['h1', 'h2', 'p'].filter((k) => mine.type[k] && theirs.type[k]).map((k) => {
      const a = mine.type[k];
      const b = theirs.type[k];
      return { k, ok: a.font === b.font && Math.abs(a.size - b.size) <= 1 && a.color === b.color, a, b };
    });
    const badType = sameType.filter((x) => !x.ok);
    const broken = mine.pictures.filter((x) => !x.loaded);
    const blown = mine.pictures.filter((x) => x.loaded && x.natural < x.shown * 0.9);
    return [
      { id: 'design-parts', label: `Made of the same kinds of parts as ${neighbour}`, pass: foreign.length === 0, detail: foreign.length ? `parts ${neighbour} does not have: ${foreign.slice(0, 4).join(', ')}` : `${mine.parts.length} parts` },
      { id: 'design-type', label: "Headings and text look like the site's", pass: sameType.length ? badType.length === 0 : null, detail: badType.length ? badType.map((x) => `${x.k}: ${x.a.font} ${x.a.size}px vs ${x.b.font} ${x.b.size}px`).join('; ') : undefined },
      { id: 'design-pictures', label: 'Pictures load and are sharp', pass: broken.length === 0 && blown.length === 0, detail: broken.length ? `${broken.length} did not load` : blown.length ? `${blown.length} shown larger than they are` : `${mine.pictures.length} pictures` },
      { id: 'design-phone', label: 'Nothing wider than a phone', pass: minePhone.overflow <= 1, detail: minePhone.overflow > 1 ? `${minePhone.overflow}px too wide at 390px` : undefined },
    ];
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}

/**
 * Every check of a change: page checks before and after, the browser check (with one repair: a framework that redraws the page
 * from its own data and undoes the change has its script taken off that page), and the score.
 * @param {{ baseRoot: string, root: string, applied: Awaited<ReturnType<typeof import('./apply.js').applyChange>>, shotsDir: string }} o
 */
export async function checkChange({ baseRoot, root, applied, shotsDir, render = renderCheck, design: designFn = null }) {
  const notes = [];
  const after = applied.file ? await pageChecks(root, applied.file) : [];
  const before = applied.beforeFile && (await stat(path.join(baseRoot, applied.beforeFile)).catch(() => null)) ? await pageChecks(baseRoot, applied.beforeFile) : null;
  let rendered = null;
  if (applied.page) {
    rendered = await render(root, applied.page, applied.expect, shotsDir);
    if (rendered.missing.length && applied.file) {
      const html = await readText(root, applied.file);
      if (runtimesOf(html).length) {
        const stripped = withoutRuntime(html);
        await writeFresh(path.join(root, applied.file), stripped.html);
        notes.push(`The page's own ${stripped.runtimes.map((r) => r.name).join(', ')} script redrew the page and undid the change, so that script was taken off this page. Anything on it that needs the script (a menu, a slider) may no longer move.`);
        rendered = await render(root, applied.page, applied.expect, shotsDir);
      }
    }
  }
  let design = [];
  if (applied.page && applied.neighbour && applied.neighbour !== applied.page) {
    try {
      design = await (designFn ?? designCheck)(root, applied.page, applied.neighbour);
    } catch (err) {
      notes.push(`The design check did not run: ${String(/** @type {Error} */ (err)?.message ?? err).slice(0, 160)}`);
    }
  }
  const stays = { id: 'stays', label: 'The change is still there after the page\'s scripts ran', pass: rendered ? rendered.missing.length === 0 : null, detail: rendered?.missing.length ? `not found: ${rendered.missing.join(' | ')}` : undefined };
  const afterAll = [...after, ...(applied.expect.length ? [stays] : []), ...design];
  const byId = new Map((before ?? []).map((c) => [c.id, c]));
  const checks = afterAll.map((c) => ({ id: c.id, label: c.label, before: byId.has(c.id) ? byId.get(c.id).pass : null, after: c.pass, detail: c.detail ?? null }));
  if (rendered?.errors.length) notes.push(`Script errors on the page: ${rendered.errors.slice(0, 3).join(' | ')}`);
  return {
    checks,
    // the same page checks on both sides, so the two numbers compare; "still there" decides `ok`
    score: { before: before ? scoreOf(before) : null, after: scoreOf(after) },
    // a design row that fails is shown to the person (the page is still theirs to approve); only 'still there' stops it
    ok: stays.pass !== false,
    design: design.length ? { neighbour: applied.neighbour, passed: design.filter((x) => x.pass).length, of: design.filter((x) => x.pass !== null).length } : null,
    shots: rendered?.shots ?? null,
    notes,
  };
}
