// @ts-check
// A site's own page templates, worked out from its finished pages (Remastly holds a copy of the site, not its source code).
// Pages of one kind (the same folder, the same build) are made by one template; comparing two of them shows what the template
// is (what is the same on both) and where its content goes (what differs): text slots, picture and link slots, repeated items
// (a list of features, the questions of a FAQ) and parts only some pages have. A new page of that kind is then that template
// with a content entry put into its slots: the design is the site's own, to the element and the class, and nothing else is
// written. No model here: template.js works out and fills templates; the AI only writes the entry (changes/agent.js).
import * as cheerio from 'cheerio';
import { htmlFiles, readText, servedPath } from './site.js';

/** Elements whose content is text with inline markup: a difference in them is one text slot. */
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
/** Attributes that hold a page's own content (a picture, a link, a description); other differing attributes keep the first page's. */
const CONTENT_ATTRS = new Set(['href', 'src', 'srcset', 'alt', 'title', 'aria-label', 'poster', 'data-src', 'data-srcset', 'datetime', 'content', 'value', 'placeholder']);
/** Never part of a template: a page's own data for its scripts, or its own structured data. */
const SKIP_TAGS = new Set(['script', 'noscript', 'template']);

export const MAX_SLOTS = 400;

/**
 * @typedef {{ kind: 'el', tag: string, attrs: Record<string, string>, attrSlots: Record<string, string>, children: TNode[] }} TEl
 * @typedef {{ kind: 'text', value: string }} TText                                   fixed text
 * @typedef {{ kind: 'slot', id: string, el: TEl }} TSlot                               an element whose words are content
 * @typedef {{ kind: 'list', id: string, item: TNode, counts: number[] }} TList          items of one shape, as many as the page needs
 * @typedef {{ kind: 'optional', id: string, node: TNode }} TOptional                     a part some pages of the kind have
 * @typedef {{ kind: 'raw', html: string }} TRaw                                          kept as it is (an inline SVG, a script both pages share)
 * @typedef {TEl | TText | TSlot | TList | TOptional | TRaw} TNode
 * @typedef {{ id: string, kind: 'text' | 'attr' | 'list' | 'optional', where: string, attr?: string, examples: string[], item?: Schema }} SlotInfo
 * @typedef {{ slots: SlotInfo[] }} Schema
 */

const tagOf = (/** @type {any} */ n) => String(n?.name ?? n?.tagName ?? '').toLowerCase();
const isEl = (/** @type {any} */ n) => n?.type === 'tag' || n?.type === 'script' || n?.type === 'style';
const isText = (/** @type {any} */ n) => n?.type === 'text';
const norm = (/** @type {string} */ s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const classSig = (/** @type {any} */ el) => String(el.attribs?.class ?? '').split(/\s+/).filter(Boolean).sort().join('.');
/** What an element is, for matching it on another page: its tag and its classes (not its id or its words). */
const sig = (/** @type {any} */ el) => (tagOf(el) === 'script' ? `script@${el.attribs?.src ?? ''}` : `${tagOf(el)}.${classSig(el)}${el.attribs?.[PART] ? `#${el.attribs[PART]}` : ''}`);
/** A one-page template numbers the page's content parts, so two alike sections stay two parts (deriveSingle). */
const PART = 'data-sas-part';

/**
 * Children worth matching: elements and text that is not only white space. A script file the site loads stays (the site's own
 * code: its menu, its slider; it matches only the same file on the other page); a script written into the page (its own data
 * for its framework) never does, nor <noscript> / <template>.
 */
const kids = (/** @type {any} */ el) => (el.children ?? []).filter((c) => (isEl(c) && (!SKIP_TAGS.has(tagOf(c)) || (tagOf(c) === 'script' && c.attribs?.src))) || (isText(c) && norm(c.data)));

/** Elements whose words are one piece of text even when a link sits inside (a paragraph with a link). */
const TEXT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'summary', 'figcaption', 'blockquote', 'label', 'td', 'th', 'caption', 'legend', 'button', 'option']);
/** Whether a link, a button or a picture is under `el`. */
const holdsControls = (/** @type {any} */ el) => (el.children ?? []).some((c) => isEl(c) && (['a', 'button', 'img', 'input', 'select', 'textarea'].includes(tagOf(c)) || holdsControls(c)));
/**
 * One text slot: a text element (a heading, a paragraph, a link's label) holding only text and inline markup. A box (a div,
 * a section) that holds links or buttons is never one: its buttons keep their own labels and links (a hero's two buttons).
 */
const oneText = (/** @type {any} */ el) => inlineOnly(el) && (TEXT_BLOCKS.has(tagOf(el)) || INLINE.has(tagOf(el)) || !holdsControls(el));

/** True when everything under `el` is text and inline markup (a heading, a paragraph, a button's label). */
function inlineOnly(el) {
  for (const c of el.children ?? []) {
    if (isText(c)) continue;
    if (c.type === 'comment') continue;
    if (!isEl(c) || !INLINE.has(tagOf(c)) || !inlineOnly(c)) return false;
  }
  return true;
}

/** Consecutive siblings of the same shape, folded into one run (the items of a list, the cards of a grid). */
function runs(nodes) {
  /** @type {{ sig: string, items: any[] }[]} */
  const out = [];
  for (const n of nodes) {
    const s = isText(n) ? '#text' : sig(n);
    const last = out.at(-1);
    if (last && last.sig === s && s !== '#text') last.items.push(n);
    else out.push({ sig: s, items: [n] });
  }
  return out;
}

/** Longest common subsequence of two run lists by shape: the pairs [i, j] that match, in order. */
function lcs(a, b) {
  const m = a.length;
  const n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = a[i].sig === b[j].sig ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i].sig === b[j].sig) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Works out templates; ids are numbered per template, so a template's schema reads the same every time. */
class Deriver {
  /** @param {cheerio.CheerioAPI} $a @param {cheerio.CheerioAPI} $b */
  constructor($a, $b) {
    this.n = 0;
    this.$a = $a;
    this.$b = $b;
    /** @type {SlotInfo[]} where the slots found now are described (a list's item has its own) */
    this.out = [];
  }

  /** @param {SlotInfo} info */
  note(info) {
    this.out.push(info);
  }

  id(prefix) {
    this.n++;
    if (this.n > MAX_SLOTS) throw new Error('This kind of page has too many differences to be one template.');
    return `${prefix}${this.n}`;
  }

  /** One element on both pages, as a template node. */
  el(a, b) {
    if (oneText(a) && oneText(b) && (a.children ?? []).length + (b.children ?? []).length > 0) {
      const same = cheerio.load('').html(a.children) === cheerio.load('').html(b.children);
      const base = this.shell(a, b);
      if (same) return { ...base, children: (a.children ?? []).map((c) => raw(c)) };
      const id = this.id('t');
      this.note({ id, kind: 'text', where: placeOf(this.$a, a), examples: [norm(this.$a(a).text()), norm(this.$b(b).text())].filter(Boolean).map((t) => t.slice(0, 400)) });
      return { kind: 'slot', id, el: base };
    }
    const base = this.shell(a, b);
    base.children = this.children(kids(a), kids(b));
    return base;
  }

  /** The element itself: its tag, the attributes both pages share, and slots for content attributes that differ. */
  shell(a, b) {
    /** @type {TEl} */
    const out = { kind: 'el', tag: tagOf(a), attrs: {}, attrSlots: {}, children: [] };
    for (const [k, v] of Object.entries(a.attribs ?? {})) {
      if (/^on/i.test(k)) continue;
      const w = b.attribs?.[k];
      if (w === v || !CONTENT_ATTRS.has(k.toLowerCase())) out.attrs[k] = v;
      else out.attrSlots[k] = this.attrSlot(a, b, k);
    }
    for (const k of Object.keys(b.attribs ?? {})) {
      if (!(k in (a.attribs ?? {})) && CONTENT_ATTRS.has(k.toLowerCase())) out.attrSlots[k] = this.attrSlot(a, b, k);
    }
    return out;
  }

  attrSlot(a, b, attr) {
    const id = this.id('a');
    this.note({ id, kind: 'attr', attr, where: `${placeOf(this.$a, a)} @${attr}`, examples: [a.attribs?.[attr], b.attribs?.[attr]].filter((v) => v != null).map(String) });
    return id;
  }

  /** Two lists of children, matched by shape. Runs of one shape become lists; parts only one page has become optional. */
  children(ka, kb) {
    const ra = runs(ka);
    const rb = runs(kb);
    const pairs = lcs(ra, rb);
    /** @type {TNode[]} */
    const out = [];
    let i = 0;
    let j = 0;
    const leftovers = (/** @type {number} */ ti, /** @type {number} */ tj) => {
      for (; i < ti; i++) for (const n of ra[i].items) out.push(this.optional(n));
      for (; j < tj; j++) for (const n of rb[j].items) out.push(this.optional(n));
    };
    for (const [pi, pj] of pairs) {
      leftovers(pi, pj);
      const x = ra[pi];
      const y = rb[pj];
      if (x.sig === '#text') {
        const same = norm(x.items[0].data) === norm(y.items[0].data);
        if (same) out.push({ kind: 'text', value: x.items[0].data });
        else {
          const id = this.id('t');
          this.note({ id, kind: 'text', where: 'text', examples: [norm(x.items[0].data), norm(y.items[0].data)] });
          out.push({ kind: 'slot', id, el: { kind: 'el', tag: '#text', attrs: {}, attrSlots: {}, children: [] } });
        }
      } else if (x.items.length === 1 && y.items.length === 1) {
        out.push(this.el(x.items[0], y.items[0]));
      } else if (x.items.length === y.items.length && x.items.every((n, k) => cheerio.load('').html(n) === cheerio.load('').html(y.items[k]))) {
        // the same items on both sides (a menu's links): part of the template, not a list to fill
        for (const n of x.items) out.push(raw(n));
      } else {
        // items of one shape: one item template, from an item of each page (every item has the same shape)
        const id = this.id('L');
        /** @type {SlotInfo[]} */
        const inner = [];
        const item = this.scoped(inner, () => this.el(x.items[0], y.items[0]));
        const said = (/** @type {any[]} */ items, $) => items.slice(0, 6).map((n) => norm($(n).text()).slice(0, 160));
        this.note({ id, kind: 'list', where: placeOf(this.$a, x.items[0]), examples: [...said(x.items, this.$a), ...said(y.items, this.$b)], item: { slots: inner } });
        out.push({ kind: 'list', id, item, counts: [x.items.length, y.items.length] });
      }
      i = pi + 1;
      j = pj + 1;
    }
    leftovers(ra.length, rb.length);
    return out;
  }

  /** A part one page has and the other does not: kept as it is, used only when the entry asks for it. */
  optional(n) {
    const id = this.id('o');
    const $ = this.inA(n) ? this.$a : this.$b;
    this.note({ id, kind: 'optional', where: isEl(n) ? placeOf($, n) : 'text', examples: [norm(isEl(n) ? $(n).text() : n.data).slice(0, 240)] });
    return { kind: 'optional', id, node: raw(n) };
  }

  /** Whether a node is the first page's. */
  inA(n) {
    let p = n;
    while (p?.parent) p = p.parent;
    return p === this.rootA;
  }

  /** A list item's slots are numbered and described on their own (every item fills the same ids). */
  scoped(/** @type {SlotInfo[]} */ into, fn) {
    const saved = this.n;
    const out = this.out;
    this.n = 0;
    this.out = into;
    try {
      return fn();
    } finally {
      this.n = saved;
      this.out = out;
    }
  }
}

/** A node kept as it is. */
const raw = (/** @type {any} */ n) => (isText(n) ? { kind: 'text', value: n.data } : { kind: 'raw', html: cheerio.load('').html(n) });

/** The part of the body a template covers: everything in it (header and footer included: they are the same on both pages). */
const bodyOf = (/** @type {string} */ html) => {
  const $ = cheerio.load(html);
  return { $, body: $('body').get(0) };
};

/**
 * The template two pages of one kind share, with its slots.
 * @param {string} htmlA @param {string} htmlB  two pages of the kind; the first one's choices win where they differ in form
 * @returns {{ root: TEl, schema: Schema, stats: { slots: number, lists: number, optional: number, fixedText: number } }}
 */
export function deriveTemplate(htmlA, htmlB) {
  const a = bodyOf(htmlA);
  const b = bodyOf(htmlB);
  if (!a.body || !b.body) throw new Error('A page has no body.');
  const d = new Deriver(a.$, b.$);
  let top = a.body;
  while (top.parent) top = top.parent;
  d.rootA = top;
  const root = /** @type {TEl} */ (d.el(a.body, b.body));
  return { root, schema: { slots: d.out }, stats: statsOf(root) };
}

function statsOf(root) {
  const s = { slots: 0, lists: 0, optional: 0, fixedText: 0 };
  const walk = (/** @type {TNode} */ n) => {
    if (n.kind === 'slot') s.slots++;
    else if (n.kind === 'list') {
      s.lists++;
      walk(n.item);
    } else if (n.kind === 'optional') s.optional++;
    else if (n.kind === 'text' && norm(n.value)) s.fixedText++;
    else if (n.kind === 'el') {
      s.slots += Object.keys(n.attrSlots).length;
      n.children.forEach(walk);
    }
  };
  walk(root);
  return s;
}

// ---- where a slot is (for the AI that writes an entry: the schema says what each slot is and what the two pages put there) ----

/** A short name for where an element sits: its tag and classes, under the nearest heading before it. */
function placeOf($, el) {
  const t = tagOf(el);
  const cls = String(el.attribs?.class ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  let near = '';
  for (let p = el; p && !near; p = p.parent) {
    if (!isEl(p)) continue;
    const h = $(p).prevAll('h1, h2, h3').first();
    if (h.length) near = norm(h.text()).slice(0, 60);
    else {
      const inner = $(p).children('h1, h2, h3').first();
      if (inner.length && inner.get(0) !== el) near = norm(inner.text()).slice(0, 60);
    }
  }
  return `${t}${cls ? `.${cls}` : ''}${near ? ` (under "${near}")` : ''}`;
}

// ---- filling a template with an entry ----

const HEADING = /^h[1-6]$/;
/** Whether a template node holds a heading (an element, a slot or kept markup). */
function holdsHeading(/** @type {TNode} */ n) {
  if (n.kind === 'slot') return HEADING.test(n.el.tag);
  if (n.kind === 'raw') return /<h[1-6][\s>]/i.test(n.html);
  if (n.kind === 'optional') return holdsHeading(n.node);
  if (n.kind === 'list') return holdsHeading(n.item);
  if (n.kind === 'el') return HEADING.test(n.tag) || n.children.some(holdsHeading);
  return false;
}

/**
 * Blocks to leave out because the entry left them partly empty: a block with no heading (an illustration, a sample sheet, a
 * row of logos) that holds a list the entry gives no items, and more content slots than the entry filled. The highest such
 * block goes whole, instead of an empty frame (a product mock-up whose sample rows were not written, chips left floating).
 * A block that holds a heading is never taken (its section is the page's content: what is empty in it goes on its own).
 * @param {TEl} root @param {Record<string, any>} entry @param {Record<string, string>} defaults
 * @returns {Set<TNode>}
 */
function emptiedBlocks(root, entry, defaults) {
  const out = new Set();
  const isFilled = (/** @type {string} */ id) => {
    const v = entry[id] ?? defaults[id];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : v === true;
  };
  /** @returns {{ had: number, filled: number, emptyList: boolean }} */
  const count = (/** @type {TNode} */ n) => {
    if (n.kind === 'slot') return { had: 1, filled: isFilled(n.id) ? 1 : 0, emptyList: false };
    if (n.kind === 'list') return { had: 1, filled: isFilled(n.id) ? 1 : 0, emptyList: !isFilled(n.id) };
    if (n.kind === 'optional') return entry[n.id] === true ? count(n.node) : { had: 0, filled: 0, emptyList: false };
    if (n.kind !== 'el') return { had: 0, filled: 0, emptyList: false };
    const c = { had: 0, filled: 0, emptyList: false };
    for (const id of Object.values(n.attrSlots)) {
      c.had++;
      if (isFilled(id)) c.filled++;
    }
    for (const k of n.children) {
      const x = count(k);
      c.had += x.had;
      c.filled += x.filled;
      c.emptyList ||= x.emptyList;
    }
    return c;
  };
  const walk = (/** @type {TNode} */ n, /** @type {boolean} */ top) => {
    if (n.kind === 'optional') return walk(n.node, top);
    if (n.kind !== 'el') return;
    if (!top && !['body', 'main'].includes(n.tag) && !holdsHeading(n)) {
      const c = count(n);
      if (c.emptyList && c.filled < c.had) {
        out.add(n);
        return;
      }
    }
    for (const k of n.children) walk(k, false);
  };
  walk(root, true);
  return out;
}

const esc = (/** @type {string} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * The template with the entry's content in its slots. Every value is plain text (escaped here). A slot the entry leaves out is
 * reported in `missing` and written empty; an optional part is used only when the entry says true; a list gets the entry's
 * items. Attribute values (links, pictures) are checked by the caller (agent.js) before they get here.
 * @param {TEl} root @param {Record<string, any>} entry
 * @returns {{ html: string, missing: string[] }}  html: the <body> element
 */
export function fillTemplate(root, entry, { dropEmpty = false, defaults = {} } = {}) {
  // defaults: values for slots the entry leaves out (top level only), e.g. a one-page template's own links
  const missing = [];
  // dropEmpty: an element whose words, picture or link the entry does not give is left out (never another page's)
  const MUST = new Set(['src', 'href', 'srcset', 'poster', 'data-src']);
  const emptied = dropEmpty ? emptiedBlocks(root, entry, defaults) : new Set();
  const render = (/** @type {TNode} */ n, /** @type {Record<string, any>} */ e, /** @type {string} */ scope) => {
    if (emptied.has(n)) return '';
    if (n.kind === 'text') return n.value;
    if (n.kind === 'raw') return n.html;
    if (n.kind === 'optional') return e[n.id] === true ? render(n.node, e, scope) : '';
    if (n.kind === 'list') {
      const items = Array.isArray(e[n.id]) ? e[n.id] : [];
      if (!items.length) missing.push(`${scope}${n.id}`);
      return items.map((it, k) => render(n.item, it && typeof it === 'object' ? it : {}, `${scope}${n.id}[${k}].`)).join('');
    }
    if (n.kind === 'slot') {
      const v = e[n.id];
      const empty = typeof v !== 'string' || !v.trim();
      if (empty) missing.push(`${scope}${n.id}`);
      if (empty && dropEmpty) return '';
      // a stylesheet's or a script's own text is code: written as it is (escaping turned `a > b` and quotes into entities),
      // only a closing tag inside it made harmless
      const code = /^(style|script)$/i.test(n.el.tag);
      const text = code ? String(v ?? '').replace(/<\/(style|script)/gi, '<\\/$1') : esc(typeof v === 'string' ? v : '');
      if (n.el.tag === '#text') return text;
      return open(n.el, e, scope) + text + close(n.el);
    }
    const given = (/** @type {string} */ id) => typeof (e[id] ?? (scope === '' ? defaults[id] : undefined)) === 'string' && String(e[id] ?? defaults[id]).trim();
    if (dropEmpty && Object.entries(n.attrSlots).some(([k, id]) => MUST.has(k.toLowerCase()) && !given(id))) {
      for (const id of Object.values(n.attrSlots)) if (!(typeof e[id] === 'string' && e[id].trim())) missing.push(`${scope}${id}`);
      return '';
    }
    return open(n, e, scope) + (VOID.has(n.tag) ? '' : n.children.map((c) => render(c, e, scope)).join('')) + close(n);
  };
  const open = (/** @type {TEl} */ el, e, scope) => {
    const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`);
    for (const [k, id] of Object.entries(el.attrSlots)) {
      const v = e[id] ?? (scope === '' ? defaults[id] : undefined);
      if (typeof v === 'string' && v.trim()) attrs.push(` ${k}="${esc(v)}"`);
      else if (!dropEmpty) missing.push(`${scope}${id}`);
    }
    return `<${el.tag}${attrs.join('')}>`;
  };
  const close = (/** @type {TEl} */ el) => (VOID.has(el.tag) ? '' : `</${el.tag}>`);
  return { html: render(root, entry, ''), missing, emptied: emptied.size };
}

// ---- kinds of pages on a site ----

/** The shape of a page, for grouping: the tags and classes of the body down to four levels (not its words). */
function skeleton(html) {
  const $ = cheerio.load(html);
  const set = new Set();
  const walk = (/** @type {any} */ el, /** @type {number} */ depth, /** @type {string} */ path) => {
    for (const c of el.children ?? []) {
      if (!isEl(c) || SKIP_TAGS.has(tagOf(c))) continue;
      const p = `${path}>${sig(c)}`;
      set.add(p);
      if (depth < 4) walk(c, depth + 1, p);
    }
  };
  const body = $('body').get(0);
  if (body) walk(body, 1, 'body');
  return set;
}
const likeness = (/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) => {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / Math.max(1, a.size + b.size - both);
};

/** The folder a page sits in ("/ai-video-analytics/forklift/" → "/ai-video-analytics/"). */
export const folderOf = (/** @type {string} */ page) => {
  const p = page.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : `${p.slice(0, cut)}/`;
};

export const LIKENESS_MIN = 0.6;

/**
 * The kinds of pages a site has: pages in one folder whose shapes are alike (the folder's own index page is not one of its
 * items). Only kinds with two pages or more: one page alone shows no template.
 * @param {string} root
 * @returns {Promise<{ folder: string, pages: string[], likeness: number }[]>}  pages as their served paths, most alike first
 */
export async function pageKinds(root) {
  const files = await htmlFiles(root);
  /** @type {Map<string, { path: string, shape: Set<string> }[]>} */
  const byFolder = new Map();
  for (const f of files) {
    if (/(^|\/)404\.html?$/i.test(f)) continue;
    const page = servedPath(f);
    if (page === '/') continue;
    const html = await readText(root, f).catch(() => '');
    if (!html || /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) continue;
    const folder = f.endsWith('/index.html') ? folderOf(page) : folderOf(page.replace(/\.html?$/i, ''));
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)?.push({ path: page, shape: skeleton(html) });
  }
  const kinds = [];
  for (const [folder, pages] of byFolder) {
    if (pages.length < 2) continue;
    // the pages most alike each other: the kind's core (a folder may also hold a page of another kind)
    const scored = pages.map((p) => ({ ...p, score: pages.filter((q) => q !== p).reduce((s, q) => s + likeness(p.shape, q.shape), 0) / (pages.length - 1) }));
    const core = scored.filter((p) => p.score >= LIKENESS_MIN).sort((x, y) => y.score - x.score);
    if (core.length < 2) continue;
    kinds.push({ folder, pages: core.map((p) => p.path), likeness: Math.round((core.reduce((s, p) => s + p.score, 0) / core.length) * 100) / 100 });
  }
  return kinds.sort((a, b) => b.pages.length - a.pages.length);
}

// ---- one page as a template (a site with no two pages of a kind: its homepage) ----

const MARK = '⁣sas';
const BAR_CLASS = /(^|\s)(site-)?(header|footer|nav|navbar|topbar)(\s|$)/i;

/** True for the site's own bars (its menu, its footer) and code; a <header> holding a first or second heading is the page's banner, not a bar. */
function isBarEl($, el) {
  const tag = tagOf(el);
  if (['script', 'style', 'noscript', 'template', 'link', 'meta'].includes(tag)) return true;
  const barLike = ['header', 'nav', 'footer'].includes(tag) || BAR_CLASS.test(el.attribs?.class ?? '');
  if (!barLike) return false;
  return tag === 'footer' || $(el).find('h1, h2').length === 0;
}

/** The page's own content parts: <main>'s children, else the body's children that are not its bars. */
function contentPartsOf($) {
  const main = $('body > main').first();
  return (main.length ? main.children() : $('body').children()).toArray().filter((el) => isEl(el) && !isBarEl($, el));
}

/** The page with its content parts numbered (PART). */
function numbered(html) {
  const $ = cheerio.load(html);
  contentPartsOf($).forEach((el, i) => { el.attribs[PART] = String(i + 1); });
  return $.html();
}

/** Every word and content attribute of the content parts, changed: compared with the page as it is, all of it is a slot. */
function marked(html) {
  const $ = cheerio.load(html);
  const walk = (/** @type {any} */ el) => {
    for (const [k, v] of Object.entries(el.attribs ?? {})) if (CONTENT_ATTRS.has(k.toLowerCase())) el.attribs[k] = `${v}${MARK}`;
    for (const c of el.children ?? []) {
      if (isText(c) && norm(c.data)) c.data = `${c.data}${MARK}`;
      else if (isEl(c) && !SKIP_TAGS.has(tagOf(c))) walk(c);
    }
  };
  for (const part of contentPartsOf($)) walk(part);
  return $.html();
}

/** Every slot id under a template node. */
function idsUnder(/** @type {TNode} */ n, /** @type {Set<string>} */ out = new Set()) {
  if (n.kind === 'slot') {
    out.add(n.id);
    Object.values(n.el.attrSlots).forEach((id) => out.add(id));
  } else if (n.kind === 'list') out.add(n.id);
  else if (n.kind === 'optional') out.add(n.id);
  else if (n.kind === 'el') {
    Object.values(n.attrSlots).forEach((id) => out.add(id));
    n.children.forEach((c) => idsUnder(c, out));
  }
  return out;
}
const hasHeading = (/** @type {TNode} */ n, tags) => (n.kind === 'el' || n.kind === 'slot') && (tags.includes((n.kind === 'slot' ? n.el : n).tag) || (n.kind === 'el' && n.children.some((c) => hasHeading(c, tags))));

/**
 * One page as a template: every word, picture and link of its content parts is a slot (its menu and footer stay as they are),
 * repeated parts are lists, and every content part but the one with the main heading is optional, with its own slots under it.
 * What the page puts there is each slot's one example. For a site without two pages of a kind (its homepage).
 * @param {string} html
 */
export function deriveSingle(html) {
  const tagged = numbered(html);
  const t = deriveTemplate(tagged, marked(tagged));
  // the parts' numbers were only for matching
  const unnumber = (/** @type {TNode} */ n) => {
    if (n.kind === 'el') {
      delete n.attrs[PART];
      n.children.forEach(unnumber);
    } else if (n.kind === 'slot') delete n.el.attrs[PART];
    else if (n.kind === 'list') unnumber(n.item);
  };
  unnumber(t.root);
  // the changed copy's values are no example of anything
  const clean = (/** @type {SlotInfo[]} */ slots) => {
    for (const s of slots) {
      s.examples = s.examples.filter((e) => !e.includes(MARK));
      if (s.item) clean(s.item.slots);
    }
  };
  clean(t.schema.slots);
  // the content parts: <main>'s children (or the body's), each optional but the one that holds the page's main heading
  const mainEl = t.root.children.find((c) => c.kind === 'el' && c.tag === 'main');
  const box = /** @type {TEl} */ (mainEl ?? t.root);
  const BAR_TAGS = new Set(['nav', 'footer', 'script', 'style', 'noscript', 'template', 'link', 'meta']);
  let n = 0;
  const parts = [];
  box.children = box.children.map((c) => {
    if (c.kind !== 'el' && c.kind !== 'slot') return c;
    const tag = c.kind === 'slot' ? c.el.tag : c.tag;
    if (BAR_TAGS.has(tag) || (tag === 'header' && !hasHeading(c, ['h1', 'h2']))) return c;
    if (hasHeading(c, ['h1'])) return c; // the page's top: always there
    const id = `p${++n}`;
    const inside = idsUnder(c);
    const mine = t.schema.slots.filter((s) => inside.has(s.id));
    t.schema.slots = t.schema.slots.filter((s) => !inside.has(s.id));
    const first = mine.find((s) => s.kind === 'text')?.examples[0] ?? '';
    const list = mine.find((s) => s.kind === 'list');
    parts.push({ id, kind: /** @type {'optional'} */ ('optional'), where: `part ${n} (${tag})`, examples: [first, ...(list ? [`${list.examples.length} items`] : [])].filter(Boolean), item: { slots: mine } });
    return { kind: 'optional', id, node: c };
  });
  t.schema.slots.push(...parts);
  return t;
}
