// Continuous motion capture (Phase 4b.3): animations that do not wait for the visitor - spinners, marquees / tickers,
// pulses, floating shapes, shimmering backgrounds, dashed strokes. Read from the desktop view after the DOM snapshot and
// BEFORE the screenshots (a screenshot with animations disabled cancels the infinite ones).
//   declared  - document.getAnimations(): CSS animations and Web Animations that repeat (iterations > 1, usually
//               infinite) or follow the scroll (ScrollTimeline / ViewTimeline). Exact timing and the keyframes as
//               the page wrote them (translateX(-50%) stays a percentage). CSS transitions are not loops.
//   script    - motion with no animation object behind it (requestAnimationFrame loops of GSAP, framer-motion, a
//               hand-written marquee): the computed transform / opacity of all elements is compared 450 ms apart,
//               the changing ones (not explained by an animation) are recorded frame by frame for ~2.2 s (a window of one period always holds a maximum and a minimum) and
//               analysed: spin (deg/s), linear movement with wrap-around (px/s, period), oscillation (period, amplitude).
// Reveal effects (one-shot, scroll-triggered) are 4b.2; hover is 4b.1. Elements are identified by the `path` of the DOM
// snapshot (body>div:1>a:2). Output: `loops` in capture/<slug>/motion.json.
//
// Page functions are self-contained (Playwright sends only their source); the analysis below runs in Node.
import { decomposeTransform } from './reveal.js';
import { findLottie, findVideoLayers } from './videotier.js';

/**
 * Page function: the repeating / scroll-linked animations of the document.
 * `all` (capture/visibility.js animations.json, CLONER_SPEC Phase 1 item 7): every animation instead, CSS transitions and
 * one-shots included, listed compactly (type, name, path, iterations, duration), plus the CSSOM's :hover / :focus rule
 * counts. The default reading is unchanged.
 * @returns {{ items: object[], total: number, unreadableSheets: number, definedKeyframes: string[], cssom?: { hover: number, focus: number } }}
 */
export function scanAnimations(opts) {
  const { max = 120, all = false } = opts || {};
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
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
  // @keyframes the readable stylesheets define: a CSS animation of one of them is already carried by the page's CSS.
  const defined = new Set();
  const cssom = { hover: 0, focus: 0 };
  const readRules = (list) => {
    for (const rule of list) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) defined.add(rule.name);
      else if (rule.cssRules) readRules(rule.cssRules);
      if (all && rule.selectorText) {
        if (/:hover\b/.test(rule.selectorText)) cssom.hover++;
        if (/:focus(-visible|-within)?\b/.test(rule.selectorText)) cssom.focus++;
      }
    }
  };
  // A sheet the page may not read contributes no @keyframes name, so `inStylesheet` comes out false for an
  // animation it defines - indistinguishable from a WAAPI one, and the loop is rebuilt from the recording instead
  // of being carried. Counted so the guess is visible rather than silent.
  let unreadableSheets = 0;
  for (const sheet of document.styleSheets) {
    try {
      readRules(sheet.cssRules);
    } catch {
      unreadableSheets++;
    }
  }
  const kebab = (p) => (p === 'cssFloat' ? 'float' : p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
  const items = [];
  let total = 0;
  for (const a of document.getAnimations()) {
    const eff = a.effect;
    const type = a.constructor.name;
    if (!eff || !eff.getKeyframes || (type === 'CSSTransition' && !all)) continue;
    let t;
    try {
      t = eff.getComputedTiming();
    } catch {
      continue;
    }
    const timeline = a.timeline && a.timeline !== document.timeline ? a.timeline.constructor.name : null;
    if (!(t.iterations > 1) && !timeline && !all) continue;
    total++;
    const target = eff.target;
    if (items.length >= max || !target) continue;
    const path = pathOf(target);
    if (!path) continue;
    if (all) {
      items.push({
        type, name: a.animationName || a.transitionProperty || a.id || null, path, pseudo: eff.pseudoElement || null,
        iterations: Number.isFinite(t.iterations) ? t.iterations : 'infinite', duration: Number(t.duration) || 0, playState: a.playState,
      });
      continue;
    }
    const r = target.getBoundingClientRect();
    items.push({
      path, pseudo: eff.pseudoElement || null, tag: target.tagName.toLowerCase(),
      text: (target.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      rect: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
      kind: type === 'CSSAnimation' ? 'css-animation' : 'waapi',
      name: a.animationName || null,
      inStylesheet: a.animationName ? defined.has(a.animationName) : null,
      timeline,
      playState: a.playState, playbackRate: a.playbackRate,
      timing: {
        duration: Number(t.duration) || 0, delay: t.delay, endDelay: t.endDelay, iterations: Number.isFinite(t.iterations) ? t.iterations : 'infinite',
        direction: t.direction, fill: t.fill, easing: t.easing, iterationStart: t.iterationStart,
      },
      keyframes: eff.getKeyframes().slice(0, 14).map((k) => {
        const props = {};
        for (const [key, value] of Object.entries(k)) {
          if (['offset', 'computedOffset', 'easing', 'composite'].includes(key) || value == null) continue;
          if (Object.keys(props).length < 20) props[kebab(key)] = String(value);
        }
        return { offset: k.computedOffset, easing: k.easing, props };
      }),
    });
  }
  return { items, total, unreadableSheets, definedKeyframes: [...defined].slice(0, 100), ...(all && { cssom }) };
}

/**
 * Page function: motion that no animation object explains. Compares the computed transform / opacity of every element
 * `probeMs` apart, then records the changing ones frame by frame for `recordMs`.
 * @returns {Promise<{ candidates: object[], scanned: number, changed: number }>}
 */
export async function findScriptLoops(opts) {
  const { maxCandidates = 40, probeMs = 450, recordMs = 2200, inView = false, minWidth = 0 } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE', 'DEFS', 'TITLE', 'DESC']);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) {
        parts.push('body');
        break;
      }
      let index = 0;
      for (const s of n.parentElement ? n.parentElement.children : []) {
        if (['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE'].includes(s.tagName)) continue;
        if (s.tagName === n.tagName) index++;
        if (s === n) break;
      }
      parts.push(`${n.tagName.toLowerCase()}:${index}`);
    }
    return parts.length && parts[parts.length - 1] === 'body' ? parts.reverse().join('>') : null;
  };
  // Everything a script moves or fades an element with: its transform and the individual transform properties, its
  // opacity, and also its position (`left` / `top` of a positioned element: particles and floating shapes are often moved
  // that way), its `filter` (a colour cycle), and an SVG shape's own position attributes (x / y / cx / cy).
  const read = (el) => {
    const cs = getComputedStyle(el);
    const at = (n) => el.getAttribute(n);
    return [cs.transform, cs.opacity, cs.rotate, cs.translate, cs.scale,
      cs.position !== 'static' ? cs.left : 'auto', cs.position !== 'static' ? cs.top : 'auto', cs.filter,
      at('x') ?? at('cx') ?? '', at('y') ?? at('cy') ?? ''];
  };
  const els = [...(document.body ? document.body.querySelectorAll('*') : [])].filter((e) => !SKIP_TAGS.has(e.tagName.toUpperCase())).slice(0, 6000);
  const before = els.map(read);
  await sleep(probeMs);
  const changed = [];
  els.forEach((el, i) => {
    const now = read(el);
    if (now.some((v, k) => v !== before[i][k])) changed.push(el);
  });
  // Animations (including a transition that is still running) explain a change; so does nothing else.
  // Below the first screen (inView): only what the window shows now, and strips (minWidth), not a reveal finishing.
  const shownNow = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= minWidth && (!inView || (r.bottom > 0 && r.top < innerHeight));
  };
  // An SVG element animated by its own SMIL child (<animate>, <animateTransform>, <animateMotion>, <set>) is explained
  // too: the copy keeps that markup, so it keeps moving - a loop rebuilt on top would move it twice.
  const smil = (el) => [...el.children].some((c) => /^(animate|animatetransform|animatemotion|set)$/i.test(c.tagName));
  const loose = changed.filter((el) => !(el.getAnimations?.().length) && !smil(el) && shownNow(el));
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const chosen = loose.sort((a, b) => area(b) - area(a)).slice(0, maxCandidates);
  const series = chosen.map(() => []);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const frame = (now) => {
      chosen.forEach((el, i) => {
        if (series[i].length < 140) series[i].push([Math.round((now - t0) * 10) / 10, ...read(el)]);
      });
      if (now - t0 < recordMs) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  // A ticker repeats its items (the page duplicates them so the strip never runs empty): the distance from the first item
  // to its next copy is how far the strip moves before it looks the same again.
  const repeatOf = (el) => {
    const kids = [...el.children].filter((c) => c.getBoundingClientRect().width > 0);
    const n = kids.length;
    if (n < 2) return null;
    const sig = kids.map((c) => [c.tagName, (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), c.querySelector('img')?.getAttribute('src') ?? '', c.childElementCount].join('|'));
    for (let k = 1; k <= n / 2; k++) {
      let same = true;
      for (let i = 0; i + k < n && same; i++) same = sig[i] === sig[i + k];
      if (!same) continue;
      const a = kids[0].getBoundingClientRect();
      const b = kids[k].getBoundingClientRect();
      return { x: Math.round((b.left - a.left) * 10) / 10, y: Math.round((b.top - a.top) * 10) / 10, items: k };
    }
    return null;
  };
  return {
    scanned: els.length,
    changed: changed.length,
    candidates: chosen.map((el, i) => {
      const r = el.getBoundingClientRect();
      const repeat = repeatOf(el);
      return {
        path: pathOf(el), tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        rect: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], series: series[i],
        ...(repeat && { repeat }),
      };
    }).filter((c) => c.path),
  };
}

/**
 * Page function: records the elements at `paths` (snapshot paths) for up to `ms`, a sample every `every` ms, and stops
 * early once each has turned around twice. For slow movers a short recording saw going one way only (a shape floating
 * up and down over several seconds).
 */
export async function recordPaths({ paths, ms = 9000, every = 50 }) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const byPath = (p) => {
    let el = document.body;
    for (const part of p.split('>').slice(1)) {
      const [tag, n] = part.split(':');
      let k = 0;
      el = [...(el ? el.children : [])].find((c) => !SKIP.has(c.tagName) && c.tagName.toLowerCase() === tag && ++k === Number(n)) ?? null;
      if (!el) return null;
    }
    return el;
  };
  // The same reading as findScriptLoops (keep the two in step).
  const read = (el) => {
    const cs = getComputedStyle(el);
    const at = (n) => el.getAttribute(n);
    return [cs.transform, cs.opacity, cs.rotate, cs.translate, cs.scale,
      cs.position !== 'static' ? cs.left : 'auto', cs.position !== 'static' ? cs.top : 'auto', cs.filter,
      at('x') ?? at('cx') ?? '', at('y') ?? at('cy') ?? ''];
  };
  // The position along both axes and the opacity (×100, so a 0.01 step counts like a quarter pixel), enough to see a
  // turn (the full reading is kept for the analysis).
  const pos = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + scrollX, r.top + scrollY, Number(getComputedStyle(el).opacity) * 100];
  };
  const els = paths.map(byPath);
  const series = els.map(() => []);
  const turns = els.map(() => ({ last: null, dir: [0, 0, 0], count: 0 }));
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const t = Math.round(performance.now() - t0);
    els.forEach((el, i) => {
      if (!el || series[i].length >= 200) return;
      series[i].push([t, ...read(el)]);
      const p = pos(el);
      const s = turns[i];
      if (s.last) {
        for (const a of [0, 1, 2]) {
          const d = Math.sign(Math.round((p[a] - s.last[a]) * 4) / 4);
          if (d && s.dir[a] && d !== s.dir[a]) s.count++;
          if (d) s.dir[a] = d;
        }
      }
      s.last = p;
    });
    // Early stop only after clear turns (a jittering position counts many small ones).
    if (turns.every((s, i) => !els[i] || s.count >= 6)) break;
    await new Promise((r) => setTimeout(r, every));
  }
  return series;
}

// ---- Node side ------------------------------------------------------------------------------------------------

const SLOW_MOVER_PX = 60; // a one-way move smaller than this in the short recording may be a slow float
const SLOW_FADE = 0.5; // a one-way opacity change smaller than this in the short recording may be a slow pulse
const SLOW_WATCH_MS = 9000;
const MAX_SCROLL_STEPS = 12; // windows scrolled through for strips that move only on screen // watched again for up to this long (stops once each one turned twice)

const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const angle = (value) => {
  const m = /^(-?[\d.]+)(deg|turn|rad|grad)?$/.exec(String(value).trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === 'turn' ? n * 360 : m[2] === 'rad' ? (n * 180) / Math.PI : m[2] === 'grad' ? n * 0.9 : n;
};
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * What a declared keyframe changes: translate (px, and % kept apart), rotation (deg), scale, opacity and the other
 * properties it sets. Understands transform functions as authored and the individual translate / rotate / scale properties.
 */
export function keyframeValues(props) {
  const out = { tx: 0, ty: 0, txPct: 0, tyPct: 0, rot: 0, scale: 1, opacity: props.opacity != null ? num(props.opacity) : null, other: Object.keys(props).filter((k) => !['transform', 'translate', 'rotate', 'scale', 'opacity'].includes(k)) };
  const t = props.transform;
  if (t && t !== 'none') {
    const matrix = /^matrix(3d)?\(/.exec(t.trim());
    if (matrix) {
      const d = decomposeTransform(t);
      if (d) Object.assign(out, { tx: d.translate[0], ty: d.translate[1], rot: d.rotate, scale: d.scale[0] });
    } else {
      for (const m of t.matchAll(/(translate3d|translateX|translateY|translate|rotateZ|rotate|scaleX|scaleY|scale)\(([^)]*)\)/g)) {
        const args = m[2].split(',').map((x) => x.trim());
        const px = (a) => (a && !a.endsWith('%') ? num(a) : 0);
        const pct = (a) => (a && a.endsWith('%') ? num(a) : 0);
        if (m[1] === 'translateX') (out.tx += px(args[0])), (out.txPct += pct(args[0]));
        else if (m[1] === 'translateY') (out.ty += px(args[0])), (out.tyPct += pct(args[0]));
        else if (m[1] === 'translate' || m[1] === 'translate3d') {
          out.tx += px(args[0]);
          out.txPct += pct(args[0]);
          out.ty += px(args[1]);
          out.tyPct += pct(args[1]);
        } else if (m[1] === 'rotate' || m[1] === 'rotateZ') out.rot += angle(args[0]);
        else if (m[1] === 'scale' || m[1] === 'scaleX') out.scale *= num(args[0]) || 1;
        else if (m[1] === 'scaleY' && !('scaleY' in out)) out.scale *= num(args[0]) || 1;
      }
    }
  }
  if (props.translate && props.translate !== 'none') {
    const a = props.translate.trim().split(/\s+/);
    if (a[0]?.endsWith('%')) out.txPct += num(a[0]);
    else out.tx += num(a[0]);
    if (a[1]?.endsWith('%')) out.tyPct += num(a[1]);
    else out.ty += num(a[1]);
  }
  if (props.rotate && props.rotate !== 'none') out.rot += angle(props.rotate.split(/\s+/).pop());
  if (props.scale && props.scale !== 'none') out.scale *= num(props.scale.split(/\s+/)[0]) || 1;
  return out;
}

/**
 * Names what a declared animation does, from its keyframes and timing.
 * @returns {{ pattern: string, params: object }}
 */
export function classifyKeyframes(keyframes, timing) {
  const values = keyframes.map((k) => keyframeValues(k.props));
  const props = new Set(keyframes.flatMap((k) => Object.keys(k.props)));
  const span = (f) => {
    const xs = values.map(f);
    return Math.max(...xs) - Math.min(...xs);
  };
  const rot = span((v) => v.rot);
  const tx = Math.max(span((v) => v.tx), span((v) => v.txPct) * 2);
  const ty = Math.max(span((v) => v.ty), span((v) => v.tyPct) * 2);
  const scale = span((v) => v.scale);
  const opacitySpan = values.every((v) => v.opacity != null) ? span((v) => v.opacity) : (values.some((v) => v.opacity != null) ? 1 : 0);
  // Holds: consecutive keyframes with the same values (the state is kept for a while). A rotator that shows one
  // word / slide after the other and moves in between is a cycle, whatever it moves.
  const same = (a, b) => JSON.stringify(a.props) === JSON.stringify(b.props);
  const holds = keyframes.slice(1).filter((k, i) => same(k, keyframes[i])).length;
  // Back where it started after the keyframes: a round trip, like alternating (a floating shape, a sway).
  const first = values[0];
  const last = values[values.length - 1];
  const roundTrip = keyframes.length >= 3 && Math.abs(last.tx - first.tx) < 1 && Math.abs(last.ty - first.ty) < 1 && Math.abs(last.txPct - first.txPct) < 1 && Math.abs(last.tyPct - first.tyPct) < 1 && Math.abs(last.rot - first.rot) < 1;
  const alternate = /alternate/.test(timing.direction ?? '') || roundTrip;
  const linear = (timing.easing ?? 'linear') === 'linear' || keyframes.every((k) => !k.easing || k.easing === 'linear');
  const unit = (fn) => ({ px: round(fn.px), percent: round(fn.pct) });
  if ([...props].some((p) => /^stroke-dash/.test(p))) return { pattern: 'dash', params: { properties: [...props].filter((p) => /^stroke-dash/.test(p)) } };
  if ([...props].some((p) => /^background-position/.test(p))) return { pattern: 'background-scroll', params: { alternate } };
  if (holds >= 2 && (rot >= 45 || tx >= 4 || ty >= 4 || opacitySpan >= 0.2)) {
    return { pattern: 'cycle', params: { stops: holds + 1, axis: tx >= ty ? 'x' : 'y', ...(opacitySpan >= 0.2 && { fades: true }) } };
  }
  if (rot >= 45) {
    const total = values[values.length - 1].rot - values[0].rot;
    return { pattern: alternate ? 'sway' : 'spin', params: { degrees: round(total), clockwise: total >= 0, linear } };
  }
  // Going back and forth is deliberate from a few px on; a one-way move needs a real distance (a ticker, not a jitter).
  if (tx >= (alternate ? 4 : 20) || ty >= (alternate ? 4 : 20)) {
    const horizontal = tx >= ty;
    const dist = horizontal ? unit({ px: last.tx - first.tx, pct: last.txPct - first.txPct }) : unit({ px: last.ty - first.ty, pct: last.tyPct - first.tyPct });
    if (alternate) return { pattern: horizontal ? 'sway' : 'float', params: { axis: horizontal ? 'x' : 'y', distance: dist, linear } };
    return { pattern: horizontal ? 'marquee' : 'ticker', params: { axis: horizontal ? 'x' : 'y', distance: dist, linear } };
  }
  if (scale >= 0.03) return { pattern: 'pulse', params: { scale: [round(Math.min(...values.map((v) => v.scale))), round(Math.max(...values.map((v) => v.scale)))] } };
  if (opacitySpan >= 0.2) return { pattern: 'blink', params: { opacity: [round(Math.min(...values.map((v) => v.opacity ?? 1))), round(Math.max(...values.map((v) => v.opacity ?? 1)))] } };
  if (tx >= 2 || ty >= 2) return { pattern: 'jiggle', params: {} };
  return { pattern: 'other', params: { properties: [...props].slice(0, 6) } };
}

const parsePair = (v) => {
  const a = String(v ?? '').trim().split(/\s+/);
  return [a[0] && a[0] !== 'none' ? num(a[0]) : 0, a[1] ? num(a[1]) : 0];
};

/** Per-sample channels of a recorded series: x / y (px), rotation (deg, unwrapped), scale, opacity. */
function channels(series) {
  let prevRot = null;
  let offset = 0;
  return series.map(([t, transform, opacity, rotate, translate, scale, left, top, filter, svgX, svgY]) => {
    const d = decomposeTransform(transform) ?? { translate: [0, 0], scale: [1, 1], rotate: 0 };
    const tr = parsePair(translate);
    // A position a script writes (`left` / `top`, an SVG shape's x / y) moves the element like a translate does: the
    // constant part cancels out in every range, period and path read below.
    const pos = (v) => (typeof v === 'string' && /^-?[\d.]+(px)?$/.test(v.trim()) ? Number.parseFloat(v) : 0);
    tr[0] += pos(left) + pos(svgX);
    tr[1] += pos(top) + pos(svgY);
    const hue = /hue-rotate\(\s*(-?[\d.]+)deg/.exec(String(filter ?? ''));
    let rot = d.rotate + (rotate && rotate !== 'none' ? angle(rotate.split(/\s+/).pop()) : 0);
    // Unwrap +-180 jumps so a full turn per second reads as one steady slope.
    if (prevRot != null) {
      const diff = rot + offset - prevRot;
      if (diff > 180) offset -= 360 * Math.round(diff / 360);
      else if (diff < -180) offset += 360 * Math.round(-diff / 360);
    }
    rot += offset;
    prevRot = rot;
    const sc = scale && scale !== 'none' ? num(String(scale).split(/\s+/)[0]) || 1 : 1;
    return { t, x: d.translate[0] + tr[0], y: d.translate[1] + tr[1], rot, scale: d.scale[0] * sc, opacity: num(opacity), hue: hue ? Number(hue[1]) : 0 };
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Points of a recorded trace: enough to follow it, few enough for a small @keyframes block. */
export const TRACE_POINTS = 16;

/**
 * A recorded movement as TRACE_POINTS evenly spaced samples relative to where it started: time (ms from the start), x, y,
 * rotation, scale, opacity - and which of them changed at all.
 * @returns {{ durationMs: number, channels: string[], points: number[][] }}
 */
export function traceOf(ch) {
  const t0 = ch[0].t;
  const durationMs = Math.max(1, ch[ch.length - 1].t - t0);
  const at = (t) => ch.reduce((best, c) => (Math.abs(c.t - t) < Math.abs(best.t - t) ? c : best), ch[0]);
  const pts = Array.from({ length: TRACE_POINTS }, (_, i) => at(t0 + (durationMs * i) / (TRACE_POINTS - 1)));
  const range = (k) => Math.max(...ch.map((c) => c[k])) - Math.min(...ch.map((c) => c[k]));
  const channels = [['x', 2], ['y', 2], ['rot', 1], ['scale', 0.01], ['opacity', 0.02]].filter(([k, min]) => range(k) >= min).map(([k]) => k);
  return {
    durationMs: Math.round(durationMs),
    channels,
    points: pts.map((c) => [Math.round(c.t - t0), round(c.x - ch[0].x, 1), round(c.y - ch[0].y, 1), round(c.rot - ch[0].rot, 1), round(c.scale / (ch[0].scale || 1), 3), round(c.opacity, 3)]),
  };
}

/** Points of a path per period: enough for a smooth loop, few enough for a small @keyframes block. */
export const PATH_POINTS = 12;

/**
 * The x / y path over one period, at PATH_POINTS evenly spaced times, relative to the middle of the movement (so the copy
 * moves around where the element stands). Null when the recording does not cover a whole period.
 * @returns {[number, number][] | null}
 */
export function periodPath(ch, periodMs) {
  if (!(periodMs > 0) || ch[ch.length - 1].t - ch[0].t < periodMs) return null;
  const at = (t) => ch.reduce((best, c) => (Math.abs(c.t - t) < Math.abs(best.t - t) ? c : best), ch[0]);
  const pts = Array.from({ length: PATH_POINTS }, (_, i) => at(ch[0].t + (periodMs * i) / PATH_POINTS));
  const mid = (k) => (Math.max(...ch.map((c) => c[k])) + Math.min(...ch.map((c) => c[k]))) / 2;
  const [mx, my] = [mid('x'), mid('y')];
  return pts.map((c) => [round(c.x - mx, 1), round(c.y - my, 1)]);
}

/**
 * Names what a recorded series does: spin (deg/s), linear movement with wrap-around (px/s, period), oscillation
 * (period, amplitude), or nothing steady.
 * @returns {null | { pattern: string, channel: string, rate?: number, unit?: string, periodMs?: number, amplitude?: number, range: number, wrap?: object }}
 */
export function analyzeSeries(series) {
  if (series.length < 8) return null;
  const ch = channels(series);
  const defs = [['x', 'px', 3], ['y', 'px', 3], ['rot', 'deg', 5], ['scale', '', 0.03], ['opacity', '', 0.05], ['hue', 'deg', 5]];
  let best = null;
  for (const [key, unit, min] of defs) {
    const vs = ch.map((c) => c[key]);
    const range = Math.max(...vs) - Math.min(...vs);
    if (range >= min && (!best || range / min > best.score)) best = { key, unit, range, score: range / min, vs };
  }
  if (!best) return null;
  const { key, unit, range, vs } = best;
  const dts = ch.slice(1).map((c, i) => c.t - ch[i].t);
  const diffs = vs.slice(1).map((v, i) => v - vs[i]);
  const dir = Math.sign(median(diffs.filter((d) => d !== 0)));
  // A wrap-around: one step that jumps back across most of the range (a marquee that restarts).
  const wraps = diffs.map((d, i) => (Math.abs(d) > range * 0.5 && dir !== 0 && Math.sign(d) === -dir ? i : -1)).filter((i) => i >= 0);
  const regular = diffs.map((d, i) => ({ d, dt: dts[i] })).filter((_, i) => !wraps.includes(i) && dts[i] > 0);
  const same = regular.filter((r) => Math.sign(r.d) === dir || r.d === 0).length / Math.max(1, regular.length);
  if (dir !== 0 && same >= 0.85) {
    const rate = median(regular.map((r) => Math.abs(r.d) / (r.dt / 1000)));
    const out = { channel: key, unit, range: round(range), rate: round(rate, rate < 1 ? 4 : 2), direction: dir > 0 ? 'forward' : 'backward' };
    // The trace always goes with it: the copy's rules (a steady spin, a seamless ticker) come first, and when none fits -
    // a movement made of jumps with a median step of 0 (a counter that rolls in steps), a one-step change, no period to
    // slide by - the recorded motion is what it plays (ir/motion.js scriptLoop), rather than standing still.
    const trace = ch.length >= 8 ? { trace: traceOf(ch) } : {};
    if (key === 'rot') return { pattern: 'spin', ...out, ...trace };
    if (key === 'x' || key === 'y') {
      const w = wraps.length ? { distance: round(Math.abs(wraps.map((i) => diffs[i]).reduce((a, b) => a + b, 0) / wraps.length)) } : undefined;
      let periodMs;
      if (wraps.length >= 2) periodMs = Math.round((ch[wraps[wraps.length - 1] + 1].t - ch[wraps[0] + 1].t) / (wraps.length - 1));
      return { pattern: 'drift', ...out, ...(w && { wrap: w }), ...(periodMs && { periodMs }), ...trace };
    }
    return { pattern: 'ramp', ...out, ...trace };
  }
  // Oscillation: the direction of movement reverses at least twice.
  const smooth = diffs.map((d, i) => d + (diffs[i + 1] ?? 0)); // two frames, steadier than one
  const turns = [];
  // Against the last direction seen: a slow movement holds still for a few samples at each end (zero steps in between).
  let last = 0;
  for (let i = 0; i < smooth.length; i++) {
    const s = Math.sign(smooth[i]);
    if (!s) continue;
    if (last && s !== last) turns.push(ch[i].t);
    last = s;
  }
  if (turns.length >= 2) {
    const half = median(turns.slice(1).map((t, i) => t - turns[i]));
    const periodMs = Math.round(half * 2);
    // Moving on the other axis too (a particle circling, a shape drifting diagonally): one axis alone would rebuild a
    // line where the original drew a loop, so the recorded path over one period goes with it.
    const other = key === 'x' ? 'y' : key === 'y' ? 'x' : null;
    const otherMoves = Boolean(other) && Math.max(...ch.map((c) => c[other])) - Math.min(...ch.map((c) => c[other])) >= 3;
    const path = otherMoves ? periodPath(ch, periodMs) : null;
    // Both axes move but the recording is shorter than a period (no path): its trace keeps both, so the copy never
    // flattens a wandering movement to one axis (ir/motion.js scriptLoop plays the trace before the one-axis rule).
    const trace = otherMoves && !path && ch.length >= 8 ? { trace: traceOf(ch) } : {};
    return { pattern: 'oscillate', channel: key, unit, range: round(range), amplitude: round(range / 2), periodMs, min: round(Math.min(...vs), 3), max: round(Math.max(...vs), 3), ...(path && { path }), ...trace };
  }
  // No pattern (it wanders, or its loop is longer than what was watched): the trace itself, a few points, is what the copy
  // can play - back and forth, so it never jumps (ir/motion.js scriptLoop, reported as approximate).
  return { pattern: 'move', channel: key, unit, range: round(range), ...(ch.length >= 8 && { trace: traceOf(ch) }) };
}

/**
 * Turns the raw page results into the `loops` description of motion.json.
 * @param {{ scan: object, script?: object }} raw
 */
export function processLoops({ scan, script }) {
  const stats = { css: 0, waapi: 0, script: 0, scrollLinked: 0, paused: 0, inStylesheet: 0, unreadableSheets: scan.unreadableSheets ?? 0, total: scan.total, truncated: scan.total > scan.items.length, scriptScanned: script?.scanned ?? 0, scriptChanged: script?.changed ?? 0, patterns: {} };
  const loops = [];
  for (const it of scan.items) {
    const { pattern, params } = classifyKeyframes(it.keyframes, it.timing);
    const loop = {
      path: it.path, ...(it.pseudo && { pseudo: it.pseudo }), tag: it.tag, ...(it.text && { text: it.text }), rect: it.rect,
      source: it.kind, ...(it.name && { name: it.name }), ...(it.inStylesheet != null && { inStylesheet: it.inStylesheet }),
      ...(it.timeline && { timeline: it.timeline }),
      pattern, params, timing: { ...it.timing, playbackRate: it.playbackRate, playState: it.playState }, keyframes: it.keyframes,
    };
    loops.push(loop);
    if (it.timeline) stats.scrollLinked++;
    else stats[it.kind === 'css-animation' ? 'css' : 'waapi']++;
    if (it.playState === 'paused') stats.paused++;
    if (it.inStylesheet) stats.inStylesheet++;
    stats.patterns[pattern] = (stats.patterns[pattern] ?? 0) + 1;
  }
  for (const c of script?.candidates ?? []) {
    const a = analyzeSeries(c.series);
    if (!a) continue;
    loops.push({ path: c.path, tag: c.tag, ...(c.text && { text: c.text }), rect: c.rect, source: 'script', pattern: a.pattern, params: { ...a, ...(c.repeat && { repeat: c.repeat }) }, timing: { driver: 'script', ...(a.periodMs && { periodMs: a.periodMs }) } });
    stats.script++;
    stats.patterns[a.pattern] = (stats.patterns[a.pattern] ?? 0) + 1;
  }
  return { version: 1, loops, stats };
}

/** At most this many canvases of a page are looked at (each costs two element screenshots). */
export const MAX_CANVASES = 8;

/**
 * Page function: the visible <canvas> elements (a WebGL scene, a chart, a particle field, a game). What they draw comes
 * from a script, which the copy never carries, so they are recorded to be reported - never passed off as copied.
 * `context` asks the canvas which kind it is ('2d' when a 2d context answers; an uninitialised canvas gets one, which
 * draws nothing).
 */
export function listCanvases({ max = 8 } = {}) {
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
  const out = [];
  document.querySelectorAll('canvas').forEach((c, index) => {
    if (out.length >= max) return;
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    if (r.width < 24 || r.height < 24 || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
    let context = 'webgl';
    try {
      if (c.getContext('2d')) context = '2d';
    } catch {
      context = 'unknown';
    }
    out.push({
      index, path: pathOf(c), context,
      rect: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
      // How much of the window it covers: a page drawn mostly on canvas (a Flutter / game page) is a different case.
      cover: Math.round(((Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * 100) / (innerWidth * innerHeight)) / 100,
    });
  });
  return out;
}

/** A canvas that keeps drawing is recorded for at most this long, a frame about every CANVAS_FRAME_MS, this wide. */
export const CANVAS_RECORD_MS = 4000;
export const CANVAS_FRAME_MS = 120;
export const CANVAS_LOOP_WIDTH = 480;
const MAX_LOOPED_CANVASES = 3;

/** Share of pixels that differ between two raw frames of the same size (a channel moved by more than 24). */
export function frameDiff(a, b) {
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return 1;
  const px = a.info.width * a.info.height;
  let changed = 0;
  for (let i = 0; i < px; i++) {
    const o = i * a.info.channels;
    for (let k = 0; k < a.info.channels; k++) {
      if (Math.abs(a.data[o + k] - b.data[o + k]) > 24) {
        changed++;
        break;
      }
    }
  }
  return changed / px;
}

/**
 * What a canvas draws over a few seconds, as a looping animated picture: frames of the element, the loop closed at the
 * frame most like the first one when one is close enough (a scene that repeats loops seamlessly), else played forward and
 * back (no jump at the seam). The canvas's own script is what drew it, and the copy has none: this is a recording of it,
 * reported as such, never a reproduction - and a canvas that reacts to the visitor does not react in the copy.
 * @returns {Promise<{ webp: Buffer, frames: number, delayMs: number, seamless: boolean } | null>}
 */
export async function recordCanvasLoop(locator, sharp, { ms = CANVAS_RECORD_MS, every = CANVAS_FRAME_MS, width = CANVAS_LOOP_WIDTH } = {}) {
  const loop = await recordLoopFrames(locator, sharp, { ms, every, width });
  if (!loop) return null;
  const webp = await sharp(loop.frames, { join: { animated: true } }).webp({ quality: 70, delay: loop.frames.map(() => loop.delayMs), loop: 0 }).toBuffer();
  return { webp, frames: loop.frames.length, delayMs: loop.delayMs, seamless: loop.seamless };
}

/**
 * The frames of a recording, closed into a loop (the one recorder behind both the animated canvas picture above and the
 * video tier, capture/videotier.js): a frame of `locator` every `every` ms for `ms`, then the loop closed at the frame
 * most like the first one when one is close enough (seamless), else played forward and back (no jump at the seam).
 * `advance(ms)`: a stepped clock (the video tier moves the page's own clock by exactly one frame between two shots, so
 * the recording is deterministic and as smooth as asked whatever a screenshot costs); without it the page runs in real
 * time and the recorder waits. `shoot`: how one frame is taken (default: the element's own picture).
 * @returns {Promise<{ frames: Buffer[], delayMs: number, seamless: boolean, recorded: number, closeness: number } | null>}
 */
export async function recordLoopFrames(locator, sharp, { ms = CANVAS_RECORD_MS, every = CANVAS_FRAME_MS, width = CANVAS_LOOP_WIDTH, advance = null, shoot = null, minFrames = 6, seamlessDiff = 0.02 } = {}) {
  const pngs = [];
  const times = [];
  const t0 = Date.now();
  const take = shoot ?? (() => locator.screenshot({ timeout: 5000, animations: 'allow' }));
  for (let i = 0; advance ? i * every < ms : Date.now() - t0 < ms; i++) {
    const shot = await take();
    pngs.push(await sharp(shot).resize({ width, withoutEnlargement: true }).png().toBuffer());
    times.push(advance ? i * every : Date.now() - t0);
    if (advance) await advance(every);
    else await new Promise((r) => setTimeout(r, every));
  }
  if (pngs.length < minFrames) return null;
  const raws = await Promise.all(pngs.map((p) => sharp(p).resize({ width: 96 }).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  // The loop's end: the frame most like the first, at least a third of the way in.
  let best = { k: -1, diff: 1 };
  for (let k = Math.max(4, Math.floor(raws.length / 3)); k < raws.length; k++) {
    const d = frameDiff(raws[0], raws[k]);
    if (d < best.diff) best = { k, diff: d };
  }
  const seamless = best.k > 0 && best.diff < seamlessDiff;
  const frames = seamless ? pngs.slice(0, best.k) : [...pngs, ...pngs.slice(1, -1).reverse()];
  const delayMs = advance ? every : Math.max(40, Math.round(times[times.length - 1] / Math.max(1, times.length - 1)));
  return { frames, delayMs, seamless, recorded: pngs.length, closeness: Math.round((1 - best.diff) * 1000) / 1000 };
}

/**
 * The canvases of a page and whether each keeps drawing: two pictures of it 700 ms apart, compared pixel by pixel
 * (downscaled; a channel moved by more than 24 = changed). Never throws: a canvas that cannot be photographed is listed
 * without `animated`.
 */
export async function captureCanvases(page) {
  const list = await page.evaluate(listCanvases, { max: MAX_CANVASES }).catch(() => []);
  const sharp = list.length ? (await import('sharp')).default : null;
  for (const c of list) {
    try {
      const el = page.locator('canvas').nth(c.index);
      const shot = async () => sharp(await el.screenshot({ timeout: 5000, animations: 'allow' })).resize({ width: 160 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const a = await shot();
      await page.waitForTimeout(700);
      const b = await shot();
      let changed = 0;
      const px = a.info.width * a.info.height;
      if (a.info.width === b.info.width && a.info.height === b.info.height) {
        for (let i = 0; i < px; i++) {
          const o = i * a.info.channels;
          for (let k = 0; k < a.info.channels; k++) {
            if (Math.abs(a.data[o + k] - b.data[o + k]) > 24) {
              changed++;
              break;
            }
          }
        }
      }
      c.animated = changed / px > 0.002;
      // One that keeps drawing is recorded as a loop (written beside the capture by capture/index.js).
      if (c.animated && list.filter((x) => x.loopWebp).length < MAX_LOOPED_CANVASES) {
        const loop = await recordCanvasLoop(el, sharp).catch(() => null);
        if (loop) {
          c.loopWebp = loop.webp;
          c.loop = { frames: loop.frames, delayMs: loop.delayMs, seamless: loop.seamless, bytes: loop.webp.length };
        }
      }
    } catch {
      // left without `animated`: listed all the same
    }
    delete c.index;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return list;
}

/**
 * Reads the continuous motion of a page (desktop view). Never throws for a page function failing: the part that failed is left out.
 * @param {import('playwright').Page} page
 */
export async function captureLoops(page, { script = true, recordMs = 2200, slowWatchMs = SLOW_WATCH_MS } = {}) {
  const scan = await page.evaluate(scanAnimations, {}).catch(() => ({ items: [], total: 0, definedKeyframes: [] }));
  const found = script ? await page.evaluate(findScriptLoops, { recordMs }).catch(() => null) : null;
  // A small, slow one-way move that never turned in the short recording is often a shape floating up and down over
  // several seconds: watched again longer (only these), it shows its turns and becomes an oscillation.
  const slow = (found?.candidates ?? []).filter((c) => {
    const a = analyzeSeries(c.series);
    // One way (drift), or one turn only (move): not enough of it was seen. A slow fade that only went one way (a card
    // "breathing" over several seconds: opacity 0.07 in 2 s) is watched longer too.
    if (a?.pattern === 'ramp' && a.channel === 'opacity' && a.range < SLOW_FADE) return true;
    // Moving on both axes with a loop longer than the short recording (a particle circling slowly): watched longer, so a
    // whole period - and so its path - is seen.
    if (a?.pattern === 'oscillate' && (a.channel === 'x' || a.channel === 'y') && !a.path) {
      const ch = c.series.map((s) => s[0]);
      const span = ch.length ? ch[ch.length - 1] - ch[0] : 0;
      if (a.periodMs > span) return true;
    }
    // Movement with no pattern in the short recording (it turned once, or wanders): watched longer, so a slow loop shows
    // its period - and what still has none is rebuilt from the longer trace (ir/motion.js, approximate).
    if (a?.pattern === 'move') return true;
    // One way with no wrap and no repeating items: a ticker would have shown one or the other, so it may be a slow loop
    // caught on its way in one direction (whatever its size) - watched longer too.
    return a?.pattern === 'drift' && !a.wrap && !c.repeat && (a.channel === 'x' || a.channel === 'y');
  }).slice(0, 12);
  if (slow.length) {
    const longer = await page.evaluate(recordPaths, { paths: slow.map((c) => c.path), ms: slowWatchMs, every: Math.max(50, Math.round(slowWatchMs / 200)) }).catch(() => null);
    slow.forEach((c, i) => {
      if (longer?.[i]?.length >= 8) c.series = longer[i];
    });
  }
  // Strips that move only while they are on screen (a ticker of testimonials further down pauses out of view): the page is
  // scrolled a window at a time and what moves there by itself (strips, not a reveal finishing) is recorded too.
  if (found && script) {
    const seen = new Set(found.candidates.map((c) => c.path));
    const { height, view } = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, view: innerHeight })).catch(() => ({ height: 0, view: 0 }));
    for (let y = Math.round(view * 0.8), steps = 0; view && y < height - view * 0.2 && steps < MAX_SCROLL_STEPS; y += Math.round(view * 0.8), steps++) {
      await page.evaluate((top) => window.scrollTo(0, top), y).catch(() => {});
      await page.waitForTimeout(700);
      const more = await page.evaluate(findScriptLoops, { recordMs: 1200, maxCandidates: 6, inView: true, minWidth: 200 }).catch(() => null);
      for (const c of more?.candidates ?? []) {
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        found.candidates.push(c);
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }
  // What canvases draw cannot be rebuilt without their script: recorded here so the copy reports them (and shows the
  // frame the capture saw) instead of an empty box that passes for copied.
  const canvas = await captureCanvases(page).catch(() => []);
  const out = processLoops({ scan, script: found ?? undefined });
  if (canvas.length) {
    out.canvas = canvas;
    out.stats.canvas = canvas.length;
    out.stats.canvasAnimated = canvas.filter((c) => c.animated).length;
  }
  // The video tier's other candidates (capture/videotier.js): what a script keeps reshaping in a way the loops above
  // cannot rebuild, and the page's Lottie animations.
  const layers = await page.evaluate(findVideoLayers, {}).catch(() => null);
  if (layers?.layers.length || layers?.skipped.length) out.videoLayers = layers;
  const lottie = await page.evaluate(findLottie, {}).catch(() => null);
  if (lottie?.animations.length || lottie?.players.length) out.lottie = lottie;
  return out;
}
