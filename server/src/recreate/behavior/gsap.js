// @ts-check
// Tier 1 replay (CLONER_SPEC Phase 2 item 1): the animation log a page's GSAP calls left (capture/animlog.js) becomes a
// replay program the copy runs with the real gsap package, on the same elements.
//
// The copy's elements are the capture's elements (matched by the snapshot path, `cpath`), so each logged target is found
// in the IR tree and marked with a replay id (`aN`, written as `data-sas-a`); the program names targets by those ids, never
// by the original's selectors (a rebuilt page renames classes, and ids are not kept on every element).
//   - to() calls carry the START values the hook read, and are replayed as fromTo(start, vars): the capture saw the page
//     after its tweens ran, so a to() from that state would not move;
//   - from() / fromTo() / set() as they were; timelines with their chained calls and positions; ScrollTrigger options with
//     their trigger / endTrigger / pin / scroller as replay ids;
//   - a call the library made from inside another one (a tween creating its ScrollTrigger) is not replayed on its own;
//   - a value only a function could give (`{ fn: true }`) is left out of that call and counted; a call left with nothing
//     to animate, or whose targets the copy does not have, is skipped and counted, never guessed.
// Elements a replayed call animates are "owned" by the library: the measured motion (reveals, loops, scroll-linked effects
// of ir/motion.js) is not rebuilt on them too - two animations on one element replace each other.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { animLogFile } from '../capture/animlog.js';

export const GSAP_VERSION = '3.15.0';
export const PROGRAM_VERSION = 1;
/** Keys whose value names elements (a ScrollTrigger's trigger, the element it pins, the one that scrolls). */
const ELEMENT_KEYS = new Set(['trigger', 'endTrigger', 'pin', 'scroller', 'pinnedContainer']);
/** Tween settings rather than animated properties (they are not in `start`). */
const CONTROL = new Set(['duration', 'delay', 'ease', 'repeat', 'repeatDelay', 'yoyo', 'yoyoEase', 'stagger', 'paused', 'overwrite',
  'immediateRender', 'lazy', 'id', 'data', 'scrollTrigger', 'runBackwards', 'startAt', 'inherit', 'reversed', 'keyframes', 'defaults',
  'smoothChildTiming', 'autoRemoveChildren']);

/**
 * The page's animation log (desktop view), or null.
 * @param {string} dir   the recreate workspace
 * @param {{ slug: string }} page
 */
export async function readAnimLogFor(dir, page) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'capture', page.slug, animLogFile('desktop')), 'utf8'));
  } catch {
    return null;
  }
}

const isFn = (v) => v && typeof v === 'object' && v.fn === true;
const isTargets = (v) => v && typeof v === 'object' && v.targets && typeof v.targets === 'object';

/**
 * Builds the replay program of one page and marks its targets.
 * @param {{ entries: any[] }} log
 * @param {Map<string, any>} nodes  cpath → IR node of the page
 * @param {{ next: () => string }} ids  replay id source shared by the site (aN)
 * @returns {{ program: object | null, owned: Set<string>, stats: object }}
 */
export function planReplay(log, nodes, ids) {
  const stats = { calls: 0, replayed: 0, nested: 0, skipped: { unmapped: 0, functionOnly: 0, notElements: 0 }, functionValues: 0, timelines: 0, scrollTriggers: 0, targets: 0 };
  const owned = new Set();
  if (!log?.entries?.length) return { program: null, owned, stats };
  const idOf = new Map(); // cpath → aN

  // Replay ids for a logged target list; null when the copy has none of those elements.
  const refs = (targets) => {
    const out = [];
    for (const t of targets?.list ?? []) {
      const node = t.path ? nodes.get(t.path) : null;
      if (!node) continue;
      let id = idOf.get(t.path);
      if (!id) {
        id = ids.next();
        idOf.set(t.path, id);
        (node.animIds ??= []).push(id);
      }
      out.push(id);
    }
    return out.length ? out : null;
  };
  // vars with element references turned into replay ids and function values left out.
  const cleanVars = (vars, { owner = false } = {}) => {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return vars ?? null;
    const out = {};
    for (const [k, v] of Object.entries(vars)) {
      if (isFn(v)) {
        stats.functionValues++;
        continue;
      }
      if (k === 'scrollTrigger' && v && typeof v === 'object') {
        const st = cleanTrigger(v);
        if (st) out.scrollTrigger = st;
        continue;
      }
      out[k] = v;
    }
    if (owner) return out;
    return out;
  };
  const cleanTrigger = (st) => {
    if (st === true || typeof st === 'string') return st === true ? true : { trigger: null, selector: st };
    const out = {};
    for (const [k, v] of Object.entries(st)) {
      if (isFn(v)) {
        stats.functionValues++;
        continue;
      }
      if (ELEMENT_KEYS.has(k)) {
        // The hook resolved it to elements (capture/animlog.js resolveTrigger); one the copy does not have is left out
        // and counted, so the trigger falls back to the tween's own target as GSAP does.
        if (isTargets(v)) {
          const r = refs(v.targets);
          if (r) out[k] = { ref: r[0] };
          else stats.skipped.triggerUnmapped = (stats.skipped.triggerUnmapped ?? 0) + 1;
        } else if (typeof v === 'boolean') out[k] = v;
        continue;
      }
      out[k] = v;
    }
    stats.scrollTriggers++;
    return out;
  };
  const animated = (vars) => Object.keys(vars ?? {}).some((k) => !CONTROL.has(k) && !k.startsWith('on'));

  const timelines = [];
  const calls = [];
  const touched = new Set(); // `${replayId}|${property}` some earlier call of the program already animates
  for (const e of log.entries) {
    stats.calls++;
    if (e.nested) {
      stats.nested++;
      continue;
    }
    // Started by the capture's hover / click probes, not by loading or scrolling: the hover and click machinery rebuilds
    // those effects; replayed on load they would run without anyone pointing at anything.
    if (e.phase === 'probe') {
      stats.skipped.interaction = (stats.skipped.interaction ?? 0) + 1;
      continue;
    }
    if (e.method === 'timeline') {
      timelines.push({ id: e.id, vars: cleanVars(e.vars) });
      stats.timelines++;
      continue;
    }
    if (e.method === 'create') {
      const st = cleanTrigger(e.vars ?? {});
      if (st && (st.trigger?.ref || st.pin?.ref)) calls.push({ lib: 'ScrollTrigger', method: 'create', vars: st });
      else stats.skipped.unmapped++;
      continue;
    }
    if (e.method === 'add' || e.method === 'call' || e.method === 'addLabel') {
      if (e.method !== 'call' && (e.child != null || e.label)) calls.push({ method: e.method, timeline: e.timeline ?? null, child: e.child ?? null, label: e.label ?? null, position: e.position ?? null });
      continue;
    }
    if (!e.targets?.count && e.targets?.other) {
      stats.skipped.notElements++;
      continue;
    }
    const targets = refs(e.targets);
    if (!targets) {
      stats.skipped.unmapped++;
      continue;
    }
    const vars = cleanVars(e.vars);
    const fromVars = e.method === 'fromTo' ? cleanVars(e.fromVars) : null;
    if (e.method !== 'set' && !animated(vars) && !animated(fromVars)) {
      stats.skipped.functionOnly++;
      continue;
    }
    // to(): replayed from where the original started (the hook's reading), one value set per target, in target order -
    // only for the first tween of the program on that element and property: a later one (the next step of a timeline,
    // a second tween on the same box) continues from where the one before it ended, exactly as a to() does.
    let start = null;
    if (e.method === 'to' && Array.isArray(e.start)) {
      const mapped = (e.targets.list ?? []).map((t, i) => (nodes.has(t.path) ? e.start[i] ?? null : undefined)).filter((s) => s !== undefined);
      if (mapped.length === targets.length && mapped.every(Boolean)) {
        const fresh = Object.keys(vars).filter((k) => !CONTROL.has(k) && !k.startsWith('on') && targets.every((id) => !touched.has(`${id}|${k}`)));
        if (fresh.length) start = mapped.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => fresh.includes(k))));
      }
    }
    for (const id of targets) for (const k of Object.keys(vars ?? {})) touched.add(`${id}|${k}`);
    for (const id of targets) for (const k of Object.keys(fromVars ?? {})) touched.add(`${id}|${k}`);
    for (const t of e.targets.list ?? []) if (nodes.has(t.path)) owned.add(t.path);
    stats.targets += targets.length;
    stats.replayed++;
    calls.push({
      method: start ? 'fromTo' : e.method,
      targets,
      ...(start && { start }),
      ...(fromVars && { fromVars }),
      vars,
      ...(e.timeline != null && { timeline: e.timeline }),
      ...(e.position != null && { position: e.position }),
    });
  }
  const program = calls.length ? { version: PROGRAM_VERSION, timelines, calls, scrollTrigger: stats.scrollTriggers > 0 } : null;
  return { program, owned, stats };
}

/** One source of replay ids for a whole site (a1, a2, …), so ids never repeat across pages that share components. */
export function replayIds() {
  let n = 0;
  return { next: () => `a${++n}` };
}

/** Sums page stats into the site's. */
export function addStats(total, s) {
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
    else if (v && typeof v === 'object') addStats((total[k] ??= {}), v);
  }
  return total;
}
