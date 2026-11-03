// @ts-check
// A live website read directly by build mode, from its address alone: no project, no analysis. The homepage and a few pages its
// menu links to are fetched through the SSRF-guarded fetch, a few of its stylesheets too, and each page is reduced to what a
// plan needs: titles, the heading outline, the menu, the main text, the calls to action, the forms, the colours and the fonts.
// Bot-protection pages are reported, never worked around. Everything read here goes into the prompt as <site_content> data.
import { load } from 'cheerio';
import { fetchPage, isBotChallenge, isHtml } from '../audit/http.js';
import { precheckUrl } from '../security/netGuard.js';
import { RULES, buildContext as detectionContext, detectStack as detectPlatforms } from '../detection/engine.js';
import { ContextError } from './context.js';

export const LIVE_SITE_LIMITS = { pages: 5, sheets: 3, pageBytes: 2 * 1024 * 1024, sheetBytes: 400 * 1024, textChars: 1500, totalChars: 24000 };
const TIMEOUT_MS = 20000;
const CSS_ACCEPT = 'text/css,*/*;q=0.1';
const PAGE_LIKE = /(\/|\.html?|\/[^./]+)$/i;
// The platform rules without their network probes: what a site runs on is told from the page that was already read.
const PASSIVE_RULES = RULES.map((r) => ({ ...r, signals: r.signals.filter((sig) => sig.type !== 'endpoint') }));
const PRIMARY = ['builder', 'cms', 'ecommerce', 'framework'];

/**
 * The stack "keep its current technology" means for a live site that runs on `platform`: one with a playbook, the "other" stack
 * under a name, or plain HTML for a hosted builder (Wix, Squarespace…), whose pages cannot be kept as code.
 * @param {{ id: string, name: string, category: string } | null} platform
 * @returns {{ stack: string, stackName?: string, note: string }}
 */
export function keptStack(platform) {
  if (!platform) return { stack: 'html', note: 'No known platform was recognised, so the site is treated as plain HTML, CSS and JavaScript.' };
  if (platform.id === 'nextjs') return { stack: 'nextjs', note: 'The site runs on Next.js.' };
  if (platform.id === 'react') return { stack: 'react-vite', note: 'The site runs on React; it is kept in React (with Vite).' };
  const named = { wordpress: 'WordPress (PHP theme)', woocommerce: 'WordPress + WooCommerce (PHP theme)', shopify: 'Shopify (Liquid theme)', gatsby: 'Gatsby', nuxt: 'Nuxt (Vue)' };
  if (named[platform.id]) return { stack: 'other', stackName: named[platform.id], note: `The site runs on ${platform.name}.` };
  return { stack: 'html', note: `The site is made with ${platform.name}, a hosted builder whose pages cannot be kept as code, so it is rebuilt in plain HTML, CSS and JavaScript.` };
}

const squash = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();
const cut = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The address the owner typed, as a full http(s) URL, or a ContextError saying what is wrong with it.
 * @param {unknown} input
 */
export function checkSiteUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ContextError('Give the address of the live website.');
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ContextError('That is not a website address.');
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new ContextError('That is not a website address.');
  const blocked = precheckUrl(url.toString());
  if (blocked) throw new ContextError(blocked);
  url.hash = '';
  return url.toString();
}

/** Colour values in CSS text, counted, most used first (white, black and transparent left out: every site has them). */
function countColours(/** @type {string} */ css, /** @type {Map<string, number>} */ counts) {
  for (const m of css.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) {
    let c = m[0].toLowerCase().replace(/\s+/g, '');
    if (/^#[0-9a-f]{3}$/.test(c)) c = `#${[...c.slice(1)].map((x) => x + x).join('')}`;
    if (/^(#ffffff|#000000)$|rgba?\(0,0,0,0\)|rgba?\(255,255,255(,1)?\)|rgba?\(0,0,0(,1)?\)/.test(c)) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
}

/** Font families named in CSS text (the first of each stack, generic names left out). */
function collectFonts(/** @type {string} */ css, /** @type {Map<string, number>} */ fonts) {
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const first = m[1].split(',')[0].replace(/["']/g, '').replace(/!important/i, '').trim();
    if (!first || /^(inherit|initial|unset|var\(|serif$|sans-serif$|monospace$|system-ui$|-apple-system$)/i.test(first)) continue;
    fonts.set(first, (fonts.get(first) ?? 0) + 1);
  }
}

/**
 * One page reduced to what a plan needs. Pure: no network.
 * @param {string} html
 * @param {string} url  the address the page was read from (links are resolved against it)
 */
export function extractPage(html, url) {
  const $ = load(html);
  const origin = new URL(url).origin;
  const inlineCss = [$('style').map((_, el) => $(el).text()).get().join('\n'), $('[style]').map((_, el) => $(el).attr('style')).get().join(';')].join('\n');
  const googleFonts = $('link[href*="fonts.googleapis.com"]').map((_, el) => [...String($(el).attr('href')).matchAll(/family=([^&:]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, ' '))).get();
  const sheets = $('link[rel~="stylesheet"][href]').map((_, el) => {
    try {
      return new URL(String($(el).attr('href')), url).toString();
    } catch {
      return null;
    }
  }).get().filter(Boolean);

  /** @param {any} el */
  const linkOf = (el) => {
    const href = $(el).attr('href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return null;
    try {
      const u = new URL(href, url);
      u.hash = '';
      return u;
    } catch {
      return null;
    }
  };
  const navRoot = $('nav, header, [role="navigation"]').first();
  const nav = [];
  const seenNav = new Set();
  navRoot.find('a').each((_, el) => {
    const text = squash($(el).text());
    const u = linkOf(el);
    if (!text || !u || text.length > 40 || seenNav.has(text)) return;
    seenNav.add(text);
    nav.push({ text, href: u.origin === origin ? u.pathname : u.toString(), internal: u.origin === origin });
  });

  const headings = $('h1, h2, h3').map((_, el) => ({ level: Number(el.tagName[1]), text: cut(squash($(el).text()), 120) })).get().filter((h) => h.text).slice(0, 40);
  const ctas = [];
  const seenCta = new Set();
  $('a[class*="btn"], a[class*="button"], a[role="button"], button, input[type="submit"]').each((_, el) => {
    const text = squash($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || '');
    if (!text || text.length > 40 || seenCta.has(text.toLowerCase())) return;
    seenCta.add(text.toLowerCase());
    ctas.push(text);
  });
  const forms = $('form').map((_, form) => {
    const fields = $(form).find('input, select, textarea').filter((__, f) => !/^(hidden|submit|button|reset)$/i.test($(f).attr('type') ?? ''))
      .map((__, f) => $(f).attr('name') || $(f).attr('placeholder') || $(f).attr('type') || f.tagName).get();
    return fields.length ? fields.slice(0, 10).join(', ') : null;
  }).get().filter(Boolean);
  const images = $('img');
  const alts = images.map((_, el) => squash($(el).attr('alt') ?? '')).get().filter(Boolean).slice(0, 8);

  const body = $('main').length ? $('main').first() : $('body');
  body.find('script, style, noscript, svg, template, nav, header, footer').remove();
  const text = cut(squash(body.text()), LIVE_SITE_LIMITS.textChars);
  const footer = cut(squash($('footer').first().text()), 400);
  const internal = $('a').map((_, el) => linkOf(el)).get().filter((u) => u.origin === origin).map((u) => `${u.origin}${u.pathname}`);

  return {
    url,
    path: new URL(url).pathname,
    title: squash($('title').first().text()),
    description: squash($('meta[name="description"]').attr('content') ?? ''),
    lang: $('html').attr('lang') ?? '',
    generator: squash($('meta[name="generator"]').attr('content') ?? ''),
    headings, nav, ctas: ctas.slice(0, 12), forms, text, footer,
    images: { count: images.length, alts },
    inlineCss, googleFonts, sheets, internal,
    assets: $('script[src], link[href], img[src]').map((_, el) => {
      try {
        return new URL(String($(el).attr('src') ?? $(el).attr('href')), url).toString();
      } catch {
        return null;
      }
    }).get().filter(Boolean),
  };
}

/**
 * Reads a live website: the homepage, the pages its menu links to (up to LIVE_SITE_LIMITS.pages in all) and a few of its
 * stylesheets. A homepage that cannot be read is a ContextError; another page that fails is only left out.
 * @param {string} url  checked by checkSiteUrl
 * @param {{ fetch?: typeof fetchPage }} [o]  fetch: tests pass their own
 */
export async function readLiveSite(url, { fetch = fetchPage } = {}) {
  const home = await fetch(url, { timeout: TIMEOUT_MS, maxBytes: LIVE_SITE_LIMITS.pageBytes });
  if (home.error === 'blocked') throw new ContextError(home.message ?? 'That address is not a public website.');
  if (home.error) throw new ContextError(`The website could not be read (${home.error}). Check the address, or give the code instead.`, 422);
  if (isBotChallenge(home)) throw new ContextError('The website answered with a bot-protection page, so it could not be read. Give its code (upload or GitHub) instead.', 422);
  if (home.status >= 400) throw new ContextError(`The website answered with an error (${home.status}).`, 422);
  if (!isHtml(home) || !home.body) throw new ContextError('That address does not answer with a web page.', 422);

  const first = extractPage(home.body, home.url);
  const detections = await detectPlatforms(detectionContext({ headers: home.headers ?? {}, rawHtml: home.body, assets: first.assets, origin: new URL(home.url).origin }), PASSIVE_RULES)
    .catch(() => []);
  const primary = detections.find((d) => PRIMARY.includes(d.category) && d.confidence >= 50) ?? null;
  const platform = primary ? { id: primary.id, name: primary.name, category: primary.category } : null;
  const origin = new URL(home.url).origin;
  const wanted = [...new Set([
    ...first.nav.filter((n) => n.internal).map((n) => `${origin}${n.href}`),
    ...first.internal,
  ])].filter((u) => u !== `${origin}${first.path}` && PAGE_LIKE.test(new URL(u).pathname) && !/\.(pdf|jpe?g|png|zip|xml)$/i.test(u))
    .slice(0, LIVE_SITE_LIMITS.pages - 1);
  const others = (await Promise.all(wanted.map(async (u) => {
    const res = await fetch(u, { timeout: TIMEOUT_MS, maxBytes: LIVE_SITE_LIMITS.pageBytes });
    return !res.error && res.status < 400 && isHtml(res) && res.body ? extractPage(res.body, res.url) : null;
  }))).filter(Boolean);
  const pages = [first, ...others.filter((p, i, all) => p && all.findIndex((q) => q?.path === p.path) === i && p.path !== first.path)];

  const colours = new Map();
  const fonts = new Map();
  for (const p of pages) {
    countColours(p.inlineCss, colours);
    collectFonts(p.inlineCss, fonts);
    for (const f of p.googleFonts) fonts.set(f, (fonts.get(f) ?? 0) + 5);
  }
  const sheetUrls = [...new Set(pages.flatMap((p) => p.sheets))].slice(0, LIVE_SITE_LIMITS.sheets);
  await Promise.all(sheetUrls.map(async (u) => {
    const res = await fetch(u, { timeout: TIMEOUT_MS, maxBytes: LIVE_SITE_LIMITS.sheetBytes, accept: CSS_ACCEPT });
    if (res.error || res.status >= 400 || !res.body) return;
    countColours(res.body, colours);
    collectFonts(res.body, fonts);
  }));
  const top = (/** @type {Map<string, number>} */ m, /** @type {number} */ n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    url: home.url,
    platform,
    pages: pages.map(({ inlineCss, googleFonts, sheets, internal, assets, ...rest }) => rest),
    colours: top(colours, 10),
    fonts: top(fonts, 4),
  };
}

/**
 * The site as the prompt reads it, within LIVE_SITE_LIMITS.totalChars.
 * @param {Awaited<ReturnType<typeof readLiveSite>>} site
 */
export function summarizeLiveSite(site) {
  const home = site.pages[0];
  const lines = [`Address: ${site.url}`, `Pages read: ${site.pages.map((p) => p.path).join(', ')}`];
  if (site.platform) lines.push(`Runs on: ${site.platform.name}`);
  if (home?.generator) lines.push(`Built with (generator tag): ${home.generator}`);
  if (home?.lang) lines.push(`Language: ${home.lang}`);
  if (home?.nav.length) lines.push(`Main menu: ${home.nav.map((n) => `${n.text} (${n.href})`).join(' · ')}`);
  if (site.colours.length) lines.push(`Colours used most: ${site.colours.join(', ')}`);
  if (site.fonts.length) lines.push(`Fonts: ${site.fonts.join(', ')}`);
  for (const p of site.pages) {
    lines.push('', `## Page ${p.path}`, `Title: ${p.title || '(none)'}`, `Description: ${p.description || '(none)'}`);
    if (p.headings.length) lines.push('Outline:', ...p.headings.map((h) => `${'  '.repeat(h.level - 1)}- h${h.level} ${h.text}`));
    if (p.ctas.length) lines.push(`Buttons and calls to action: ${p.ctas.join(' · ')}`);
    if (p.forms.length) lines.push(`Forms: ${p.forms.map((f) => `[${f}]`).join(' ')}`);
    lines.push(`Images: ${p.images.count}${p.images.alts.length ? ` (e.g. ${p.images.alts.map((a) => `"${a}"`).join(', ')})` : ''}`);
    if (p.text) lines.push(`Text: ${p.text}`);
    if (p === home && p.footer) lines.push(`Footer: ${p.footer}`);
  }
  return cut(lines.join('\n'), LIVE_SITE_LIMITS.totalChars);
}
