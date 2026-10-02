// Motion in the IR (Phase 4b.4): what the motion capture (capture/<slug>/motion.json: hover / focus 4b.1, scroll reveal 4b.2,
// continuous loops 4b.3) says about the page elements, turned into platform-free data every emitter can write.
//
// Elements are matched by the `path` of the desktop snapshot (tree.js keeps it as `cpath`). A matched element gets
// motion tokens in one attribute, `data-motion="h1 rv r2 d70"`, and the stylesheet has one rule per distinct effect
// (elements with the same effect share a token), so the markup stays small and no original class name is needed:
//   hN  hover        [data-motion~=hN]:hover { … }  (+ ::before / ::after and descendants), inside @media (hover: hover)
//   fN  focus        [data-motion~=fN]:focus-visible { … }
//   rv  scroll reveal marker (the generated script adds `is-in` when the element scrolls into view) + rN the effect
//       (a from-state, duration, easing), dN a start delay (stagger), rp = hide again when it leaves the view
//   lN  a loop the page's own CSS does not carry (a Web Animation, a script-driven spin / oscillation)
// Without script nothing is hidden: the reveal rules only apply under `.js-motion`, which the script sets. CSS loops
// the stylesheet already carries (animation-name in the element's captured style) are counted, not written twice.
//
// ir.motion = { version, hover: [{ token, decls, pseudo?, kids? }], focus: [...], reveal: [{ token, opacity?, translate?,
//   scale?, rotate?, filter?, duration, easing }], delays: [ms], loops: [{ token, name, keyframes, timing }], script: boolean }
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mapUrls } from './styles.js';
import { isElement } from './tree.js';

export const MOTION_VERSION = 1;
const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?[\d.]+(\s*,\s*-?[\d.]+){3}\s*\)|steps\(\s*\d+\s*(,\s*[\w-]+\s*)?\))$/;
const MAX_DELAY = 2000;
const NO_VALUE = /^(null|undefined)$/;

/** The motion capture of one page (capture/<slug>/motion.json), or null. */
export async function readPageMotion(dir, page) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'capture', page.slug, 'motion.json'), 'utf8'));
  } catch {
    return null;
  }
}

const r1 = (n) => Math.round(n * 10) / 10;

// A hover / focus change as declarations: the value it changes to. Properties without a usable value are left out.
function changeDecls(changes, assetFile) {
  const out = {};
  for (const [prop, pair] of Object.entries(changes ?? {})) {
    let value = pair?.[1];
    if (value == null || NO_VALUE.test(String(value))) continue;
    value = String(value);
    if (/url\(/i.test(value)) {
      const mapped = mapUrls(value, assetFile);
      // A file that was not downloaded is never linked live (mapUrls turns it into `none`): the property is left out.
      if (!/url\("(asset:|data:)/.test(mapped) && !/url\(\s*["']?data:/.test(value)) continue;
      value = mapped;
    }
    out[prop] = value;
  }
  return out;
}

/** A reveal as a from-state: what the element starts at, relative to where it ends (its own styles). */
export function revealSpec(el) {
  const from = el.from;
  const to = el.to;
  const spec = { duration: 600, easing: 'ease' };
  if (from.opacity < 0.95) spec.opacity = from.opacity;
  const f = from.motion;
  const t = to.motion;
  if (f && t) {
    const dx = r1(f.translate[0] - t.translate[0]);
    const dy = r1(f.translate[1] - t.translate[1]);
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) spec.translate = [dx, dy];
    const sx = Math.round((f.scale[0] / (t.scale[0] || 1)) * 100) / 100;
    const sy = Math.round((f.scale[1] / (t.scale[1] || 1)) * 100) / 100;
    if (Math.abs(sx - 1) >= 0.01 || Math.abs(sy - 1) >= 0.01) spec.scale = [sx, sy];
    const rot = r1(f.rotate - t.rotate);
    if (Math.abs(rot) >= 0.5) spec.rotate = rot;
  }
  if (from.filter && from.filter !== 'none' && from.filter !== to.filter) spec.filter = from.filter;
  const d = el.timing?.duration;
  if (Number.isFinite(d) && d > 0) spec.duration = Math.min(3000, Math.max(100, Math.round(d)));
  const e = el.timing?.easing?.css;
  if (e && EASING.test(e)) spec.easing = e;
  return spec;
}

const specKey = (s) => JSON.stringify([s.opacity ?? null, s.translate ?? null, s.scale ?? null, s.rotate ?? null, s.filter ?? null, s.duration, s.easing]);

// Keyframes of a loop (as authored) for @keyframes.
const loopKeyframes = (kfs) => kfs.map((k) => ({ offset: Math.round(k.offset * 10000) / 100, ...(k.easing && k.easing !== 'linear' && { easing: k.easing }), props: k.props }));

/** Loops the page's CSS does not carry, from a script-driven analysis: a steady spin or an oscillation. */
function scriptLoop(loop) {
  const p = loop.params;
  if (loop.pattern === 'spin' && p.rate > 0.5) {
    const deg = p.direction === 'backward' ? -360 : 360;
    return { keyframes: [{ offset: 0, props: { rotate: '0deg' } }, { offset: 100, props: { rotate: `${deg}deg` } }], timing: { duration: Math.round((360 / p.rate) * 1000), delay: 0, iterations: 'infinite', direction: 'normal', fill: 'none', easing: 'linear' } };
  }
  if (loop.pattern === 'oscillate' && p.periodMs >= 200 && p.amplitude > 0 && (p.channel === 'x' || p.channel === 'y')) {
    const a = r1(p.amplitude);
    const v = (n) => (p.channel === 'x' ? `${n}px 0` : `0 ${n}px`);
    return { keyframes: [{ offset: 0, props: { translate: v(-a) } }, { offset: 100, props: { translate: v(a) } }], timing: { duration: Math.round(p.periodMs / 2), delay: 0, iterations: 'infinite', direction: 'alternate', fill: 'none', easing: 'ease-in-out' } };
  }
  return null;
}

/**
 * Attaches motion tokens to the nodes of the page trees and returns the site-level motion (ir.motion) plus a report.
 * @param {{ pages: object[], assetResolve: Function }} site  the prepared site (trees with `info`, `root`)
 * @param {Map<string, object>} byPath  page path → its motion.json
 */
export function applyMotion(site, byPath) {
  const reg = { hover: new Map(), focus: new Map(), reveal: new Map(), loops: [], delays: new Set() };
  const stats = {
    pages: 0,
    hover: { elements: 0, effects: 0, skipped: { script: 0, unmapped: 0, empty: 0 } },
    focus: { elements: 0, effects: 0, skipped: { unmapped: 0, empty: 0 } },
    reveal: { elements: 0, effects: 0, replay: 0, skipped: { timed: 0, unmapped: 0, flat: 0 } },
    loops: { carried: 0, rebuilt: 0, skipped: [] },
  };
  const tokenize = (node, token) => {
    node.motionTokens ??= [];
    if (!node.motionTokens.includes(token)) node.motionTokens.push(token);
  };

  for (const tree of site.pages) {
    const motion = byPath.get(tree.info.path);
    if (!motion) continue;
    stats.pages++;
    const nodes = new Map();
    const walk = (n) => {
      if (!isElement(n)) return;
      if (n.cpath) nodes.set(n.cpath, n);
      for (const alt of n.cpathAlt ?? []) if (!nodes.has(alt)) nodes.set(alt, n);
      n.children.forEach(walk);
    };
    walk(tree.root);
    const assetFile = (url) => site.assetResolve(url, tree.info.url);

    // Hover and focus: one effect per distinct set of changed values.
    const pseudoDecls = (pseudo) => Object.fromEntries(Object.entries(pseudo ?? {}).map(([which, c]) => [which, changeDecls(c, assetFile)]).filter(([, d]) => Object.keys(d).length));
    for (const [kind, list, prefix, s] of [['hover', motion.hover ?? [], 'h', stats.hover], ['focus', motion.focus ?? [], 'f', stats.focus]]) {
      for (const entry of list) {
        const node = nodes.get(entry.path);
        if (!node) {
          s.skipped.unmapped++;
          continue;
        }
        if (entry.domDelta) {
          s.skipped.script = (s.skipped.script ?? 0) + 1; // the effect adds or removes elements: a script, not styles
          continue;
        }
        const decls = changeDecls(entry.changes, assetFile);
        const pseudo = pseudoDecls(entry.pseudo);
        const kids = [];
        for (const k of entry.kids ?? []) {
          const kidNode = nodes.get(k.path);
          const d = changeDecls(k.changes, assetFile);
          if (kidNode && Object.keys(d).length) kids.push({ node: kidNode, decls: d });
        }
        if (!Object.keys(decls).length && !Object.keys(pseudo).length && !kids.length) {
          s.skipped.empty++;
          continue;
        }
        const key = JSON.stringify([decls, pseudo, kids.map((k) => k.decls)]);
        let effect = reg[kind].get(key);
        if (!effect) {
          effect = { token: `${prefix}${reg[kind].size + 1}`, decls, ...(Object.keys(pseudo).length && { pseudo }), kids: kids.map((k, i) => ({ token: `${prefix}${reg[kind].size + 1}k${i + 1}`, decls: k.decls })) };
          reg[kind].set(key, effect);
          s.effects++;
        }
        tokenize(node, effect.token);
        kids.forEach((k, i) => tokenize(k.node, effect.kids[i].token));
        s.elements++;
      }
    }

    // Scroll reveal: those the scroll started (timed ones - rotating headlines, timers - are not scroll effects).
    for (const el of motion.reveal?.elements ?? []) {
      if (el.trigger?.kind !== 'scroll') {
        stats.reveal.skipped.timed++;
        continue;
      }
      const node = nodes.get(el.path);
      if (!node) {
        stats.reveal.skipped.unmapped++;
        continue;
      }
      const spec = revealSpec(el);
      if (spec.opacity == null && !spec.translate && !spec.scale && spec.rotate == null && !spec.filter) {
        stats.reveal.skipped.flat++;
        continue;
      }
      const key = specKey(spec);
      let effect = reg.reveal.get(key);
      if (!effect) {
        effect = { token: `r${reg.reveal.size + 1}`, ...spec };
        reg.reveal.set(key, effect);
        stats.reveal.effects++;
      }
      tokenize(node, 'rv');
      tokenize(node, effect.token);
      const delay = Math.min(MAX_DELAY, Math.round((el.offsetMs ?? 0) / 10) * 10);
      if (delay >= 20) {
        reg.delays.add(delay);
        tokenize(node, `d${delay}`);
      }
      if (el.replay) {
        tokenize(node, 'rp');
        stats.reveal.replay++;
      }
      stats.reveal.elements++;
    }

    // Loops: a CSS animation the element's captured style carries is already in the stylesheet; the others are rebuilt.
    for (const loop of motion.loops?.loops ?? []) {
      const node = nodes.get(loop.path);
      if (!node) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'unmapped' });
        continue;
      }
      if (loop.timeline) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'scroll-linked' });
        continue;
      }
      const own = loop.pseudo ? node.views.desktop?.[loop.pseudo === '::before' ? 'before' : 'after']?.style : node.views.desktop?.style;
      if (loop.source === 'css-animation' && loop.inStylesheet && loop.name && String(own?.['animation-name'] ?? '').split(/,\s*/).includes(loop.name)) {
        stats.loops.carried++;
        continue;
      }
      if (loop.pseudo) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'pseudo-element' });
        continue;
      }
      let built = null;
      if (loop.source === 'script') built = scriptLoop(loop);
      else if (loop.keyframes?.length >= 2) {
        const t = loop.timing;
        const rate = t.playbackRate > 0 && t.playbackRate !== 1 ? t.playbackRate : 1;
        built = {
          keyframes: loopKeyframes(loop.keyframes),
          timing: { duration: Math.round(t.duration / rate), delay: Math.round(t.delay / rate), iterations: t.iterations, direction: t.direction, fill: t.fill, easing: t.easing },
        };
      }
      if (!built) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: loop.source === 'script' ? 'script-driven' : 'no-keyframes' });
        continue;
      }
      if (built.keyframes.some((k) => Object.values(k.props).some((v) => /url\(/i.test(v)))) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'url-in-keyframes' });
        continue;
      }
      const key = JSON.stringify(built);
      let entry = reg.loops.find((l) => l.key === key);
      if (!entry) {
        entry = { key, token: `l${reg.loops.length + 1}`, name: `m-l${reg.loops.length + 1}`, ...built };
        reg.loops.push(entry);
      }
      tokenize(node, entry.token);
      stats.loops.rebuilt++;
    }
  }

  const hover = [...reg.hover.values()];
  const focus = [...reg.focus.values()];
  const reveal = [...reg.reveal.values()];
  const loops = reg.loops.map(({ key, ...rest }) => rest);
  const any = hover.length || focus.length || reveal.length || loops.length;
  const motion = any ? {
    version: MOTION_VERSION,
    hover,
    focus,
    reveal,
    delays: [...reg.delays].sort((a, b) => a - b),
    loops,
    // The generated script is only needed for the reveal (IntersectionObserver); hover, focus and loops are CSS.
    script: reveal.length > 0,
  } : null;
  return { motion, stats };
}
