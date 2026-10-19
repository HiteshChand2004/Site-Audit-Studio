import * as cheerio from 'cheerio';
import { sameSite } from './util.js';

const SKIP_PROTOCOL = /^(mailto|tel|sms|javascript|data|blob|about|ftp):/i;
const wordCount = (s) => (s.match(/\S+/g) || []).length;
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function jsonLdTypes(node, out) {
  if (Array.isArray(node)) return node.forEach((n) => jsonLdTypes(n, out));
  if (!node || typeof node !== 'object') return;
  const t = node['@type'];
  if (t) (Array.isArray(t) ? t : [t]).forEach((x) => out.add(String(x)));
  if (node['@graph']) jsonLdTypes(node['@graph'], out);
  if (node.mainEntity) jsonLdTypes(node.mainEntity, out);
}

// Text of the element that answers a question heading: the next sibling, or the next sibling of
// the heading's wrapper (accordion markup often wraps the question).
function answerFor($, el) {
  let next = $(el).nextAll().filter((_, n) => !/^h[1-6]$/i.test(n.tagName)).first();
  if (!next.length) next = $(el).parent().nextAll().first();
  return clean(next.text());
}

/** Extracts the SEO/AEO-relevant facts of one HTML document. Pure: no network. */
export function extractPage(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const meta = (key) =>
    clean($(`meta[name="${key}" i]`).attr('content') ?? $(`meta[property="${key}" i]`).attr('content') ?? '') || null;
  const base = (() => {
    try {
      return new URL($('base[href]').attr('href') || pageUrl, pageUrl).toString();
    } catch {
      return pageUrl;
    }
  })();
  const resolve = (href) => {
    if (!href || SKIP_PROTOCOL.test(href.trim()) || href.trim().startsWith('#')) return null;
    try {
      const u = new URL(href.trim(), base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.hash = '';
      return u.toString();
    } catch {
      return null;
    }
  };

  const metas = $('meta')
    .map((_, el) => ({
      name: ($(el).attr('name') || $(el).attr('property') || $(el).attr('http-equiv') || '').toLowerCase(),
      content: $(el).attr('content') || '',
    }))
    .get()
    .filter((m) => m.name);

  const headings = $('h1, h2, h3, h4, h5, h6')
    .map((_, el) => ({ level: Number(el.tagName[1]), text: clean($(el).text()).slice(0, 200) }))
    .get();

  const questionHeadings = $('h2, h3, h4, summary, dt')
    .filter((_, el) => {
      const t = clean($(el).text());
      return /\?\s*$/.test(t) && t.length < 200;
    })
    .map((_, el) => {
      const q = clean($(el).text());
      const answer = el.tagName === 'summary' ? clean($(el).parent().text()).slice(q.length) : answerFor($, el);
      return { text: q, answerWords: wordCount(answer) };
    })
    .get();

  const jsonLd = $('script[type="application/ld+json" i]')
    .map((_, el) => {
      try {
        const types = new Set();
        jsonLdTypes(JSON.parse($(el).text()), types);
        return { valid: true, types: [...types] };
      } catch {
        return { valid: false, types: [] };
      }
    })
    .get();

  const links = $('a[href]')
    .map((_, el) => {
      const href = resolve($(el).attr('href'));
      return href && { href, text: clean($(el).text()).slice(0, 120), internal: sameSite(href, pageUrl) };
    })
    .get()
    .filter(Boolean);

  const images = $('img')
    .map((_, el) => ({ src: $(el).attr('src') || $(el).attr('data-src') || '', alt: $(el).attr('alt') ?? null }))
    .get();

  const assets = [
    ...$('script[src]').map((_, el) => resolve($(el).attr('src'))).get(),
    ...$('link[href]').map((_, el) => resolve($(el).attr('href'))).get(),
    ...$('img[src]').map((_, el) => resolve($(el).attr('src'))).get(),
  ].filter(Boolean);

  const mixedContent = pageUrl.startsWith('https:')
    ? $('img[src^="http:"], script[src^="http:"], iframe[src^="http:"], link[rel="stylesheet"][href^="http:"], video[src^="http:"], audio[src^="http:"]')
        .map((_, el) => $(el).attr('src') || $(el).attr('href'))
        .get()
    : [];

  const faqSignals =
    $('details > summary').length +
    $('[class*="faq" i], [id*="faq" i], [class*="accordion" i]').length +
    // A heading that titles an FAQ section ("FAQ", "Frequently asked questions"), not one that mentions FAQs
    // ("Instant FAQs & Troubleshooting" on a feature card).
    headings.filter((h) => /^\s*(faqs?|f\.a\.q\.?s?|frequently asked( questions)?)\b/i.test(h.text)).length;

  const body = $('body').clone();
  body.find('script, style, noscript, template, svg').remove();
  const text = clean(body.text());

  return {
    title: clean($('title').first().text()) || null,
    metaDescription: meta('description'),
    canonical: resolve($('link[rel="canonical" i]').attr('href')),
    robotsMeta: meta('robots'),
    lang: $('html').attr('lang')?.trim() || null,
    viewport: meta('viewport'),
    charset: Boolean($('meta[charset]').length || /charset=/i.test($('meta[http-equiv="content-type" i]').attr('content') || '')),
    themeColor: meta('theme-color'),
    favicon: Boolean($('link[rel~="icon" i], link[rel="apple-touch-icon" i]').length),
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image') },
    twitter: { card: meta('twitter:card') },
    generator: meta('generator'),
    metas,
    headings,
    questionHeadings,
    faqSignals,
    jsonLd,
    links,
    images,
    assets,
    mixedContent,
    textLength: text.length,
    wordCount: wordCount(text),
  };
}

// A client-rendered shell: almost no text or links until JavaScript runs.
export const looksLikeShell = (facts) => facts.textLength < 300 && facts.links.length < 3;

// Elements single-page apps mount into (React, Vue, Next.js, Nuxt, Gatsby, Svelte, Angular…): empty in the HTML the server sends.
const APP_ROOTS = '#root, #app, #__next, #__nuxt, #___gatsby, #svelte, [data-reactroot], [ng-version], app-root';
const NEEDS_JS = /enable javascript|requires javascript|javascript (is )?(required|disabled)|turn on javascript/i;

/**
 * Whether the HTML a server sent may not hold everything a visitor sees (links built by script), so a browser render is worth
 * it. Broader than looksLikeShell on purpose, for Recreate's page discovery, where a missed link is a missed page: when in
 * doubt, render. Site-agnostic signals only:
 *  - a shell (looksLikeShell), or almost no text whatever the links (a header with a menu around an empty body);
 *  - an app mount point that is (nearly) empty while the page has little text;
 *  - a <noscript> asking for JavaScript while the page has little text.
 * @param {{ textLength: number, links: object[] }} facts  extractPage() of the same HTML
 * @param {string} html
 */
export function looksClientRendered(facts, html) {
  if (looksLikeShell(facts) || facts.textLength < 300) return true;
  if (facts.textLength >= 2000 || !html) return false;
  const $ = cheerio.load(html);
  const emptyRoot = $(APP_ROOTS).toArray().some((el) => clean($(el).text()).length < 50);
  const askJs = $('noscript').toArray().some((el) => NEEDS_JS.test($(el).text()));
  return emptyRoot || askJs;
}
