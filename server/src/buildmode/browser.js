// @ts-check
// The agent's eyes: the site as a visitor sees it. Every page is opened in Chromium (served from 127.0.0.1 by the same
// static server the recreate checks use), at phone, tablet and computer width, and comes back as screenshots the agent
// looks at, plus findings a screenshot does not show reliably: sideways scrolling and the elements causing it, broken
// images, script errors, cramped tap targets and tiny text on phones, clipped text, bracketed placeholders still on the
// page, and the serious accessibility problems axe finds. Screenshots are downscaled JPEG tiles, at most PREVIEW_LIMITS of
// them, so a look costs a bounded number of tokens.
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import sharp from 'sharp';
import { startSiteServer } from '../recreate/verify/server.js';
import { listFiles } from './workspace.js';

export const VIEWS = {
  phone: { width: 375, height: 812, mobile: true, shotWidth: 375 },
  tablet: { width: 768, height: 1024, mobile: true, shotWidth: 480 },
  desktop: { width: 1440, height: 900, mobile: false, shotWidth: 800 },
};
export const PREVIEW_LIMITS = { pages: 6, tileHeight: 1400, tilesPerView: 3, findingsPerKind: 6 };
const LOAD_MS = 20000;

/** The address of each page of the site: index.html → /, about/index.html → /about/, menu.html → /menu.html. */
export async function sitePages(siteDir) {
  return (await listFiles(siteDir)).filter((f) => /\.html?$/i.test(f))
    .map((f) => (f === 'index.html' ? '/' : f.endsWith('/index.html') ? `/${f.slice(0, -'index.html'.length)}` : `/${f}`))
    .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

/** Runs in the page: what a screenshot does not show reliably. */
function diagnose({ mobile, max, width }) {
  // The device's width, not innerWidth: a phone browser zooms out to fit content that is too wide, which hides the problem.
  const W = width;
  const describe = (el) => {
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    const text = (el.innerText || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}>${text ? ` "${text}"` : ''}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const all = [...document.body.querySelectorAll('*')];
  const overflow = document.documentElement.scrollWidth > W + 1
    ? all.filter((el) => { const r = el.getBoundingClientRect(); return (r.right > W + 1 || r.left < -1) && visible(el) && !clippedByAncestor(el); })
      .filter((el, _, list) => !list.some((o) => o !== el && o.contains(el)))
      .slice(0, max).map(describe)
    : [];
  const brokenImages = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).slice(0, max).map((i) => i.getAttribute('src'));
  const smallTargets = mobile
    ? [...document.querySelectorAll('a[href], button, input, select, textarea, summary')].filter((el) => {
      if (!visible(el) || el.closest('p, li p, figcaption')) return false;
      const r = el.getBoundingClientRect();
      return r.height < 40 || r.width < 40;
    }).slice(0, max).map(describe)
    : [];
  const tinyText = mobile
    ? all.filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 13)
      .slice(0, max).map((el) => `${describe(el)} at ${getComputedStyle(el).fontSize}`)
    : [];
  const clipped = all.filter((el) => {
    const s = getComputedStyle(el);
    return /(hidden|clip)/.test(s.overflow + s.overflowX) && el.scrollWidth > el.clientWidth + 2 && (el.innerText || '').trim() && visible(el) && s.textOverflow !== 'ellipsis';
  }).slice(0, max).map(describe);
  const placeholders = [...new Set((document.body.innerText.match(/\[[^\]\n]{2,80}\]/g) || []))];
  // A placeholder where the content rules forbid one: the first screen, a heading, the navigation, a button or the wordmark.
  const BRACKET = /\[[^\]\n]{2,80}\]/;
  const prominent = [...new Set(all.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && BRACKET.test(n.textContent)) && visible(el))
    .filter((el) => el.getBoundingClientRect().top < window.innerHeight || el.closest('h1, h2, h3, nav, header, button, .btn, .button, [role="button"]'))
    .map((el) => `${(el.textContent.match(BRACKET) || [''])[0]} in ${describe(el)}`))].slice(0, max);
  return {
    overflow, brokenImages, smallTargets, tinyText, clipped, placeholders, prominent,
    h1: document.querySelectorAll('h1').length,
    height: document.documentElement.scrollHeight,
  };
}

/** A full-page screenshot as downscaled JPEG tiles (base64). */
async function tiles(png, shotWidth, cssWidth) {
  const scaled = sharp(png).resize({ width: shotWidth });
  const { data, info } = await scaled.jpeg({ quality: 72 }).toBuffer({ resolveWithObject: true });
  const out = [];
  for (let top = 0; top < info.height && out.length < PREVIEW_LIMITS.tilesPerView; top += PREVIEW_LIMITS.tileHeight) {
    const height = Math.min(PREVIEW_LIMITS.tileHeight, info.height - top);
    out.push((await sharp(data).extract({ left: 0, top, width: info.width, height }).jpeg({ quality: 72 }).toBuffer()).toString('base64'));
  }
  return { tiles: out, cut: info.height > PREVIEW_LIMITS.tileHeight * PREVIEW_LIMITS.tilesPerView ? Math.round(PREVIEW_LIMITS.tileHeight * PREVIEW_LIMITS.tilesPerView * (cssWidth / shotWidth)) : 0 };
}

/**
 * Opens the site's pages in a browser.
 * @param {string} siteDir
 * @param {{ pages?: string[], sizes?: (keyof typeof VIEWS)[], axe?: boolean }} [o]
 * @returns {Promise<{ pages: string[], findings: string[], shots: { label: string, data: string }[] }>}
 */
export async function previewSite(siteDir, { pages, sizes = ['desktop', 'tablet', 'phone'], axe = true } = {}) {
  const all = await sitePages(siteDir);
  const chosen = (pages?.length ? pages.map((p) => (p.startsWith('/') ? p : `/${p}`)).filter((p) => all.includes(p)) : all).slice(0, PREVIEW_LIMITS.pages);
  const findings = [];
  const shots = [];
  if (!chosen.length) return { pages: [], findings: ['The site has no pages yet.'], shots };
  const server = await startSiteServer(siteDir);
  const browser = await chromium.launch();
  try {
    for (const pagePath of chosen) {
      for (const size of sizes.filter((s) => VIEWS[s])) {
        const v = VIEWS[size];
        const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
        page.on('requestfailed', (r) => errors.push(`failed to load ${new URL(r.url()).pathname}`));
        try {
          await page.goto(`${server.origin}${pagePath}`, { waitUntil: 'load', timeout: LOAD_MS });
          await page.evaluate(() => document.fonts.ready);
          // Content that appears on scroll is shown in the screenshot as a visitor would see it after scrolling.
          await page.evaluate(async () => {
            for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
            window.scrollTo(0, 0);
          });
          await page.waitForTimeout(400);
          const d = await page.evaluate(diagnose, { mobile: v.mobile, max: PREVIEW_LIMITS.findingsPerKind, width: v.width });
          const at = `${pagePath} on ${size} (${v.width} px)`;
          if (d.prominent.length) findings.push(`${at}: MUST FIX — placeholders in the first screen, a heading, the navigation or a button, which the content rules forbid: ${d.prominent.join(', ')}. Write around the missing fact there (or move it to the visit or contact section).`);
          if (d.overflow.length) findings.push(`${at}: the page scrolls sideways; these stick out: ${d.overflow.join(', ')}`);
          if (d.brokenImages.length) findings.push(`${at}: images that do not load: ${d.brokenImages.join(', ')}`);
          if (d.smallTargets.length) findings.push(`${at}: tap targets smaller than 40 px: ${d.smallTargets.join(', ')}`);
          if (d.tinyText.length) findings.push(`${at}: text smaller than 13 px: ${d.tinyText.join(', ')}`);
          if (d.clipped.length) findings.push(`${at}: text cut off by its box: ${d.clipped.join(', ')}`);
          if (errors.length) findings.push(`${at}: errors in the browser: ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
          if (size === 'desktop') {
            if (d.h1 !== 1) findings.push(`${pagePath}: ${d.h1} h1 headings (a page needs exactly one)`);
            if (d.placeholders.length) findings.push(`${pagePath}: ${d.placeholders.length} bracketed placeholder(s) still visible: ${d.placeholders.slice(0, 8).join(' ')}`);
            if (axe) {
              const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze().catch(() => null);
              const serious = (result?.violations ?? []).filter((x) => x.impact === 'serious' || x.impact === 'critical');
              for (const x of serious.slice(0, PREVIEW_LIMITS.findingsPerKind)) findings.push(`${pagePath}: accessibility — ${x.help} (${x.nodes.length}×, e.g. ${x.nodes[0]?.target?.join(' ') ?? ''})`);
            }
          }
          const png = await page.screenshot({ fullPage: true, type: 'png' });
          const t = await tiles(png, v.shotWidth, v.width);
          t.tiles.forEach((data, i) => shots.push({ label: `${at}${t.tiles.length > 1 ? `, part ${i + 1} of ${t.tiles.length}` : ''}`, data }));
          if (t.cut) findings.push(`${at}: the page is long; the screenshots stop after about ${t.cut} px`);
        } catch (err) {
          findings.push(`${pagePath} on ${size}: the page could not be opened (${String(err?.message ?? err).slice(0, 120)})`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return { pages: chosen, findings, shots };
}

/** The preview as the agent reads it: the findings, then each screenshot with its label. */
export function previewContent(/** @type {{ pages: string[], findings: string[], shots: { label: string, data: string }[] }} */ p) {
  const head = p.findings.length
    ? `Opened ${p.pages.join(', ')}. Automatic findings to fix:\n${p.findings.map((f) => `- ${f}`).join('\n')}`
    : `Opened ${p.pages.join(', ')}. No automatic findings.`;
  return [
    { type: 'text', text: `${head}\nNow look at every screenshot as a demanding senior designer would, using the visual review list, and fix everything that is not excellent.` },
    ...p.shots.flatMap((s) => [{ type: 'text', text: s.label }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.data } }]),
  ];
}
