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
//   rl  the same effect played once as the page opens, CSS alone (an entrance a timer or the first scroll started in
//       the original, not the element coming into view: see isScrollReveal)
//   lN  a loop the page's own CSS does not carry (a Web Animation, a script-driven spin / oscillation)
// Without script nothing is hidden: the reveal rules only apply under `.js-motion`, which the script sets. CSS loops
// the stylesheet already carries (animation-name in the element's captured style) are counted, not written twice.
//
// An effect the original drove with script (no state rule, no transition of its own) also carries the `transition`
// the copy needs to arrive the same way, over the time the probe measured: synthTransition below.
//
// ir.motion = { version, hover: [{ token, decls, transition?, pseudo?, kids? }], focus: [...], reveal: [{ token, opacity?, translate?,
//   scale?, rotate?, filter?, duration, easing }], delays: [ms], loops: [{ token, name, keyframes, timing }], script: boolean }
import { readFile } from 'node:fs/promises';
import { commonPath } from '../capture/clicks.js';
import path from 'node:path';
import { KNOWN_MEDIA_VIEWS, KNOWN_VIEWS } from '../views.js';
import { mapUrls } from './styles.js';
import { deepText, isElement } from './tree.js';
import { load } from 'cheerio';

// The inline <svg> a capture path goes into ("…>svg:1>g:2>line:1"): { svg: its tree node, rest: ['g:2', 'line:1'] }.
function svgTarget(capturePath, nodes) {
  const parts = String(capturePath ?? '').split('>');
  for (let k = parts.length - 1; k > 0; k--) {
    const n = nodes.get(parts.slice(0, k).join('>'));
    if (n) return n.tag === 'svg' && n.svg ? { svg: n, rest: parts.slice(k) } : null;
  }
  return null;
}

// Adds a motion token to the element `rest` points at inside the SVG's markup (tag:n = the n-th child with that tag).
function tokenizeInSvg(svgNode, rest, token) {
  const $ = load(svgNode.svg, { xml: { xmlMode: true } }, false);
  let el = $.root().children().filter((i, x) => x.name?.toLowerCase() === 'svg').first();
  for (const seg of rest) {
    const [tag, n] = seg.split(':');
    el = el.children().filter((i, x) => x.name?.toLowerCase() === tag).eq(Math.max(0, Number(n) - 1));
    if (!el.length) return false;
  }
  const tokens = new Set(String(el.attr('data-motion') ?? '').split(/\s+/).filter(Boolean));
  tokens.add(token);
  el.attr('data-motion', [...tokens].join(' '));
  svgNode.svg = $.xml();
  return true;
}

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
  // The controls of the narrow layouts (capture/index.js mobile-clicks.json / tablet-clicks.json): a menu button or a
  // drawer the desktop layout does not have, named by that view's snapshot paths.
  for (const [view, key] of [['mobile', 'clicksMobile'], ['tablet', 'clicksTablet']]) {
    try {
      motion[key] = JSON.parse(await readFile(path.join(dir, 'capture', page.slug, `${view}-clicks.json`), 'utf8')).clicks;
    } catch {
      // none captured
    }
  }
  // An exact copy probes every view in full instead of running the short click pass, and writes one file per view
  // (capture/index.js motionFile). Its controls are the same data under another name, so the narrow-layout path above
  // keeps working rather than quietly losing the menu button it used to find; and what else that view found is
  // recorded, including the kinds this builder does not rebuild yet, so none of it is a silent loss.
  for (const view of KNOWN_MEDIA_VIEWS) {
    let full = null;
    try {
      full = JSON.parse(await readFile(path.join(dir, 'capture', page.slug, `${view}-motion.json`), 'utf8'));
    } catch {
      continue; // that view was not probed
    }
    const key = view === 'mobile' ? 'clicksMobile' : view === 'tablet' ? 'clicksTablet' : null;
    if (key && !motion[key] && full.clicks) motion[key] = full.clicks;
    motion.byView = {
      ...motion.byView,
      [view]: {
        hover: full.hover?.length ?? 0,
        focus: full.focus?.length ?? 0,
        clicks: full.clicks?.stats?.found ?? 0,
        states: full.states?.sets ?? 0,
        notices: full.notices?.notices ?? 0,
        loops: full.loops?.stats?.total ?? 0,
        reveal: full.reveal?.stats?.revealed ?? 0,
        // What this builder can place from a narrow view: its controls, by that view's own paths (ir/tree.js
        // mpath / tpath). Hover, focus, reveals and loops of a narrow view have no path map yet, so they are
        // counted here instead of being quietly dropped.
        rebuilt: key ? ['clicks'] : [],
        notRebuilt: ['hover', 'focus', 'states', 'notices', 'loops', 'reveal', ...(key ? [] : ['clicks'])]
          .filter((k) => (k === 'clicks' ? (full.clicks?.stats?.found ?? 0) : (Array.isArray(full[k]) ? full[k].length : 0)) > 0
            || (k === 'states' && (full.states?.sets ?? 0) > 0)
            || (k === 'notices' && (full.notices?.notices ?? 0) > 0)
            || (k === 'loops' && (full.loops?.stats?.total ?? 0) > 0)
            || (k === 'reveal' && (full.reveal?.stats?.revealed ?? 0) > 0)),
      },
    };
  }
  return motion;
}

const r1 = (n) => Math.round(n * 10) / 10;

/** A link that would leave the page (not `#`, `javascript:` or empty). */
function realHref(node) {
  if (node?.tag !== 'a') return false;
  const href = String(node.attrs?.href ?? '').trim();
  return !!href && !/^(#|javascript:)/i.test(href);
}

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

// The properties a synthetic transition may animate: the ones a browser interpolates and a visitor reads as
// movement. `display`, `visibility`, `background-image`, `cursor` and the like change in one step by nature and are
// left to do so.
const SYNTH_PROP = /^(transform|translate|scale|rotate|opacity|filter|backdrop-filter|clip-path|box-shadow|text-shadow|color|fill|stroke|letter-spacing|word-spacing|font-weight|outline-color|outline-offset|outline-width|row-gap|column-gap|gap|background-color|background-position|background-size|width|height|min-width|min-height|max-width|max-height|left|top|right|bottom|flex-basis|border-(top|right|bottom|left)-(color|width)|border-(top|bottom)-(left|right)-radius|text-decoration-(color|thickness)|text-underline-offset|margin-(top|right|bottom|left)|padding-(top|right|bottom|left))$/;
// The copy's own timing for an effect the original ran with script. The measured time is used wherever there is one
// (capture/interactions.js scriptedMs); these only bound it, so one slow read cannot give a page a sluggish hover.
const SYNTH_MS = 250;
const SYNTH_MIN_MS = 120;
const SYNTH_MAX_MS = 700;
// A change a visitor asks for arrives quickly and comes to rest softly; the same curve in both directions, so the
// effect leaves the way it came.
const SYNTH_EASING = 'ease-out';
const DURATION_VALUE = /^-?[\d.]+m?s$/;
const msList = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter((s) => DURATION_VALUE.test(s))
  .map((s) => (s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000));

/** Does the element animate the change itself? Then its own `transition` is copied with its styles and kept. */
function hasOwnTransition(tr) {
  if (!tr || String(tr.property ?? 'none') === 'none') return false;
  return msList(tr.duration).some((ms) => ms > 0);
}

/**
 * The transition that lets a rebuilt hover / focus effect arrive the way the original's did when the original drove it
 * with JavaScript. Such an element has no state rule and no transition of its own, so the copy - which carries no
 * script of the original - would snap into the end state in a single frame. Written on the element at rest, so the
 * effect eases out again as well.
 * Only for an effect the probe timed (`scripted`, a measured duration > 0: an end state the page set in one step
 * stays a step), only for an element with no transition of its own (so nothing the original wrote is overruled) and
 * only for the properties a browser interpolates.
 * @param {object} decls  the end values of this part of the effect
 * @param {{ scripted?: boolean, scriptedMs?: number, transition?: object, transitionOut?: object }} [entry]
 * @returns {string|null} the value of a `transition` declaration, or null when the original needs none
 */
export function synthTransition(decls, entry) {
  if (!entry?.scripted) return null;
  // The transition of the element at rest: what it had before the mouse arrived.
  if (hasOwnTransition(entry.transitionOut ?? entry.transition)) return null;
  const props = Object.keys(decls ?? {}).filter((p) => SYNTH_PROP.test(p));
  if (!props.length) return null;
  const measured = Number(entry.scriptedMs);
  const ms = Math.min(SYNTH_MAX_MS, Math.max(SYNTH_MIN_MS, Math.round(Number.isFinite(measured) && measured > 0 ? measured : SYNTH_MS)));
  return props.map((p) => `${p} ${ms}ms ${SYNTH_EASING}`).join(', ');
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
/**
 * What two snapshot paths say about how their elements are related, or null when they cannot say. Only an ancestor
 * is readable from a path: the index in `div:2` counts same-tag siblings, so it cannot order two elements of
 * different tags, and which side of an element its neighbour is on is only ever taken from the capture's own
 * reading of the document order (capture/interactions.js relation()).
 * @returns {'ancestor'|null}
 */
export function relationOf(hostPath, otherPath) {
  if (!hostPath || !otherPath || hostPath === otherPath) return null;
  return hostPath.startsWith(`${otherPath}>`) ? 'ancestor' : null;
}

export function spreadToGroups(list, groups) {
  const bySig = new Map((groups ?? []).filter((g) => g.paths?.length).map((g) => [g.sig, g]));
  if (!bySig.size) return { list, spread: 0 };
  const have = new Set(list.map((e) => e.path));
  const out = [...list];
  let spread = 0;
  let droppedSibs = 0;
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
      // A descendant's path is the host's path plus a tail, so it can be rebased onto the other member. A neighbour's
      // cannot: nothing says which element sits beside THIS member. Carrying them over would point the effect at the
      // first member's neighbours, so they are dropped and counted instead of guessed at.
      if (e.sibs?.length) droppedSibs += e.sibs.length;
      delete entry.sibs;
      out.push(entry);
      spread++;
    }
  }
  return { list: out, spread, droppedSibs };
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

// One item of a strip as `repeatOf` (capture/loops.js) reads it in the page: enough to tell one item from the next and
// to recognise its copy further along the strip.
function itemSig(node) {
  const image = (n) => {
    if (!isElement(n)) return '';
    if (n.tag === 'img') return String(n.attrs?.src ?? n.src ?? '');
    for (const c of n.children) {
      const found = image(c);
      if (found) return found;
    }
    return '';
  };
  return [node.tag, deepText(node).slice(0, 60), image(node), node.children.filter(isElement).length].join('|');
}

export const MIN_REPEAT_PX = 20;
const TRACK_DEPTH = 3;

/**
 * How far a script-driven strip moves before it looks the same again, read from the tree. The page function
 * (capture/loops.js `repeatOf`) looks at the children of the element that moves, and a wrap-around is only seen when
 * the short recording happens to cover one - so a ticker whose items sit in an inner track, or one that never wrapped
 * while it was watched, reached the IR with no period at all and its loop was dropped. Here the element that holds the
 * items is found first (a single element child is a track around them, not an item), then the items are matched by
 * their content like `repeatOf` does, and the distance from the first item to its next copy is the period.
 * @returns {number} px, 0 when the tree shows no repeat
 */
export function irRepeat(node, channel, view = 'desktop') {
  const axis = channel === 'x' ? 0 : channel === 'y' ? 1 : -1;
  if (axis < 0 || !isElement(node)) return 0;
  let track = node;
  for (let depth = 0; depth < TRACK_DEPTH; depth++) {
    const kids = track.children.filter(isElement);
    if (kids.length !== 1) break;
    track = kids[0];
  }
  const items = track.children.filter((c) => isElement(c) && Number(c.views?.[view]?.rect?.[2]) > 0);
  if (items.length < 2) return 0;
  const sigs = items.map(itemSig);
  for (let k = 1; k <= items.length / 2; k++) {
    let same = true;
    for (let i = 0; i + k < items.length && same; i++) same = sigs[i] === sigs[i + k];
    if (!same) continue;
    const distance = Math.abs(items[k].views[view].rect[axis] - items[0].views[view].rect[axis]);
    return distance >= MIN_REPEAT_PX ? r1(distance) : 0;
  }
  return 0;
}

/**
 * Loops the page's CSS does not carry, from a script-driven analysis: a steady spin or an oscillation.
 * @param {object} loop  one entry of motion.json `loops`
 * @param {object} [node]  the element in the merged tree, for a drift whose period the recording did not see
 */
export function scriptLoop(loop, node) {
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
  // A slow fade in and out (a "breathing" card or glow) between the opacities the recording saw.
  if (loop.pattern === 'oscillate' && p.channel === 'opacity' && p.periodMs >= 400 && Number.isFinite(p.min) && Number.isFinite(p.max) && p.max - p.min >= 0.05) {
    const o = (n) => String(Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000);
    return { keyframes: [{ offset: 0, props: { opacity: o(p.min) } }, { offset: 100, props: { opacity: o(p.max) } }], timing: { duration: Math.round(p.periodMs / 2), delay: 0, iterations: 'infinite', direction: 'alternate', fill: 'none', easing: 'ease-in-out' } };
  }
  // A ticker moved by script: its items repeat, so it slides by one repeat at the same speed, then starts over (seamless).
  // What the recording measured comes first; without it the tree is asked how far one repeat of the strip is (irRepeat).
  if (loop.pattern === 'drift' && (p.channel === 'x' || p.channel === 'y') && p.rate > 1) {
    const measured = Math.abs(Number(p.channel === 'x' ? p.repeat?.x : p.repeat?.y) || Number(p.wrap?.distance) || 0);
    const fromTree = measured >= MIN_REPEAT_PX ? 0 : irRepeat(node, p.channel);
    const period = measured >= MIN_REPEAT_PX ? measured : fromTree;
    if (period >= MIN_REPEAT_PX) {
      const end = r1(p.direction === 'backward' ? -period : period);
      const v = (n) => (p.channel === 'x' ? `${n}px 0` : `0 ${n}px`);
      return {
        ...(fromTree && { periodFrom: 'tree' }),
        keyframes: [{ offset: 0, props: { translate: v(0) } }, { offset: 100, props: { translate: v(end) } }],
        timing: { duration: Math.round((period / p.rate) * 1000), delay: 0, iterations: 'infinite', direction: 'normal', fill: 'none', easing: 'linear' },
      };
    }
  }
  return null;
}

// The scale / move of a captured transform (a computed matrix, or a scale() / translate() a minifier wrote).
function entrancePose(transform) {
  const t = String(transform ?? '').trim();
  if (!t || t === 'none') return null;
  const m = t.match(/^matrix\(([^)]+)\)$/);
  if (m) {
    const [a, b, , , e, f] = m[1].split(',').map(Number);
    if (![a, b, e, f].every(Number.isFinite)) return null;
    return { scale: Math.round(Math.hypot(a, b) * 100) / 100, translate: [r1(e), r1(f)] };
  }
  const s = t.match(/^scale\(\s*([\d.]+)\s*\)$/);
  if (s) return { scale: Number(s[1]), translate: [0, 0] };
  const tr = t.match(/^translate(?:3d)?\(\s*(-?[\d.]+)px(?:\s*,\s*(-?[\d.]+)px)?/);
  if (tr) return { scale: 1, translate: [Number(tr[1]), Number(tr[2] ?? 0)] };
  return null;
}

/**
 * Boxes the capture caught in the first pose of an entrance the page never played while it was read (opacity 0 and moved
 * or scaled, in every view that shows them: a builder's "appear" effect waiting for a scroll the capture did not give it).
 * Left as captured they stay invisible in the copy (a blog row, a card list). They get the end state (the pose dropped)
 * and a scroll reveal from that pose, timed like the page's other reveals. Boxes that are hidden on purpose are left alone:
 * positioned layers (hover overlays, menus), anything the script switches or a hover / reveal already drives, empty boxes.
 */
function frozenEntrances(site, reg, stats) {
  const durations = [...reg.reveal.values()].map((e) => `${e.duration}|${e.easing}`);
  const common = durations.sort((a, b) => durations.filter((x) => x === b).length - durations.filter((x) => x === a).length)[0];
  const [duration, easing] = common ? [Number(common.split('|')[0]), common.split('|')[1]] : [600, 'ease'];
  const hasContent = (n) => n.children.some((c) => (isElement(c) ? ['img', 'svg', 'video', 'picture'].includes(c.tag) || hasContent(c) : String(c.text ?? '').trim()));
  let count = 0;
  // Mostly inside the parent's box in that view: a carousel's waiting slides sit further along their track, outside it.
  const inside = (n, parent, v) => {
    const r = n.views?.[v]?.rect;
    const p = parent?.views?.[v]?.rect;
    if (!r || !p || !(r[2] > 0)) return true;
    const overlap = Math.min(r[0] + r[2], p[0] + p[2]) - Math.max(r[0], p[0]);
    return overlap >= r[2] * 0.5;
  };
  const visit = (n, parent) => {
    if (!isElement(n)) return;
    const views = Object.entries(n.views ?? {}).filter(([, d]) => d && !d.hidden);
    const shown = views.map(([, d]) => d);
    const owned = (n.motionTokens ?? []).length || Object.keys(n.stateAttrs ?? {}).some((k) => k.startsWith('data-w-'));
    const moved = (p) => p && (Math.abs(p.scale - 1) >= 0.01 || Math.abs(p.translate[0]) >= 1 || Math.abs(p.translate[1]) >= 1);
    const poses = shown.map((d) => (Number(d.style?.opacity) < 0.05 && !/absolute|fixed/.test(d.style?.position ?? '') ? entrancePose(d.style?.transform) : null));
    // Frozen in at least one view (others may have been read after the entrance played, like a laptop view read later).
    const frozen = shown.filter((d, i) => moved(poses[i]) && inside(n, parent, views[i][0]));
    if (!owned && frozen.length && hasContent(n)) {
      const pose = poses.find(moved);
      for (const d of frozen) {
        const { opacity, transform, ...rest } = d.style;
        d.style = rest;
      }
      const spec = { duration, easing, opacity: 0, ...(Math.abs(pose.scale - 1) >= 0.01 && { scale: [pose.scale, pose.scale] }), ...((Math.abs(pose.translate[0]) >= 1 || Math.abs(pose.translate[1]) >= 1) && { translate: pose.translate }) };
      const key = specKey(spec);
      let effect = reg.reveal.get(key);
      if (!effect) {
        effect = { token: `r${reg.reveal.size + 1}`, ...spec };
        reg.reveal.set(key, effect);
      }
      n.motionTokens = [...(n.motionTokens ?? []), 'rv', effect.token];
      count++;
      return;
    }
    n.children.forEach((c) => visit(c, n));
  };
  for (const t of site.pages) visit(t.root, null);
  stats.reveal.frozen = count;
  stats.reveal.elements += count;
}

/**
 * Attaches motion tokens to the nodes of the page trees and returns the site-level motion (ir.motion) plus a report.
 * @param {{ pages: object[], assetResolve: Function }} site  the prepared site (trees with `info`, `root`)
 * @param {Map<string, object>} byPath  page path → its motion.json
 */
/** One line per view for the report: what the probe found there, and what this builder could place from it. */
function sumByView(out, byView) {
  for (const [view, found] of Object.entries(byView ?? {})) {
    const o = out[view] ??= { pages: 0, hover: 0, focus: 0, clicks: 0, states: 0, notices: 0, loops: 0, reveal: 0, rebuilt: [], notRebuilt: [] };
    o.pages++;
    for (const k of ['hover', 'focus', 'clicks', 'states', 'notices', 'loops', 'reveal']) o[k] += found[k] ?? 0;
    for (const k of found.rebuilt ?? []) if (!o.rebuilt.includes(k)) o.rebuilt.push(k);
    for (const k of found.notRebuilt ?? []) if (!o.notRebuilt.includes(k)) o.notRebuilt.push(k);
  }
}

export function applyMotion(site, byPath) {
  const reg = { hover: new Map(), focus: new Map(), reveal: new Map(), loops: [], delays: new Set(), widgets: new Map(), scrolled: new Map() };
  const stats = {
    pages: 0,
    scrolled: { bars: 0 },
    widgets: { elements: 0, effects: 0, skipped: { noState: 0, renderedOnOpen: 0, unmapped: 0, empty: 0, kinds: {} } },
    // `dynamic` / `scripted` / `synthesized`: elements the probe only reached by a script's fingerprint, effects the
    // original timed with script, and the effects the copy therefore times itself (synthTransition).
    hover: { elements: 0, effects: 0, fromRules: 0, spread: 0, sibs: 0, dynamic: 0, scripted: 0, synthesized: 0, skipped: { script: 0, unmapped: 0, empty: 0, combinator: 0, kidNotDescendant: 0 } },
    focus: { elements: 0, effects: 0, fromRules: 0, spread: 0, sibs: 0, dynamic: 0, scripted: 0, synthesized: 0, skipped: { unmapped: 0, empty: 0, combinator: 0, kidNotDescendant: 0 } },
    reveal: { elements: 0, effects: 0, replay: 0, belowFold: 0, skipped: { timed: 0, unmapped: 0, flat: 0 } },
    loops: { carried: 0, rebuilt: 0, skipped: [] },
    // Elements that follow the pointer (capture/pointer.js): js/motion.js moves them like the original's script did.
    pointer: { followers: 0, unmapped: 0 },
    // An exact copy probes the narrow views too: what each found, and which kinds were placed from it.
    byView: {},
  };
  // Where each hover / focus token's effects came from: tokens only the site's own state rules gave (`source: 'css'`)
  // are what the original stylesheet already does - an as-is copy, which keeps that stylesheet, leaves them off
  // (ir/asis.js), so a value read wrong can never overrule the site's own rule.
  const tokenSource = new Map();
  const noteSource = (token, source) => {
    const t = tokenSource.get(token) ?? { css: 0, other: 0 };
    if (source === 'css') t.css++;
    else t.other++;
    tokenSource.set(token, t);
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
  let panels = 0;
  for (const tree of site.pages) {
    const ids = new Set();
    const walk = (n) => {
      if (!isElement(n)) return;
      if (n.stateAttrs?.['data-w-set']) ids.add(n.stateAttrs['data-w-set']);
      if (n.stateAttrs?.['data-w-note-of']) notices++;
      if (n.stateAttrs?.['data-w-panel-of']) panels++;
      if (n.stateAttrs && 'data-w-hcopy' in n.stateAttrs) hoverCards++;
      n.children.forEach(walk);
    };
    walk(tree.root);
    stateSets += ids.size;
  }
  stats.states = { sets: stateSets, notices, hoverCards, panels };

  for (const tree of site.pages) {
    const motion = byPath.get(tree.info.path);
    if (!motion) continue;
    stats.pages++;
    sumByView(stats.byView, motion.byView);
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

    // What follows the mouse: its ratio to the mouse's moves, where it was for one known mouse position, and how quickly it
    // catches up - written on the element as data the generated script reads (data-w-follow).
    for (const f of motion.pointer?.followers ?? []) {
      const node = nodes.get(f.path);
      if (!node) {
        stats.pointer.unmapped++;
        continue;
      }
      node.stateAttrs = { ...node.stateAttrs, 'data-w-follow': [f.kx, f.ky, f.ref.cx, f.ref.cy, f.ref.mx, f.ref.my, f.tauMs, f.fixed ? 1 : 0, f.share ?? ''].join(',') };
      stats.pointer.followers++;
    }

    // Hover and focus: one effect per distinct set of changed values.
    const pseudoDecls = (pseudo) => Object.fromEntries(Object.entries(pseudo ?? {}).map(([which, c]) => [which, changeDecls(c, assetFile)]).filter(([, d]) => Object.keys(d).length));
    for (const [kind, found, prefix, s] of [['hover', [...(motion.hover ?? []), ...extra.hover], 'h', stats.hover], ['focus', [...(motion.focus ?? []), ...extra.focus], 'f', stats.focus]]) {
      const { list, spread, droppedSibs } = spreadToGroups(found, motion.groups);
      s.spread += spread;
      if (droppedSibs) s.skipped.spreadSibs = (s.skipped.spreadSibs ?? 0) + droppedSibs;
      for (const entry of list) {
        const node = nodes.get(entry.path);
        if (!node) {
          s.skipped.unmapped++;
          continue;
        }
        // The effect also adds or removes elements (a dropdown a script opens): that part is a script's, its own style changes
        // (background, colours) are still rebuilt.
        if (entry.domDelta) s.skipped.script = (s.skipped.script ?? 0) + 1;
        const decls = changeDecls(entry.changes, assetFile);
        const pseudo = pseudoDecls(entry.pseudo);
        const kids = [];
        const sibs = [];
        for (const k of entry.kids ?? []) {
          const kidNode = nodes.get(k.path);
          const d = changeDecls(k.changes, assetFile);
          if (!kidNode || !Object.keys(d).length) continue;
          // A "kid" that is not inside the hovered element would be emitted as a descendant selector matching
          // nothing. Where the paths say what it really is, it is rebuilt as a neighbour instead of being lost.
          if (!k.path.startsWith(`${entry.path}>`)) {
            const rel = relationOf(entry.path, k.path);
            if (rel) sibs.push({ node: kidNode, rel, decls: d });
            else s.skipped.kidNotDescendant = (s.skipped.kidNotDescendant ?? 0) + 1;
            continue;
          }
          kids.push({ node: kidNode, decls: d, transition: synthTransition(d, { ...entry, transition: k.transition, transitionOut: null }) });
        }
        // Elements beside or around the hovered one (capture/interactions.js relatedOf): a card grid dimming its
        // other cards, a nav tinting the rest of the bar.
        for (const sib of entry.sibs ?? []) {
          const sibNode = nodes.get(sib.path);
          const d = changeDecls(sib.changes, assetFile);
          if (!sibNode || !Object.keys(d).length) continue;
          const rel = sib.rel ?? relationOf(entry.path, sib.path);
          if (!rel) {
            s.skipped.combinator = (s.skipped.combinator ?? 0) + 1;
            continue;
          }
          sibs.push({ node: sibNode, rel, decls: d, transition: synthTransition(d, { ...entry, transition: sib.transition, transitionOut: null }) });
        }
        if (!Object.keys(decls).length && !Object.keys(pseudo).length && !kids.length && !sibs.length) {
          s.skipped.empty++;
          continue;
        }
        // The original drove this with script: the copy times the change itself, over the measured duration.
        const transition = synthTransition(decls, entry);
        const key = JSON.stringify([decls, pseudo, kids.map((k) => [k.decls, k.transition]), sibs.map((x) => [x.rel, x.decls, x.transition]), transition]);
        let effect = reg[kind].get(key);
        if (!effect) {
          const n = reg[kind].size + 1;
          effect = {
            token: `${prefix}${n}`,
            decls,
            ...(transition && { transition }),
            ...(Object.keys(pseudo).length && { pseudo }),
            kids: kids.map((k, i) => ({ token: `${prefix}${n}k${i + 1}`, decls: k.decls, ...(k.transition && { transition: k.transition }) })),
            ...(sibs.length && { sibs: sibs.map((x, i) => ({ token: `${prefix}${n}s${i + 1}`, rel: x.rel, decls: x.decls, ...(x.transition && { transition: x.transition }) })) }),
          };
          reg[kind].set(key, effect);
          s.effects++;
          if (transition || effect.kids.some((k) => k.transition) || (effect.sibs ?? []).some((x) => x.transition)) s.synthesized = (s.synthesized ?? 0) + 1;
        }
        tokenize(node, effect.token);
        kids.forEach((k, i) => tokenize(k.node, effect.kids[i].token));
        sibs.forEach((x, i) => tokenize(x.node, effect.sibs[i].token));
        for (const t of [effect.token, ...effect.kids.map((k) => k.token), ...(effect.sibs ?? []).map((x) => x.token)]) noteSource(t, entry.source);
        s.elements++;
        s.sibs = (s.sibs ?? 0) + sibs.length;
        if (entry.source === 'css') s.fromRules++;
        // Evidence for the report: the effect the original ran with script, and the mark that made the probe look at
        // an element no rule, cursor or transition described (capture/interactions.js dynamicSignature).
        if (entry.scripted) s.scripted = (s.scripted ?? 0) + 1;
        if (entry.dyn) s.dynamic = (s.dynamic ?? 0) + 1;
      }
    }

    // Scroll reveal: those the scroll started, and timed ones below the first screen (isScrollReveal); timed ones in the
    // first screen (an entrance a timer or the first scroll started) are not scroll effects and are rebuilt as `rl`.
    // An element that loops (a ticker strip) only seemed to "reveal" because it moves by itself; its loop is rebuilt instead
    // (a reveal's animation on the same element would replace the loop's).
    const loopHosts = new Set((motion.loops?.loops ?? []).filter((l) => !l.pseudo && !l.timeline).map((l) => l.path));
    // A part that changes by itself (capture/feeds.js): what fades in there is its update's own entrance, which the copy's
    // feed replays; a reveal on top would replace that animation and hold the row until it is scrolled to.
    const feedAreas = [...nodes].filter(([, n]) => n?.stateAttrs?.['data-w-feed'] != null).map(([p]) => p);
    for (const el of motion.reveal?.elements ?? []) {
      if (loopHosts.has(el.path)) {
        stats.reveal.skipped.loop = (stats.reveal.skipped.loop ?? 0) + 1;
        continue;
      }
      if (feedAreas.some((p) => el.path === p || el.path.startsWith(`${p}>`))) {
        stats.reveal.skipped.feed = (stats.reveal.skipped.feed ?? 0) + 1;
        continue;
      }
      // Timed ones in the first screen are the page's entrance (a hero fading in as the page opens, an effect a timer or
      // the first scroll started): played once on load with CSS alone (`rl`), nothing waiting for a scroll. An element
      // that carries an animation of its own (a word rotator, a loop) keeps it - a second animation would replace it.
      const onLoad = !isScrollReveal(el);
      const node = nodes.get(el.path);
      if (!node) {
        stats.reveal.skipped.unmapped++;
        continue;
      }
      if (onLoad && String(node.views?.desktop?.style?.['animation-name'] ?? 'none') !== 'none') {
        stats.reveal.skipped.timed++;
        continue;
      }
      if (!onLoad && el.trigger.kind !== 'scroll') stats.reveal.belowFold++;
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
      // A scroll reveal starts when it comes into view, so only its place in a stagger (`offsetMs`) is a delay. A load
      // entrance starts with the page, so its own declared delay is the one a visitor sees (a hero coming in after the
      // heading); without a measured one the stagger is used there too.
      const own = onLoad ? Number(el.timing?.delay) : NaN;
      const ms = Number.isFinite(own) && own > 0 ? own : (el.offsetMs ?? 0);
      const delay = Math.min(MAX_DELAY, Math.round(ms / 10) * 10);
      if (delay >= 20) {
        reg.delays.add(delay);
        tokenize(node, `d${delay}`);
      }
      // Hidden again when it leaves the view: only a reveal the script watches can repeat; a load entrance plays once.
      if (el.replay && !onLoad) {
        tokenize(node, 'rp');
        stats.reveal.replay++;
      }
      stats.reveal.elements++;
    }

    // Loops: a CSS animation the element's captured style carries is already in the stylesheet; the others are rebuilt.
    for (const loop of motion.loops?.loops ?? []) {
      let node = nodes.get(loop.path);
      // A loop inside an inline SVG (dashes running along lines): the SVG is kept as markup, so the token goes on the
      // element inside it (the SVG sanitizer keeps data-* attributes) and the keyframes are rebuilt like any other loop.
      const inSvg = node ? null : svgTarget(loop.path, nodes);
      if (inSvg && !loop.pseudo && !loop.timeline && loop.keyframes?.length >= 2) node = inSvg.svg;
      if (!node) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'unmapped' });
        continue;
      }
      if (loop.timeline) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'scroll-linked' });
        continue;
      }
      const own = loop.pseudo ? node.views.desktop?.[loop.pseudo === '::before' ? 'before' : 'after']?.style : node.views.desktop?.style;
      if (!inSvg && loop.source === 'css-animation' && loop.inStylesheet && loop.name && String(own?.['animation-name'] ?? '').split(/,\s*/).includes(loop.name)) {
        stats.loops.carried++;
        continue;
      }
      if (loop.pseudo) {
        stats.loops.skipped.push({ pattern: loop.pattern, reason: 'pseudo-element' });
        continue;
      }
      let built = null;
      if (loop.source === 'script') {
        built = scriptLoop(loop, node);
        // A drift whose period only the tree showed (irRepeat): counted, and the note itself is not part of the loop.
        if (built?.periodFrom === 'tree') {
          stats.loops.repeatFromTree = (stats.loops.repeatFromTree ?? 0) + 1;
          const { periodFrom: _from, ...rest } = built;
          built = rest;
        }
      } else if (loop.keyframes?.length >= 2) {
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
      if (inSvg) {
        if (!tokenizeInSvg(inSvg.svg, inSvg.rest, entry.token)) {
          stats.loops.skipped.push({ pattern: loop.pattern, reason: 'unmapped' });
          continue;
        }
      } else tokenize(node, entry.token);
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
    // Controls of the narrow layouts (mobile-clicks.json, tablet-clicks.json) are found by that view's snapshot path.
    const viewNodes = (key, alt) => {
      const map = new Map();
      const walk = (n) => {
        if (!isElement(n)) return;
        if (n[key]) map.set(n[key], n);
        for (const a of n[alt] ?? []) if (!map.has(a)) map.set(a, n);
        n.children.forEach(walk);
      };
      walk(tree.root);
      return map;
    };
    const desktopNodes = nodes;
    const done = new Set();
    const tabletWidgets = motion.clicksTablet?.widgets ?? [];
    const phoneWidgets = motion.clicksMobile?.widgets ?? [];
    const tabletNodes = tabletWidgets.length ? viewNodes('tpath', 'tpathAlt') : null;
    const phoneNodes = phoneWidgets.length ? viewNodes('mpath', 'mpathAlt') : null;
    const allWidgets = [
      ...(motion.clicks?.widgets ?? []).map((w) => [w, desktopNodes, 'd']),
      ...tabletWidgets.map((w) => [w, tabletNodes, 't']),
      ...phoneWidgets.map((w) => [w, phoneNodes, 'm']),
    ];
    for (const [w, nodes, src] of allWidgets) {
      const ws = stats.widgets;
      // A control another view's probe already rebuilt (the same element) needs nothing more.
      if (src !== 'd' && nodes.get(w.trigger)?.motionTokens?.includes('wt')) {
        ws.skipped.viewDone = (ws.skipped.viewDone ?? 0) + 1;
        continue;
      }
      if (src === 'm') ws.phone = (ws.phone ?? 0) + 1;
      if (src === 't') ws.tablet = (ws.tablet ?? 0) + 1;
      // A part a hover opens (a card unfolding its details, a dropdown) is rebuilt with CSS :hover, no script.
      const onHover = w.opensOn === 'hover' && (w.kind === 'disclosure' || w.kind === 'carousel');
      // A dialog the page already holds (a modal layer at the end of the body, hidden until a click shows it) is a panel
      // that opens like any other: its open state is in the stylesheet, the click adds `is-open`.
      if (!onHover && !((w.kind === 'disclosure' || w.kind === 'dialog') && w.opensOn === 'click')) {
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
      // A link whose click opened the panel is rebuilt as a control only when the original stayed on the page (its script
      // suppressed the link, capture/clicks.js `stay`). A link that also navigates stays a plain link in the copy.
      if (!onHover && w.stay === false) {
        ws.skipped.navigates = (ws.skipped.navigates ?? 0) + 1;
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
        if (on === 'click') {
          // A link keeps its href (where it would lead) but must not follow it: the original stayed on the page.
          if (realHref(triggerNode)) {
            for (const n of [triggerNode, ...(triggerNode.stateTwins ?? [])]) n.stateAttrs = { ...n.stateAttrs, 'data-w-stay': '' };
          }
          // How the original closed it again: Escape and a click outside for a dialog (a layer over the whole screen,
          // whose own control it covers), else what the probe recorded. The control inside it that closed it (a × in the
          // corner, capture/states.js) closes it in the copy too.
          const ways = [];
          if (w.closes === 'escape' || w.kind === 'dialog') ways.push('esc');
          if (w.closes === 'outside' || w.kind === 'dialog') ways.push('out');
          if (ways.length) {
            for (const n of [rootNode, ...(rootNode.stateTwins ?? [])]) n.stateAttrs = { ...n.stateAttrs, 'data-w-dismiss': ways.join(' ') };
            // The layer itself (the dialog box): "outside" means outside it, not outside its area - a dialog's area is the
            // whole body, since that is the only element holding both the layer and its control.
            const layerNode = w.targets?.length ? nodes.get(w.targets[0]) : null;
            if (layerNode) {
              for (const n of [layerNode, ...(layerNode.stateTwins ?? [])]) n.stateAttrs = { ...n.stateAttrs, 'data-w-layer': '' };
            }
          }
          const closeNode = w.closePath ? nodes.get(w.closePath) : null;
          if (closeNode) {
            for (const n of [closeNode, ...(closeNode.stateTwins ?? [])]) n.stateAttrs = { ...n.stateAttrs, 'data-w-x': '' };
          }
        }
        for (const p of effect.parts) {
          if (p.rel === '') continue;
          const partNode = nodes.get(`${rootPath}>${p.rel}`);
          if (partNode) tokenize(partNode, p.token);
        }
        ws.elements++;
      }
    }
  }

  frozenEntrances(site, reg, stats);

  const hover = [...reg.hover.values()];
  const focus = [...reg.focus.values()];
  const reveal = [...reg.reveal.values()];
  const loops = reg.loops.map(({ key, ...rest }) => rest);
  const widgets = [...reg.widgets.values()];
  const scrolled = [...reg.scrolled.values()];
  const any = hover.length || focus.length || reveal.length || loops.length || widgets.length || stateSets || scrolled.length || notices || panels || hoverCards;
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
    panels,
    hoverCards,
    scrolled,
    // Hover / focus tokens only the site's own state rules gave (see noteSource).
    cssOnly: [...tokenSource].filter(([, t]) => t.css > 0 && t.other === 0).map(([token]) => token),
    // The generated script is needed for the reveal (IntersectionObserver), the click widgets, the switched states, the
    // scroll states, the panels a click opens (dialogs the page only renders when open) and the hover cards (their
    // hovered look waits in a <template> until first pointed at); hover, focus and loops are CSS.
    script: reveal.length > 0 || stats.pointer.followers > 0 || widgets.some((w) => !w.on) || stateSets > 0 || scrolled.length > 0 || notices > 0 || panels > 0 || hoverCards > 0,
  } : null;
  return { motion, stats };
}
