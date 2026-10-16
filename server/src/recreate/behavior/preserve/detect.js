// @ts-check
// Which parts of a page animate or react to the visitor (CLONER_SPEC Phase 1 items 7-10, 17; what the capture already
// records, read here and never re-measured). Every signal gets one DRIVER, the thing that makes it move:
//   css     a stylesheet rule or a CSS animation / transition the page declared (copyable verbatim)
//   script  the page's own JavaScript (measured, not declared: needs the script or a rebuild to run offline)
//   framer  a Framer appear entrance (its settings are in the page's HTML; behavior/framer/)
//   canvas  a canvas / WebGL / video layer (behavior/video.js records it)
// Signals that sit in the same section are grouped into one component. The section is the HIGHEST ancestor of the
// signal that is still section-sized (≤ MAX_SECTION_PX tall, ≥ half the page wide), so a card, a menu and its marquee
// in one band become one component, and the page's wrappers (taller than the page is worth) are never a component.
import { ancestorsOf } from './dom.js';

/** A section is at most this tall (CSS px). Taller ancestors are page wrappers, not sections. */
export const MAX_SECTION_PX = 1400;
/** A section is at least this share of the page width. */
export const MIN_SECTION_WIDTH_SHARE = 0.5;
/** Signals kept per component in the index (the full list stays in the capture). */
const MAX_SIGNALS_PER_COMPONENT = 80;

/**
 * @typedef {{ kind: string, driver: 'css'|'script'|'framer'|'canvas', path: string, text?: string, detail?: string }} Signal
 */

/**
 * Every animated or reactive signal of one view's motion record.
 * @param {any} motion           capture/index/<view>-motion.json (or motion.json for the desktop view)
 * @param {{ framerPaths?: string[], canvasPaths?: string[] }} [extra]
 * @returns {Signal[]}
 */
export function collectSignals(motion, extra = {}) {
  /** @type {Signal[]} */
  const out = [];
  const add = (/** @type {Signal} */ s) => s.path && out.push(s);
  for (const l of motion?.loops?.loops ?? []) {
    add({ kind: 'loop', driver: l.source === 'script' ? 'script' : 'css', path: l.path, detail: `${l.source}/${l.pattern}` });
  }
  for (const e of motion?.reveal?.elements ?? []) {
    const declared = e.timing?.source === 'transition' || e.timing?.source === 'animation';
    add({ kind: 'reveal', driver: declared ? 'css' : 'script', path: e.path, text: e.text, detail: e.timing?.source });
  }
  for (const h of motion?.hover ?? []) {
    // `expect`: the end values the capture read on hover (prop → [before, after]); the render step checks them.
    add({ kind: 'hover', driver: h.source === 'css' ? 'css' : 'script', path: h.path, text: h.text, expect: h.changes ? Object.fromEntries(Object.entries(h.changes).map(([k, v]) => [k, v[1]])) : undefined });
  }
  for (const f of motion?.focus ?? []) add({ kind: 'focus', driver: 'css', path: f.path, text: f.text });
  for (const w of motion?.clicks?.widgets ?? motion?.clicks?.items ?? []) {
    add({ kind: 'click', driver: 'script', path: w.trigger ?? w.targets?.[0], text: w.text, detail: w.kind });
  }
  for (const a of motion?.feeds?.areas ?? []) add({ kind: 'feed', driver: 'script', path: a.path, detail: `${a.states} states` });
  for (const f of motion?.pointer?.followers ?? []) add({ kind: 'pointer', driver: 'script', path: f.path });
  for (const e of motion?.scrollLinked?.elements ?? []) add({ kind: 'scroll-linked', driver: 'script', path: e.path });
  for (const p of extra.framerPaths ?? []) add({ kind: 'framer-appear', driver: 'framer', path: p });
  for (const p of extra.canvasPaths ?? []) add({ kind: 'canvas', driver: 'canvas', path: p });
  return out;
}

/**
 * Picks the section of one signal: the highest ancestor (or the element itself) that is section-sized.
 * @param {string} path
 * @param {Map<string, { tag: string, rect: number[]|null }>} snapshot
 * @param {number} pageWidth
 */
export function sectionOf(path, snapshot, pageWidth) {
  const candidates = [...ancestorsOf(path).filter((p) => p !== 'body'), path];
  for (const p of candidates) {
    const rect = snapshot.get(p)?.rect;
    if (!rect) continue;
    const [, , w, h] = rect;
    if (h <= MAX_SECTION_PX && w >= pageWidth * MIN_SECTION_WIDTH_SHARE) return p;
  }
  return path;
}

/**
 * Groups signals into components by their section.
 * @param {Signal[]} signals
 * @param {{ snapshot: Map<string, { tag: string, rect: number[]|null }>, pageWidth: number }} o
 */
export function groupComponents(signals, { snapshot, pageWidth }) {
  /** @type {Map<string, { root: string, rect: number[]|null, signals: Signal[] }>} */
  const groups = new Map();
  for (const s of signals) {
    const root = sectionOf(s.path, snapshot, pageWidth);
    if (!groups.has(root)) groups.set(root, { root, rect: snapshot.get(root)?.rect ?? null, signals: [] });
    groups.get(root)?.signals.push(s);
  }
  const components = [...groups.values()].sort((a, b) => (a.rect?.[1] ?? 0) - (b.rect?.[1] ?? 0) || a.root.localeCompare(b.root));
  return components.map((g, i) => {
    /** @type {Record<string, number>} */
    const kinds = {};
    const drivers = new Set();
    for (const s of g.signals) {
      kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
      drivers.add(s.driver);
    }
    return {
      id: `c${String(i + 1).padStart(2, '0')}`,
      root: g.root,
      rect: g.rect,
      kinds,
      drivers: [...drivers].sort(),
      signalCount: g.signals.length,
      signals: g.signals.slice(0, MAX_SIGNALS_PER_COMPONENT),
    };
  });
}
