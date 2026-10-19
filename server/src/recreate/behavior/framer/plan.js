// @ts-check
// Framer appear animations in the copy (CLONER_SPEC Phase 2A item 2): the settings the page shipped (appear.js) are put on
// the captured elements they name (capture.js) and become a per-page program the copy runs with the `motion` package
// (emit.js) - the same entrance, timing, easing and spring the original ran, from the original's own numbers rather than
// from a measurement of it. They win over the measured entrance of that element (ir/motion.js leaves it alone: two
// animations on one element replace each other); both counts are reported.
//
// Safe fallback: an element marked as an appear target whose settings are missing or not understood is never left in its
// first pose. A rebuilt page drops a first pose the capture caught it in (ir/motion.js frozenEntrances, which also covers
// any other entrance the page never played); an as-is page (exact mode) has the original's inline style, so a near-
// invisible first pose there is replaced by the end state the settings give, or removed when there are none.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { networkDir } from '../../capture/index.js';
import { APPEAR_ATTR, keyframesOf, motionOptions, parseAppearConfig, transformOf } from './appear.js';

export const APPEAR_PROGRAM_VERSION = 1;
export const MOTION_PACKAGE_VERSION = '13.4.6';
/** At or below this opacity an inline first pose paints nothing a visitor can see. */
const INVISIBLE = 0.05;

/**
 * The page's document as the server sent it (before any script ran), from the job's network record. Null when the record
 * does not hold it (an older capture, a page rebuilt from evidence).
 * @param {{ dir: string, netCache?: any }} ctx
 * @param {{ url: string }} info
 */
export async function readDocumentHtml(ctx, info) {
  const pathname = (() => {
    try {
      return new URL(info.url).pathname;
    } catch {
      return null;
    }
  })();
  const record = ctx.netCache?.record;
  if (record) {
    await record.flush?.();
    const hit = record.entryOf(info.url);
    if (hit?.file) return readFile(hit.file, 'utf8').catch(() => null);
  }
  let index;
  try {
    index = JSON.parse(await readFile(path.join(networkDir(ctx.dir), 'index.json'), 'utf8'));
  } catch {
    return null;
  }
  const byUrl = new Map((index.entries ?? []).map((e) => [e.url, e]));
  let entry = byUrl.get(info.url);
  for (let hops = 0; entry?.redirect && hops < 10; hops++) entry = byUrl.get(entry.redirect);
  // The page's main document by the page it was recorded for (a redirect the record did not keep as a hop).
  if (!entry?.sha && pathname) entry = (index.entries ?? []).find((e) => e.kind === 'document' && e.frame !== 'child' && e.sha && (e.pages ?? []).includes(pathname));
  if (!entry?.sha) return null;
  return readFile(path.join(networkDir(ctx.dir), 'files', entry.sha), 'utf8').catch(() => null);
}

/** Replay ids for appear targets (`fN`, beside the animation library's `aN` in the same `data-sas-a` attribute). */
export function appearIds() {
  let n = 0;
  return { next: () => `f${++n}` };
}

/** One spec of the program: the browser keyframes, motion's options, the trigger. */
const specOf = (e) => ({
  keyframes: keyframesOf(e),
  options: motionOptions(e.transition),
  trigger: e.trigger,
  ...(e.viewport && { viewport: e.viewport }),
});

/**
 * Builds a page's appear program and marks its targets.
 * @param {{ config: ReturnType<typeof parseAppearConfig> | null, elements: { id: string, path: string }[], nodes: Map<string, any>, ids: { next: () => string }, measured?: Set<string> }} o
 *   measured: capture paths the capture measured an entrance for (capture/reveal.js), to report how many the settings replaced
 * @returns {{ program: object | null, owned: Set<string>, stats: object }}
 */
export function planAppear({ config, elements, nodes, ids, measured = new Set() }) {
  const stats = { elements: elements.length, configured: 0, replayed: 0, load: 0, inView: 0, spring: 0, variants: 0, unmapped: 0, missing: 0, garbled: 0, off: 0, notOnPage: 0, measuredReplaced: 0, dropped: 0 };
  const owned = new Set();
  const byId = new Map();
  for (const e of config?.entries ?? []) {
    const list = byId.get(e.appearId) ?? [];
    list.push(e);
    byId.set(e.appearId, list);
  }
  const offIds = new Map();
  for (const o of config?.off ?? []) offIds.set(o.appearId, [...(offIds.get(o.appearId) ?? []), o.variant]);
  const garbledIds = new Set((config?.unknown ?? []).map((u) => u.appearId).filter(Boolean));
  stats.configured = new Set([...byId.keys(), ...offIds.keys()]).size;
  const seen = new Set();
  const entries = [];
  const targetOf = new Map(); // appear id → its replay id (the same id on every element that carries it)
  for (const el of elements) {
    seen.add(el.id);
    const node = nodes.get(el.path);
    if (!node) {
      stats.unmapped++;
      continue;
    }
    const specs = byId.get(el.id);
    if (!specs?.length) {
      if (offIds.has(el.id) && !garbledIds.has(el.id)) {
        // Switched off at every breakpoint the page lists: Framer shows it as it is, so does the copy.
        stats.off++;
      } else if (garbledIds.has(el.id)) stats.garbled++;
      else stats.missing++;
      node.appear = 'fallback';
      continue;
    }
    let target = targetOf.get(el.id);
    if (!target) {
      target = ids.next();
      targetOf.set(el.id, target);
      const variants = {};
      for (const s of specs) {
        variants[s.variant] = specOf(s);
        if (s.dropped?.length) stats.dropped += s.dropped.length;
      }
      for (const v of offIds.get(el.id) ?? []) variants[v] = null;
      const main = specs.find((s) => s.variant === 'default') ?? specs[0];
      entries.push({ target, appearId: el.id, variants });
      stats[main.trigger === 'inView' ? 'inView' : 'load']++;
      if (specs.some((s) => s.transition.type === 'spring')) stats.spring++;
      if (Object.keys(variants).length > 1) stats.variants++;
    }
    (node.animIds ??= []).includes(target) || node.animIds.push(target);
    node.appear = 'replay';
    owned.add(el.path);
    stats.replayed++;
    if (measured.has(el.path)) stats.measuredReplaced++;
  }
  for (const id of byId.keys()) if (!seen.has(id)) stats.notOnPage++;
  const program = entries.length
    ? { version: APPEAR_PROGRAM_VERSION, motion: MOTION_PACKAGE_VERSION, breakpoints: (config?.breakpoints ?? []).filter((b) => b.media), entries }
    : null;
  return { program, owned, stats };
}

/** Adds one page's counts to the site's. */
export function addAppearStats(into, stats) {
  for (const [k, v] of Object.entries(stats)) into[k] = (into[k] ?? 0) + v;
  return into;
}

// ---- as-is pages (exact mode) -----------------------------------------------------------------------------------------

const declsOf = (css) => String(css).split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const i = d.indexOf(':');
  return i < 0 ? [d, ''] : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
});

/**
 * The inline style of an as-is appear target, never left in a first pose nobody would see: with settings, the end state
 * they give (opacity and transform of the default spec); without, the first pose removed so the stylesheet draws it.
 * Returns the new style text, or null when the style was already showing the element.
 * @param {string} css
 * @param {{ animate: object, transformTemplate?: string } | null} spec  the element's default spec (normalised), or null
 */
export function shownStyle(css, spec) {
  const decls = declsOf(css);
  const opacity = decls.find(([k]) => k === 'opacity');
  const value = opacity ? parseFloat(opacity[1]) : NaN;
  if (!(value <= INVISIBLE)) return null;
  const kept = decls.filter(([k]) => k !== 'opacity' && k !== 'transform');
  if (spec) {
    const end = spec.animate;
    const keys = Object.keys(end).filter((k) => /^(x|y|z|translate[XYZ]|scale[XY]?|rotate[XYZ]?|skew[XY]?|transformPerspective)$/.test(k));
    const lastOf = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
    const state = Object.fromEntries(keys.map((k) => [k, lastOf(end[k])]));
    if (end.opacity != null) kept.push(['opacity', String(lastOf(end.opacity))]);
    if (keys.length) kept.push(['transform', transformOf(state, keys, spec.transformTemplate)]);
  }
  return kept.map(([k, v]) => `${k}: ${v}`).join('; ');
}

/**
 * Exact mode: every as-is element carrying an appear id whose inline style holds it invisible is shown (`shownStyle`).
 * @param {{ pages: { path?: string, outPath?: string, body: any }[] }} ir
 * @param {Map<string, ReturnType<typeof parseAppearConfig>>} configs  page path → its parsed settings
 * @param {(page: any) => string} keyOf  the page's key in `configs`
 * @returns {{ shown: number, withSettings: number }}
 */
export function showAsIsAppear(ir, configs, keyOf) {
  const out = { shown: 0, withSettings: 0 };
  for (const page of ir.pages) {
    const config = configs.get(keyOf(page));
    const specOfId = (id) => {
      const list = (config?.entries ?? []).filter((e) => e.appearId === id);
      return list.find((e) => e.variant === 'default') ?? list[0] ?? null;
    };
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      const id = n.attrs?.[APPEAR_ATTR];
      if (typeof id === 'string' && n.attrs.style != null) {
        const css = typeof n.attrs.style === 'string' ? n.attrs.style : n.attrs.style.css;
        const spec = specOfId(id);
        const next = typeof css === 'string' ? shownStyle(css, spec) : null;
        if (next != null) {
          if (typeof n.attrs.style === 'string') n.attrs.style = next;
          else n.attrs.style = { ...n.attrs.style, css: next };
          out.shown++;
          if (spec) out.withSettings++;
        }
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(page.body);
  }
  return out;
}
