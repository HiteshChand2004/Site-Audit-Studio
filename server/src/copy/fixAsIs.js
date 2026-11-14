// The safe fixes of an as-is copy (docs/COPY-MY-SITE.md §2): what can be corrected in the original's own markup without changing
// how a page looks or behaves. They run on the lifted HTML files, after the link pass and before packaging, so every stack gets
// them. The rules are the ones the clean rebuild uses (recreate/fixers, ir/seoText, ir/aeo, ir/crawlFiles): the lifted document
// is given to them through a thin adapter whose elements share the parsed element's attributes, so a fixer's change is a change
// to the markup. Only what is missing, empty, duplicated or invalid is touched; nothing the original states correctly is rewritten.
//   alt          <img> without alt (fixAlt)
//   names        links, buttons and fields without an accessible name (fixNames)
//   aria         frame titles, positive tabindex, invalid ARIA values, focusable inside aria-hidden (fixAria, asIs: duplicate
//                ids are reported, never renamed — the original's styles and scripts may use them)
//   head         a missing or duplicated title or description; a title outside 10–60 characters or a description outside
//                50–160 (shortened at a word, or completed from the page's own words; marked for review); a missing canonical /
//                og:title / og:description / og:url; a canonical or og:url naming the original moved to the new site; a missing
//                <html lang>; a missing theme-color (the site's manifest, its TileColor, else its links' and buttons' colour from
//                its own stylesheets: review) and a missing icon (the site's own /favicon.ico, else a letter icon: review)
//   data         JSON-LD Organization + WebSite on the homepage when no page has them; FAQPage where the page shows questions
//                with their answers and has none
//   files        sitemap.xml, llms.txt (when the copy has none), robots.txt kept but pointing at the new site, _headers
//   anchors, linktext, headings, prohibited, scrollable, and an invalid <html lang>: copy/seoA11yAsIs.js (role="button" on
//                javascript:void(0) links, visually hidden text in vague links, aria-level on skipped headings, role="img" on a
//                named element with no text that may not carry a name, tabindex="0" on a box that scrolls out of the keyboard's reach)
//   lcp, lazy, webp  copy/perfAsIs.js, from what the browser measured (`perf`): fetchpriority on the largest image, loading="lazy"
//                below the first screen at every width, a lossless WebP for a local PNG with the very same pixels
// A description is also taken from the page's own og:description / twitter:description when its paragraphs give none. A missing
// or zoom-blocking <meta name="viewport"> is reported, never changed: adding or loosening one changes how phones lay out the page.
// Not here (they change pixels or behaviour, reason d): contrast, font subsets, sprite / layout parking, dead-link unlinking,
// LCP entrance removal; lossy or resized images, font-display, the original's scripts.
// Every page's fixes are listed; the stage then proves them invisible (preserve/check.js fixGate) and reverts a page's fixes
// when they are not.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fixAlt, fixNames } from '../recreate/fixers/a11y.js';
import { fixAria } from '../recreate/fixers/aria.js';
import { fitTitle, fitDescription, pathLabel, detectLang } from '../recreate/ir/seoText.js';
import { faqPairs } from '../recreate/ir/aeo.js';
import { generatedFavicon } from '../recreate/ir/head.js';
import { hexColor } from '../recreate/ir/index.js';
import { crawlFiles } from '../recreate/ir/crawlFiles.js';
import { resetTextCache } from '../recreate/ir/tree.js';
import { HEADERS_FILE as CACHE_HEADERS } from '../recreate/behavior/preserve/pack.js';
import { blocksZoom, fixInvalidLang, isValidLang } from './seoA11yAsIs.js';
import { MARKUP_PASS, emptyCounts, fixGroup } from './fixRegistry.js';
import { fixImageLoading, fixPngImages } from './perfAsIs.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { faithfulHtml, loadFaithful } from './faithfulHtml.js';
import { bundledTemplate, headOf, syncShellHead, withTemplate } from './bundled.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The visible words of a page's body: its text without what a script, a stylesheet or a template holds. */
export function visibleText($) {
  const body = $('body').first().clone();
  body.find('script, style, noscript, template').remove();
  return body.text();
}

const SKIP = new Set(['script', 'style', 'noscript', 'template']);
const bareHost = (h) => String(h ?? '').toLowerCase().replace(/^www\./, '');

/**
 * Security headers an as-is copy can ship: no Content-Security-Policy, because the original's own scripts (often inline) run
 * in it. Then the copy's caching rules (pages revalidate, files are kept).
 */
export const AS_IS_HEADERS = [
  '/*',
  ...SECURITY_HEADERS.map(([name, value]) => `  ${name}: ${value}`),
  '',
  CACHE_HEADERS,
].join('\n');

/** The parsed body as the nodes the fixers walk: { tag, attrs (the element's own attribute object), children, views }. */
export function adapt($, el) {
  if (el.type === 'text') return { text: el.data ?? '' };
  if (el.type !== 'tag' && el.type !== 'script' && el.type !== 'style') return null;
  const tag = String(el.name).toLowerCase();
  if (SKIP.has(tag)) return null;
  const style = String(el.attribs.style ?? '').replace(/\s+/g, '');
  const hidden = el.attribs.hidden != null || /display:none/i.test(style);
  const views = { desktop: { hidden, rect: [0, 0, hidden ? 0 : 1, hidden ? 0 : 1] } };
  if (tag === 'svg') return { tag, attrs: el.attribs, svg: $.html(el), children: [], views };
  const n = { tag, attrs: el.attribs, children: [], views };
  if (tag === 'img') n.src = el.attribs.src;
  if (tag === 'a') n.href = el.attribs.href;
  n.children = (el.children ?? []).map((c) => adapt($, c)).filter(Boolean);
  return n;
}

const jsonLdTypes = ($) => $('script[type="application/ld+json"]').toArray().flatMap((s) => {
  try {
    return [JSON.parse($(s).text())].flat().flatMap((x) => x?.['@graph'] ?? [x]).flatMap((x) => [x?.['@type']].flat()).filter(Boolean);
  } catch {
    return [];
  }
});

/** JSON-LD as a <script>: `<`, `>` and `&` written as \u escapes, so the text can never close the element. */
const ldScript = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>`;

/** The page's own paragraphs (text a visitor reads), for a description. */
const paragraphsOf = ($) => $('body p').toArray().map((p) => clean($(p).text())).filter((t) => t.length >= 30);

/**
 * @param {object} o
 * @param {string} o.dir                the lifted copy (files are rewritten in place)
 * @param {{ path: string, outPath: string, url: string }[]} o.pages  homepage first
 * @param {string} o.siteUrl            the original's address
 * @param {string|null} [o.newSiteUrl]  the new site's address (canonical, sitemap, robots); without it nothing names an address
 * @param {string|null} [o.siteName]
 * @param {(origin: string) => Promise<{ text: string|null }>} [o.fetchLlms]  the original's llms.txt (the job passes the guarded fetch; none = not asked)
 * @param {string|null} [o.readDir]     where the pages are read from (default `dir`): the lifted copy, for a retry that must start
 *   from the same pages the first pass started from
 * @param {Map<string, Set<string>>|null} [o.only]  a retry of some fixes (preserve/stage.js fixAndProve): outPath → the groups
 *   (fixGroup) allowed on that page. Every page is still read, so a duplicate title or description is judged as in the first
 *   pass, but only the pages named here are written, with only those groups, and the site files are not written again.
 * @param {Map<string, object>|null} [o.perf]  outPath → its plan (copy/perfAsIs.js planPerf, from preserve/check.js perfProbe);
 *   a page without one gets no lcp / lazy fix. The same plan is passed to a retry, so it makes the same fixes.
 * @param {boolean} [o.write]  false: nothing is written; the pages' fixed HTML comes back as `html` (outPath → HTML)
 * @returns {Promise<{ pages: object[], files: object, counts: Record<string, number>, open: object[], originals: Map<string, string>, html?: Map<string, string> }>}
 *   originals: outPath → the page's HTML before its fixes (for a revert)
 */
export async function fixAsIsCopy({ dir, pages, siteUrl, newSiteUrl = null, siteName = null, fetchLlms = null, readDir = null, only = null, perf = null, write = true }) {
  // write: false = no page is written; the fixed HTML of each page (of the `only` pages, when given) is returned as `html`
  // (preserve/stage.js: a page without one group of its fixes, for the "problem gone?" check). Files a fix makes beside the
  // pages (a letter icon, a WebP) are the same bytes the first pass wrote.
  const htmlOut = new Map();
  const siteHost = bareHost(new URL(siteUrl).hostname);
  const newOrigin = newSiteUrl ? new URL(newSiteUrl).origin : null;
  const docs = [];
  for (const p of pages) {
    const file = path.join(dir, p.outPath);
    const html = await readFile(path.join(readDir ?? dir, p.outPath), 'utf8').catch(() => null);
    if (html == null) continue;
    // A bundled page (copy/bundled.js) draws the document in its template: that document is the one fixed (`html`), and the
    // page around it (`shell`) is written back with it.
    const template = bundledTemplate(html);
    const drawn = template ? template.inner : html;
    // With the parser's source positions: a fixed page is written back as its own bytes with only the fixes changed (faithfulHtml).
    docs.push({ ...p, file, html: drawn, ...(template && { shell: html, template }), $: loadFaithful(drawn) });
  }
  const name = siteName || clean(docs[0]?.$('meta[property="og:site_name"]').attr('content')) || siteHost;

  // Every page's path in the copy → its output file, for link targets (names) and for the titles of the pages they point at.
  const byPath = new Map();
  for (const d of docs) {
    byPath.set(d.path, d.outPath);
    byPath.set(d.path.replace(/\/$/, '') || '/', d.outPath);
  }
  const pageTitles = new Map(docs.map((d) => [d.outPath, clean(d.$('title').first().text())]));
  const resolveLink = (href, base) => {
    if (!href) return null;
    if (href.startsWith('#')) return { anchor: href };
    let u;
    try {
      u = new URL(href, base);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const local = bareHost(u.hostname) === siteHost || u.origin === new URL(base).origin;
    if (!local) return { external: true };
    const p = decodeURIComponent(u.pathname);
    const outPath = byPath.get(p) ?? byPath.get(p.replace(/\/$/, '') || '/') ?? byPath.get(p.replace(/index\.html$/, ''));
    if (outPath) return u.hash && u.pathname === new URL(base).pathname ? { anchor: u.hash } : { page: outPath };
    return null;
  };

  // Titles and descriptions used more than once (case and spacing ignored): the first page keeps its own.
  const seenTitle = new Set();
  const seenDescription = new Set();
  const allTypes = new Set(docs.flatMap((d) => jsonLdTypes(d.$)));
  const result = [];
  const open = [];
  const counts = emptyCounts();
  const originals = new Map();
  // The site's theme colour and icon, decided once (undefined = not looked for yet; null = none).
  let theme;
  let icon;
  // One WebP per PNG for the whole run, however many pages show it.
  const webpMade = new Map();
  // The site's logo card for link previews, made once (previewPicture).
  const pictures = new Map();

  for (const d of docs) {
    const { $ } = d;
    const fixes = [];
    const body = $('body').get(0);
    const root = body ? adapt($, body) : null;
    // The page's text before any fix adds to it (a link's hidden text), so the language read from it is the same in a retry.
    // Only the words a visitor reads: a stylesheet or script inside the body (a bundled page holds its fonts' CSS there) is no
    // text, and 20 000 characters of CSS told detectLang nothing (procuredesk: no lang).
    const bodyText = visibleText($);
    resetTextCache();
    // A retry (`only`) makes only the groups it names on its page; every other page, and a first pass, makes them all.
    const allow = (group) => !only?.has(d.outPath) || only.get(d.outPath).has(group);
    if (root) {
      const tree = { root, info: { path: d.path, url: d.url, outPath: d.outPath } };
      if (allow('alt')) {
        const alt = fixAlt(tree);
        for (const f of [...alt.fixed, ...alt.decorative]) fixes.push({ kind: 'alt', ...f });
      }
      if (allow('names')) {
        const names = fixNames(tree, { pageUrl: d.url, resolveLink, pageTitles, siteName: name });
        for (const f of names.fixed) fixes.push({ kind: 'names', ...f });
        open.push(...names.open.map((o) => ({ kind: 'names', reason: 'c', ...o })));
      }
      if (allow('aria')) {
        const aria = fixAria(tree, { asIs: true });
        for (const f of aria.fixed) fixes.push({ kind: 'aria', ...f });
        open.push(...aria.open.map((o) => ({ kind: 'aria', ...o })));
      }
    }
    if (body) {
      // The page's language for link-text: the declared one when it is a language code, else what its text shows.
      const declared = clean($('html').attr('lang'));
      const pageLang = declared && isValidLang(declared) ? declared : detectLang(bodyText);
      // The registry's markup pass (copy/fixRegistry.js MARKUP_PASS), in its order. A fix that needs the probe's plan runs only
      // where the probe measured the page: which boxes scroll is the browser's to say.
      const ctx = { resolveLink, pageTitles, siteName: name, lang: pageLang, plan: perf?.get(d.outPath) ?? null };
      for (const { kind, apply, needs } of MARKUP_PASS) {
        if (needs === 'perf' && !perf?.has(d.outPath)) continue;
        if (!allow(kind)) continue;
        const r = apply($, d, ctx);
        for (const f of r.fixed) fixes.push({ kind, ...f });
        open.push(...r.open.map((o) => ({ kind, ...o })));
      }
      const loading = fixImageLoading($, d, perf?.get(d.outPath) ?? null, { lcp: allow('lcp'), lazy: allow('lazy') });
      for (const kind of ['lcp', 'lazy']) {
        if (!allow(kind)) continue;
        for (const f of loading[kind].fixed) fixes.push({ kind, ...f });
        open.push(...loading[kind].open.map((o) => ({ kind, ...o })));
      }
      // Only on a page the probe measured (its plan): a caller that proves the markup fixes alone, or a page that could not be
      // measured, gets no image rewritten either.
      if (perf?.has(d.outPath) && allow('webp')) {
        const webp = await fixPngImages($, d, dir, webpMade);
        for (const f of webp.fixed) fixes.push({ kind: 'webp', ...f });
        open.push(...webp.open.map((o) => ({ kind: 'webp', ...o })));
      }
    }

    // Head: only what is missing or duplicated. A page whose head tags stand in a <helmet> block (its script moves them into the
    // head when it draws the page: react-helmet, a bundled page's x-dc) is given them there; a tag written into <head> beside
    // them would lose to the helmet's own when the script runs.
    const head = headOf($);
    const h1 = clean($('body h1').first().text()) || clean($('body h2').first().text());
    // The page's own title where it stands (the head's first, else any: a title outside the head is still the page's title).
    let titleEl = head.find('title').first();
    if (!titleEl.length) titleEl = $('title').first();
    const title = clean(titleEl.text());
    const titleKey = title.toLowerCase();
    let finalTitle = title;
    if (allow('head:title') && (!title || seenTitle.has(titleKey))) {
      const fresh = fitTitle(h1 && h1.toLowerCase() !== titleKey ? h1 : pathLabel(d.path) || h1, name);
      if (fresh && !seenTitle.has(fresh.toLowerCase())) {
        if (!titleEl.length) {
          head.prepend('<title></title>');
          titleEl = head.find('title').first();
        }
        titleEl.text(fresh);
        fixes.push({ kind: 'head', field: 'title', from: title || null, value: fresh, source: title ? 'duplicate of another page' : 'missing' });
        finalTitle = fresh;
      }
    }
    // Length (10–60 characters, the Analyze check): a long title loses its trailing parts (" | tagline") first, then is cut at a
    // word; a short one gets the site name. Only the page's own words and the site name; marked for review in the report.
    if (allow('head:title') && finalTitle && finalTitle === title && outside(finalTitle, TITLE_LIMITS)) {
      const fitted = fitTitle(finalTitle, name);
      if (fitted !== finalTitle && !outside(fitted, TITLE_LIMITS) && !seenTitle.has(fitted.toLowerCase())) {
        titleEl.text(fitted);
        fixes.push({ kind: 'head', field: 'title', from: finalTitle, value: fitted, source: finalTitle.length > TITLE_LIMITS[1] ? 'too long: shortened' : 'too short: the site name added' });
        finalTitle = fitted;
      } else open.push({ kind: 'head', field: 'title', page: d.path, reason: 'c', detail: `The title is ${finalTitle.length} characters (10–60 wanted) and the page gives nothing to ${finalTitle.length > TITLE_LIMITS[1] ? 'shorten it to' : 'complete it with'}: the owner writes it` });
    }
    // The page's own title counts as taken too: a later page with the same text is still a duplicate after this one's was fitted.
    seenTitle.add(finalTitle.toLowerCase());
    if (title) seenTitle.add(titleKey);
    let descEl = head.find('meta[name="description"]').first();
    if (!descEl.length) descEl = $('meta[name="description"]').first();
    const description = clean(descEl.attr('content'));
    let finalDescription = description;
    if (allow('head:description') && (!description || seenDescription.has(description.toLowerCase()))) {
      const own = paragraphsOf($).filter((t) => !seenDescription.has(t.toLowerCase()));
      let fresh = fitDescription(own);
      let from = 'the page\'s own paragraphs';
      if (!fresh || fresh.length < 50) {
        // The owner's own summary of the page, when its paragraphs are too short to make one.
        const summary = clean($('meta[property="og:description"]').attr('content') || $('meta[name="twitter:description"]').attr('content'));
        if (summary.length >= 50) {
          fresh = fitDescription([summary]);
          from = 'the page\'s own og:description';
        }
      }
      if (fresh && fresh.length >= 50 && !seenDescription.has(fresh.toLowerCase())) {
        if (!descEl.length) {
          head.append('<meta name="description" content="">');
          descEl = head.find('meta[name="description"]').first();
        }
        descEl.attr('content', fresh);
        fixes.push({ kind: 'head', field: 'description', from: description || null, value: fresh, source: description ? 'duplicate of another page' : from });
        finalDescription = fresh;
      }
    }
    // Length (50–160 characters): a long description is cut at a word; a short one is completed with the page's own paragraphs
    // (those no other page uses). Marked for review.
    if (allow('head:description') && finalDescription && finalDescription === description && outside(finalDescription, DESCRIPTION_LIMITS)) {
      const long = finalDescription.length > DESCRIPTION_LIMITS[1];
      const fitted = fitDescription(long ? [finalDescription] : [finalDescription, ...paragraphsOf($).filter((t) => !seenDescription.has(t.toLowerCase()))]);
      if (fitted !== finalDescription && !outside(fitted, DESCRIPTION_LIMITS) && !seenDescription.has(fitted.toLowerCase())) {
        descEl.attr('content', fitted);
        fixes.push({ kind: 'head', field: 'description', from: finalDescription, value: fitted, source: long ? 'too long: cut at a word' : 'too short: completed with the page\'s own paragraphs' });
        finalDescription = fitted;
      } else open.push({ kind: 'head', field: 'description', page: d.path, reason: 'c', detail: `The description is ${finalDescription.length} characters (50–160 wanted) and the page gives no words of its own to complete it: the owner writes it` });
    }
    if (finalDescription) seenDescription.add(finalDescription.toLowerCase());
    if (description) seenDescription.add(description.toLowerCase());

    // Addresses (applyAddress, shared with the address pass at download, copy/addressPass.js): a canonical / og:url / og:image
    // naming the original moves to the new site, a missing canonical / og:url is added (only with an address).
    const og = (prop, value, source) => {
      if (!allow('head:meta') || !value || $(`meta[property="${prop}"]`).length) return;
      head.append(`<meta property="${prop}" content="">`);
      head.find(`meta[property="${prop}"]`).last().attr('content', value);
      fixes.push({ kind: 'head', field: prop, value, source });
    };
    // (Its fixes go into this page's list in the order they are made, the og:title / og:description between them as before.)
    const { own } = await applyAddress($, d, {
      dir, siteHost, newOrigin, byPath, allow: allow('head:meta'), fixes, open, pictures,
      between: () => {
        og('og:title', finalTitle, 'the page title');
        og('og:description', finalDescription, 'the page description');
      },
    });

    // theme-color and an icon, when the page has none: neither ever shows on the page. The colour and the icon are decided once
    // for the site (the homepage's evidence); a value taken from the stylesheets, and a letter icon, are marked for review.
    if (allow('head:meta') && !clean($('meta[name="theme-color"]').attr('content'))) {
      if (theme === undefined) theme = await siteThemeColor(docs[0], dir);
      if (theme) {
        head.append('<meta name="theme-color" content="">');
        head.find('meta[name="theme-color"]').last().attr('content', theme.value);
        fixes.push({ kind: 'head', field: 'theme-color', value: theme.value, source: theme.source, ...(theme.review && { review: true }) });
      } else open.push({ kind: 'head', field: 'theme-color', page: d.path, reason: 'c', detail: 'The site states no brand colour (no manifest theme_color, no TileColor, no strong colour on its links or buttons): the owner chooses it' });
    }
    if (allow('head:meta') && !$('link[rel~="icon" i], link[rel="apple-touch-icon" i]').length) {
      if (icon === undefined) icon = await siteIcon(dir, name, theme?.value ?? null);
      const up = '../'.repeat(d.outPath.split('/').length - 1);
      head.append('<link rel="icon" href="">');
      head.find('link[rel="icon"]').last().attr('href', `${up}${icon.file}`);
      if (icon.type) head.find('link[rel="icon"]').last().attr('type', icon.type);
      fixes.push({ kind: 'head', field: 'icon', value: icon.file, source: icon.source, ...(icon.review && { review: true }) });
    }

    const html = $('html');
    if (allow('lang') && !clean(html.attr('lang'))) {
      const lang = detectLang(bodyText);
      if (lang) {
        html.attr('lang', lang);
        fixes.push({ kind: 'lang', field: 'lang', value: lang, source: 'the page text' });
      } else open.push({ kind: 'lang', page: d.path, reason: 'c', detail: 'The page declares no language and its text does not say clearly' });
    } else if (allow('lang')) {
      const invalid = fixInvalidLang($, detectLang(bodyText));
      if (invalid?.value) {
        html.attr('lang', invalid.value);
        fixes.push({ kind: 'lang', field: 'lang', from: invalid.from, value: invalid.value, source: 'the page text (the declared one is not a language code)' });
      } else if (invalid) open.push({ kind: 'lang', page: d.path, reason: 'c', detail: `<html lang="${invalid.from}"> is not a language code and the page text does not say clearly which one it is` });
    }
    const viewport = $('meta[name="viewport"]').attr('content');
    if (viewport == null) open.push({ kind: 'viewport', page: d.path, reason: 'd', detail: 'The page has no <meta name="viewport">: adding one changes how every phone lays it out, so it is not added' });
    else if (blocksZoom(viewport)) open.push({ kind: 'viewport', page: d.path, reason: 'd', detail: `<meta name="viewport" content="${clean(viewport)}"> stops zooming: loosening it changes how the page behaves on a phone, so it is not changed` });

    // Structured data.
    const types = jsonLdTypes($);
    if (d === docs[0] && allow('data')) {
      const url = newOrigin ? `${newOrigin}/` : undefined;
      const icon = $('link[rel="apple-touch-icon"]').attr('href') ?? $('link[rel~="icon"]').attr('href');
      const logo = icon && newOrigin ? new URL(icon, `${newOrigin}${d.path}`).href : undefined;
      if (!['Organization', 'LocalBusiness', 'Corporation'].some((t) => allTypes.has(t))) {
        head.append(ldScript({ '@context': 'https://schema.org', '@type': 'Organization', name, ...(url && { url }), ...(logo && { logo }) }));
        fixes.push({ kind: 'data', field: 'json-ld', value: 'Organization', source: 'site name, the new address and the site icon' });
      }
      if (!allTypes.has('WebSite')) {
        head.append(ldScript({ '@context': 'https://schema.org', '@type': 'WebSite', name, ...(url && { url }) }));
        fixes.push({ kind: 'data', field: 'json-ld', value: 'WebSite', source: 'site name and the new address' });
      }
    }
    if (allow('data') && root && !types.includes('FAQPage')) {
      const pairs = faqPairs(root);
      if (pairs.length >= 2) {
        head.append(ldScript({
          '@context': 'https://schema.org', '@type': 'FAQPage',
          mainEntity: pairs.map((q) => ({ '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: q.a } })),
        }));
        fixes.push({ kind: 'data', field: 'json-ld', value: `FAQPage (${pairs.length} questions)`, source: 'the questions and answers shown on the page' });
      }
    }

    // The page's own bytes with only the fixes' changes; when the parser's positions cannot place one, the whole page as cheerio
    // writes it, and the page says why (`reserialized`).
    let written = null;
    // The whole page as written: a bundled page's template carries the fixed document, and its shell's head follows it.
    const pageOf = (w) => (d.template ? syncShellHead(withTemplate(d.shell, d.template, w.html), w.html).html : w.html);
    if (!write) {
      if (!only || only.has(d.outPath)) {
        written = faithfulHtml($, d.html);
        htmlOut.set(d.outPath, pageOf(written));
      }
    } else if (fixes.length && (!only || only.has(d.outPath))) {
      originals.set(d.outPath, d.shell ?? d.html);
      written = faithfulHtml($, d.html);
      await writeFile(d.file, pageOf(written), 'utf8');
    }
    for (const f of fixes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    d.head = { title: finalTitle, description: finalDescription, canonical: own };
    result.push({ path: d.path, outPath: d.outPath, fixes, ...(d.template && { bundled: true }), ...(written && !written.faithful && { reserialized: written.why }) });
  }

  const files = only || !write ? null : await siteFiles({ dir, docs, newOrigin, siteName: name, siteUrl, fetchLlms });
  return { pages: result, files, counts, open, originals, ...(!write && { html: htmlOut }) };
}

/** The tags that name a page's own address or picture: the only head tags an address writes or moves (copy/addressPass.js). */
export const ADDRESS_TAGS = [
  { field: 'canonical', selector: 'link[rel="canonical"]', attr: 'href' },
  { field: 'og:url', selector: 'meta[property="og:url"]', attr: 'content' },
  { field: 'og:image', selector: 'meta[property="og:image"]', attr: 'content' },
  { field: 'twitter:image', selector: 'meta[name="twitter:image"], meta[property="twitter:image"]', attr: 'content' },
];

/**
 * The new site's address written into one page's head (the full fix stage and the address pass at download use this same code):
 *   - a canonical / og:url naming one of the copy's pages on the original's host moves to that page on the new site;
 *   - an og:image / twitter:image naming the original's host moves to the new site when the copy holds that very file (a picture
 *     the copy does not hold, or one given without a full address, is left as it is and listed);
 *   - a missing canonical and og:url are added (the page on the new site); a missing og:image is the original's own picture
 *     (previewPicture: a large image the page shows, else the site's logo on a 1200 × 630 card; marked for review), listed when
 *     the site has neither;
 *   - structured data (JSON-LD) that names the original's address is kept as the original wrote it, and listed.
 * Nothing else is touched. Without an address (`newOrigin` null) nothing is written or listed.
 * @param {import('cheerio').CheerioAPI} $  the page
 * @param {{ path: string, outPath: string }} page
 * @param {{ dir: string, siteHost: string, newOrigin: string|null, byPath: Map<string, string>, allow?: boolean, fixes?: object[],
 *   open?: object[], between?: () => void, pictures?: Map<string, object|null> }} o  `between` runs after the moves and before
 *   og:url is added (the full stage puts og:title / og:description there, as it always has); `fixes` / `open` are the page's
 *   lists, appended to in order; `pictures`: one per run, so the logo card is made once for the site
 * @returns {Promise<{ own: string|null, fixes: object[], open: object[] }>}  own: the page's address on the new site
 */
export async function applyAddress($, page, { dir, siteHost, newOrigin, byPath, allow = true, fixes = [], open = [], between = null, pictures = new Map() }) {
  const head = headOf($);
  const own = newOrigin ? new URL(page.path, newOrigin).href : null;
  const canonical = $('link[rel="canonical"]').first();
  if (canonical.length) {
    const moved = movedToNewSite(canonical.attr('href'), siteHost, newOrigin, byPath);
    if (moved && allow) {
      fixes.push({ kind: 'address', field: 'canonical', from: canonical.attr('href'), value: moved });
      canonical.attr('href', moved);
    }
  } else if (own && allow) {
    head.append('<link rel="canonical" href="">');
    head.find('link[rel="canonical"]').last().attr('href', own);
    fixes.push({ kind: 'head', field: 'canonical', value: own, source: 'the new address' });
  }
  const ogUrl = $('meta[property="og:url"]').first();
  if (ogUrl.length) {
    const moved = movedToNewSite(ogUrl.attr('content'), siteHost, newOrigin, byPath);
    if (moved && allow) {
      fixes.push({ kind: 'address', field: 'og:url', from: ogUrl.attr('content'), value: moved });
      ogUrl.attr('content', moved);
    }
  }
  if (newOrigin && allow) {
    for (const { field, selector, attr } of ADDRESS_TAGS.filter((t) => t.field.endsWith(':image'))) {
      const el = $(selector).first();
      const value = clean(el.attr(attr));
      if (!el.length || !value) continue;
      const moved = movedFileToNewSite(value, siteHost, newOrigin, dir);
      if (moved) {
        fixes.push({ kind: 'address', field, from: value, value: moved });
        el.attr(attr, moved);
      } else if (namesOriginal(value, siteHost)) {
        open.push({ kind: 'address', field, page: page.path, reason: 'c', detail: `The ${field} picture (${value.slice(0, 160)}) is on the original site and the copy does not hold that file, so it still names the original's address: give the page a picture of the new site` });
      } else if (!/^https?:\/\//i.test(value)) {
        open.push({ kind: 'address', field, page: page.path, reason: 'c', detail: `The ${field} picture (${value.slice(0, 160)}) is not a full address, which link previews need; it is left as the original wrote it` });
      }
    }
  }
  between?.();
  if (allow && own && !$('meta[property="og:url"]').length) {
    head.append('<meta property="og:url" content="">');
    head.find('meta[property="og:url"]').last().attr('content', own);
    fixes.push({ kind: 'head', field: 'og:url', value: own, source: 'the new address' });
  }
  if (newOrigin && allow) {
    if (!$('meta[property="og:image"]').length) {
      const picture = await previewPicture($, page, { dir, siteHost, pictures });
      if (picture) {
        const value = new URL(picture.file, `${newOrigin}/`).href;
        head.append('<meta property="og:image" content="">');
        head.find('meta[property="og:image"]').last().attr('content', value);
        fixes.push({ kind: 'head', field: 'og:image', value, source: picture.source, review: true, ...(picture.made && { file: picture.file }) });
      } else {
        open.push({ kind: 'address', field: 'og:image', page: page.path, reason: 'c', detail: 'The page has no og:image (the picture a link preview shows), and it shows no large picture and the site no logo the copy holds: the owner chooses one' });
      }
    }
    const named = $('script[type="application/ld+json"]').toArray().some((s) => namesOriginal($(s).text(), siteHost, true));
    if (named) {
      open.push({ kind: 'address', field: 'json-ld', page: page.path, reason: 'c', detail: 'The page\'s structured data (JSON-LD) still names the original site\'s address: it is kept as the original wrote it. Change it by hand if it should name the new site' });
    }
  }
  return { own, fixes, open };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does this address (or, `anywhere`, any address in this text) name the original's host? */
function namesOriginal(value, siteHost, anywhere = false) {
  const re = new RegExp(`https?:(?:\\\\?/){2}(?:www\\.)?${escapeRe(siteHost)}(?=[/:\\s"'\\\\)\\]>?#]|$)`, 'i');
  if (anywhere) return re.test(String(value ?? ''));
  try {
    return bareHost(new URL(value).hostname) === siteHost;
  } catch {
    return false;
  }
}

/** A picture on the original's host, as the same file on the new site when the copy holds it; null otherwise. */
function movedFileToNewSite(value, siteHost, newOrigin, dir) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || bareHost(u.hostname) !== siteHost) return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const file = path.resolve(dir, rel);
  if (!rel || !file.startsWith(path.resolve(dir) + path.sep)) return null;
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return new URL(`${u.pathname}${u.search}`, newOrigin).href;
}

// Link-preview pictures (og:image): only what the original itself shows. Facebook's smallest picture is 200 × 200; the card is
// the 1200 × 630 size every network shows in full.
const PREVIEW_MIN = 200;
const CARD = { width: 1200, height: 630, logo: 360 };
const RASTER = /\.(png|jpe?g|webp|gif)$/i;

/** The file of the copy a src / href names (from the page, or a full address on the original's host), or null. */
function heldFile(src, page, dir, siteHost) {
  const value = clean(src);
  if (!value || /^data:/i.test(value)) return null;
  try {
    const u = new URL(value, `http://copy.local/${page.outPath}`);
    if (u.origin !== 'http://copy.local' && !(/^https?:$/.test(u.protocol) && bareHost(u.hostname) === siteHost)) return null;
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.resolve(dir, rel);
    if (!rel || !file.startsWith(path.resolve(dir) + path.sep) || !statSync(file).isFile()) return null;
    return path.relative(dir, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}

/** Every address an <img> may load: its src, then its srcset's candidates widest first. */
function imageSources($, img) {
  const set = clean($(img).attr('srcset')).split(/,\s+/).map((c) => c.trim().split(/\s+/)).filter((c) => c[0])
    .sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0)).map((c) => c[0]);
  return [$(img).attr('src'), ...set];
}

/**
 * The picture a link preview of this page shows, from the original only (null when it has none):
 *   1. the first image the page shows that the copy holds, raster and at least 200 × 200 — used as it is;
 *   2. else the site's logo — the image or drawn <svg> in a link to the homepage, else anything named "logo", else the site's own
 *      icon (never the letter icon the copy made) — centred on a 1200 × 630 card written into the copy once for the run.
 * A drawn logo that paints in `currentColor` is painted in the page's theme-color (else near-black): the colour the header gave
 * it is not in the file, so the card is marked for review like every picture chosen here.
 * @returns {Promise<{ file: string, source: string, made?: boolean }|null>}  file: from the copy's root
 */
async function previewPicture($, page, { dir, siteHost, pictures }) {
  for (const img of $('body img').toArray()) {
    for (const src of imageSources($, img)) {
      const file = heldFile(src, page, dir, siteHost);
      if (!file || !RASTER.test(file)) continue;
      const meta = await sharp(path.join(dir, file)).metadata().catch(() => null);
      if (meta?.width >= PREVIEW_MIN && meta?.height >= PREVIEW_MIN) return { file, source: 'a picture the page itself shows' };
    }
  }
  if (!pictures.has('logo')) pictures.set('logo', await logoCard($, page, dir, siteHost));
  return pictures.get('logo');
}

/** The site's logo on a 1200 × 630 card, written into the copy (null when the site has no logo the copy holds). */
async function logoCard($, page, dir, siteHost) {
  const colour = hexColor($('meta[name="theme-color"]').attr('content') ?? '') ?? '#111827';
  const fromSvg = (el) => {
    if ($(el).find('use').length) return null; // draws a symbol defined elsewhere in the page
    const svg = $.html(el).replace(/currentColor/gi, colour);
    return Buffer.from(/\sxmlns=/.test(svg.slice(0, svg.indexOf('>'))) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'));
  };
  const fromImg = (el) => {
    const file = imageSources($, el).map((src) => heldFile(src, page, dir, siteHost)).find((f) => f && (RASTER.test(f) || /\.svg$/i.test(f)));
    return file ? readFile(path.join(dir, file)).catch(() => null) : null;
  };
  const isHome = (a) => {
    const href = clean($(a).attr('href'));
    if (!href || href.startsWith('#')) return false;
    try {
      const u = new URL(href, `http://copy.local/${page.outPath}`);
      const own = u.origin === 'http://copy.local' || bareHost(u.hostname) === siteHost;
      return own && /^\/(index\.html?)?$/i.test(u.pathname);
    } catch {
      return false;
    }
  };
  const candidates = [
    ...$('a[href]').toArray().filter(isHome).map((a) => $(a).find('img, svg').first()).filter((el) => el.length).map((el) => [el[0], 'the site\'s logo (in its link to the homepage)']),
    ...$('img[src*="logo" i], img[alt*="logo" i], img[class*="logo" i], svg[class*="logo" i], [class*="logo" i] img, [class*="logo" i] svg, [id*="logo" i] img, [id*="logo" i] svg')
      .toArray().map((el) => [el, 'the site\'s logo']),
    ...$('link[rel="apple-touch-icon" i], link[rel~="icon" i]').toArray()
      .filter((l) => !/favicon-generated/.test($(l).attr('href') ?? '')).map((el) => [el, 'the site\'s own icon']),
  ];
  for (const [el, source] of candidates) {
    const tag = el.tagName?.toLowerCase();
    const bytes = tag === 'svg' ? fromSvg(el) : await (tag === 'link' ? (() => {
      const file = heldFile($(el).attr('href'), page, dir, siteHost);
      return file && !/\.ico$/i.test(file) ? readFile(path.join(dir, file)).catch(() => null) : null;
    })() : fromImg(el));
    const card = bytes && await cardOf(bytes).catch(() => null);
    if (!card) continue;
    const file = `images/og-image-${createHash('sha256').update(card).digest('hex').slice(0, 10)}.png`;
    await mkdir(path.join(dir, 'images'), { recursive: true });
    await writeFile(path.join(dir, file), card);
    return { file, source: `${source}, on a 1200 × 630 card`, made: true };
  }
  return null;
}

/** A logo (raster or SVG bytes) centred on a 1200 × 630 card; a light logo goes on a dark card. Null when it paints nothing. */
async function cardOf(bytes) {
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height) return null;
  // An SVG is drawn at the size it ends at (sharp draws it at 72 dpi unless told), a raster is never enlarged past twice its size.
  const scale = CARD.logo / Math.max(meta.width, meta.height);
  const input = meta.format === 'svg' ? sharp(bytes, { density: Math.min(2400, Math.max(1, 72 * scale)) }) : sharp(bytes);
  const size = meta.format === 'svg' ? CARD.logo : Math.min(CARD.logo, Math.round(Math.max(meta.width, meta.height) * 2));
  const { data, info } = await input.resize(size, size, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let painted = 0;
  let light = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    painted++;
    if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 220) light++;
  }
  if (painted < 20) return null;
  // Dark only for a logo drawn light on nothing (a solid picture keeps its own background on white).
  const dark = painted < info.width * info.height && light > painted / 2;
  const logo = await sharp(data, { raw: info }).png().toBuffer();
  return sharp({ create: { width: CARD.width, height: CARD.height, channels: 3, background: dark ? '#111827' : '#ffffff' } })
    .composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
}

/** A canonical / og:url on the original's host, as the same page on the new site; null when it names something else. */
function movedToNewSite(value, siteHost, newOrigin, byPath) {
  if (!newOrigin || !value) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (bareHost(u.hostname) !== siteHost) return null;
  const p = decodeURIComponent(u.pathname);
  if (!byPath.has(p) && !byPath.has(p.replace(/\/$/, '') || '/')) return null;
  return new URL(`${u.pathname}${u.search}`, newOrigin).href;
}

const exists = (f) => stat(f).then(() => true, () => false);

/** sitemap.xml, llms.txt, robots.txt and _headers of the copy. */
async function siteFiles({ dir, docs, newOrigin, siteName, siteUrl, fetchLlms }) {
  const out = { written: [], notes: [] };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '_headers'), AS_IS_HEADERS, 'utf8');
  out.written.push('_headers');
  // The original's own llms.txt is part of the site: kept as the owner wrote it (no page asks for it, so the lift never had it).
  // Its addresses of the original name the new site when there is one; without one they stay as written, like the lifted pages.
  if (!(await exists(path.join(dir, 'llms.txt')))) {
    const origin = new URL(siteUrl).origin;
    const own = fetchLlms ? await fetchLlms(origin).catch(() => null) : null;
    if (own?.text) {
      const text = newOrigin ? withNewSite(own.text, siteUrl, newOrigin) : own.text;
      await writeFile(path.join(dir, 'llms.txt'), text, 'utf8');
      out.written.push('llms.txt');
      out.llms = newOrigin ? "the original's, naming the new site" : "the original's, as written";
    } else if (own?.tooLarge) out.notes.push("The original's llms.txt is too large to copy whole: copy it by hand.");
  }
  if (!newOrigin) {
    out.notes.push('No new-site address: sitemap.xml, robots.txt and llms.txt name no address and were left as lifted.');
    return out;
  }
  const files = await addressFiles({ dir, docs, newOrigin, siteName, siteUrl });
  const llms = out.llms ?? files.llms;
  return { ...out, ...files, written: [...new Set([...out.written, ...files.written])], ...(llms && { llms }) };
}

/** Every full address of the original's host in a text, on the new site instead (llms.txt). */
function withNewSite(text, siteUrl, newOrigin) {
  const host = escapeRe(bareHost(new URL(siteUrl).hostname));
  return text.replace(new RegExp(`https?://(?:www\\.)?${host}(?=[/\\s)\\]>"']|$)`, 'gi'), newOrigin);
}

/**
 * The site files that name the new site's address (the full fix stage and the address pass at download use this same code):
 * sitemap.xml of the copy's pages (noindex ones left out), robots.txt with the original's rules kept and its Host / Sitemap lines
 * naming the new site (written when there is none), and llms.txt: the copy's own one with the original's addresses moved to the
 * new site, else one written from the pages. Only these three files are written.
 * @param {{ dir: string, docs: { path: string, outPath: string, $: import('cheerio').CheerioAPI, head: object }[], newOrigin: string,
 *   siteName: string, siteUrl: string }} o  each doc's `head` = { title, description, canonical }
 */
export async function addressFiles({ dir, docs, newOrigin, siteName, siteUrl }) {
  const out = { written: [] };
  const generated = crawlFiles({
    pages: docs.map((d) => ({ info: { path: d.path, outPath: d.outPath }, head: { ...d.head, meta: noindexMeta(d.$) } })),
    baseUrl: newOrigin,
    siteName,
  });
  const file = (p) => generated.files.find((f) => f.path === p)?.content;
  await writeFile(path.join(dir, 'sitemap.xml'), file('sitemap.xml'), 'utf8');
  out.written.push('sitemap.xml');
  out.sitemap = generated.sitemap;
  const llmsFile = path.join(dir, 'llms.txt');
  const llms = await readFile(llmsFile, 'utf8').catch(() => null);
  if (llms == null && file('llms.txt')) {
    await writeFile(llmsFile, file('llms.txt'), 'utf8');
    out.written.push('llms.txt');
  } else if (llms != null) {
    const moved = withNewSite(llms, siteUrl, newOrigin);
    if (moved !== llms) {
      await writeFile(llmsFile, moved, 'utf8');
      out.written.push('llms.txt');
      out.llms = "the copy's own, naming the new site";
    }
  }
  // robots.txt: the original's rules are kept; its Host and Sitemap lines name the new site.
  const robotsFile = path.join(dir, 'robots.txt');
  const robots = await readFile(robotsFile, 'utf8').catch(() => null);
  if (robots == null) {
    await writeFile(robotsFile, file('robots.txt'), 'utf8');
    out.robots = 'generated';
  } else {
    let lines = robots.split(/\r?\n/)
      .map((l) => (/^\s*host\s*:/i.test(l) ? `Host: ${newOrigin}` : l))
      .filter((l) => !/^\s*sitemap\s*:/i.test(l));
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines = [...lines, `Sitemap: ${newOrigin}/sitemap.xml`, ''];
    await writeFile(robotsFile, lines.join('\n'), 'utf8');
    out.robots = 'kept, pointing at the new site';
  }
  out.written.push('robots.txt');
  return out;
}

const noindexMeta = ($) => $('meta[name]').toArray().map((m) => ({ name: $(m).attr('name'), content: $(m).attr('content') }));

const TITLE_LIMITS = [10, 60];
const DESCRIPTION_LIMITS = [50, 160];
const outside = (text, [min, max]) => text.length < min || text.length > max;
const strong = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) > 60;
};
// A selector naming a link or a button (a, button, .btn…, [role=button]).
const CONTROL_SELECTOR = /(^|[\s,>+~(])a(?=$|[\s,:.[#>+~)])|button|\bbtn\b|role=["']?button/i;

/**
 * The site's own colour for theme-color, from evidence only: its web manifest's theme_color, else its msapplication-TileColor,
 * else the strong (saturated) background colour its own stylesheets give its links and buttons most (a choice the tool made from
 * the site's colours: review). Null when there is none.
 */
async function siteThemeColor(home, dir) {
  if (!home) return null;
  const { $ } = home;
  const fileOf = (href) => {
    if (!clean(href)) return null;
    try {
      const u = new URL(href, `http://copy.local/${home.outPath}`);
      return u.origin === 'http://copy.local' ? path.join(dir, decodeURIComponent(u.pathname)) : null;
    } catch {
      return null;
    }
  };
  const manifest = fileOf($('link[rel="manifest"]').attr('href') ?? '');
  // An unreadable or invalid manifest is no evidence.
  const manifestJson = manifest ? await readFile(manifest, 'utf8').then((s) => JSON.parse(s)).catch(() => null) : null;
  const fromManifest = hexColor(String(manifestJson?.theme_color ?? ''));
  if (fromManifest) return { value: fromManifest, source: 'the site\'s web manifest (theme_color)' };
  const tile = hexColor($('meta[name="msapplication-TileColor" i]').attr('content') ?? '');
  if (tile) return { value: tile, source: 'the site\'s msapplication-TileColor' };
  let css = $('style').text();
  for (const el of $('link[rel~="stylesheet" i]').toArray()) {
    const f = fileOf($(el).attr('href') ?? '');
    if (f) css += `\n${await readFile(f, 'utf8').catch(() => '')}`;
  }
  const counts = new Map();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!CONTROL_SELECTOR.test(rule[1])) continue;
    for (const v of rule[2].matchAll(/background(?:-color)?\s*:\s*(#[0-9a-f]{3,6}\b|rgba?\([^)]*\))/gi)) {
      const hex = hexColor(v[1].replace(/\s+/g, ' '));
      if (hex && strong(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? { value: best, source: 'the colour the site\'s own stylesheets give its links and buttons most', review: true } : null;
}

/** The site's icon: its own /favicon.ico when the copy holds it, else a letter icon in its colour (review), written once. */
async function siteIcon(dir, name, colour) {
  if (await stat(path.join(dir, 'favicon.ico')).then((s) => s.isFile(), () => false)) return { file: 'favicon.ico', source: 'the site\'s own /favicon.ico' };
  const file = 'icons/favicon-generated.svg';
  await mkdir(path.join(dir, 'icons'), { recursive: true });
  await writeFile(path.join(dir, file), generatedFavicon(name, colour ?? '#334155'), 'utf8');
  return { file, type: 'image/svg+xml', source: `a letter icon (the first letter of ${name}${colour ? ' in the site\'s colour' : ''})`, review: true };
}

/** The group a fix is retried in (copy/fixRegistry.js fixGroup), exported here as before. */
export { fixGroup };

/** Puts a page's HTML back as it was lifted (its fixes were not invisible). */
export async function revertPage(dir, outPath, html) {
  await writeFile(path.join(dir, outPath), html, 'utf8');
}
