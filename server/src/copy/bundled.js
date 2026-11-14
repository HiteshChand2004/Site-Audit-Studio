// @ts-check
// Pages that carry their real document as data. A "bundled" export (one self-contained HTML file) ships a small shell — a
// loading note, a <title>, the loader script — and the page itself as a JSON string in <script type="__bundler/template">.
// On DOMContentLoaded the loader parses that string (JSON.parse) and puts the document it holds in place of the shell, so every
// head tag, landmark, label and heading a visitor's browser (or Google, Lighthouse, axe) sees comes from the template.
//
// A fix written into the shell is therefore thrown away the moment the page loads (procuredesk.panscience.ai: 16 fixes made,
// none in the page as drawn; the re-check read the original's title, description and missing lang on the copy). The copy's
// fixes are made in the template's document instead, and the shell's head is brought in line with it (for a reader that runs
// no script: a link preview, a plain crawler).
import { loadFaithful, faithfulHtml } from './faithfulHtml.js';

const TEMPLATE = /(<script\b[^>]*\btype\s*=\s*["']?__bundler\/template["']?[^>]*>)([\s\S]*?)(<\/script\s*>)/i;

/**
 * The document a bundled page draws, with where its JSON string sits in the page; null for an ordinary page.
 * @param {string} html
 * @returns {{ inner: string, start: number, end: number } | null}
 */
export function bundledTemplate(html) {
  const s = String(html ?? '');
  const m = TEMPLATE.exec(s);
  if (!m) return null;
  let inner;
  try {
    inner = JSON.parse(m[2]);
  } catch {
    return null;
  }
  if (typeof inner !== 'string' || !/<html[\s>]|<body[\s>]|<head[\s>]/i.test(inner)) return null;
  const start = m.index + m[1].length;
  return { inner, start, end: start + m[2].length };
}

/** The page with its template's document replaced by `inner`, written as the loader reads it (JSON, "</" escaped). */
export function withTemplate(html, t, inner) {
  const json = JSON.stringify(inner).replace(/<\//g, '<\\/').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `${html.slice(0, t.start)}${json}${html.slice(t.end)}`;
}

/** The HTML a browser ends up drawing for a page: the template's document of a bundled page, else the page itself. */
export function drawnHtml(html) {
  return bundledTemplate(html)?.inner ?? String(html ?? '');
}

/**
 * Where a page's head tags are: a <helmet> block that holds a <title> or <meta> (head tags the page's script moves into the
 * head when it draws the page: react-helmet, a bundled page's x-dc), else <head>.
 * @param {import('cheerio').CheerioAPI} $
 */
export function headOf($) {
  const helmet = $('helmet').filter((_, el) => $(el).children('title, meta').length > 0).first();
  return helmet.length ? helmet : $('head');
}

/** Head tags a reader that runs no script takes from the shell: kept equal to the drawn document's. */
const SHELL_TAGS = [
  ['title', (el) => 'title'],
  ['meta[name]', (el) => `meta[name="${el.attr('name')}"]`],
  ['meta[property]', (el) => `meta[property="${el.attr('property')}"]`],
  ['link[rel="canonical" i]', () => 'link[rel="canonical" i]'],
  ['link[rel~="icon" i]', () => 'link[rel~="icon" i]'],
];
const SHELL_META = /^(description|robots|theme-color|twitter:.+|og:.+)$/i;

/**
 * The shell's head brought in line with the drawn document's for what the fixes write: title, description, robots,
 * theme-color, og:* / twitter:*, canonical, icon, the JSON-LD and <html lang>. A tag the shell has gets the drawn value; one it
 * lacks is added at the end of its head. Nothing of the shell is removed (its loader, styles and loading note stay).
 * @param {string} shell  the page's HTML (its template already updated or not: only the head is touched)
 * @param {string} drawn  the drawn document after the fixes
 * @returns {{ html: string, changed: number }}
 */
export function syncShellHead(shell, drawn) {
  const $ = loadFaithful(shell);
  const $d = loadFaithful(drawn);
  const head = $('head').first();
  if (!head.length) return { html: shell, changed: 0 };
  let changed = 0;
  const drawnHead = headOf($d);
  for (const [sel, keyOf] of SHELL_TAGS) {
    drawnHead.find(sel).each((_, node) => {
      const el = $d(node);
      if (sel === 'meta[name]' && !SHELL_META.test(String(el.attr('name') ?? ''))) return;
      if (sel === 'meta[property]' && !SHELL_META.test(String(el.attr('property') ?? ''))) return;
      const mine = head.find(keyOf(el)).first();
      if (sel === 'title') {
        const text = el.text();
        if (mine.length && mine.text() === text) return;
        if (mine.length) mine.text(text);
        else head.append($('<title></title>').text(text));
        changed++;
        return;
      }
      const attrs = { ...(node.attribs ?? {}) };
      if (mine.length) {
        const differs = Object.entries(attrs).some(([k, v]) => mine.attr(k) !== v);
        if (!differs) return;
        for (const [k, v] of Object.entries(attrs)) mine.attr(k, v);
      } else head.append($d.html(el));
      changed++;
    });
  }
  // JSON-LD: the drawn document's blocks the shell does not hold word for word.
  const have = new Set(head.find('script[type="application/ld+json"]').toArray().map((n) => $(n).text().trim()));
  $d('script[type="application/ld+json"]').each((_, node) => {
    const text = $d(node).text().trim();
    if (!text || have.has(text)) return;
    head.append($d.html($d(node)));
    have.add(text);
    changed++;
  });
  const lang = $d('html').attr('lang');
  if (lang && $('html').attr('lang') !== lang) {
    $('html').attr('lang', lang);
    changed++;
  }
  return changed ? { html: faithfulHtml($, shell).html, changed } : { html: shell, changed: 0 };
}
