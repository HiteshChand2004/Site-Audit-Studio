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
// Not here (they change pixels or behaviour, reason d): contrast, font subsets, sprite / layout parking, longer-or-shorter-only
// title rewrites, dead-link unlinking, LCP entrance removal; images (only when the pixels stay the same: not yet).
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
 * @returns {Promise<{ pages: object[], files: object, counts: Record<string, number>, open: object[], originals: Map<string, string> }>}
 *   originals: outPath → the page's HTML before its fixes (for a revert)
 */
export async function fixAsIsCopy({ dir, pages, siteUrl, newSiteUrl = null, siteName = null }) {
  const siteHost = bareHost(new URL(siteUrl).hostname);
  const newOrigin = newSiteUrl ? new URL(newSiteUrl).origin : null;
  const docs = [];
  for (const p of pages) {
    const file = path.join(dir, p.outPath);
    const html = await readFile(file, 'utf8').catch(() => null);
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
  const counts = { alt: 0, names: 0, aria: 0, head: 0, data: 0, address: 0, lang: 0 };
  const originals = new Map();

  for (const d of docs) {
    const { $ } = d;
    const fixes = [];
    const body = $('body').get(0);
    const root = body ? adapt($, body) : null;
    resetTextCache();
    if (root) {
      const tree = { root, info: { path: d.path, url: d.url, outPath: d.outPath } };
      const alt = fixAlt(tree);
      for (const f of [...alt.fixed, ...alt.decorative]) fixes.push({ kind: 'alt', ...f });
      const names = fixNames(tree, { pageUrl: d.url, resolveLink, pageTitles, siteName: name });
      for (const f of names.fixed) fixes.push({ kind: 'names', ...f });
      open.push(...names.open.map((o) => ({ kind: 'names', reason: 'c', ...o })));
      const aria = fixAria(tree, { asIs: true });
      for (const f of aria.fixed) fixes.push({ kind: 'aria', ...f });
      open.push(...aria.open.map((o) => ({ kind: 'aria', ...o })));
    }

    // Head: only what is missing or duplicated.
    const head = $('head');
    const h1 = clean($('body h1').first().text()) || clean($('body h2').first().text());
    const titleEl = $('title').first();
    const title = clean(titleEl.text());
    const titleKey = title.toLowerCase();
    let finalTitle = title;
    if (!title || seenTitle.has(titleKey)) {
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
    if (!description || seenDescription.has(description.toLowerCase())) {
      const own = paragraphsOf($).filter((t) => !seenDescription.has(t.toLowerCase()));
      const fresh = fitDescription(own);
      if (fresh && fresh.length >= 50 && !seenDescription.has(fresh.toLowerCase())) {
        if (!descEl.length) head.append('<meta name="description" content="">');
        head.find('meta[name="description"]').first().attr('content', fresh);
        fixes.push({ kind: 'head', field: 'description', from: description || null, value: fresh, source: description ? 'duplicate of another page' : 'the page\'s own paragraphs' });
        finalDescription = fresh;
      }
    }
    if (finalDescription) seenDescription.add(finalDescription.toLowerCase());

    // Addresses: a canonical / og:url naming the original moves to the new site; a missing one is added (only with an address).
    const own = newOrigin ? new URL(d.path, newOrigin).href : null;
    const canonical = $('link[rel="canonical"]').first();
    if (canonical.length) {
      const moved = movedToNewSite(canonical.attr('href'), siteHost, newOrigin, byPath);
      if (moved) {
        fixes.push({ kind: 'address', field: 'canonical', from: canonical.attr('href'), value: moved });
        canonical.attr('href', moved);
      }
    } else if (own) {
      head.append('<link rel="canonical" href="">');
      head.find('link[rel="canonical"]').last().attr('href', own);
      fixes.push({ kind: 'head', field: 'canonical', value: own, source: 'the new address' });
    }
    const ogUrl = $('meta[property="og:url"]').first();
    if (ogUrl.length) {
      const moved = movedToNewSite(ogUrl.attr('content'), siteHost, newOrigin, byPath);
      if (moved) {
        fixes.push({ kind: 'address', field: 'og:url', from: ogUrl.attr('content'), value: moved });
        ogUrl.attr('content', moved);
      }
    }
    const og = (prop, value, source) => {
      if (!value || $(`meta[property="${prop}"]`).length) return;
      head.append(`<meta property="${prop}" content="">`);
      head.find(`meta[property="${prop}"]`).last().attr('content', value);
      fixes.push({ kind: 'head', field: prop, value, source });
    };
    og('og:title', finalTitle, 'the page title');
    og('og:description', finalDescription, 'the page description');
    og('og:url', own, 'the new address');

    const html = $('html');
    if (!clean(html.attr('lang'))) {
      const lang = detectLang($('body').text());
      if (lang) {
        html.attr('lang', lang);
        fixes.push({ kind: 'lang', field: 'lang', value: lang, source: 'the page text' });
      } else open.push({ kind: 'lang', page: d.path, reason: 'c', detail: 'The page declares no language and its text does not say clearly' });
    }

    // Structured data.
    const types = jsonLdTypes($);
    if (d === docs[0]) {
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
    if (root && !types.includes('FAQPage')) {
      const pairs = faqPairs(root);
      if (pairs.length >= 2) {
        head.append(ldScript({
          '@context': 'https://schema.org', '@type': 'FAQPage',
          mainEntity: pairs.map((q) => ({ '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: q.a } })),
        }));
        fixes.push({ kind: 'data', field: 'json-ld', value: `FAQPage (${pairs.length} questions)`, source: 'the questions and answers shown on the page' });
      }
    }

    if (fixes.length) {
      originals.set(d.outPath, d.html);
      await writeFile(d.file, $.html(), 'utf8');
    }
    for (const f of fixes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    d.head = { title: finalTitle, description: finalDescription, canonical: own };
    result.push({ path: d.path, outPath: d.outPath, fixes });
  }

  const files = await siteFiles({ dir, docs, newOrigin, siteName: name });
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
async function siteFiles({ dir, docs, newOrigin, siteName }) {
  const out = { written: [], notes: [] };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '_headers'), AS_IS_HEADERS, 'utf8');
  out.written.push('_headers');
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

/** Puts a page's HTML back as it was lifted (its fixes were not invisible). */
export async function revertPage(dir, outPath, html) {
  await writeFile(path.join(dir, outPath), html, 'utf8');
}
