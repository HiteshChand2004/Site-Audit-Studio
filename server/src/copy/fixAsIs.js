// The safe fixes of an as-is copy (docs/COPY-MY-SITE.md §2): what can be corrected in the original's own markup without changing
// how a page looks or behaves. They run on the lifted HTML files, after the link pass and before packaging, so every stack gets
// them. The rules are the ones the clean rebuild uses (recreate/fixers, ir/seoText, ir/aeo, ir/crawlFiles): the lifted document
// is given to them through a thin adapter whose elements share the parsed element's attributes, so a fixer's change is a change
// to the markup. Only what is missing, empty, duplicated or invalid is touched; nothing the original states correctly is rewritten.
//   alt          <img> without alt (fixAlt)
//   names        links, buttons and fields without an accessible name (fixNames)
//   aria         frame titles, positive tabindex, invalid ARIA values, focusable inside aria-hidden (fixAria, asIs: duplicate
//                ids are reported, never renamed — the original's styles and scripts may use them)
//   head         a missing or duplicated title or description; a missing canonical / og:title / og:description / og:url; a
//                canonical or og:url naming the original moved to the new site; a missing <html lang>
//   data         JSON-LD Organization + WebSite on the homepage when no page has them; FAQPage where the page shows questions
//                with their answers and has none
//   files        sitemap.xml, llms.txt (when the copy has none), robots.txt kept but pointing at the new site, _headers
//   anchors, linktext, headings, and an invalid <html lang>: copy/seoA11yAsIs.js (role="button" on javascript:void(0) links,
//                visually hidden text in vague links, aria-level on skipped headings)
//   lcp, lazy, webp  copy/perfAsIs.js, from what the browser measured (`perf`): fetchpriority on the largest image, loading="lazy"
//                below the first screen at every width, a lossless WebP for a local PNG with the very same pixels
// A description is also taken from the page's own og:description / twitter:description when its paragraphs give none. A missing
// or zoom-blocking <meta name="viewport"> is reported, never changed: adding or loosening one changes how phones lay out the page.
// Not here (they change pixels or behaviour, reason d): contrast, font subsets, sprite / layout parking, longer-or-shorter-only
// title rewrites, dead-link unlinking, LCP entrance removal; lossy or resized images, font-display, the original's scripts.
// Every page's fixes are listed; the stage then proves them invisible (preserve/check.js fixGate) and reverts a page's fixes
// when they are not.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fixAlt, fixNames } from '../recreate/fixers/a11y.js';
import { fixAria } from '../recreate/fixers/aria.js';
import { fitTitle, fitDescription, pathLabel, detectLang } from '../recreate/ir/seoText.js';
import { faqPairs } from '../recreate/ir/aeo.js';
import { crawlFiles } from '../recreate/ir/crawlFiles.js';
import { resetTextCache } from '../recreate/ir/tree.js';
import { HEADERS_FILE as CACHE_HEADERS } from '../recreate/behavior/preserve/pack.js';
import { blocksZoom, fixCrawlableAnchors, fixHeadingLevels, fixInvalidLang, fixLinkText, isValidLang } from './seoA11yAsIs.js';
import { fixImageLoading, fixPngImages } from './perfAsIs.js';
import { SECURITY_HEADERS } from './securityHeaders.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
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
 * @returns {Promise<{ pages: object[], files: object, counts: Record<string, number>, open: object[], originals: Map<string, string> }>}
 *   originals: outPath → the page's HTML before its fixes (for a revert)
 */
export async function fixAsIsCopy({ dir, pages, siteUrl, newSiteUrl = null, siteName = null, fetchLlms = null, readDir = null, only = null, perf = null }) {
  const siteHost = bareHost(new URL(siteUrl).hostname);
  const newOrigin = newSiteUrl ? new URL(newSiteUrl).origin : null;
  const docs = [];
  for (const p of pages) {
    const file = path.join(dir, p.outPath);
    const html = await readFile(path.join(readDir ?? dir, p.outPath), 'utf8').catch(() => null);
    if (html == null) continue;
    docs.push({ ...p, file, html, $: cheerio.load(html) });
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
  const counts = { alt: 0, names: 0, aria: 0, head: 0, data: 0, address: 0, lang: 0, anchors: 0, linktext: 0, headings: 0, lcp: 0, lazy: 0, webp: 0 };
  const originals = new Map();
  // One WebP per PNG for the whole run, however many pages show it.
  const webpMade = new Map();

  for (const d of docs) {
    const { $ } = d;
    const fixes = [];
    const body = $('body').get(0);
    const root = body ? adapt($, body) : null;
    // The page's text before any fix adds to it (a link's hidden text), so the language read from it is the same in a retry.
    const bodyText = $('body').text();
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
      const more = [
        ['anchors', () => fixCrawlableAnchors($, d)],
        ['linktext', () => fixLinkText($, d, { resolveLink, pageTitles, siteName: name, lang: pageLang })],
        ['headings', () => fixHeadingLevels($, d)],
      ];
      for (const [kind, run] of more) {
        if (!allow(kind)) continue;
        const r = run();
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

    // Head: only what is missing or duplicated.
    const head = $('head');
    const h1 = clean($('body h1').first().text()) || clean($('body h2').first().text());
    const titleEl = $('title').first();
    const title = clean(titleEl.text());
    const titleKey = title.toLowerCase();
    let finalTitle = title;
    if (allow('head:title') && (!title || seenTitle.has(titleKey))) {
      const fresh = fitTitle(h1 && h1.toLowerCase() !== titleKey ? h1 : pathLabel(d.path) || h1, name);
      if (fresh && !seenTitle.has(fresh.toLowerCase())) {
        if (!titleEl.length) head.prepend('<title></title>');
        head.find('title').first().text(fresh);
        fixes.push({ kind: 'head', field: 'title', from: title || null, value: fresh, source: title ? 'duplicate of another page' : 'missing' });
        finalTitle = fresh;
      }
    }
    seenTitle.add(finalTitle.toLowerCase());
    const descEl = $('meta[name="description"]').first();
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
        if (!descEl.length) head.append('<meta name="description" content="">');
        head.find('meta[name="description"]').first().attr('content', fresh);
        fixes.push({ kind: 'head', field: 'description', from: description || null, value: fresh, source: description ? 'duplicate of another page' : from });
        finalDescription = fresh;
      }
    }
    if (finalDescription) seenDescription.add(finalDescription.toLowerCase());

    // Addresses: a canonical / og:url naming the original moves to the new site; a missing one is added (only with an address).
    const own = newOrigin ? new URL(d.path, newOrigin).href : null;
    const canonical = $('link[rel="canonical"]').first();
    if (canonical.length) {
      const moved = movedToNewSite(canonical.attr('href'), siteHost, newOrigin, byPath);
      if (moved && allow('head:meta')) {
        fixes.push({ kind: 'address', field: 'canonical', from: canonical.attr('href'), value: moved });
        canonical.attr('href', moved);
      }
    } else if (own && allow('head:meta')) {
      head.append('<link rel="canonical" href="">');
      head.find('link[rel="canonical"]').last().attr('href', own);
      fixes.push({ kind: 'head', field: 'canonical', value: own, source: 'the new address' });
    }
    const ogUrl = $('meta[property="og:url"]').first();
    if (ogUrl.length) {
      const moved = movedToNewSite(ogUrl.attr('content'), siteHost, newOrigin, byPath);
      if (moved && allow('head:meta')) {
        fixes.push({ kind: 'address', field: 'og:url', from: ogUrl.attr('content'), value: moved });
        ogUrl.attr('content', moved);
      }
    }
    const og = (prop, value, source) => {
      if (!allow('head:meta') || !value || $(`meta[property="${prop}"]`).length) return;
      head.append(`<meta property="${prop}" content="">`);
      head.find(`meta[property="${prop}"]`).last().attr('content', value);
      fixes.push({ kind: 'head', field: prop, value, source });
    };
    og('og:title', finalTitle, 'the page title');
    og('og:description', finalDescription, 'the page description');
    og('og:url', own, 'the new address');

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

    if (fixes.length && (!only || only.has(d.outPath))) {
      originals.set(d.outPath, d.html);
      await writeFile(d.file, $.html(), 'utf8');
    }
    for (const f of fixes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    d.head = { title: finalTitle, description: finalDescription, canonical: own };
    result.push({ path: d.path, outPath: d.outPath, fixes });
  }

  const files = only ? null : await siteFiles({ dir, docs, newOrigin, siteName: name, siteUrl, fetchLlms });
  return { pages: result, files, counts, open, originals };
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
      const host = bareHost(new URL(siteUrl).hostname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const text = newOrigin ? own.text.replace(new RegExp(`https?://(?:www\\.)?${host}(?=[/\\s)\\]>"']|$)`, 'gi'), newOrigin) : own.text;
      await writeFile(path.join(dir, 'llms.txt'), text, 'utf8');
      out.written.push('llms.txt');
      out.llms = newOrigin ? "the original's, naming the new site" : "the original's, as written";
    } else if (own?.tooLarge) out.notes.push("The original's llms.txt is too large to copy whole: copy it by hand.");
  }
  if (!newOrigin) {
    out.notes.push('No new-site address: sitemap.xml, robots.txt and llms.txt name no address and were left as lifted.');
    return out;
  }
  const generated = crawlFiles({
    pages: docs.map((d) => ({ info: { path: d.path, outPath: d.outPath }, head: { ...d.head, meta: noindexMeta(d.$) } })),
    baseUrl: newOrigin,
    siteName,
  });
  const file = (p) => generated.files.find((f) => f.path === p)?.content;
  await writeFile(path.join(dir, 'sitemap.xml'), file('sitemap.xml'), 'utf8');
  out.written.push('sitemap.xml');
  out.sitemap = generated.sitemap;
  if (!(await exists(path.join(dir, 'llms.txt'))) && file('llms.txt')) {
    await writeFile(path.join(dir, 'llms.txt'), file('llms.txt'), 'utf8');
    out.written.push('llms.txt');
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

/** The head tags that never show on the page: the canonical and og:url (added, or moved to the new site) and the og tags. */
const HEAD_META_FIELDS = new Set(['canonical', 'og:url', 'og:title', 'og:description']);

/**
 * The group a fix is retried in when its page's fixes are not invisible together (preserve/stage.js fixAndProve): its kind, but
 * the head is split three ways, because a title can show (a script that prints it) where the description and the meta tags never
 * do. A canonical or og:url moved to the new site is a head:meta fix too; it is still counted and reported as `address`. Any
 * other address rewrite keeps the group `address`.
 */
export function fixGroup(fix) {
  if (fix.kind === 'head' && fix.field === 'title') return 'head:title';
  if (fix.kind === 'head' && fix.field === 'description') return 'head:description';
  if ((fix.kind === 'head' || fix.kind === 'address') && HEAD_META_FIELDS.has(fix.field)) return 'head:meta';
  return fix.kind;
}

/** Puts a page's HTML back as it was lifted (its fixes were not invisible). */
export async function revertPage(dir, outPath, html) {
  await writeFile(path.join(dir, outPath), html, 'utf8');
}
