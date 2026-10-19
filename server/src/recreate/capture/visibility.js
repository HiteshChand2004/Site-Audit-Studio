// @ts-check
// What the visitor sees, element by element (CLONER_SPEC Phase 1 items 7 and 14), read on the original once the page has
// settled (scrolled through, back at the top) and read the same way on the copy by verify/visibility.js:
//   visibility.json  - every element with text of its own or a picture (img / svg / video / canvas): visible or not, and
//                      when not, why (display, visibility, opacity, zero size, clipped by a collapsed parent, transformed or
//                      placed off the document) and which element in its chain causes it (the "culprit").
//   animations.json  - document.getAnimations() in short (type, name, target path, iterations, duration; capture/loops.js
//                      scanAnimations with `all`, no second scanner) plus the CSSOM's :hover / :focus rule counts and
//                      @keyframes names.
// Page functions are self-contained (Playwright sends only their source).
import { scanAnimations } from './loops.js';

/** Elements recorded per page and view (the original); the copy reads more (state copies, extras). */
export const MAX_VISIBILITY_ELEMENTS = 3000;
export const MAX_ANIMATIONS = 400;
export const visibilityFile = (viewId) => (viewId === 'desktop' ? 'visibility.json' : `${viewId}-visibility.json`);
export const ANIMATIONS_FILE = 'animations.json';

/**
 * Page function: the visibility of every element with own text or a picture.
 *   `record: true` only remembers which elements are visible right now (window.__sasVisSeen) and returns null: the copy
 *   side calls it at each scroll step, so a reveal that played while its element was in view counts as shown;
 *   otherwise it returns the entries, `seen` merged in (visible at some point = visible).
 * Entry: { path, sid, tag, text, visible, reason?, by?: { path, sid, tag, prop, motion, isIn, attrs } }.
 * @param {{ max?: number, record?: boolean }} o
 */
export function readVisibility({ max = 3000, record = false }) {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const MEDIA = new Set(['img', 'svg', 'video', 'canvas']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP_TAGS.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  const w = /** @type {any} */ (window);
  w.__sasVisSeen ??= new WeakSet();
  const seen = w.__sasVisSeen;
  const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, innerHeight);
  const styles = new Map();
  const style = (el) => {
    let cs = styles.get(el);
    if (!cs) styles.set(el, (cs = getComputedStyle(el)));
    return cs;
  };
  const ownText = (el) => [...el.childNodes].some((c) => c.nodeType === 3 && /\S/.test(c.nodeValue ?? ''));
  const chainOf = (el) => {
    const chain = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) chain.push(e);
    return chain;
  };
  const transformed = (cs) => (cs.transform && cs.transform !== 'none') || (cs.translate && cs.translate !== 'none') || (cs.scale && cs.scale !== 'none');
  // A repeating animation (a blink, a pulse) is "on screen" whatever the instant it is read at.
  const looping = (el) => (el.getAnimations?.() ?? []).some((a) => {
    const t = a.effect?.getComputedTiming?.();
    return t && !Number.isFinite(t.iterations) && a.playState === 'running';
  });
  /** Why the element is not seen, and the element of its chain that causes it; null when it is seen. */
  const judge = (el) => {
    const chain = chainOf(el);
    const none = [...chain].reverse().find((e) => style(e).display === 'none');
    if (none) return { reason: 'display', by: none, prop: 'display' };
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: false })) {
      const closed = el.closest('details:not([open])');
      return { reason: 'display', by: closed ?? el, prop: closed ? 'details' : 'content-visibility' };
    }
    if (/hidden|collapse/.test(style(el).visibility)) {
      // The outermost element of the run that is hidden (visibility is inherited).
      let by = el;
      for (const e of chain) {
        if (!/hidden|collapse/.test(style(e).visibility)) break;
        by = e;
      }
      return { reason: 'visibility', by, prop: 'visibility' };
    }
    let product = 1;
    let lowest = null;
    for (const e of chain) {
      const o = Number(style(e).opacity);
      product *= o;
      if (o < 1 && (!lowest || o < Number(style(lowest).opacity))) lowest = e;
    }
    if (product < 0.02 && lowest && !looping(lowest)) return { reason: 'opacity', by: lowest, prop: 'opacity' };
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      const scaled = chain.find((e) => transformed(style(e)) && (e.getBoundingClientRect().width < 1 || e.getBoundingClientRect().height < 1));
      if (scaled) return { reason: 'transform', by: scaled, prop: 'transform' };
      return { reason: 'size', by: el, prop: r.height < 1 ? 'height' : 'width' };
    }
    // Clipped away by a parent that collapsed (an accordion's closed answer: height 0, overflow hidden).
    for (const e of chain.slice(1)) {
      const cs = style(e);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = e.getBoundingClientRect();
      if (pr.height < 1) return { reason: 'clipped', by: e, prop: 'height' };
      if (pr.width < 1) return { reason: 'clipped', by: e, prop: 'width' };
    }
    // Entirely outside the document (page coordinates; fixed elements against the window).
    const fixed = chain.some((e) => style(e).position === 'fixed');
    const x = r.left + (fixed ? 0 : scrollX);
    const y = r.top + (fixed ? 0 : scrollY);
    const [W, H] = fixed ? [innerWidth, innerHeight] : [docW, docH];
    if (x + r.width <= 0 || y + r.height <= 0 || x >= W || y >= H) {
      const moved = chain.find((e) => transformed(style(e)));
      return moved ? { reason: 'transform', by: moved, prop: 'transform' } : { reason: 'offscreen', by: el, prop: 'position' };
    }
    return null;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = /** @type {Element|null} */ (walker.nextNode()); el && out.length < max; el = /** @type {Element|null} */ (walker.nextNode())) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    const tag = el.tagName.toLowerCase();
    // The inside of an inline SVG is the SVG's (one picture).
    if (el.parentElement?.closest('svg')) continue;
    if (!MEDIA.has(tag) && !ownText(el)) continue;
    const verdict = judge(el);
    if (record) {
      if (!verdict) seen.add(el);
      out.push(0);
      continue;
    }
    const visible = !verdict || seen.has(el);
    const by = verdict?.by;
    out.push({
      path: pathOf(el), sid: el.getAttribute('data-sas-id'), tag,
      text: MEDIA.has(tag) ? null : (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      visible,
      ...(!visible && verdict && {
        reason: verdict.reason,
        by: {
          path: pathOf(by), sid: by.getAttribute('data-sas-id'), tag: by.tagName.toLowerCase(), prop: verdict.prop,
          motion: by.getAttribute('data-motion'), isIn: by.classList.contains('is-in'),
          attrs: by.getAttributeNames().filter((n) => /^data-(w-|sas-v|sas-a|framer-appear)/.test(n) || n === 'hidden'),
        },
      }),
    });
  }
  return record ? null : out;
}

/** Reads the visibility of the page in front (capture side, the settled original at the top). */
export const captureVisibility = (page) => page.evaluate(readVisibility, { max: MAX_VISIBILITY_ELEMENTS });

/**
 * Page function wrapper: the page's animations in short (scanAnimations with `all`).
 * @param {import('playwright').Page} page
 */
export async function captureAnimations(page) {
  const scan = await page.evaluate(scanAnimations, { all: true, max: MAX_ANIMATIONS });
  return summarizeAnimations(scan);
}

/** The comparable shape of one reading: counts per type, names, CSSOM counts. */
export function summarizeAnimations(scan) {
  const byType = {};
  for (const a of scan.items ?? []) byType[a.type] = (byType[a.type] ?? 0) + 1;
  const names = [...new Set((scan.items ?? []).filter((a) => a.type === 'CSSAnimation' && a.name).map((a) => a.name))].sort();
  return {
    total: scan.total ?? 0, byType, names,
    hover: scan.cssom?.hover ?? 0, focus: scan.cssom?.focus ?? 0,
    keyframes: [...(scan.definedKeyframes ?? [])].sort(), unreadableSheets: scan.unreadableSheets ?? 0,
    items: scan.items ?? [],
  };
}
