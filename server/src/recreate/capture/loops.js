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

/**
 * Page function: the repeating / scroll-linked animations of the document.
 * @returns {{ items: object[], total: number, definedKeyframes: string[] }}
 */
export function scanAnimations(opts) {
  const { max = 120 } = opts || {};
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
  const readRules = (list) => {
    for (const rule of list) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) defined.add(rule.name);
      else if (rule.cssRules) readRules(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      readRules(sheet.cssRules);
    } catch { /* cross-origin sheet */ }
  }
  const kebab = (p) => (p === 'cssFloat' ? 'float' : p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
  const items = [];
  let total = 0;
  for (const a of document.getAnimations()) {
    const eff = a.effect;
    const type = a.constructor.name;
    if (!eff || !eff.getKeyframes || type === 'CSSTransition') continue;
    let t;
    try {
      t = eff.getComputedTiming();
    } catch {
      continue;
    }
    const timeline = a.timeline && a.timeline !== document.timeline ? a.timeline.constructor.name : null;
    if (!(t.iterations > 1) && !timeline) continue;
    total++;
    const target = eff.target;
    if (items.length >= max || !target) continue;
    const path = pathOf(target);
    if (!path) continue;
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
  return { items, total, definedKeyframes: [...defined].slice(0, 100) };
}

/**
 * Page function: motion that no animation object explains. Compares the computed transform / opacity of every element
 * `probeMs` apart, then records the changing ones frame by frame for `recordMs`.
 * @returns {Promise<{ candidates: object[], scanned: number, changed: number }>}
 */
export async function findScriptLoops(opts) {
  const { maxCandidates = 40, probeMs = 450, recordMs = 2200 } = opts || {};
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
  const read = (el) => {
    const cs = getComputedStyle(el);
    return [cs.transform, cs.opacity, cs.rotate, cs.translate, cs.scale];
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
  const loose = changed.filter((el) => !(el.getAnimations?.().length));
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
  return {
    scanned: els.length,
    changed: changed.length,
    candidates: chosen.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        path: pathOf(el), tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        rect: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], series: series[i],
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
  const read = (el) => {
    const cs = getComputedStyle(el);
    return [cs.transform, cs.opacity, cs.rotate, cs.translate, cs.scale];
  };
  // The position along both axes, enough to see a turn (the full reading is kept for the analysis).
  const pos = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + scrollX, r.top + scrollY];
  };
  const els = paths.map(byPath);
  const series = els.map(() => []);
  const turns = els.map(() => ({ last: null, dir: [0, 0], count: 0 }));
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const t = Math.round(performance.now() - t0);
    els.forEach((el, i) => {
      if (!el || series[i].length >= 200) return;
      series[i].push([t, ...read(el)]);
      const p = pos(el);
      const s = turns[i];
      if (s.last) {
        for (const a of [0, 1]) {
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
const SLOW_WATCH_MS = 9000; // watched again for up to this long (stops once each one turned twice)

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
  return series.map(([t, transform, opacity, rotate, translate, scale]) => {
    const d = decomposeTransform(transform) ?? { translate: [0, 0], scale: [1, 1], rotate: 0 };
    const tr = parsePair(translate);
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
    return { t, x: d.translate[0] + tr[0], y: d.translate[1] + tr[1], rot, scale: d.scale[0] * sc, opacity: num(opacity) };
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * Names what a recorded series does: spin (deg/s), linear movement with wrap-around (px/s, period), oscillation
 * (period, amplitude), or nothing steady.
 * @returns {null | { pattern: string, channel: string, rate?: number, unit?: string, periodMs?: number, amplitude?: number, range: number, wrap?: object }}
 */
export function analyzeSeries(series) {
  if (series.length < 8) return null;
  const ch = channels(series);
  const defs = [['x', 'px', 3], ['y', 'px', 3], ['rot', 'deg', 5], ['scale', '', 0.03], ['opacity', '', 0.05]];
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
    if (key === 'rot') return { pattern: 'spin', ...out };
    if (key === 'x' || key === 'y') {
      const w = wraps.length ? { distance: round(Math.abs(wraps.map((i) => diffs[i]).reduce((a, b) => a + b, 0) / wraps.length)) } : undefined;
      let periodMs;
      if (wraps.length >= 2) periodMs = Math.round((ch[wraps[wraps.length - 1] + 1].t - ch[wraps[0] + 1].t) / (wraps.length - 1));
      return { pattern: 'drift', ...out, ...(w && { wrap: w }), ...(periodMs && { periodMs }) };
    }
    return { pattern: 'ramp', ...out };
  }
  // Oscillation: the direction of movement reverses at least twice.
  const smooth = diffs.map((d, i) => d + (diffs[i + 1] ?? 0)); // two frames, steadier than one
  const turns = [];
  for (let i = 1; i < smooth.length; i++) if (Math.sign(smooth[i]) !== 0 && Math.sign(smooth[i - 1]) !== 0 && Math.sign(smooth[i]) !== Math.sign(smooth[i - 1])) turns.push(ch[i].t);
  if (turns.length >= 2) {
    const half = median(turns.slice(1).map((t, i) => t - turns[i]));
    return { pattern: 'oscillate', channel: key, unit, range: round(range), amplitude: round(range / 2), periodMs: Math.round(half * 2) };
  }
  return { pattern: 'move', channel: key, unit, range: round(range) };
}

/**
 * Turns the raw page results into the `loops` description of motion.json.
 * @param {{ scan: object, script?: object }} raw
 */
export function processLoops({ scan, script }) {
  const stats = { css: 0, waapi: 0, script: 0, scrollLinked: 0, paused: 0, inStylesheet: 0, total: scan.total, truncated: scan.total > scan.items.length, scriptScanned: script?.scanned ?? 0, scriptChanged: script?.changed ?? 0, patterns: {} };
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
    loops.push({ path: c.path, tag: c.tag, ...(c.text && { text: c.text }), rect: c.rect, source: 'script', pattern: a.pattern, params: a, timing: { driver: 'script', ...(a.periodMs && { periodMs: a.periodMs }) } });
    stats.script++;
    stats.patterns[a.pattern] = (stats.patterns[a.pattern] ?? 0) + 1;
  }
  return { version: 1, loops, stats };
}

/**
 * Reads the continuous motion of a page (desktop view). Never throws for a page function failing: the part that failed is left out.
 * @param {import('playwright').Page} page
 */
export async function captureLoops(page, { script = true, recordMs = 2200 } = {}) {
  const scan = await page.evaluate(scanAnimations, {}).catch(() => ({ items: [], total: 0, definedKeyframes: [] }));
  const found = script ? await page.evaluate(findScriptLoops, { recordMs }).catch(() => null) : null;
  // A small, slow one-way move that never turned in the short recording is often a shape floating up and down over
  // several seconds: watched again longer (only these), it shows its turns and becomes an oscillation.
  const slow = (found?.candidates ?? []).filter((c) => {
    const a = analyzeSeries(c.series);
    // One way (drift), or one turn only (move): not enough of it was seen.
    return (a?.pattern === 'drift' || a?.pattern === 'move') && !a.wrap && (a.channel === 'x' || a.channel === 'y') && a.range < SLOW_MOVER_PX;
  }).slice(0, 12);
  if (slow.length) {
    const longer = await page.evaluate(recordPaths, { paths: slow.map((c) => c.path), ms: SLOW_WATCH_MS }).catch(() => null);
    slow.forEach((c, i) => {
      if (longer?.[i]?.length >= 8) c.series = longer[i];
    });
  }
  return processLoops({ scan, script: found ?? undefined });
}
