// Effects tied to the scroll position (parallax layers, a heading that slides as the page scrolls, a progress bar, a
// section that fades with the scroll): whatever drives them - a CSS scroll timeline, GSAP ScrollTrigger with scrub,
// framer-motion's useScroll, a hand-written scroll listener - their value is a function of how far the page is
// scrolled. That is what this probe measures, the same way for all of them:
//   - the page is scrolled down through a few positions and every element's transform / opacity / filter read at each;
//   - then back up through the same positions and read again: a scroll-linked value is the same at the same position
//     whichever way the page got there; a one-shot reveal is not (it stays revealed), a bar that hides on the way down
//     and comes back on the way up is not (it depends on the direction) - both are other probes' business;
//   - at the last position the page is held still and read once more: what changes on its own is a time loop, not this.
// The copy scrubs keyframes built from those samples by the page's scroll progress (ir/motion.js, js/motion.js).
// Positions are kept as shares of the page's scroll range, so the effect follows the page at any window size.
import { decomposeTransform } from './reveal.js';

/** Scroll positions read (the top, the bottom and evenly in between), and at most this many elements reported. */
export const SCROLL_POSITIONS = 9;
export const MAX_SCROLL_LINKED = 24;
const SETTLE_MS = 160;

/** Page function: the readings down and up, and which elements also change while the page stands still. */
export async function readScrollSamples({ positions = 9, settleMs = 160, maxNodes = 5000 } = {}) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (SKIP.has(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const root = document.documentElement;
  const max = Math.max(0, root.scrollHeight - innerHeight);
  if (max < 200) return { max, elements: [] };
  const els = [...document.body.querySelectorAll('*')].filter((e) => !SKIP.has(e.tagName.toUpperCase())).slice(0, maxNodes);
  const read = () => els.map((el) => {
    const cs = getComputedStyle(el);
    return `${cs.transform}|${cs.opacity}|${cs.filter}|${cs.translate}|${cs.rotate}|${cs.scale}`;
  });
  const behavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  const ys = Array.from({ length: positions }, (_, k) => Math.round((max * k) / (positions - 1)));
  const at = async (y) => {
    window.scrollTo(0, y);
    await frames();
    await sleep(settleMs);
    return read();
  };
  const down = [];
  for (const y of ys) down.push(await at(y));
  // Held still at the bottom: anything that changes now is moving by itself.
  await sleep(400);
  const still = read();
  const up = [];
  for (const y of [...ys].reverse()) up.unshift(await at(y));
  window.scrollTo(0, 0);
  root.style.scrollBehavior = behavior;
  const elements = [];
  els.forEach((el, i) => {
    const values = down.map((d) => d[i]);
    if (new Set(values).size < 2) return; // never changed with the scroll
    if (still[i] !== down[down.length - 1][i]) return; // moves by itself: a time loop
    if (up.some((u, k) => u[i] !== down[k][i])) return; // depends on the way the page got there: not scroll-linked
    const path = pathOf(el);
    if (!path) return;
    const r = el.getBoundingClientRect();
    // Driven by a scroll timeline the page's own CSS declares: an as-is copy keeps that CSS, so it is already there.
    const declared = (el.getAnimations?.() ?? []).some((a) => a.timeline && a.timeline !== document.timeline);
    elements.push({ path, tag: el.tagName.toLowerCase(), rect: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], values, ...(declared && { declared: true }) });
  });
  return { max, ys, elements };
}

const num = (s) => Number.parseFloat(s);
/** One reading ("transform|opacity|filter|translate|rotate|scale") as the channels the copy animates. */
export function channelsOf(reading) {
  const [transform, opacity, filter, translate, rotate, scale] = String(reading).split('|');
  const d = decomposeTransform(transform) ?? { translate: [0, 0], scale: [1, 1], rotate: 0 };
  const tr = String(translate ?? 'none') === 'none' ? [0, 0] : translate.split(/\s+/).map(num).map((v) => (Number.isFinite(v) ? v : 0));
  const rot = String(rotate ?? 'none') === 'none' ? 0 : num(rotate.split(/\s+/).pop()) || 0;
  const sc = String(scale ?? 'none') === 'none' ? 1 : num(scale.split(/\s+/)[0]) || 1;
  return {
    x: d.translate[0] + (tr[0] ?? 0),
    y: d.translate[1] + (tr[1] ?? 0),
    rot: d.rotate + rot,
    scale: d.scale[0] * sc,
    opacity: num(opacity),
    filter: filter && filter !== 'none' ? filter : null,
  };
}

/**
 * The scroll-linked elements of a page: for each, its samples as shares of the scroll range (0 = top, 1 = bottom) and
 * the channels that change. Only the outermost of a group that moves together is kept (a parallax layer, not also its
 * children - their own values do not change anyway). Pure past the page function.
 */
export function analyzeScrollSamples(raw) {
  if (!raw?.elements?.length) return [];
  const out = [];
  for (const e of raw.elements) {
    const ch = e.values.map(channelsOf);
    const range = (k) => Math.max(...ch.map((c) => c[k])) - Math.min(...ch.map((c) => c[k]));
    const moving = {
      x: range('x') >= 2, y: range('y') >= 2, rot: range('rot') >= 1, scale: range('scale') >= 0.01, opacity: range('opacity') >= 0.02,
      filter: new Set(ch.map((c) => c.filter)).size > 1,
    };
    if (!Object.values(moving).some(Boolean)) continue;
    out.push({
      path: e.path, tag: e.tag, rect: e.rect, ...(e.declared && { declared: true }),
      channels: Object.keys(moving).filter((k) => moving[k]),
      samples: ch.map((c, k) => ({ at: Math.round((raw.ys[k] / raw.max) * 1000) / 1000, ...c })),
    });
  }
  return out.slice(0, MAX_SCROLL_LINKED);
}

/** Scrolls the page down and up and returns its scroll-linked effects. Never throws. */
export async function captureScrollLinked(page) {
  const started = Date.now();
  const raw = await page.evaluate(readScrollSamples, { positions: SCROLL_POSITIONS, settleMs: SETTLE_MS }).catch(() => null);
  const elements = analyzeScrollSamples(raw);
  return { elements, positions: raw?.ys?.length ?? 0, scrollRange: raw?.max ?? 0, ms: Date.now() - started };
}
