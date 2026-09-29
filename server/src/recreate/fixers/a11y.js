// Accessibility fixers. They run on the merged page trees (before styles and class names are
// built) and only add or correct what can be derived from the page itself; nothing is invented and
// every generated text is reported as auto-generated with its source (Phase 4a decision: heuristics
// only, no LLM).
//
// - Images without alt: title / aria-label, the caption of their <figure>, a readable file name;
//   otherwise alt="" (decorative), reported for review.
// - Links and buttons without an accessible name: the target page's title, a known service name for
//   external links, the email / phone target, or a hint in the original class, id or icon file name.
// - Form fields without a label: the placeholder or the field name.
// - Headings: one h1 per page (extra h1 become h2, a page without one gets its first heading
//   promoted) and no skipped levels (h2 → h4 becomes h2 → h3). The UA margins of the original tag
//   are written explicitly so the retagged heading renders the same.
import { deepText, isElement, isText } from '../ir/tree.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Chromium's UA margins (margin-block) of each heading at its default font size, in px. The capture
// stores margins as a diff against these values, so a missing margin means exactly this value.
const HEADING_MARGIN = { h1: '21.44px', h2: '19.92px', h3: '18.72px', h4: '21.28px', h5: '22.1776px', h6: '24.9776px' };

const SOCIAL = {
  'facebook.com': 'Facebook', 'fb.com': 'Facebook', 'instagram.com': 'Instagram', 'twitter.com': 'X (Twitter)', 'x.com': 'X (Twitter)',
  'linkedin.com': 'LinkedIn', 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'github.com': 'GitHub', 'tiktok.com': 'TikTok',
  'pinterest.com': 'Pinterest', 'dribbble.com': 'Dribbble', 'behance.net': 'Behance', 'medium.com': 'Medium', 'threads.net': 'Threads',
  'wa.me': 'WhatsApp', 'whatsapp.com': 'WhatsApp', 't.me': 'Telegram', 'discord.gg': 'Discord', 'discord.com': 'Discord',
  'vimeo.com': 'Vimeo', 'reddit.com': 'Reddit', 'mastodon.social': 'Mastodon', 'bsky.app': 'Bluesky', 'spotify.com': 'Spotify',
};

// Words in class names, ids and icon file names that say what an icon control does.
const HINTS = [
  [/(^|[-_ ])(hamburger|burger|menu|nav-?toggle|navbar-?toggler|offcanvas)([-_ ]|$)/i, 'Open menu'],
  [/(^|[-_ ])(close|dismiss)([-_ ]|$)/i, 'Close'],
  [/(^|[-_ ])search([-_ ]|$)/i, 'Search'],
  [/(^|[-_ ])(cart|basket|bag)([-_ ]|$)/i, 'Cart'],
  [/(^|[-_ ])(prev|previous|back)([-_ ]|$)/i, 'Previous'],
  [/(^|[-_ ])next([-_ ]|$)/i, 'Next'],
  [/(^|[-_ ])play([-_ ]|$)/i, 'Play'],
  [/(^|[-_ ])pause([-_ ]|$)/i, 'Pause'],
  [/(^|[-_ ])(mute|volume)([-_ ]|$)/i, 'Toggle sound'],
  [/(^|[-_ ])share([-_ ]|$)/i, 'Share'],
  [/(^|[-_ ])(account|user|profile|login)([-_ ]|$)/i, 'Account'],
  [/(^|[-_ ])(scroll-?top|back-?to-?top|to-?top)([-_ ]|$)/i, 'Back to top'],
  [/(^|[-_ ])(theme|dark-?mode)([-_ ]|$)/i, 'Toggle theme'],
  [/(^|[-_ ])(expand|more)([-_ ]|$)/i, 'Show more'],
];

const visibleSomewhere = (n) => Object.values(n.views).some((d) => !d.hidden && d.rect[2] > 0 && d.rect[3] > 0);

function walk(node, fn, ancestors = []) {
  if (!isElement(node)) return;
  fn(node, ancestors);
  const next = [...ancestors, node];
  for (const c of node.children) walk(c, fn, next);
}

/** A readable name from an image or icon URL ("team-photo@2x-abc123.png" → "Team photo"), or null. */
export function fileLabel(url) {
  let last;
  try {
    last = decodeURIComponent(new URL(url, 'http://x/').pathname.split('/').pop() ?? '');
  } catch {
    return null;
  }
  const words = last
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/@\dx/gi, '')
    .replace(/[-_.](\d+x\d+|[0-9a-f]{6,}|\d{3,})(?=$|[-_.])/gi, '')
    .split(/[-_.\s]+/)
    .filter(Boolean);
  const text = words.join(' ').toLowerCase();
  if (!/[a-z]{3,}/.test(text)) return null;
  if (/^(img|image|dsc|dscn|pic|picture|photo|screenshot|screen shot|untitled|file|download|asset|unnamed|placeholder|default|icon)( ?\d+)?$/.test(text)) return null;
  if (words.filter((w) => /\d/.test(w)).length > words.length / 2) return null;
  return cap(text);
}

function svgTitle(n) {
  if (n.tag !== 'svg' || !n.svg) return '';
  return clean(n.svg.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]) || clean(n.svg.match(/^<svg\b[^>]*\saria-label="([^"]*)"/i)?.[1]);
}

/** The accessible name a browser would compute, roughly: aria, text, title, image alt, SVG title. */
export function accessibleName(n) {
  if (clean(n.attrs['aria-label']) || clean(n.attrs['aria-labelledby'])) return clean(n.attrs['aria-label']) || 'labelled';
  const text = clean(deepText(n));
  if (text) return text;
  if (n.tag === 'input') return clean(n.attrs.value) || clean(n.attrs.alt);
  let found = '';
  walk(n, (c) => {
    if (found) return;
    if (c.tag === 'img' && clean(c.attrs.alt)) found = clean(c.attrs.alt);
    else if (c.tag === 'svg') found = svgTitle(c);
  });
  return found || clean(n.attrs.title);
}

const hintOf = (text) => HINTS.find(([re]) => re.test(text))?.[1] ?? null;

function iconFile(n) {
  let url = null;
  walk(n, (c) => {
    if (!url && c.tag === 'img') url = c.src ?? c.attrs.src ?? null;
  });
  return url;
}

/**
 * Name for a link or button without one: { value, source } or null.
 * @param {object} ctx  { pageUrl, resolveLink, pageTitles: Map<outPath, title>, siteName }
 */
function deriveName(n, ctx) {
  if (n.tag === 'a') {
    const href = n.href ?? n.attrs.href;
    let u = null;
    try {
      u = href ? new URL(href, ctx.pageUrl) : null;
    } catch {
      u = null;
    }
    if (u?.protocol === 'mailto:') return { value: `Email ${decodeURIComponent(u.pathname)}`, source: 'email address' };
    if (u?.protocol === 'tel:') return { value: `Call ${decodeURIComponent(u.pathname)}`, source: 'phone number' };
    const link = href ? ctx.resolveLink(href, ctx.pageUrl) : null;
    if (link?.page) {
      if (link.page === 'index.html') return { value: `${ctx.siteName} home`, source: 'link target (homepage)' };
      const title = ctx.pageTitles.get(link.page);
      if (title) return { value: clean(title.split(/\s+[|–—-]\s+/)[0]), source: 'link target page title' };
    }
    if (link?.anchor) {
      const id = link.anchor.slice(1);
      return { value: id === 'top' || !id ? 'Back to top' : cap(id.replace(/[-_]+/g, ' ')), source: 'link target anchor' };
    }
    if (link?.external && u) {
      const host = u.hostname.replace(/^www\./, '');
      const known = Object.entries(SOCIAL).find(([h]) => host === h || host.endsWith(`.${h}`))?.[1];
      return { value: known ?? host, source: known ? 'link target (known service)' : 'link target host' };
    }
  }
  const hint = hintOf([n.attrs.class, n.attrs.id, n.attrs.name].filter(Boolean).join(' '));
  if (hint) return { value: hint, source: 'class or id of the original element' };
  const file = iconFile(n);
  const fromFile = file && (hintOf(file.split('/').pop()) ?? fileLabel(file));
  if (fromFile) return { value: fromFile, source: 'icon file name' };
  if (n.tag === 'a') {
    const link = n.href ?? n.attrs.href;
    try {
      const u = new URL(link, ctx.pageUrl);
      const label = fileLabel(u.pathname.replace(/\/$/, ''));
      if (label) return { value: label, source: 'link target path' };
    } catch {
      // no usable href
    }
  }
  return null;
}

/**
 * Links, buttons and form fields without an accessible name.
 * @returns {{ fixed: object[], open: object[] }}
 */
export function fixNames(t, ctx) {
  const fixed = [];
  const open = [];
  const labelled = new Set();
  walk(t.root, (n) => {
    if (n.tag === 'label' && n.attrs.for) labelled.add(n.attrs.for);
  });
  walk(t.root, (n, ancestors) => {
    if (!visibleSomewhere(n)) return;
    const control = n.tag === 'button' || (n.tag === 'a' && (n.href || n.attrs.href)) || (n.tag === 'input' && /^(button|submit|reset|image)$/i.test(n.attrs.type ?? ''));
    if (control) {
      if (accessibleName(n)) return;
      const name = deriveName(n, ctx);
      if (!name) {
        open.push({ page: t.info.path, element: n.tag, detail: 'No text, label or usable hint found' });
        return;
      }
      // An icon image without alt carries the name itself; otherwise the control gets aria-label.
      let img = null;
      walk(n, (c) => {
        if (!img && c.tag === 'img' && !clean(c.attrs.alt)) img = c;
      });
      if (img && !n.children.some((c) => isText(c) && c.text.trim())) {
        img.attrs.alt = name.value;
        fixed.push({ page: t.info.path, element: n.tag, field: 'alt', ...name });
      } else {
        n.attrs['aria-label'] = name.value;
        fixed.push({ page: t.info.path, element: n.tag, field: 'aria-label', ...name });
      }
      return;
    }
    const field = /^(input|select|textarea)$/.test(n.tag) && !/^(hidden|button|submit|reset|image)$/i.test(n.attrs.type ?? '');
    if (!field) return;
    if (clean(n.attrs['aria-label']) || n.attrs['aria-labelledby'] || clean(n.attrs.title)) return;
    if ((n.attrs.id && labelled.has(n.attrs.id)) || ancestors.some((a) => a.tag === 'label')) return;
    const value = clean(n.attrs.placeholder) || (n.attrs.name ? cap(n.attrs.name.replace(/[-_[\]]+/g, ' ').trim()) : '');
    if (!value) {
      open.push({ page: t.info.path, element: n.tag, detail: 'Form field without label, placeholder or name' });
      return;
    }
    n.attrs['aria-label'] = value;
    fixed.push({ page: t.info.path, element: n.tag, field: 'aria-label', value, source: n.attrs.placeholder ? 'placeholder' : 'field name' });
  });
  return { fixed, open };
}

/**
 * Images without an alt attribute.
 * @returns {{ fixed: object[], decorative: object[] }}
 */
export function fixAlt(t) {
  const fixed = [];
  const decorative = [];
  walk(t.root, (n, ancestors) => {
    if (n.tag !== 'img' || n.attrs.alt != null) return;
    const src = n.src ?? n.attrs.src ?? null;
    const figure = ancestors.at(-1)?.tag === 'figure' ? ancestors.at(-1) : null;
    const caption = figure?.children.find((c) => isElement(c) && c.tag === 'figcaption');
    const control = ancestors.find((a) => a.tag === 'a' || a.tag === 'button');
    let alt = null;
    let source = null;
    if (/^(presentation|none)$/.test(n.attrs.role ?? '') || n.attrs['aria-hidden'] === 'true') [alt, source] = ['', 'marked decorative'];
    else if (control && clean(deepText(control))) [alt, source] = ['', 'decorative (the link or button has text)'];
    else if (clean(n.attrs.title) || clean(n.attrs['aria-label'])) [alt, source] = [clean(n.attrs.title) || clean(n.attrs['aria-label']), 'title attribute'];
    else if (caption && clean(deepText(caption))) [alt, source] = [clean(deepText(caption)).slice(0, 125), 'figure caption'];
    else if (src && fileLabel(src)) [alt, source] = [fileLabel(src), 'file name'];
    else [alt, source] = ['', 'decorative (no description found)'];
    n.attrs.alt = alt;
    const entry = { page: t.info.path, field: 'alt', value: alt, source, src };
    if (!alt && source.startsWith('decorative (no')) decorative.push(entry);
    else fixed.push(entry);
  });
  return { fixed, decorative };
}

function retag(n, to) {
  const from = n.tag;
  for (const d of Object.values(n.views)) {
    for (const side of ['margin-top', 'margin-bottom']) if (d.style[side] == null) d.style[side] = HEADING_MARGIN[from];
  }
  n.tag = to;
}

/**
 * One h1 per page and no skipped heading levels. Only visible headings count.
 * @returns {object[]} the changes: { page, from, to, text, reason }
 */
export function fixHeadings(t) {
  const headings = [];
  let main = null;
  walk(t.root, (n) => {
    if (n.tag === 'main' && !main) main = n;
    if (/^h[1-6]$/.test(n.tag) && visibleSomewhere(n)) headings.push(n);
  });
  if (!headings.length) return [];
  const changes = [];
  const change = (n, to, reason) => {
    changes.push({ page: t.info.path, from: n.tag, to, text: clean(deepText(n)).slice(0, 80), reason });
    retag(n, to);
  };
  if (!headings.some((h) => h.tag === 'h1')) {
    const inMain = main ? headings.find((h) => { let hit = false; walk(main, (x) => { if (x === h) hit = true; }); return hit; }) : null;
    change(inMain ?? headings[0], 'h1', 'the page had no h1');
  }
  // Outline by original level: a heading goes one level below the nearest earlier heading of a
  // higher original level, so siblings stay siblings (h1, h3, h3 → h1, h2, h2).
  const stack = []; // { orig, fixed }
  let seenH1 = false;
  for (const h of headings) {
    let orig = Number(h.tag[1]);
    if (orig === 1) {
      if (seenH1) {
        change(h, 'h2', 'more than one h1');
        orig = 2;
      }
      seenH1 = true;
    }
    while (stack.length && stack.at(-1).orig >= orig) stack.pop();
    const parent = stack.at(-1);
    const fixed = parent ? Math.min(orig, parent.fixed + 1) : orig;
    if (fixed !== Number(h.tag[1])) change(h, `h${fixed}`, `skipped level (h${parent.fixed} → h${orig})`);
    stack.push({ orig, fixed });
  }
  return changes;
}
