// Scroll states of fixed / sticky bars (step 3 of the "as is" fixes): a header that turns light with dark links once the page
// is scrolled past the hero. The capture reads the page at the top only, so the copy kept the top look everywhere. Here each
// fixed or sticky element (and what is inside it) is read at the top and further down; when its look changed, the scroll
// position where it changes is searched (to ~10 px), and what the bar looks like there is kept. A bar that hides itself while
// scrolling down and comes back when scrolling up changes by direction, not by position: what reverts after a small scroll
// up is left out. Nothing is identified by class name.
//
// Output: `node.scrolled = { at, viewport, parts: [{ rel, changes: { prop: [top, scrolled] }, before?, after? }] }` on the
// snapshot node of the bar (capture/<slug>/<view>.json); `at` = scroll position in px, `viewport` = the window height.

import { scrollToY } from './index.js';

const PROPS = ['color', 'background-color', 'background-image', 'border-bottom-color', 'border-bottom-width', 'box-shadow', 'backdrop-filter',
  'opacity', 'fill', 'stroke', 'filter', 'padding-top', 'padding-bottom', 'height', 'font-size'];
const PSEUDO = ['content', 'color', 'background-color', 'opacity'];

/** Page function: the bars (fixed / sticky elements, outermost) with the style of each part, keyed by snapshot path. */
export function readBars({ props, pseudo }) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let i = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP.has(s.tagName)) continue;
        if (s.tagName === n.tagName) i++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${i}`);
    }
    return parts.reverse().join('>');
  };
  const bars = [];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (SKIP.has(el.tagName)) continue;
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    if (bars.some((b) => b.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.5 || r.height < 20 || r.height > innerHeight * 0.4) continue; // a bar, not a dialog or a widget
    bars.push(el);
  }
  const out = {};
  for (const bar of bars.slice(0, 4)) {
    const parts = {};
    let n = 0;
    const walk = (el, rel) => {
      if (n++ > 300) return;
      const cs = getComputedStyle(el);
      const entry = { s: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])) };
      for (const w of ['before', 'after']) {
        const pcs = getComputedStyle(el, `::${w}`);
        if (pcs.content && pcs.content !== 'none' && pcs.content !== 'normal') entry[w] = Object.fromEntries(pseudo.map((p) => [p, pcs.getPropertyValue(p)]));
      }
      parts[rel] = entry;
      if (el.tagName.toLowerCase() === 'svg') return;
      const idx = {};
      for (const c of el.children) {
        if (SKIP.has(c.tagName)) continue;
        const t = c.tagName.toLowerCase();
        idx[t] = (idx[t] || 0) + 1;
        walk(c, `${rel ? `${rel}>` : ''}${t}:${idx[t]}`);
      }
    };
    walk(bar, '');
    out[pathOf(bar)] = parts;
  }
  return out;
}

const pairs = (a = {}, b = {}) => {
  const c = {};
  for (const k of Object.keys(b)) if (a[k] !== b[k]) c[k] = [a[k] ?? null, b[k]];
  return c;
};

/** What differs between two reads of one bar: [{ rel, changes, before?, after? }]. */
export function barDiff(top, down) {
  const parts = [];
  for (const [rel, d] of Object.entries(down ?? {})) {
    const t = top?.[rel];
    if (!t) continue;
    const part = { rel, changes: pairs(t.s, d.s) };
    for (const w of ['before', 'after']) {
      if (t[w] || d[w]) {
        const c = pairs(t[w] ?? { content: 'none' }, d[w] ?? { content: 'none' });
        if (Object.keys(c).length) part[w] = c;
      }
    }
    if (Object.keys(part.changes).length || part.before || part.after) parts.push(part);
  }
  return parts;
}

/** Leaves out what a small scroll back up undid (a bar reacting to the direction, not the position). */
export function keepPositional(parts, backUp) {
  return parts.map((p) => {
    const now = backUp?.[p.rel];
    const keep = (changes, at) => Object.fromEntries(Object.entries(changes).filter(([k, [, v]]) => (at ? at[k] === v : true)));
    const out = { rel: p.rel, changes: keep(p.changes, now?.s) };
    for (const w of ['before', 'after']) if (p[w]) out[w] = keep(p[w], now?.[w]);
    return out;
  }).filter((p) => Object.keys(p.changes).length || (p.before && Object.keys(p.before).length) || (p.after && Object.keys(p.after).length));
}

/**
 * Finds the scroll states of the page's bars and writes them onto the snapshot (`body`). The page ends at the top again.
 * @returns {Promise<{ bars: number, ms: number }>}
 */
export async function probeScrollStates(page, body, view) {
  const started = Date.now();
  const opts = { props: PROPS, pseudo: PSEUDO };
  // Like a visitor (the mouse wheel; scrollTo as a fallback): a script that owns the scroll ignores scrollTo, and the bar
  // reacts to the scroll the script reports.
  await page.mouse.move(Math.min(20, view.width / 4), Math.round(view.height / 2)).catch(() => {});
  const scrollTo = async (y) => {
    await scrollToY(page, y);
    await page.waitForTimeout(220);
  };
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const read = () => page.evaluate(readBars, opts);
  await scrollTo(0);
  const top = await read();
  if (!Object.keys(top).length) return { bars: 0, ms: Date.now() - started };
  // Further down in steps: the first position where a bar looks different.
  const steps = [0.25, 0.5, 0.8, 1.0, 1.3, 1.8, 2.5].map((k) => Math.round(view.height * k)).filter((y) => y < height - view.height / 2);
  let lo = 0;
  let hi = null;
  for (const y of steps) {
    await scrollTo(y);
    const now = await read();
    if (Object.entries(top).some(([p, parts]) => barDiff(parts, now[p]).length)) {
      hi = y;
      break;
    }
    lo = y;
  }
  let found = 0;
  if (hi != null) {
    // The threshold, to ~10 px.
    while (hi - lo > 10) {
      const mid = Math.round((lo + hi) / 2);
      await scrollTo(mid);
      const now = await read();
      if (Object.entries(top).some(([p, parts]) => barDiff(parts, now[p]).length)) hi = mid;
      else lo = mid;
    }
    await scrollTo(hi + 60);
    const down = await read();
    await scrollTo(hi + 20); // a small scroll back up, still past the threshold
    const backUp = await read();
    for (const [p, parts] of Object.entries(top)) {
      const kept = keepPositional(barDiff(parts, down[p]), backUp[p]);
      if (!kept.length) continue;
      const walk = (n) => {
        if (!n || 'text' in n) return null;
        if (n.path === p) return n;
        for (const c of n.children ?? []) {
          const hit = p.startsWith(`${c.path}>`) || c.path === p ? walk(c) : null;
          if (hit) return hit;
        }
        return null;
      };
      const node = walk(body);
      if (node) {
        node.scrolled = { at: hi, viewport: view.height, parts: kept };
        found++;
      }
    }
  }
  await scrollTo(0);
  return { bars: found, ms: Date.now() - started };
}
