// @ts-check
// Makes one change on a change's folder (site.js). No model: every word comes from the request (Growth OS's reviewed draft or
// the fix), and the look comes from the site's own pages. A new page is the site's nearest page of the same kind with its main
// part replaced; the head, header, footer, styles and scripts stay the site's. Every text is escaped where it is written.
import * as cheerio from 'cheerio';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { htmlFiles, newPageFile, pageFile, readText, servedPath, writeFresh } from './site.js';
import { templateImprove, templatePage } from './fromTemplate.js';
import { allowGoogleTag as allowGoogleInPolicy } from '../deploy/tracking.js';

export class ApplyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ApplyError';
  }
}

const esc = (/** @type {string} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const load = (/** @type {string} */ html) => cheerio.load(html, {}, true);

/** The element that holds a page's own content: <main>, else role=main, else the body child with the most text. @param {cheerio.CheerioAPI} $ */
export function findMain($) {
  const main = $('main').first();
  if (main.length) return main;
  const role = $('[role="main"]').first();
  if (role.length) return role;
  let best = null;
  let most = -1;
  $('body').children().each((_, el) => {
    const tag = /** @type {any} */ (el).tagName?.toLowerCase();
    if (['header', 'nav', 'footer', 'script', 'style', 'noscript', 'template'].includes(tag)) return;
    const n = $(el).text().replace(/\s+/g, ' ').length;
    if (n > most) {
      most = n;
      best = el;
    }
  });
  return best ? $(best) : $('body');
}

/**
 * A page that holds writing (a first heading, or an article), as opposed to a tool or app screen (a designer, a dashboard, a
 * sign-in form) whose main part is the tool's own layout: an article put there is squeezed into the tool's panels.
 * @param {cheerio.CheerioAPI} $
 */
export const isContentPage = ($) => $('h1').length > 0 || $('article').length > 0;

/**
 * Puts `html` where the page's own content is, and nothing of the old content stays: <main> (or role=main) gets it as its
 * content; on a page without one (a homepage made of sections), every body part between the header and the footer is
 * replaced by one <main> holding it, so no section of the template page comes along.
 * @param {cheerio.CheerioAPI} $ @param {string} html
 */
/** The page's own top-level parts on a page without <main>: every body child but its bars (menu, footer) and code. */
function contentParts($) {
  const SKIP = new Set(['header', 'nav', 'footer', 'script', 'style', 'noscript', 'template', 'link', 'meta']);
  // The site's own bars stay (its menu, its footer). A <header> that holds a first or second heading is not a bar but the
  // page's own top banner (a "hero"), which is the template page's content and goes like the rest.
  const isBar = (el) => {
    const tag = /** @type {any} */ (el).tagName?.toLowerCase();
    const barLike = SKIP.has(tag) || /(^|\s)(site-)?(header|footer|nav|navbar|topbar)(\s|$)/i.test($(el).attr('class') ?? '');
    if (!barLike) return false;
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'link' || tag === 'meta') return true;
    return tag === 'footer' || $(el).find('h1, h2').length === 0;
  };
  return $('body').children().filter((_, el) => !isBar(el));
}

/**
 * A frame of one of the page's own parts: a copy of `part` keeping only the elements on the way from it down to `target`
 * (its wrappers, with their classes: the part's spacing, width and background), with `target` itself still in it. The old
 * words around it are gone. Null when `part` has no `sel`.
 */
function frameOf($, part, /** @type {string} */ sel) {
  const shell = $(part).clone();
  const target = shell.find(sel).first();
  if (!target.length) return null;
  // the first paragraph next to the heading: the look of a paragraph in this part
  const para = target.parent().children('p').first().clone();
  let cur = target;
  while (cur.length && cur.get(0) !== shell.get(0)) {
    cur.siblings().remove();
    cur = cur.parent();
  }
  return { shell, target, para };
}

/**
 * The draft as copies of the template page's own parts (no <main> on it): the heading and intro in a frame of its top banner,
 * each section in a frame of its first part with a second heading. Null when the page has no such parts.
 */
function framedDraft($, parts, d, { links, contact, changeId }) {
  const heroPart = parts.filter((_, el) => $(el).find('h1').length > 0).first();
  const sectionPart = parts.filter((_, el) => $(el).find('h2').length > 0 && $(el).find('h1').length === 0).first();
  if (!heroPart.length || !sectionPart.length) return null;
  const out = [];
  const hero = frameOf($, heroPart, 'h1');
  hero.target.text(d.h1 || d.title);
  if (d.intro) hero.target.after(hero.para.length ? hero.para.clone().text(d.intro) : `<p>${esc(d.intro)}</p>`);
  hero.shell.attr('data-remastly-change', changeId);
  out.push($.html(hero.shell));
  const section = (/** @type {string} */ h2, /** @type {string} */ inner) => {
    const f = /** @type {NonNullable<ReturnType<typeof frameOf>>} */ (frameOf($, sectionPart, 'h2'));
    f.shell.removeAttr('id'); // the template's anchors (#features) are not this page's
    f.target.text(h2);
    f.target.after(inner);
    return $.html(f.shell);
  };
  const p = (/** @type {string} */ text) => {
    const f = frameOf($, sectionPart, 'h2');
    return f?.para.length ? $.html(f.para.clone().text(text)) : `<p>${esc(text)}</p>`;
  };
  for (const s of d.sections) out.push(section(s.h2 || d.h1, s.body ? p(s.body) : ''));
  if (d.proof.length) out.push(section('Proof', `<ul>${d.proof.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`));
  if (d.faq.length) out.push(section('Questions', d.faq.map((f) => `<details><summary>${esc(f.q)}</summary>${p(f.a)}</details>`).join('')));
  const button = ($('a[class*="btn"], a[class*="button"], a[class*="cta"]').first().attr('class') ?? '').trim();
  const end = [
    d.cta ? `<p><a${cls(button)} href="${esc(contact ?? '/')}">${esc(d.cta)}</a></p>` : '',
    links.length ? `<ul>${links.map((l) => `<li><a href="${esc(l.path)}">${esc(l.title)}</a></li>`).join('')}</ul>` : '',
  ].join('');
  if (end) out.push(section(links.length ? 'Related' : d.cta, end));
  return out.join('\n');
}

function replaceContent($, html) {
  const main = $('main').first().length ? $('main').first() : $('[role="main"]').first();
  if (main.length) {
    main.html(html);
    return;
  }
  const parts = contentParts($);
  if (!parts.length) {
    const footer = $('body > footer').first();
    if (footer.length) footer.before(`<main>${html}</main>`);
    else $('body').append(`<main>${html}</main>`);
    return;
  }
  parts.first().replaceWith(`<main>${html}</main>`);
  parts.slice(1).remove();
}

/** A page address made from a heading: "/free-a4-label-designer-for-india". @param {string} text */
const slugFrom = (text) => `/${String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 70).replace(/-$/, '') || 'new-page'}`;

/**
 * The class of the first element matching `sel` inside `scope` (the site's own look for that kind of element), else of the
 * first one anywhere on the page (a homepage's first heading sits in its top banner, outside the content parts).
 */
const classOf = ($, scope, /** @type {string} */ sel) => (scope.find(sel).first().attr('class') ?? $('body').find(sel).first().attr('class') ?? '').trim();
const cls = (/** @type {string} */ c) => (c ? ` class="${esc(c)}"` : '');

/** Sets (or adds) a <meta name|property> in the head. */
function setMeta($, attr, key, value) {
  const el = $(`head meta[${attr}="${key}"]`).first();
  if (el.length) el.attr('content', value);
  else $('head').append(`<meta ${attr}="${esc(key)}" content="${esc(value)}">`);
}
const setMetaIfPresent = ($, attr, key, value) => {
  const el = $(`head meta[${attr}="${key}"]`).first();
  if (el.length) el.attr('content', value);
};

/** Title and description in the head (and their og: / twitter: twins where the page has them). */
function setHead($, { title, description }) {
  if (title) {
    if ($('head title').length) $('head title').first().text(title);
    else $('head').prepend(`<title>${esc(title)}</title>`);
    setMetaIfPresent($, 'property', 'og:title', title);
    setMetaIfPresent($, 'name', 'twitter:title', title);
  }
  if (description) {
    setMeta($, 'name', 'description', description);
    setMetaIfPresent($, 'property', 'og:description', description);
    setMetaIfPresent($, 'name', 'twitter:description', description);
  }
}

/** Points the page's own address fields (canonical, og:url) at a new path, keeping their origin. */
function setAddress($, servedAt) {
  const swap = (/** @type {string | undefined} */ v) => {
    if (!v) return v;
    try {
      const u = new URL(v);
      return `${u.origin}${servedAt}`;
    } catch {
      return servedAt;
    }
  };
  $('head link[rel="canonical"]').each((_, el) => { $(el).attr('href', swap($(el).attr('href'))); });
  $('head meta[property="og:url"]').each((_, el) => { $(el).attr('content', swap($(el).attr('content'))); });
  $('head link[rel="alternate"][hreflang]').remove(); // the template's language twins are not this page's
}

/** Structured data that describes the template page (an article, a product, its FAQ) is not this page's; the site's own stays. */
function dropPageData($) {
  $('script[type="application/ld+json"]').each((_, el) => {
    let keep = false;
    try {
      const data = JSON.parse($(el).html() ?? '');
      const types = [data, ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])].map((d) => String(d?.['@type'] ?? ''));
      keep = types.length > 0 && types.every((t) => /^(Organization|WebSite|LocalBusiness|Corporation)$/.test(t));
    } catch {}
    if (!keep) $(el).remove();
  });
}

/** The site's contact page, if it has one (where a call to action leads). @param {string[]} files */
const contactPath = (files) => {
  const f = files.find((r) => /(^|\/)(contact|contact-us|get-in-touch|talk-to-us|demo|book-a-demo)(\/index)?\.html?$/i.test(r));
  return f ? servedPath(f) : null;
};

/** The draft as the content of the main part, in the site's own classes. */
function draftHtml($, main, d, { links, contact, changeId }) {
  const h1 = classOf($, main, 'h1');
  const h2 = classOf($, main, 'h2');
  const p = classOf($, main, 'p');
  const button = (main.find('a[class*="btn"], a[class*="button"], a[class*="cta"]').first().attr('class') ?? '').trim();
  const container = (main.find('div[class*="container"], div[class*="wrapper"], div[class*="inner"], div[class*="max-w"]').first().attr('class') ?? '').trim();
  const out = [];
  if (d.h1 || d.title) out.push(`<h1${cls(h1)}>${esc(d.h1 || d.title)}</h1>`);
  if (d.intro) out.push(`<p${cls(p)}>${esc(d.intro)}</p>`);
  for (const s of d.sections) out.push(`<section>${s.h2 ? `<h2${cls(h2)}>${esc(s.h2)}</h2>` : ''}${s.body ? `<p${cls(p)}>${esc(s.body)}</p>` : ''}</section>`);
  if (d.proof.length) out.push(`<section><h2${cls(h2)}>Proof</h2><ul>${d.proof.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`);
  if (d.faq.length) out.push(`<section><h2${cls(h2)}>Questions</h2>${d.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p${cls(p)}>${esc(f.a)}</p></details>`).join('')}</section>`);
  if (d.cta) out.push(`<p><a${cls(button)} href="${esc(contact ?? '/')}">${esc(d.cta)}</a></p>`);
  if (links.length) out.push(`<nav aria-label="Related pages"><h2${cls(h2)}>Related</h2><ul>${links.map((l) => `<li><a href="${esc(l.path)}">${esc(l.title)}</a></li>`).join('')}</ul></nav>`);
  const body = out.join('\n');
  return `<div data-remastly-change="${esc(changeId)}"${container ? ` class="${esc(container)}"` : ''}>\n${body}\n</div>`;
}

/**
 * The page of the site most like the one to make: a sibling in the same folder, a page it links to, else the fullest page,
 * else the homepage. Only pages that hold writing qualify: a tool screen or a notice page is never a template.
 */
async function pickTemplate(root, files, page, internalLinks) {
  const pages = files.filter((f) => !/(^|\/)404\.html$/i.test(f));
  /** @type {Map<string, boolean>} */
  const known = new Map();
  const usable = async (/** @type {string} */ f) => {
    if (!known.has(f)) {
      const html = await readText(root, f).catch(() => '');
      known.set(f, Boolean(html) && !/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html) && isContentPage(load(html)));
    }
    return known.get(f);
  };
  const parent = page.replace(/^\/+/, '').replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  if (parent) {
    for (const f of pages.filter((x) => x.startsWith(`${parent}/`) && x !== `${parent}/index.html`)) if (await usable(f)) return f;
    if (pages.includes(`${parent}/index.html`) && (await usable(`${parent}/index.html`))) return `${parent}/index.html`;
  }
  for (const l of internalLinks) {
    const f = await pageFile(root, l);
    if (f && f !== 'index.html' && (await usable(f))) return f;
  }
  let best = null;
  let most = -1;
  for (const f of pages.slice(0, 200)) {
    if (f === 'index.html' || !(await usable(f))) continue;
    const html = await readText(root, f).catch(() => '');
    const n = (html.match(/<p[\s>]/gi) ?? []).length;
    if (n > most) {
      most = n;
      best = f;
    }
  }
  if (best) return best;
  if (pages.includes('index.html')) return 'index.html'; // the homepage: always the site's own look
  return pages[0] ?? null;
}

/** Adds a page to sitemap.xml when the site has one (its address beside the others'). */
async function addToSitemap(root, servedAt) {
  const file = path.join(root, 'sitemap.xml');
  const xml = await readText(root, 'sitemap.xml').catch(() => null);
  if (!xml || !/<\/urlset>/i.test(xml)) return false;
  const loc = xml.match(/<loc>\s*(https?:\/\/[^/<\s]+)/i);
  const full = `${loc ? loc[1] : ''}${servedAt}`;
  if (xml.includes(`<loc>${full}</loc>`)) return false;
  await writeFresh(file, xml.replace(/<\/urlset>/i, `  <url><loc>${esc(full)}</loc></url>\n</urlset>`));
  return true;
}

/** The title of a page of the site (for a related link). */
async function titleOf(root, rel) {
  const html = await readText(root, rel).catch(() => '');
  const $ = load(html);
  return ($('h1').first().text() || $('title').first().text() || servedPath(rel)).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * A new page at `page`: the nearest page of the site that holds writing, with its whole content area replaced by the draft.
 * @returns {Promise<{ page: string, file: string, files: string[], notes: string[], expect: string[], beforeFile: null }>}
 */
async function createPage(change, root, files, page, notes) {
  const d = change.draft;
  const existing = await pageFile(root, page);
  if (existing) throw new ApplyError(`A page already answers at ${page} (${existing}). Send it as "page.improve" to change that page instead of adding a second one.`);
  const rel = newPageFile(page);
  if ((await stat(path.join(root, rel)).catch(() => null))) throw new ApplyError(`${rel} already exists.`);
  const servedAt = servedPath(rel);

  // First choice: the site's own template for this kind of page (pages of the same folder), worked out from two of them and
  // filled with the draft: the page is the site's design to the element, only the words are the draft's (fromTemplate.js).
  const made = await templatePage(root, page, withSearches(change));
  // no kind and the homepage could not be the template: why, then the frames way below
  if (made && !made.$ && made.why) notes.push(`${made.why} The draft went into the frames of the site's page instead.`);
  if (made?.$) {
    const $t = made.$;
    setHead($t, { title: d.title || d.h1, description: d.metaDescription });
    setAddress($t, servedAt);
    dropPageData($t);
    $t('body').attr('data-remastly-change', change.id);
    await writeFresh(path.join(root, rel), $t.html());
    const written = [rel];
    if (await addToSitemap(root, servedAt)) written.push('sitemap.xml');
    if (!made.single) notes.push(`Made with the site's own template for ${made.kind.folder} pages (worked out from ${made.from.join(' and ')}): the design is theirs, only the words are ${made.by.ai ? 'written by the AI from the draft' : 'the draft\'s'}.`);
    notes.push(...made.notes);
    const skipped = made.missing.length;
    if (skipped) notes.push(`${skipped} part(s) of the template were left out because the draft has nothing for them (another page's picture or words are never copied).`);
    if (d.numbersToCheck.length) notes.push(`Numbers for a person to check: ${d.numbersToCheck.join(', ')}.`);
    return { page: servedAt, file: rel, files: written, notes, expect: [made.heading || d.h1 || d.title].filter(Boolean), beforeFile: null, template: { folder: made.kind.folder, from: made.from, ...(made.single && { single: true }) }, by: made.by, neighbour: made.from[0] };
  }

  const template = await pickTemplate(root, files, page, d.internalLinks);
  if (!template) throw new ApplyError('No page of the site to build the new page from.');
  const $ = load(await readText(root, template));
  const links = [];
  for (const l of d.internalLinks) {
    const f = await pageFile(root, l);
    if (f) links.push({ path: servedPath(f), title: await titleOf(root, f) });
    else notes.push(`Left out a related link to ${l}: the site has no such page.`);
  }
  // A page without <main> (a homepage made of parts): the draft goes into frames of its own parts, so it gets their spacing,
  // widths and backgrounds. Else the site's classes are read from the template's content, and that content is replaced whole.
  const ctx = { links, contact: contactPath(files), changeId: change.id };
  const hasMain = $('main').length > 0 || $('[role="main"]').length > 0;
  const parts = hasMain ? null : contentParts($);
  const framed = parts?.length ? framedDraft($, parts, d, ctx) : null;
  if (framed) {
    parts.first().replaceWith(framed);
    parts.slice(1).remove();
  } else replaceContent($, draftHtml($, findMain($), d, ctx));
  setHead($, { title: d.title || d.h1, description: d.metaDescription });
  setAddress($, servedAt);
  dropPageData($);
  await writeFresh(path.join(root, rel), $.html());
  const written = [rel];
  if (await addToSitemap(root, servedAt)) written.push('sitemap.xml');
  notes.push(`Built from the site's page ${servedPath(template)} (its header, footer and styles).`);
  if (d.numbersToCheck.length) notes.push(`Numbers for a person to check: ${d.numbersToCheck.join(', ')}.`);
  return { page: servedAt, file: rel, files: written, notes, expect: [d.h1 || d.title].filter(Boolean), beforeFile: null, neighbour: servedPath(template), by: { ai: false } };
}

/** The draft with the searches it answers (Growth OS sends them beside it), for the AI. */
const withSearches = (/** @type {any} */ change) => ({ ...change.draft, targetSearches: change.context?.searches ?? [] });

const GA_FILE = 'remastly-ga4.js';

/** Lets the site's own security policy (_headers) load and send to Google's tag. */
async function allowGoogleTag(root) {
  const text = await readText(root, '_headers').catch(() => null);
  if (!text || !/Content-Security-Policy/i.test(text)) return false;
  const next = allowGoogleInPolicy(text);
  if (next === text) return false;
  await writeFresh(path.join(root, '_headers'), next);
  return true;
}

/**
 * Makes the change. Returns what it wrote and what to look for afterwards.
 * @param {{ id: string, type: string, page: string | null, draft: any, fix: any }} change
 * @param {string} root  the change's own folder (site.js changeSiteDir)
 * @returns {Promise<{ page: string | null, file: string | null, files: string[], notes: string[], expect: string[], beforeFile: string | null, redirectedFrom?: string }>}
 *   page: the path the change is seen at; expect: texts that must be on the page once its scripts ran; beforeFile: the file as it
 *   was (null for a new page), read by the checks from the base folder
 */
export async function applyChange(change, root) {
  const { type, draft: d, fix } = change;
  const files = await htmlFiles(root);
  if (!files.length) throw new ApplyError('The copy has no pages.');
  /** @type {string[]} */
  const notes = [];

  if (type === 'tracking.ga4') {
    const id = fix.measurementId;
    const script = `// Google tag (${id}), added by Remastly for Growth OS.\nwindow.dataLayer = window.dataLayer || [];\nfunction gtag(){ dataLayer.push(arguments); }\ngtag('js', new Date());\ngtag('config', '${id}');\n`;
    await writeFresh(path.join(root, GA_FILE), script);
    const written = [GA_FILE];
    let already = 0;
    for (const rel of files) {
      const html = await readText(root, rel);
      if (html.includes(`gtag/js?id=${id}`)) {
        already++;
        continue;
      }
      const $ = load(html);
      if (!$('head').length) continue;
      $('head').append(`<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(id)}"></script><script src="/${GA_FILE}"></script>`);
      await writeFresh(path.join(root, rel), $.html());
      written.push(rel);
    }
    if (await allowGoogleTag(root)) {
      written.push('_headers');
      notes.push('The site\'s security policy (_headers) now allows Google\'s tag.');
    }
    if (already) notes.push(`${already} page(s) already had this tag.`);
    notes.push('Visits reach Google Analytics only on the live site (previews block outside scripts).');
    const home = files.includes('index.html') ? 'index.html' : files[0];
    return { page: servedPath(home), file: home, files: written, notes, expect: [], beforeFile: home };
  }

  if (type === 'page.create') return createPage(change, root, files, /** @type {string} */ (change.page), notes);

  const page = /** @type {string} */ (change.page);
  const rel = await pageFile(root, page);
  if (!rel) throw new ApplyError(`The site has no page at ${page}.`);
  const $ = load(await readText(root, rel));
  /** @type {string[]} */
  const expect = [];

  if (type === 'page.improve' && !isContentPage($)) {
    // A tool or app screen (no first heading, no article): the draft's words would be squeezed into the tool's own layout.
    // The draft becomes a page of its own instead, at its own address; the tool page is left as it is.
    // An improve draft's own address is usually the tool page's ("/app.html" written as "/app-html"): then the address is made
    // from the draft's heading instead.
    const same = (/** @type {string} */ a) => a.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').replace(/-html?$/, '');
    let target = d.slug && d.slug !== '/' && same(d.slug) !== same(page) ? d.slug : slugFrom(d.h1 || d.title || 'new page');
    if (await pageFile(root, target)) target = slugFrom(d.h1 || d.title || 'new page');
    if (await pageFile(root, target)) throw new ApplyError(`${page} is a tool screen, not a page with writing, and a page already answers at ${target}. Send the draft as a new page with an address of its own.`);
    notes.push(`${page} is a tool screen (no first heading, no article), so the draft was not put into it: it became a new page at ${target} instead. ${page} is unchanged.`);
    const made = await createPage(change, root, files, target, notes);
    return { ...made, redirectedFrom: page };
  }

  if (type === 'page.improve') {
    // A page of a kind (one of several made by one template): made again by that template, its own content kept where the
    // draft does not change it, the draft's sections and questions in the template's own lists. Needs the AI.
    const again = await templateImprove(root, servedPath(rel), withSearches(change));
    if (again) {
      const $t = again.$;
      setHead($t, { title: d.title, description: d.metaDescription });
      $t('body').attr('data-remastly-change', change.id);
      await writeFresh(path.join(root, rel), $t.html());
      notes.push(`Made again with the site's own template for ${again.kind.folder} pages: the design is theirs; the AI kept the page's own content and put the draft's changes into it.`);
      notes.push(...again.notes);
      if (d.changes.length) notes.push(...d.changes.map((c) => `Asked in the draft: ${c}`));
      if (d.numbersToCheck.length) notes.push(`Numbers for a person to check: ${d.numbersToCheck.join(', ')}.`);
      return { page: servedPath(rel), file: rel, files: [rel], notes, expect: [again.heading || d.h1].filter(Boolean), beforeFile: rel, template: { folder: again.kind.folder, from: again.from }, by: again.by, neighbour: again.from[1] };
    }
    setHead($, { title: d.title, description: d.metaDescription });
    if (d.h1) {
      const h = $('h1').first();
      // Only what was written is looked for afterwards (the "still there" check).
      if (h.length) {
        h.text(d.h1);
        expect.push(d.h1);
      } else notes.push('The page has no first heading to change.');
    }
    const main = findMain($);
    const addition = { ...d, h1: '', title: '', intro: '', cta: '' };
    const extra = addition.sections.length || addition.faq.length || addition.proof.length;
    if (extra) {
      const links = [];
      for (const l of d.internalLinks) {
        const f = await pageFile(root, l);
        if (f && servedPath(f) !== servedPath(rel)) links.push({ path: servedPath(f), title: await titleOf(root, f) });
      }
      main.append(draftHtml($, main, addition, { links, contact: null, changeId: change.id }));
      const first = addition.sections[0]?.h2;
      if (first) expect.push(first);
    }
    if (d.changes.length) notes.push(...d.changes.map((c) => `Asked in the draft: ${c}`));
    if (d.numbersToCheck.length) notes.push(`Numbers for a person to check: ${d.numbersToCheck.join(', ')}.`);
  } else if (type === 'meta.title') {
    setHead($, { title: fix.title, description: '' });
  } else if (type === 'meta.description') {
    setHead($, { title: '', description: fix.description });
  } else if (type === 'image.alt') {
    for (const item of fix.items) {
      let n = 0;
      $('img').each((_, el) => {
        const src = `${$(el).attr('src') ?? ''} ${$(el).attr('srcset') ?? ''}`;
        if (src.includes(item.src)) {
          $(el).attr('alt', item.alt);
          n++;
        }
      });
      if (!n) notes.push(`No picture on the page has "${item.src}" in its address.`);
    }
  } else if (type === 'form.shorten') {
    for (const name of fix.remove) {
      const fields = $('form').find(`[name="${name}"]`);
      if (!fields.length) {
        notes.push(`No form field named "${name}" on the page.`);
        continue;
      }
      fields.each((_, el) => {
        const field = $(el);
        const id = field.attr('id');
        if (id) $(`label[for="${id}"]`).remove();
        // the wrapper that holds only this field (its label, its hint) goes with it; never the form itself
        let node = field;
        while (node.parent().length && !node.parent().is('form') && node.parent().find('input, select, textarea').length === 1) node = node.parent();
        node.remove();
      });
    }
  } else {
    throw new ApplyError(`Unknown change "${type}".`);
  }
  await writeFresh(path.join(root, rel), $.html());
  return { page: servedPath(rel), file: rel, files: [rel], notes, expect, beforeFile: rel };
}
