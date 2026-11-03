// The SEO and accessibility fixes an as-is copy adds to the original's own markup beyond copy/fixAsIs.js's first ones, each
// matched to the audit that scores it, read from its source (Lighthouse 12.8.2, axe-core 4.13.0). Each one is only an attribute
// or a visually hidden text: nothing a visitor sees or does is meant to change, and preserve/check.js proves it at 375 and
// 1440 px (fixGate; for `anchors` also anchorClicks). A group that shows is dropped, reason d.
//   anchors    Lighthouse crawlable-anchors: an <a href="javascript:void(0)"> that has a name gets role="button". Its href, its
//              click and its place in the tab order stay as they were.
//   linktext   Lighthouse link-text: an English "Read more" / "Click here" link to a page of the copy gets a visually hidden
//              " about <that page's title>".
//   headings   axe heading-order: a heading that skips a level gets aria-level. The tag stays, so the original's CSS still applies.
//   lang       axe html-lang-valid: an <html lang> that is not a language code is replaced by the language the text shows.
// Only reported (changing them changes how the page looks or behaves): a link to a file: address or to one that is not an
// address, a link with no href that a script may listen to, a vague link text not in English or pointing outside the copy, a
// heading whose own aria-level skips, a missing or zoom-blocking <meta name="viewport"> (copy/fixAsIs.js).
import { createRequire } from 'node:module';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Lighthouse crawlable-anchors' test for a link that goes nowhere (core/audits/seo/crawlable-anchors.js). */
export const VOID_HREF = /javascript:void(\(|)0(\)|)/;
/** At most this many links per page get a role: the stage clicks each one on both sides, at both widths. */
export const MAX_ANCHORS = 8;
/** Lighthouse link-text's English list (core/audits/seo/link-text.js, nonDescriptiveLinkTexts.en). */
export const VAGUE_LINK_TEXT_EN = new Set(['click here', 'click this', 'go', 'here', 'information', 'learn more', 'more',
  'more info', 'more information', 'right here', 'read more', 'see more', 'start', 'this']);
/** Visually hidden text: kept in innerText and in the accessible name, drawn nowhere. */
export const VISUALLY_HIDDEN = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;'
  + 'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap';

// axe's own language list (the one html-lang-valid uses), from the axe-core that @axe-core/playwright runs: the same list the
// audit judges with, and no dependency of our own on it.
let axeUtils = null;
const axe = () => {
  axeUtils ??= createRequire(createRequire(import.meta.url).resolve('@axe-core/playwright'))('axe-core').utils;
  return axeUtils;
};

/** axe html-lang-valid: the base language (before "-", lower case) is in axe's list. */
export function isValidLang(value) {
  const base = axe().getBaseLang(String(value ?? ''));
  return base !== '' && axe().isValidLang(base);
}

/** Hidden by the markup itself (the hidden attribute or inline display:none, on it or around it); the page's CSS is not read. */
const hiddenInMarkup = ($, el) => $(el).parents().addBack().toArray()
  .some((e) => e.attribs?.hidden != null || /display:none/i.test(String(e.attribs?.style ?? '').replace(/\s+/g, '')));

/** A name a screen reader reads for the link, from the markup: its text, a label, a title, or an image's alt. */
const hasName = ($, el) => Boolean(clean($(el).text()) || clean(el.attribs['aria-label']) || clean(el.attribs['aria-labelledby'])
  || clean(el.attribs.title) || $(el).find('img[alt]').toArray().some((i) => clean(i.attribs.alt)) || $(el).find('svg title').length);

const short = (s) => clean(s).slice(0, 80);

/**
 * crawlable-anchors. The audit fails a link with no role and no name attribute whose href is javascript:void(0), file:, not an
 * address, or (with no href) has a script listening to it. Only the first is a control by its own markup: it gets role="button"
 * (it already acts as one), when it has a name (role="button" without one would fail button-name instead). The rest are reported.
 * @param {import('cheerio').CheerioAPI} $
 * @param {{ path: string, url: string }} page
 */
export function fixCrawlableAnchors($, page) {
  const fixed = [];
  const open = [];
  let noHref = 0;
  for (const el of $('body a').toArray()) {
    const a = el.attribs;
    if (clean(a.role) || clean(a.name)) continue;
    if (a.href == null) {
      noHref++;
      continue;
    }
    const raw = String(a.href).replace(/\s/g, '');
    if (VOID_HREF.test(raw)) {
      if (!hasName($, el)) open.push({ page: page.path, reason: 'c', detail: `A link to javascript:void(0) has no name: "${raw}" is left as it is` });
      else if (fixed.length >= MAX_ANCHORS) open.push({ page: page.path, reason: 'c', detail: `"${short($(el).text())}": only the first ${MAX_ANCHORS} such links of a page are changed (each is clicked to prove it)` });
      else {
        a.role = 'button';
        fixed.push({ page: page.path, tag: 'a', text: short($(el).text()) || null, field: 'role', value: 'button', from: raw });
      }
      continue;
    }
    let bad = raw.startsWith('file:');
    if (!bad && raw && !raw.startsWith('mailto:')) {
      try {
        new URL(raw, page.url);
      } catch {
        bad = true;
      }
    }
    if (bad) open.push({ page: page.path, reason: 'd', detail: `"${short($(el).text())}" links to "${raw.slice(0, 80)}", which a search engine cannot follow: changing it changes where it goes` });
  }
  if (noHref) open.push({ page: page.path, reason: 'c', detail: `${noHref} link(s) with no href: not crawlable when a script listens to them; their behaviour is the script's, so they are left as they are` });
  return { fixed, open };
}

/** A page title without the site's name ("Pricing | Acme" → "Pricing"); the title itself when that is all it says. */
export function titleWithoutSite(title, siteName) {
  const parts = clean(title).split(/\s+[|–—·:-]\s+/).map(clean).filter(Boolean);
  const site = clean(siteName).toLowerCase();
  return parts.find((p) => p.toLowerCase() !== site) ?? clean(title);
}

/**
 * link-text. The audit fails a followed link (not nofollow, not javascript: or mailto:, not this page) whose visible text is in
 * its list. A link to another page of the copy gets " about <that page's title>" as visually hidden text inside it. Only the
 * English list, on a page in English: words in another language are not written into a page.
 * @param {{ resolveLink: Function, pageTitles: Map<string, string>, siteName: string, lang: string|null }} o
 */
export function fixLinkText($, page, { resolveLink, pageTitles, siteName, lang }) {
  const fixed = [];
  const open = [];
  const english = String(lang ?? '').toLowerCase().split('-')[0] === 'en';
  for (const el of $('body a[href]').toArray()) {
    const href = String(el.attribs.href).trim();
    if (/\bnofollow\b/i.test(el.attribs.rel ?? '') || /^(javascript|mailto):/i.test(href)) continue;
    const text = clean($(el).text()).toLowerCase();
    if (!VAGUE_LINK_TEXT_EN.has(text)) continue;
    const target = resolveLink(href, page.url);
    if (target?.anchor) continue;
    const about = target?.page ? titleWithoutSite(pageTitles.get(target.page), siteName) : '';
    if (!english || !about || about.toLowerCase() === text) {
      open.push({ page: page.path, reason: 'c', detail: `"${text}" names nothing${!english ? ' (the page is not in English)' : target?.page ? '' : ' (it points outside the copy)'}: left as it is` });
      continue;
    }
    $(el).append($('<span></span>').attr('style', VISUALLY_HIDDEN).text(` about ${about}`));
    fixed.push({ page: page.path, tag: 'a', text, field: 'hidden-text', value: ` about ${about}`, source: 'the title of the page it links to' });
  }
  return { fixed, open };
}

/**
 * heading-order. axe passes the first heading and every heading at most one level below the one before it (aria-level counts
 * before the tag). Outline by the original levels, as fixers/a11y.js fixHeadings does: a heading goes one level below the nearest
 * earlier heading of a higher level, so siblings stay siblings (h1, h4, h4 → 1, 2, 2). Written as aria-level on the h1–h6;
 * a heading whose level comes from its own aria-level, or a role="heading" element, is never changed (reported when it skips).
 */
export function fixHeadingLevels($, page) {
  const fixed = [];
  const open = [];
  const stack = [];
  for (const el of $('body').find('h1, h2, h3, h4, h5, h6, [role="heading"]').toArray()) {
    const role = clean(el.attribs.role);
    if ((role && role !== 'heading') || hiddenInMarkup($, el)) continue;
    const tagLevel = /^h[1-6]$/i.test(el.name) ? Number(el.name[1]) : null;
    const own = parseInt(el.attribs['aria-level'], 10);
    const orig = own >= 1 ? own : tagLevel ?? 2;
    while (stack.length && stack.at(-1).orig >= orig) stack.pop();
    const parent = stack.at(-1);
    let level = parent ? Math.min(orig, parent.level + 1) : orig;
    if (level !== orig) {
      if (tagLevel && !(own >= 1)) {
        el.attribs['aria-level'] = String(level);
        fixed.push({ page: page.path, tag: el.name, text: short($(el).text()), field: 'aria-level', value: String(level), from: `h${orig}` });
      } else {
        open.push({ page: page.path, reason: 'c', detail: `"${short($(el).text())}" skips a heading level by its own aria-level ${orig}: left as the original says` });
        level = orig;
      }
    }
    stack.push({ orig, level });
  }
  return { fixed, open };
}

/**
 * html-lang-valid. A declared <html lang> that is not a language code (axe's list): the language the page text shows, or
 * null when the text does not say clearly. A missing lang is copy/fixAsIs.js's own fix; a valid one is never touched.
 * @returns {{ from: string, value: string|null }|null}  null: nothing to fix
 */
export function fixInvalidLang($, detected) {
  const from = clean($('html').attr('lang'));
  if (!from || isValidLang(from)) return null;
  return { from, value: detected && isValidLang(detected) ? detected : null };
}

/** Lighthouse meta-viewport: zooming blocked (user-scalable=no, or maximum-scale below 5). */
export function blocksZoom(content) {
  const c = String(content ?? '').toLowerCase();
  const max = c.match(/maximum-scale\s*=\s*([\d.]+)/);
  return /user-scalable\s*=\s*(no|0)\b/.test(c) || (max != null && parseFloat(max[1]) < 5);
}
