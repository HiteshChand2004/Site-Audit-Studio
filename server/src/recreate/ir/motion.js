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
import { commonPath } from '../capture/clicks.js';
import path from 'node:path';
import { KNOWN_VIEWS } from '../views.js';
import { mapUrls } from './styles.js';
import { isElement } from './tree.js';

export const MOTION_VERSION = 1;
// The height of the first screen of the desktop capture: a reveal below it is seen by a visitor who scrolls to it.
const FIRST_SCREEN = KNOWN_VIEWS.find((v) => v.id === 'desktop')?.height ?? 900;
const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?[\d.]+(\s*,\s*-?[\d.]+){3}\s*\)|steps\(\s*\d+\s*(,\s*[\w-]+\s*)?\))$/;
const MAX_DELAY = 2000;
const NO_VALUE = /^(null|undefined)$/;

/** The motion capture of one page (capture/<slug>/motion.json), or null. */
export async function readPageMotion(dir, page) {
  let motion = null;
  try {
    motion = JSON.parse(await readFile(path.join(dir, 'capture', page.slug, 'motion.json'), 'utf8'));
  } catch {
    return null;
  }
  // The phone layout's own controls (capture/index.js mobile-clicks.json), named by phone snapshot paths.
  try {
    motion.clicksMobile = JSON.parse(await readFile(path.join(dir, 'capture', page.slug, 'mobile-clicks.json'), 'utf8')).clicks;
  } catch {
    // none captured
  }
  return motion;
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

const isZero = (v) => /^0(\.0+)?(px)?$/.test(String(v ?? '').trim());

/**
 * The open state of a panel as declarations: the value each changed property has when open. A size that was collapsed
 * opens to its content (height auto, max-height none, grid rows 1fr), never to the px the capture measured, which is
 * right for one screen width only; other size changes are the consequence of the panel opening and left out.
 */
export function openDecls(changes, assetFile) {
  const out = {};
  for (const [prop, [closed, open]] of Object.entries(changes ?? {})) {
    if (open == null || NO_VALUE.test(String(open))) continue;
    if (prop === 'height' || prop === 'max-height') {
      if (isZero(closed)) out[prop] = prop === 'height' ? 'auto' : 'none';
      continue;
    }
    if (prop === 'grid-template-rows') {
      const rows = String(closed ?? '').trim().split(/\s+/);
      if (rows.length && rows.every(isZero)) out[prop] = String(open).trim().split(/\s+/).map((r) => (isZero(r) ? '0fr' : '1fr')).join(' ');
      continue;
    }
    Object.assign(out, changeDecls({ [prop]: [closed, open] }, assetFile));
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

/**
 * The mouse probe tries a few members of a group of equal elements (same tag, role, classes and parent: the same
 * styles and the same handlers); the effect it found is given to the other members too, with the descendants it
 * changed found at the same place inside each member. Effects the stylesheets declare (`source: 'css'`) are already
 * read on every element they apply to.
 */
export function spreadToGroups(list, groups) {
  const bySig = new Map((groups ?? []).filter((g) => g.paths?.length).map((g) => [g.sig, g]));
  if (!bySig.size) return { list, spread: 0 };
  const have = new Set(list.map((e) => e.path));
  const out = [...list];
  let spread = 0;
  for (const e of list) {
    const g = e.source !== 'css' && e.sig ? bySig.get(e.sig) : null;
    if (!g) continue;
    for (const p of g.paths) {
      if (have.has(p)) continue;
      have.add(p);
      const kids = (e.kids ?? []).filter((k) => k.path.startsWith(`${e.path}>`)).map((k) => ({ ...k, path: p + k.path.slice(e.path.length) }));
      const entry = { ...e, path: p, spreadFrom: e.path };
      if (kids.length) entry.kids = kids;
      else delete entry.kids;
      out.push(entry);
      spread++;
    }
  }
  return { list: out, spread };
}

/**
 * Is this reveal one a visitor sees by scrolling to it? A scroll trigger is; so is a reveal the capture called 'timed'
 * (a timer or "reveal on the first scroll" fired while the element was still far below the screen) when the element sits
 * below the first screen: the visitor who scrolls there sees it come in. A timed one in the first screen (rotating
 * headline, page-load entrance) is not a scroll effect.
 */
export const isScrollReveal = (el) => el.trigger?.kind === 'scroll' || (el.trigger?.kind === 'timed' && Number(el.rect?.[1]) >= FIRST_SCREEN);

const specKey = (s) => JSON.stringify([s.opacity ?? null, s.translate ?? null, s.scale ?? null, s.rotate ?? null, s.filter ?? null, s.duration, s.easing]);

// Keyframes of a loop (as authored) for @keyframes.
const loopKeyframes = (kfs) => kfs.map((k) => ({ offset: Math.round(k.offset * 10000) / 100, ...(k.easing && k.easing !== 'linear' && { easing: k.easing }), props: k.props }));

/** Loops the page's CSS does not carry, from a script-driven analysis: a steady spin or an oscillation. */
export function scriptLoop(loop) {
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
  // A ticker moved by script: its items repeat, so it slides by one repeat at the same speed, then starts over (seamless).
  if (loop.pattern === 'drift' && (p.channel === 'x' || p.channel === 'y') && p.rate > 1) {
    const period = Math.abs(Number(p.channel === 'x' ? p.repeat?.x : p.repeat?.y) || Number(p.wrap?.distance) || 0);
    if (period >= 20) {
      const end = r1(p.direction === 'backward' ? -period : period);
      const v = (n) => (p.channel === 'x' ? `${n}px 0` : `0 ${n}px`);
      return { keyframes: [{ offset: 0, props: { translate: v(0) } }, { offset: 100, props: { translate: v(end) } }], timing: { duration: Math.round((period / p.rate) * 1000), delay: 0, iterations: 'infinite', direction: 'normal', fill: 'none', easing: 'linear' } };
    }
  }
  return null;
}

/**
 * Attaches motion tokens to the nodes of the page trees and returns the site-level motion (ir.motion) plus a report.
 * @param {{ pages: object[], assetResolve: Function }} site  the prepared site (trees with `info`, `root`)
 * @param {Map<string, object>} byPath  page path → its motion.json
 */
export function applyMotion(site, byPath) {
  const reg = { hover: new Map(), focus: new Map(), reveal: new Map(), loops: [], delays: new Set(), widgets: new Map(), scrolled: new Map() };
  const stats = {
    pages: 0,
    scrolled: { bars: 0 },
    widgets: { elements: 0, effects: 0, skipped: { noState: 0, renderedOnOpen: 0, unmapped: 0, empty: 0, kinds: {} } },
    hover: { elements: 0, effects: 0, fromRules: 0, spread: 0, skipped: { script: 0, unmapped: 0, empty: 0 } },
    focus: { elements: 0, effects: 0, fromRules: 0, spread: 0, skipped: { unmapped: 0, empty: 0 } },
    reveal: { elements: 0, effects: 0, replay: 0, belowFold: 0, skipped: { timed: 0, unmapped: 0, flat: 0 } },
    loops: { carried: 0, rebuilt: 0, skipped: [] },
  };
  const tokenize = (node, token) => {
    // The same element in the other states of a tab panel / carousel (ir/states.js) gets the same effect.
    for (const n of [node, ...(node.stateTwins ?? [])]) {
      n.motionTokens ??= [];
      if (!n.motionTokens.includes(token)) n.motionTokens.push(token);
    }
  };
  // Areas with click-switched states (ir/states.js): they need the script, and the rule that keeps hidden states hidden.
  let stateSets = 0;
  let notices = 0;
  let hoverCards = 0;
  for (const tree of site.pages) {
    const ids = new Set();
    const walk = (n) => {
      if (!isElement(n)) return;
      if (n.stateAttrs?.['data-w-set']) ids.add(n.stateAttrs['data-w-set']);
      if (n.stateAttrs?.['data-w-note-of']) notices++;
      if (n.stateAttrs && 'data-w-hcopy' in n.stateAttrs) hoverCards++;
      n.children.forEach(walk);
    };
    walk(tree.root);
    stateSets += ids.size;
  }
  stats.states = { sets: stateSets, notices, hoverCards };

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
    // Hover / focus effects of content only a tab / filter state shows (ir/states.js `stateEffects` on its copies).
    const extra = { hover: [], focus: [] };
    const gather = (n) => {
      if (!isElement(n)) return;
      for (const kind of ['hover', 'focus']) extra[kind].push(...(n.stateEffects?.[kind] ?? []));
      n.children.forEach(gather);
    };
    gather(tree.root);

    // Hover and focus: one effect per distinct set of changed values.
    const pseudoDecls = (pseudo) => Object.fromEntries(Object.entries(pseudo ?? {}).map(([which, c]) => [which, changeDecls(c, assetFile)]).filter(([, d]) => Object.keys(d).length));
    for (const [kind, found, prefix, s] of [['hover', [...(motion.hover ?? []), ...extra.hover], 'h', stats.hover], ['focus', [...(motion.focus ?? []), ...extra.focus], 'f', stats.focus]]) {
      const { list, spread } = spreadToGroups(found, motion.groups);
      s.spread += spread;
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
        if (entry.source === 'css') s.fromRules++;
      }
    }

    // Scroll reveal: those the scroll started, and timed ones below the first screen (isScrollReveal); timed ones in the
    // first screen (rotating headlines, timers) are not scroll effects.
    for (const el of motion.reveal?.elements ?? []) {
      // Timed ones in the first screen are the page's entrance (a hero fading in as the page opens): played once on load
      // with CSS alone (`rl`), unless the element carries an animation of its own (a word rotator, a loop) or repeats.
      const onLoad = !isScrollReveal(el);
      const node = nodes.get(el.path);
      if (onLoad && (el.replay || !node || String(node.views?.desktop?.style?.['animation-name'] ?? 'none') !== 'none')) {
        stats.reveal.skipped.timed++;
        continue;
      }
      if (!onLoad && el.trigger.kind !== 'scroll') stats.reveal.belowFold++;
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
      tokenize(node, onLoad ? 'rl' : 'rv');
      tokenize(node, effect.token);
      if (onLoad) stats.reveal.onLoad = (stats.reveal.onLoad ?? 0) + 1;
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

    // Scroll states of fixed / sticky bars (capture/scrollstate.js): past `at` the bar gets `is-scrolled` (js/motion.js) and the
    // stylesheet holds its look there. A threshold near the window height is kept as a share of it (the hero above is one screen).
    for (const bar of [...nodes.values()].filter((n, i, all) => n.cpath && n.views?.desktop?.scrolled && all.indexOf(n) === i)) {
      const sc = bar.views.desktop.scrolled;
      const parts = sc.parts.map((p) => {
        const pseudo = {};
        for (const which of ['before', 'after']) {
          const d = p[which] ? changeDecls(p[which], assetFile) : {};
          if (Object.keys(d).length) pseudo[which] = d;
        }
        return { rel: p.rel, decls: changeDecls(p.changes, assetFile), ...(Object.keys(pseudo).length && { pseudo }) };
      }).filter((p) => Object.keys(p.decls).length || p.pseudo);
      if (!parts.length) continue;
      const key = JSON.stringify(parts);
      let effect = reg.scrolled.get(key);
      if (!effect) {
        const token = `s${reg.scrolled.size + 1}`;
        effect = { token, parts: parts.map((p, i) => ({ ...p, token: p.rel === '' ? token : `${token}p${i + 1}` })) };
        reg.scrolled.set(key, effect);
      }
      tokenize(bar, effect.token);
      for (const p of effect.parts) {
        if (p.rel === '') continue;
        const partNode = nodes.get(`${bar.cpath}>${p.rel}`);
        if (partNode) tokenize(partNode, p.token);
      }
      const share = sc.at / sc.viewport;
      bar.stateAttrs = { ...bar.stateAttrs, 'data-scroll-at': share >= 0.5 && share <= 1.5 ? `${Math.round(share * 1000) / 1000}vh` : String(Math.round(sc.at)) };
      stats.scrolled.bars++;
    }

    // Click widgets (capture/clicks.js). A panel a click opens (accordion answer, dropdown): its area gets `wN`, the
    // control `wt`, each part the click changed `wNpK`; js/motion.js toggles `is-open` on the area, the stylesheet holds the
    // open state. Equal controls (the other questions of the FAQ) get the same effect at the same places inside their area.
    // Controls of the phone layout (mobile-clicks.json) are found by their phone snapshot path.
    const phoneNodes = new Map();
    const walkPhone = (n) => {
      if (!isElement(n)) return;
      if (n.mpath) phoneNodes.set(n.mpath, n);
      for (const alt of n.mpathAlt ?? []) if (!phoneNodes.has(alt)) phoneNodes.set(alt, n);
      n.children.forEach(walkPhone);
    };
    walkPhone(tree.root);
    const desktopNodes = nodes;
    const done = new Set();
    const allWidgets = [...(motion.clicks?.widgets ?? []).map((w) => [w, desktopNodes, 'd']), ...(motion.clicksMobile?.widgets ?? []).map((w) => [w, phoneNodes, 'm'])];
    for (const [w, nodes, src] of allWidgets) {
      const ws = stats.widgets;
      // A phone control the desktop probe already rebuilt (the same element) needs nothing more.
      if (src === 'm' && nodes.get(w.trigger)?.motionTokens?.includes('wt')) {
        ws.skipped.phoneDone = (ws.skipped.phoneDone ?? 0) + 1;
        continue;
      }
      if (src === 'm') ws.phone = (ws.phone ?? 0) + 1;
      // A part a hover opens (a card unfolding its details, a dropdown) is rebuilt with CSS :hover, no script.
      const onHover = w.opensOn === 'hover' && (w.kind === 'disclosure' || w.kind === 'carousel');
      if (!onHover && (w.kind !== 'disclosure' || w.opensOn !== 'click')) {
        ws.skipped.kinds[`${w.kind}${w.opensOn === 'hover' ? ' (hover)' : ''}`] = (ws.skipped.kinds[`${w.kind}${w.opensOn === 'hover' ? ' (hover)' : ''}`] ?? 0) + 1;
        continue;
      }
      // A card replaced by its hovered snapshot on hover (ir/states.js expandHoverCards) needs no rebuilt styles.
      const tn = onHover ? nodes.get(w.trigger) : null;
      if (tn?.stateAttrs && 'data-w-hrest' in tn.stateAttrs) {
        ws.skipped.hoverCard = (ws.skipped.hoverCard ?? 0) + 1;
        continue;
      }
      if (!w.state) {
        ws.skipped.noState++;
        continue;
      }
      if (w.state.added) {
        ws.skipped.renderedOnOpen++; // the page renders the panel only when open: nothing in the copy to show
        continue;
      }
      const parts = w.state.parts.map((p) => {
        const pseudo = {};
        for (const which of ['before', 'after']) {
          const d = p[which] ? openDecls(p[which], assetFile) : {};
          if (Object.keys(d).length) pseudo[which] = d;
        }
        return { rel: p.rel, decls: openDecls(p.changes, assetFile), ...(Object.keys(pseudo).length && { pseudo }) };
      }).filter((p) => Object.keys(p.decls).length || p.pseudo);
      if (!parts.length) {
        ws.skipped.empty++;
        continue;
      }
      const depth = w.trigger.split('>').length - w.state.root.split('>').length;
      // On hover: the area itself is hovered when the control is the area; else the area opens while its control is hovered.
      const on = onHover ? (depth === 0 ? 'hover' : 'hover-control') : 'click';
      const key = JSON.stringify([on, parts]);
      let effect = reg.widgets.get(key);
      if (!effect) {
        const token = `w${reg.widgets.size + 1}`;
        effect = { token, kind: 'disclosure', ...(on !== 'click' && { on }), parts: parts.map((p, i) => ({ ...p, token: p.rel === '' ? token : `${token}p${i + 1}` })) };
        reg.widgets.set(key, effect);
        ws.effects++;
      }
      // One panel at a time (an accordion, capture/clicks.js): the list holding all its controls is marked; js/motion.js
      // closes the other open panels in it.
      if (w.exclusive && w.group?.paths?.length > 1) {
        const list = nodes.get(commonPath(w.group.paths));
        // Also in the other states of an area that holds the list (ir/states.js twins).
        for (const n of list ? [list, ...(list.stateTwins ?? [])] : []) n.stateAttrs = { ...n.stateAttrs, 'data-w-one': '' };
      }
      for (const trigger of [w.trigger, ...(w.group?.paths ?? [])]) {
        if (done.has(src + trigger)) continue;
        done.add(src + trigger);
        const segs = trigger.split('>');
        const rootPath = segs.slice(0, segs.length - depth).join('>');
        const rootNode = nodes.get(rootPath);
        const triggerNode = nodes.get(trigger);
        if (!rootNode || !triggerNode || depth < 0) {
          ws.skipped.unmapped++;
          continue;
        }
        tokenize(rootNode, effect.token);
        // `wt` = a control js/motion.js toggles on click; `wh` = a control whose hover opens its area (CSS only).
        if (on === 'click') tokenize(triggerNode, 'wt');
        else if (on === 'hover-control') tokenize(triggerNode, 'wh');
        for (const p of effect.parts) {
          if (p.rel === '') continue;
          const partNode = nodes.get(`${rootPath}>${p.rel}`);
          if (partNode) tokenize(partNode, p.token);
        }
        ws.elements++;
      }
    }
  }

  const hover = [...reg.hover.values()];
  const focus = [...reg.focus.values()];
  const reveal = [...reg.reveal.values()];
  const loops = reg.loops.map(({ key, ...rest }) => rest);
  const widgets = [...reg.widgets.values()];
  const scrolled = [...reg.scrolled.values()];
  const any = hover.length || focus.length || reveal.length || loops.length || widgets.length || stateSets || scrolled.length || notices || hoverCards;
  const motion = any ? {
    version: MOTION_VERSION,
    hover,
    focus,
    reveal,
    delays: [...reg.delays].sort((a, b) => a - b),
    loops,
    widgets,
    states: stateSets,
    notices,
    hoverCards,
    scrolled,
    // The generated script is needed for the reveal (IntersectionObserver), the click widgets, the switched states and the
    // scroll states; hover, focus and loops are CSS.
    script: reveal.length > 0 || widgets.some((w) => !w.on) || stateSets > 0 || scrolled.length > 0 || notices > 0,
  } : null;
  return { motion, stats };
}
