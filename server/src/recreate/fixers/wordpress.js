// WordPress REST content. When the analysis detected WordPress and /wp-json/wp/v2/ answers (or the
// ?rest_route= fallback), the clean content of every recreated page or post is read from the API
// instead of trusting the scraped text alone:
// - head: the REST title and excerpt fill a missing <title> / meta description (before the page
//   heuristics), reported as auto-generated from the WordPress REST API;
// - text: the content blocks (paragraphs, headings, list items, quotes, captions, table cells) are
//   aligned with the rendered blocks of the page; where the text differs (plugins that rewrite text
//   in the browser, email obfuscation, lazy placeholders, …) the REST text replaces it. Layout and
//   styles still come from the rendered page;
// - IR: pages[].content keeps the clean content (sanitized HTML, title, excerpt, dates) for the
//   stack emitters of Phase 6;
// - report: how many posts and pages the site has in total versus how many were recreated.
// Every request is SSRF-guarded (fetchPage) and the whole lookup has its own time budget.
import { load } from 'cheerio';
import { fetchPage } from '../../audit/http.js';
import { mapLimit, urlKey } from '../../audit/util.js';
import { deepText, isElement, isText, resetTextCache } from '../ir/tree.js';
import { sanitizeSvg } from './svg.js';

const TYPES = [
  { route: 'pages', type: 'page' },
  { route: 'posts', type: 'post' },
];
const LIST_PAGES = 3; // 3 × 100 items per type
const ITEM_FIELDS = 'id,type,slug,link,title,excerpt,content,date,modified';
const REQUEST = { timeout: 10000, maxBytes: 3 * 1024 * 1024, accept: 'application/json' };
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'figcaption', 'dt', 'dd', 'td', 'th', 'caption', 'pre']);
const MATCH_WINDOW = 40;
const MIN_SIMILARITY = 0.5;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Text of a REST HTML field (title.rendered, excerpt.rendered): tags removed, entities decoded. */
export const restText = (html) => clean(load(`<div>${html ?? ''}</div>`).text());

export const isWordPress = (audit) => (audit?.techStack ?? []).some((s) => s.id === 'wordpress');

// Same key for www and bare host, like the link resolver.
const pageKey = (url) => {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.replace(/^www\./, '');
    return urlKey(u.href);
  } catch {
    return url;
  }
};

function endpoints(origin) {
  return [
    { api: `${origin}/wp-json/wp/v2/`, url: (route, qs) => `${origin}/wp-json/wp/v2/${route}?${qs}` },
    { api: `${origin}/?rest_route=/wp/v2/`, url: (route, qs) => `${origin}/?rest_route=/wp/v2/${route}&${qs}` },
  ];
}

async function getJson(url, signal) {
  const res = await fetchPage(url, { ...REQUEST, signal });
  if (res.status !== 200 || !/json/i.test(res.contentType)) return { ok: false, status: res.status, error: res.error ?? `http-${res.status}` };
  try {
    return { ok: true, data: JSON.parse(res.body), headers: res.headers };
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
}

/**
 * Reads the REST content of the recreated pages.
 * @param {object} o
 * @param {string} o.origin
 * @param {{ url: string }[]} o.pages  recreated pages
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.deadline]  epoch ms; no new request starts after it
 * @returns {Promise<{ api: string|null, reachable: boolean, error?: string, totals: object, items: Map<string, object> }>}
 */
export async function fetchWordPress({ origin, pages, signal, deadline = Infinity }) {
  const items = new Map();
  const totals = { pages: null, posts: null };
  const late = () => Date.now() > deadline;
  let endpoint = null;
  let firstError = null;
  const index = new Map(); // pageKey(link) → { id, route }

  for (const ep of endpoints(origin)) {
    const probe = await getJson(ep.url('pages', 'per_page=100&page=1&_fields=id,link,type'), signal);
    if (probe.ok && Array.isArray(probe.data)) {
      endpoint = ep;
      break;
    }
    firstError ??= probe.error;
  }
  if (!endpoint) return { api: null, reachable: false, error: firstError ?? 'error', totals, items };

  for (const { route } of TYPES) {
    for (let page = 1; page <= LIST_PAGES && !late(); page++) {
      const res = await getJson(endpoint.url(route, `per_page=100&page=${page}&_fields=id,link,type`), signal);
      if (!res.ok || !Array.isArray(res.data)) break;
      if (page === 1) totals[route] = Number(res.headers['x-wp-total']) || res.data.length;
      for (const it of res.data) if (it?.link && it.id != null) index.set(pageKey(it.link), { id: it.id, route });
      if (page >= (Number(res.headers['x-wp-totalpages']) || 1)) break;
    }
  }

  const wanted = pages.map((p) => [pageKey(p.url), index.get(pageKey(p.url))]).filter(([, hit]) => hit);
  await mapLimit(wanted, 4, async ([key, { id, route }]) => {
    if (late() || signal?.aborted) return;
    const res = await getJson(endpoint.url(`${route}/${id}`, `_fields=${ITEM_FIELDS}`), signal);
    if (res.ok && res.data && typeof res.data === 'object') items.set(key, res.data);
  });
  return { api: endpoint.api, reachable: true, totals, items };
}

/** The REST item of a page, looked up by its URL. */
export const itemFor = (wp, url) => wp?.items?.get(pageKey(url)) ?? null;

/** Title and excerpt for the head builder. */
export function headHints(item) {
  if (!item) return null;
  return { title: restText(item.title?.rendered), excerpt: restText(item.excerpt?.rendered).replace(/\s*(\[…\]|\[\.\.\.\]|…)$/, '…') };
}

// ---------------------------------------------------------------------------------------------
// Clean content for the IR: an allowlist of content tags and attributes; scripts, styles, forms,
// builder classes and inline styles are dropped, inline SVG goes through the SVG sanitizer.
const CONTENT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
  'blockquote', 'q', 'cite', 'code', 'pre', 'br', 'hr', 'figure', 'figcaption', 'img', 'picture', 'source', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'dl', 'dt', 'dd', 'span', 'div', 'section', 'article', 'header', 'footer',
  'aside', 'mark', 'abbr', 'time', 'iframe', 'video', 'audio', 'track', 'details', 'summary', 'kbd', 'del', 'ins',
]);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'form', 'object', 'embed', 'applet', 'frame', 'frameset', 'button', 'input', 'select', 'textarea']);
const CONTENT_ATTRS = new Set(['href', 'src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'scope', 'datetime', 'cite', 'controls', 'poster', 'type', 'lang', 'dir', 'start', 'reversed', 'open', 'media', 'kind', 'srclang', 'label']);
const URL_ATTRS = new Set(['href', 'src', 'cite', 'poster']);
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const VOID = new Set(['br', 'hr', 'img', 'source', 'track']);

function safeUrl(value, attr, tag) {
  const v = String(value).replace(/[\u0000- \u007f-\u009f]+/g, '');
  if (attr === 'href' && tag === 'a') return /^(https?:|mailto:|tel:|#|\/(?!\/))/i.test(v) ? value : null;
  return /^https:\/\//i.test(v) || (tag !== 'iframe' && /^http:\/\//i.test(v)) ? value : null;
}

/** Sanitized content HTML (WordPress content.rendered). */
export function cleanContentHtml(html) {
  const $ = load(`<div id="sas-root">${html ?? ''}</div>`);
  const out = (node) => {
    if (node.type === 'text') return escText(node.data);
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return '';
    const tag = node.name.toLowerCase();
    if (tag === 'svg') return sanitizeSvg($.html(node), { inline: true }).svg ?? '';
    if (DROP_WITH_CONTENT.has(tag)) return '';
    const inner = (node.children ?? []).map(out).join('');
    if (!CONTENT_TAGS.has(tag)) return inner; // unknown wrappers are unwrapped
    const attrs = [];
    for (const [k, v] of Object.entries(node.attribs ?? {})) {
      const name = k.toLowerCase();
      if (!CONTENT_ATTRS.has(name)) continue;
      let value = v;
      if (URL_ATTRS.has(name)) value = safeUrl(v, name, tag);
      if (name === 'srcset') value = String(v).split(',').every((c) => /^\s*https?:\/\//i.test(c)) ? v : null;
      if (value == null) continue;
      attrs.push(` ${name}="${escAttr(value)}"`);
    }
    if (tag === 'iframe' && !attrs.some((a) => a.startsWith(' src='))) return '';
    if (tag === 'iframe') attrs.push(' loading="lazy"');
    if (VOID.has(tag)) return `<${tag}${attrs.join('')}>`;
    return `<${tag}${attrs.join('')}>${inner}</${tag}>`;
  };
  return ($('#sas-root')[0].children ?? []).map(out).join('').trim();
}

// ---------------------------------------------------------------------------------------------
// Text sync between the REST content and the rendered page.

const tokens = (s) => clean(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Dice coefficient of the word sets of two texts (0–1). */
export function similarity(a, b) {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return (2 * common) / (x.size + y.size);
}

const sameKind = (a, b) => a === b || (/^h[1-6]$/.test(a) && /^h[1-6]$/.test(b));
const visibleSomewhere = (n) => Object.values(n.views).some((d) => !d.hidden && d.rect[2] > 0 && d.rect[3] > 0);

/** Leaf content blocks of the REST HTML, in order: { tag, text }. */
export function restBlocks(html) {
  const $ = load(`<div id="sas-root">${html ?? ''}</div>`);
  const out = [];
  $('#sas-root *').each((_, el) => {
    const tag = el.name.toLowerCase();
    if (!BLOCKS.has(tag)) return;
    if ($(el).find([...BLOCKS].join(',')).length) return;
    const text = clean($(el).text());
    if (text) out.push({ tag, text });
  });
  return out;
}

function pageBlocks(root) {
  let scope = root;
  const find = (n) => {
    if (!isElement(n) || scope !== root) return;
    if (n.tag === 'main') scope = n;
    else n.children.forEach(find);
  };
  find(root);
  const out = [];
  const walk = (n) => {
    if (!isElement(n)) return;
    const hasBlockChild = (x) => isElement(x) && x.children.some((c) => isElement(c) && (BLOCKS.has(c.tag) || hasBlockChild(c)));
    if (BLOCKS.has(n.tag) && !hasBlockChild(n)) {
      if (visibleSomewhere(n) && clean(deepText(n))) out.push(n);
      return;
    }
    n.children.forEach(walk);
  };
  walk(scope);
  return out;
}

/**
 * Aligns the REST blocks with the page blocks and replaces differing text.
 * @returns {{ blocks: number, matched: number, updated: object[], kept: number, missing: number }}
 */
export function syncText(t, item) {
  const rest = restBlocks(item?.content?.rendered);
  const page = pageBlocks(t.root);
  const result = { blocks: rest.length, matched: 0, updated: [], kept: 0, missing: 0 };
  let j = 0;
  for (const b of rest) {
    let hit = -1;
    for (let k = j; k < Math.min(page.length, j + MATCH_WINDOW); k++) {
      if (sameKind(page[k].tag, b.tag) && similarity(deepText(page[k]), b.text) >= MIN_SIMILARITY) {
        hit = k;
        break;
      }
    }
    if (hit < 0) {
      result.missing++;
      continue;
    }
    result.matched++;
    j = hit + 1;
    const node = page[hit];
    const before = clean(deepText(node));
    if (before === b.text) continue;
    if (node.children.every(isText)) {
      node.children = [{ text: b.text }];
      result.updated.push({ page: t.info.path, tag: node.tag, before: before.slice(0, 120), after: b.text.slice(0, 120) });
    } else result.kept++; // inline markup (links, emphasis) is kept as rendered
  }
  if (result.updated.length) resetTextCache();
  return result;
}

/** The clean content record kept in the IR (pages[].content). */
export function contentRecord(item) {
  return {
    source: 'wordpress-rest',
    type: item.type ?? null,
    id: item.id ?? null,
    slug: item.slug ?? null,
    link: item.link ?? null,
    title: restText(item.title?.rendered),
    excerpt: restText(item.excerpt?.rendered),
    html: cleanContentHtml(item.content?.rendered),
    date: item.date ?? null,
    modified: item.modified ?? null,
  };
}
