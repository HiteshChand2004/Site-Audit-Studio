// The accessibility attributes a removed runtime set once the page had loaded. A framework's or a builder's script often finishes
// a page's controls in the browser: a dropdown toggle gets role="button", tabindex="0", aria-haspopup, aria-expanded and an id its
// aria-controls names; a tab list gets its roles; a dialog its aria-modal. A page written without that runtime (runtimeFree.js)
// keeps the HTML as the server sent it, so those controls lose their names and roles: Lighthouse then finds nothing to check where
// the original passed ("does not apply"), the copy's accessibility score is lower, and a keyboard or a screen reader cannot reach
// what it could on the original.
//
// The evidence is the as-is page itself, loaded with its runtime (readLoadedA11y): every body element's accessibility attributes
// once the page is loaded, scrolled through and back at the top, read at each of the check's widths and twice there, a moment
// apart (loadedStyles.js reads the same way). An attribute is written into the page only when
//   - the HTML's element has no such attribute (nothing the server sent is changed or taken away),
//   - it holds the same value on both readings and at every width (a state a script keeps changing is not the page's own),
//   - the element is the one of the HTML: same path (the capture's `tag:n` rule), same tag, same classes,
//   - an attribute naming other elements by id (aria-controls, aria-labelledby...) names only ids the page has, or that are added
//     with it; an id is added only when no other element of the page has it.
// Nothing of the look depends on these attributes in the copy's own HTML any more than it did on the original once its script
// ran; the look gate (fixGate) still holds the page to the as-is page with its runtime.
import * as cheerio from 'cheerio';
import { elementsByPath, STABLE_MS } from './loadedStyles.js';

/** Most elements given attributes per page. */
export const MAX_ELEMENTS = 1000;
/** Longest value taken over. */
export const MAX_VALUE = 500;

/** The attributes this carries over: roles, keyboard reach, ARIA, the names images and frames are read by, and ids for references. */
export const isA11yAttr = (name) => name === 'role' || name === 'tabindex' || name === 'id' || name === 'alt' || name === 'title' || /^aria-/.test(name);
/** The ARIA attributes whose value is a list of ids. */
export const ID_REFS = new Set(['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto']);

const classSet = (v) => String(v ?? '').split(/\s+/).filter(Boolean).sort().join(' ');

/** In the page: every body element's tag, classes and accessibility attributes (see isA11yAttr). Runs in the browser. */
export function pageA11y() {
  const pick = (name) => name === 'role' || name === 'tabindex' || name === 'id' || name === 'alt' || name === 'title' || /^aria-/.test(name);
  const out = {};
  const walk = (node, at) => {
    const seen = new Map();
    for (const c of node.children) {
      const tag = c.localName;
      const n = (seen.get(tag) ?? 0) + 1;
      seen.set(tag, n);
      const p = `${at}>${tag}:${n}`;
      const attrs = {};
      for (const a of c.attributes) if (pick(a.name)) attrs[a.name] = a.value;
      if (Object.keys(attrs).length) out[p] = { tag, cls: (typeof c.className === 'string' ? c.className : c.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort().join(' '), attrs };
      // An inline SVG's insides are drawing, not controls.
      if (tag !== 'svg') walk(c, p);
    }
  };
  if (document.body) walk(document.body, 'body');
  return out;
}

/**
 * The settled accessibility attributes of the as-is page, read at each width (see the head of this file).
 * @param {(width: number) => Promise<import('playwright').Page>} openAt  opens a page at a width, loaded and scrolled; closes with page.context()
 * @returns {Promise<{ width: number, attrs: Record<string, object> }[]>}
 */
export async function readLoadedA11y(openAt, widths) {
  const readings = [];
  for (const width of widths) {
    const page = await openAt(width);
    try {
      const first = await page.evaluate(pageA11y);
      await page.waitForTimeout(STABLE_MS);
      const second = await page.evaluate(pageA11y);
      const attrs = {};
      for (const [p, a] of Object.entries(first)) {
        const b = second[p];
        if (!b || b.tag !== a.tag || b.cls !== a.cls) continue;
        // Only what both readings agree on.
        const same = Object.fromEntries(Object.entries(a.attrs).filter(([k, v]) => b.attrs[k] === v));
        attrs[p] = { tag: a.tag, cls: a.cls, attrs: same };
      }
      readings.push({ width, attrs });
    } finally {
      await page.context().close().catch(() => {});
    }
  }
  return readings;
}

/**
 * What to write: for each element, the accessibility attributes the runtime added that the HTML lacks, settled and the same at
 * every width. Pure: the readings of readLoadedA11y against the page's HTML.
 * @returns {{ list: { path: string, tag: string, cls: string, attrs: Record<string, string> }[], varies: number, refsDropped: number }}
 */
export function loadedA11yChanges(html, readings) {
  const $ = cheerio.load(html);
  const els = elementsByPath($);
  const paths = new Set(readings.flatMap((r) => Object.keys(r.attrs)));
  const ids = new Set($('[id]').toArray().map((e) => e.attribs.id));
  const list = [];
  let varies = 0;
  for (const p of paths) {
    const el = els.get(p);
    if (!el) continue;
    const tag = el.name;
    const cls = classSet(el.attribs?.class);
    const seen = readings.map((r) => r.attrs[p]);
    // The same element on every reading (a runtime that swapped it is not this element any more).
    if (seen.some((s) => !s || s.tag !== tag || s.cls !== cls)) continue;
    const names = new Set(seen.flatMap((s) => Object.keys(s.attrs)));
    const add = {};
    for (const name of names) {
      if (el.attribs?.[name] != null) continue;
      const values = new Set(seen.map((s) => s.attrs[name]));
      if (values.size !== 1 || values.has(undefined)) { varies++; continue; }
      const value = [...values][0];
      if (String(value).length > MAX_VALUE) { varies++; continue; }
      add[name] = value;
    }
    if (add.id != null && ids.has(add.id)) delete add.id;
    if (Object.keys(add).length) list.push({ path: p, tag, cls, attrs: add });
    if (list.length >= MAX_ELEMENTS) break;
  }
  // References: only to ids the page will have.
  const willHave = new Set([...ids, ...list.map((c) => c.attrs.id).filter(Boolean)]);
  let refsDropped = 0;
  for (const c of list) {
    for (const name of Object.keys(c.attrs)) {
      if (!ID_REFS.has(name)) continue;
      if (!String(c.attrs[name]).split(/\s+/).filter(Boolean).every((id) => willHave.has(id))) { delete c.attrs[name]; refsDropped++; }
    }
  }
  return { list: list.filter((c) => Object.keys(c.attrs).length), varies, refsDropped };
}

/** The page with the settled accessibility attributes added (see loadedA11yChanges); an element that is not there any more is skipped. */
export function withLoadedA11y(html, list) {
  if (!list?.length) return { html, written: 0, attrs: 0 };
  const $ = cheerio.load(html);
  const els = elementsByPath($);
  let written = 0;
  let attrs = 0;
  for (const c of list) {
    const el = els.get(c.path);
    if (!el || el.name !== c.tag || classSet(el.attribs?.class) !== c.cls) continue;
    let any = false;
    for (const [name, value] of Object.entries(c.attrs)) {
      if (el.attribs?.[name] != null) continue;
      $(el).attr(name, value);
      attrs++;
      any = true;
    }
    if (any) written++;
  }
  return written ? { html: $.html(), written, attrs } : { html, written: 0, attrs: 0 };
}
