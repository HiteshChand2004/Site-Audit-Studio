// Scroll-reveal capture (Phase 4b.2).
//
// Many sites (Framer appear effects, Webflow interactions, AOS, GSAP ScrollTrigger, plain IntersectionObserver +
// CSS) start sections at opacity 0 and show them while they are in view; some hide them again when they leave.
// The scroll-through of the capture (index.js `settle`) already pins such elements in their revealed end state.
// This module also records HOW they appear, for the recreate's motion (generated CSS + a small script, later steps):
//   from / to  the hidden state (opacity, transform, filter) and the settled state;
//   timing     duration, delay and easing - exact when the page uses CSS transitions, CSS animations or the Web
//              Animations API (read from `getAnimations()` before the animation is finished); for effects driven
//              by script (rAF loops of GSAP / framer-motion, ...) measured by sampling every frame, with the
//              easing fitted to a cubic-bezier;
//   trigger    where the element was on screen before and after the scroll step that revealed it;
//   replay     hidden again when it leaves the view (the reveal repeats);
//   groups     elements of one parent revealed by the same step, with their stagger (offset between neighbours).
// Elements are identified by the `path` of the DOM snapshot (body>div:1>a:2), like the hover capture.
//
// Page functions are self-contained (Playwright sends only their source); the processing below runs in Node.

/**
 * Page function: installs the reveal tracker as window.__sasReveal { dwell(step), finalize() }.
 * With `observe` the reveal effects are also recorded (timing, series, trigger); without it only the end state
 * is tracked and pinned (the other views).
 * @param {{ observe?: boolean }} [opts]
 */
export function installRevealTracker(opts) {
  const { observe = false } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HIDDEN = 0.05;
  const MAX_TRACKED = 400;
  const MAX_SAMPLES = 90;
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const seenHidden = new Set();
  const hiddenState = new Map(); // element → { opacity, transform, filter } when first seen hidden
  const revealed = new Map(); // element → { opacity, transform, filter } once it settles visible
  const last = new Map(); // element → "opacity|transform|filter" at the previous sample
  const records = new Map(); // observe: element → what is known about its reveal
  const animSeen = new WeakSet();
  let step = -1;
  let lastY = window.scrollY;

  // The snapshot's path (capture/snapshot.js): body>div:1>a:2, the index counts same-tag element siblings.
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

  const state = (cs) => `${cs.opacity}|${cs.transform}|${cs.filter}`;
  // CSS transitions and Web Animations (which most builders use for appear effects) are finished at
  // once, so the element is read in its end state; polling alone can read a frame mid-animation.
  const finish = (el) => {
    for (const a of el.getAnimations?.() ?? []) {
      if (a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime)) continue;
      try {
        a.finish();
      } catch { /* not finishable */ }
    }
  };

  // ---- observe: what is known about each reveal ---------------------------------------------------------------
  const ensure = (el) => {
    let rec = records.get(el);
    if (!rec && records.size < MAX_TRACKED) {
      const r = el.getBoundingClientRect();
      rec = {
        el, step, y: Math.round(window.scrollY), prevY: Math.round(lastY), vh: window.innerHeight,
        rect: [Math.round(r.left + window.scrollX), Math.round(r.top + window.scrollY), Math.round(r.width), Math.round(r.height)],
        anims: [],
      };
      records.set(el, rec);
    }
    return rec;
  };
  // A keyframe's transform / filter as the computed value (matrix), like the other states.
  let probe = null;
  const resolve = (prop, value) => {
    if (value == null || value === 'none') return value;
    try {
      if (!probe) {
        probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:10px;height:10px';
        document.body.appendChild(probe);
      }
      probe.style[prop] = '';
      probe.style[prop] = value;
      return getComputedStyle(probe)[prop] || value;
    } catch {
      return value;
    }
  };
  // The declared animations on an element (read before they are finished): CSS transitions, CSS animations, WAAPI.
  const watch = (el) => {
    for (const a of el.getAnimations?.() ?? []) {
      if (animSeen.has(a) || !a.effect?.getKeyframes) continue;
      let t;
      try {
        t = a.effect.getComputedTiming();
      } catch {
        continue;
      }
      if (t.iterations !== 1 || !Number.isFinite(t.endTime)) continue; // looping effects are continuous motion
      const kfs = a.effect.getKeyframes();
      const props = new Set();
      for (const k of kfs) for (const p of ['opacity', 'transform', 'filter', 'translate', 'scale', 'rotate']) if (k[p] != null) props.add(p);
      if (!props.size) continue;
      animSeen.add(a);
      const rec = ensure(el);
      if (!rec) return;
      const kind = a.constructor.name === 'CSSTransition' ? 'transition' : a.constructor.name === 'CSSAnimation' ? 'animation' : 'waapi';
      const startTime = a.startTime ?? document.timeline.currentTime;
      rec.anims.push({
        kind, props: [...props], duration: Number(t.duration) || 0, delay: t.delay, endDelay: t.endDelay, easing: t.easing, direction: t.direction,
        start: startTime + t.delay,
        keyframes: kfs.slice(0, 8).map((k) => ({ offset: k.computedOffset, opacity: k.opacity, transform: resolve('transform', k.transform), filter: resolve('filter', k.filter), easing: k.easing })),
      });
    }
  };

  // Frame-by-frame samples of every element that starts hidden: effects driven by script have no animation to read.
  const series = new Map(); // element → { o, tf, t, cur, eps }
  let running = false;
  const frame = (now) => {
    if (!running) return;
    for (const el of seenHidden) {
      if (!el.isConnected) continue;
      const cs = getComputedStyle(el);
      const o = parseFloat(cs.opacity);
      const tf = cs.transform;
      let s = series.get(el);
      if (!s) {
        series.set(el, { o, tf, t: now, cur: null, eps: [] });
        continue;
      }
      if (o !== s.o || tf !== s.tf) {
        if (!s.cur) s.cur = { t0: s.t, lastChange: now, samples: [[0, s.o, s.tf]] };
        if (s.cur.samples.length < MAX_SAMPLES) s.cur.samples.push([Math.round((now - s.cur.t0) * 10) / 10, o, tf]);
        s.cur.lastChange = now;
      } else if (s.cur && now - s.cur.lastChange > 120) {
        if (s.eps.length < 3) s.eps.push(s.cur);
        s.cur = null;
      }
      s.o = o;
      s.tf = tf;
      s.t = now;
    }
    requestAnimationFrame(frame);
  };
  if (observe) {
    running = true;
    requestAnimationFrame(frame);
  }

  // Samples tracked elements (all elements when `full`); returns true when none of them changed.
  const sample = (full) => {
    let stable = true;
    const els = full ? document.body?.getElementsByTagName('*') ?? [] : [...seenHidden];
    for (const el of els) {
      if (seenHidden.has(el)) {
        if (observe) watch(el);
        finish(el);
      }
      const cs = getComputedStyle(el);
      const opacity = parseFloat(cs.opacity);
      if (opacity < HIDDEN) {
        seenHidden.add(el);
        if (!hiddenState.has(el)) hiddenState.set(el, { opacity, transform: cs.transform, filter: cs.filter });
        continue;
      }
      if (!seenHidden.has(el)) continue;
      if (observe) ensure(el);
      const s = state(cs);
      const settled = last.get(el) === s; // same state as the previous sample: not mid-animation
      if (!settled) stable = false;
      last.set(el, s);
      const prev = revealed.get(el);
      if (settled && (!prev || opacity >= prev.opacity - 0.01)) revealed.set(el, { opacity, transform: cs.transform, filter: cs.filter });
    }
    return stable;
  };

  // After each scroll step: let observers fire, then wait only while revealed elements are still
  // animating (at most 1.5 s); pages without reveal effects move on at once.
  const dwell = async (index) => {
    step = index ?? step + 1;
    await sleep(150);
    let changing = !sample(true);
    const until = Date.now() + 1500;
    while (changing && Date.now() < until) {
      await sleep(120);
      changing = !sample(false);
    }
    lastY = window.scrollY;
  };
  sample(true);
  window.__sasReveal = { dwell, finalize: () => finalize() };

  // Back at the top: pin the revealed state on elements that are hidden again below the first screen.
  const finalize = async () => {
    running = false;
    for (const s of series.values()) {
      if (s.cur) s.eps.push(s.cur);
      s.cur = null;
    }
    await sleep(300);
    const candidates = [];
    for (const [el, final] of revealed) {
      if (!el.isConnected || final.opacity < HIDDEN) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // Entirely in the first screen: what the visitor sees now (a hidden element there is more likely
      // a carousel or timed effect). One that crosses the fold is re-hidden by a scroll trigger.
      if (r.top >= 0 && r.bottom <= window.innerHeight) continue;
      if (parseFloat(cs.opacity) < final.opacity - 0.05 || cs.transform !== final.transform || cs.filter !== final.filter) {
        candidates.push({ el, final, rect: [r.left, r.top, r.width, r.height] });
      }
    }
    const overlap = (a, b) => {
      const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
      const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
      return x * y > 0.5 * Math.min(a[2] * a[3], b[2] * b[3]);
    };
    const stacked = new Set();
    for (const a of candidates) {
      for (const b of candidates) {
        if (a !== b && a.el.parentElement === b.el.parentElement && a.rect[2] * a.rect[3] > 0 && overlap(a.rect, b.rect)) stacked.add(a.el);
      }
    }
    const pinned = candidates.filter((c) => !stacked.has(c.el));
    const pin = ({ el, final }) => {
      el.style.setProperty('opacity', String(final.opacity), 'important');
      el.style.setProperty('transform', final.transform, 'important');
      el.style.setProperty('filter', final.filter, 'important');
      finish(el); // the change starts the site's own transition; jump to its end
    };
    pinned.forEach(pin);
    const byEl = new Map(pinned.map((c) => [c.el, c]));
    // Some runtimes write the style again (for example when the element leaves the view).
    const observer = new MutationObserver((records2) => {
      for (const rec of records2) {
        const c = byEl.get(rec.target);
        if (c && rec.target.style.getPropertyPriority('opacity') !== 'important') pin(c);
      }
    });
    for (const c of pinned) observer.observe(c.el, { attributes: true, attributeFilter: ['style'] });

    const pending = [...document.images].filter((img) => !img.complete);
    await Promise.all(pending.map((img) => new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
      setTimeout(r, 3000);
    })));
    await document.fonts?.ready;
    const out = { revealed: revealed.size, pinned: pinned.length, stacked: stacked.size };
    if (observe) {
      const replay = new Set(pinned.map((c) => c.el));
      out.events = [...records.values()].map((rec) => {
        const el = rec.el;
        const s = series.get(el);
        return {
          path: pathOf(el), tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
          from: hiddenState.get(el) ?? null, to: revealed.get(el) ?? null,
          step: rec.step, y: rec.y, prevY: rec.prevY, vh: rec.vh, rect: rec.rect, anims: rec.anims,
          series: s?.eps.length ? s.eps[0] : null, replay: replay.has(el),
        };
      }).filter((e) => e.path);
    }
    return out;
  };
}

// ---- Node side: from the raw events to the reveal description ------------------------------------------------

/** Named easings (CSS keywords and common ones of animation libraries) as cubic-bezier control points. */
export const EASINGS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'cubic-bezier(0.33, 1, 0.68, 1)': [0.33, 1, 0.68, 1], // easeOutCubic
  'cubic-bezier(0.25, 1, 0.5, 1)': [0.25, 1, 0.5, 1], // easeOutQuart
  'cubic-bezier(0.16, 1, 0.3, 1)': [0.16, 1, 0.3, 1], // easeOutExpo
  'cubic-bezier(0.5, 1, 0.89, 1)': [0.5, 1, 0.89, 1], // easeOutQuad
  'cubic-bezier(0.61, 1, 0.88, 1)': [0.61, 1, 0.88, 1], // easeOutSine
  'cubic-bezier(0.65, 0, 0.35, 1)': [0.65, 0, 0.35, 1], // easeInOutCubic
  'cubic-bezier(0.45, 0, 0.55, 1)': [0.45, 0, 0.55, 1], // easeInOutQuad
  'cubic-bezier(0.37, 0, 0.63, 1)': [0.37, 0, 0.63, 1], // easeInOutSine
  'cubic-bezier(0.32, 0, 0.67, 0)': [0.32, 0, 0.67, 0], // easeInCubic
  'cubic-bezier(0.34, 1.56, 0.64, 1)': [0.34, 1.56, 0.64, 1], // easeOutBack
};

/** Progress (0..1, may overshoot) of a cubic-bezier easing at time fraction x. */
export function bezierAt([x1, y1, x2, y2], x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let lo = 0;
  let hi = 1;
  let s = x;
  for (let i = 0; i < 30; i++) {
    s = (lo + hi) / 2;
    const v = ((ax * s + bx) * s + cx) * s;
    if (v < x) lo = s;
    else hi = s;
  }
  return ((ay * s + by) * s + cy) * s;
}

const rmse = (points, bez) => Math.sqrt(points.reduce((sum, [t, p]) => sum + (bezierAt(bez, t) - p) ** 2, 0) / points.length);
const r2 = (n) => Math.round(n * 100) / 100;
const cssBezier = (b) => `cubic-bezier(${b.map(r2).join(', ')})`;

/**
 * Fits an easing to measured progress points [[timeFraction 0..1, progress]]: the closest named easing, refined by a
 * small local search when none is close.
 * @returns {{ css: string, error: number, bezier: number[] }}
 */
export function fitEasing(points) {
  if (points.length < 3) return { css: 'ease', error: 1, bezier: EASINGS.ease };
  let best = null;
  for (const [name, bez] of Object.entries(EASINGS)) {
    const e = rmse(points, bez);
    if (!best || e < best.error) best = { css: name, error: e, bezier: bez };
  }
  if (best.error > 0.02) {
    let cur = [...best.bezier];
    let err = best.error;
    for (let stepSize = 0.2; stepSize > 0.01; stepSize /= 2) {
      for (let round = 0; round < 3; round++) {
        for (let k = 0; k < 4; k++) {
          for (const d of [stepSize, -stepSize]) {
            const next = [...cur];
            next[k] = k % 2 === 0 ? Math.min(1, Math.max(0, next[k] + d)) : Math.min(2, Math.max(-1, next[k] + d));
            const e = rmse(points, next);
            if (e < err) {
              err = e;
              cur = next;
            }
          }
        }
      }
    }
    if (err < best.error - 0.005) best = { css: cssBezier(cur), error: err, bezier: cur.map(r2) };
  }
  return { css: best.css, error: r2(best.error), bezier: best.bezier };
}

/** A computed `transform` as translate / scale / rotate (2D; matrix3d keeps x, y and z). */
export function decomposeTransform(transform) {
  if (!transform || transform === 'none') return { translate: [0, 0], scale: [1, 1], rotate: 0 };
  const m = /^matrix(3d)?\(([^)]+)\)$/.exec(transform.trim());
  if (!m) return null;
  const v = m[2].split(',').map((n) => parseFloat(n));
  if (v.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c, d, e, f] = m[1] ? [v[0], v[1], v[4], v[5], v[12], v[13]] : v;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const sy = det < 0 ? -Math.hypot(c, d) : Math.hypot(c, d);
  return { translate: [r2(e), r2(f)], scale: [r2(sx), r2(sy)], rotate: r2((Math.atan2(b, a) * 180) / Math.PI) };
}

const state = (s) => s && { opacity: r2(s.opacity), transform: s.transform, filter: s.filter };

/** The reveal measured by sampling frames: duration, easing fit, start time. Null when the samples show no reveal. */
export function fitSeries(episode) {
  const samples = episode?.samples ?? [];
  if (samples.length < 2) return null;
  const o0 = samples[0][1];
  const oN = samples[samples.length - 1][1];
  let channel;
  if (Math.abs(oN - o0) >= 0.2) channel = (s) => s[1];
  else {
    // Transform-only: the translate / scale component that moves most.
    const d0 = decomposeTransform(samples[0][2]);
    const dN = decomposeTransform(samples[samples.length - 1][2]);
    if (!d0 || !dN) return null;
    const comps = [(d) => d.translate[0], (d) => d.translate[1], (d) => d.scale[0], (d) => d.rotate];
    const move = comps.map((f) => Math.abs(f(dN) - f(d0)));
    const k = move.indexOf(Math.max(...move));
    if (move[k] < 0.01) return null;
    channel = (s) => comps[k](decomposeTransform(s[2]) ?? d0);
  }
  const c0 = channel(samples[0]);
  const cN = channel(samples[samples.length - 1]);
  if (Math.abs(cN - c0) < 1e-6) return null;
  const progress = samples.map(([t], i) => [t, (channel(samples[i]) - c0) / (cN - c0)]);
  const done = progress.find(([, p]) => p >= 0.99);
  const duration = done ? done[0] : progress[progress.length - 1][0];
  if (duration < 16) return null;
  const points = progress.filter(([t]) => t <= duration).map(([t, p]) => [t / duration, Math.min(1.5, Math.max(-0.5, p))]);
  const fit = fitEasing(points);
  return { duration: Math.round(duration / 10) * 10, easing: { css: fit.css, bezier: fit.bezier, error: fit.error, fit: 'sampled' }, start: episode.t0 };
}

// The keyframe-level easing is where animation-timing-function lands for a CSS animation with two keyframes.
const effectiveEasing = (a) => {
  if (a.easing && a.easing !== 'linear') return a.easing;
  return a.keyframes?.[0]?.easing && a.keyframes[0].easing !== 'linear' ? a.keyframes[0].easing : (a.easing ?? 'linear');
};

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** DOM order of two snapshot paths (body>div:1>a:2). */
export function comparePaths(a, b) {
  const pa = a.split('>');
  const pb = b.split('>');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const [ta, ia] = pa[i].split(':');
    const [tb, ib] = pb[i].split(':');
    return ta === tb ? Number(ia) - Number(ib) : pa[i] < pb[i] ? -1 : 1; // different tags: stable, not DOM order
  }
  return pa.length - pb.length;
}

// Where the element was before / after the scroll step that revealed it (fractions of the viewport height, 1 = bottom
// edge). A scroll reveal starts when the element comes into view: it was below the screen before the step and is on the
// screen (or just below it, for a preloading margin) after it. Anything else is 'timed': an element already on screen
// before the step (rotating headline, timer), or one revealed while it was still far below the screen (a failsafe timer,
// "reveal everything on the first scroll"): it was not triggered by coming into view, and whether the capture sees it
// before or after the timer fires depends on timing, so it is never rebuilt as a scroll reveal.
export const SCROLL_REVEAL_MAX_TOP_AFTER = 1.35;
function triggerOf(ev) {
  const topBefore = r2((ev.rect[1] - ev.prevY) / ev.vh);
  const topAfter = r2((ev.rect[1] - ev.y) / ev.vh);
  const entering = topBefore > 1 && topAfter <= SCROLL_REVEAL_MAX_TOP_AFTER;
  return { kind: entering ? 'scroll' : 'timed', step: ev.step, topBefore, topAfter };
}

/**
 * Turns the tracker's raw events into the reveal description stored in motion.json.
 * @param {object[]} events  `events` of installRevealTracker's finalize()
 */
export function processReveal(events) {
  const stats = { tracked: events.length, revealed: 0, declared: 0, sampled: 0, unmeasured: 0, unsettled: 0, replay: 0, timed: 0, groups: 0, staggered: 0 };
  const elements = [];
  for (const ev of events) {
    if (!ev.from || !ev.to || ev.from.opacity >= 0.05 || ev.to.opacity < 0.5) {
      stats.unsettled++;
      continue;
    }
    let timing = null;
    let start = null;
    let keyframes;
    if (ev.anims.length) {
      // The animation that fades the element in is the main one; others (transform with its own timing) are parts.
      const parts = ev.anims.map((a) => ({
        kind: a.kind, props: a.props, duration: Math.round(a.duration), delay: Math.round(a.delay), easing: effectiveEasing(a), start: a.start,
        ...(a.endDelay ? { endDelay: Math.round(a.endDelay) } : {}),
      }));
      const main = parts.find((p) => p.props.includes('opacity')) ?? [...parts].sort((a, b) => b.duration - a.duration)[0];
      timing = { source: main.kind, duration: main.duration, delay: main.delay, easing: { css: main.easing, fit: 'declared' } };
      if (parts.length > 1) timing.parts = parts.map(({ start: _s, ...rest }) => rest);
      start = Math.min(...parts.map((p) => p.start));
      const multi = ev.anims.find((a) => a.props.includes('opacity') && a.keyframes.length > 2)?.keyframes;
      if (multi) keyframes = multi;
      stats.declared++;
    } else if (ev.series) {
      const fit = fitSeries(ev.series);
      if (fit) {
        timing = { source: 'sampled', duration: fit.duration, delay: null, easing: fit.easing };
        start = fit.start;
        stats.sampled++;
      }
    }
    if (!timing) {
      timing = { source: 'unmeasured', duration: null, delay: null, easing: null };
      stats.unmeasured++;
    }
    const from = state(ev.from);
    const to = state(ev.to);
    // What the animation declares (its first and last keyframe) is more exact than the state read around it.
    const kfs = ev.anims.find((x) => x.props.includes('opacity') && x.keyframes.length >= 2)?.keyframes;
    if (kfs) {
      const [k0, kN] = [kfs[0], kfs[kfs.length - 1]];
      if (k0.offset === 0) {
        if (k0.opacity != null) from.opacity = r2(Number(k0.opacity));
        if (k0.transform != null) from.transform = k0.transform;
        if (k0.filter != null) from.filter = k0.filter;
      }
      if (kN.offset === 1) {
        if (kN.opacity != null) to.opacity = r2(Number(kN.opacity));
        if (kN.transform != null) to.transform = kN.transform;
        if (kN.filter != null) to.filter = kN.filter;
      }
    }
    const df = decomposeTransform(from.transform);
    const dt = decomposeTransform(to.transform);
    stats.revealed++;
    if (ev.replay) stats.replay++;
    if (triggerOf(ev).kind === 'timed') stats.timed++;
    elements.push({
      path: ev.path, tag: ev.tag, ...(ev.text && { text: ev.text }), rect: ev.rect,
      from: { ...from, ...(df && { motion: df }) }, to: { ...to, ...(dt && { motion: dt }) },
      timing, ...(keyframes && { keyframes }),
      trigger: triggerOf(ev),
      replay: ev.replay,
      start,
    });
  }

  // Groups: the elements of one parent revealed by the same scroll step; singletons are regrouped by their
  // grandparent when they look alike (cards of a grid, each in its own column).
  const parentOf = (p, up = 1) => p.split('>').slice(0, -up).join('>');
  const sig = (e) => `${e.tag}|${JSON.stringify(e.from)}|${e.timing.duration}|${e.timing.easing?.css}`;
  const buckets = new Map();
  for (const e of elements) {
    const key = `${parentOf(e.path)}|${e.trigger.step}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const singles = [...buckets.values()].filter((b) => b.length === 1).map((b) => b[0]);
  const grouped = [...buckets.values()].filter((b) => b.length > 1);
  const regroup = new Map();
  for (const e of singles) {
    const key = `${parentOf(e.path, 2)}|${e.trigger.step}|${sig(e)}`;
    if (!regroup.has(key)) regroup.set(key, []);
    regroup.get(key).push(e);
  }
  const groups = [];
  for (const members of [...grouped, ...regroup.values()]) {
    members.sort((a, b) => comparePaths(a.path, b.path));
    const id = `r${groups.length + 1}`;
    const group = { id, count: members.length, step: members[0].trigger.step, parent: parentOf(members[0].path), stagger: null };
    const starts = members.map((m) => m.start);
    if (members.length > 1 && starts.every((s) => s != null)) {
      const first = Math.min(...starts);
      members.forEach((m) => { m.offsetMs = Math.round(m.start - first); });
      // Stagger: consecutive neighbours start a constant step apart (same direction through the list).
      const diffs = starts.slice(1).map((s, i) => s - starts[i]);
      const step = median(diffs);
      const jitter = Math.max(...diffs.map((d) => Math.abs(d - step)));
      if (members.length >= 3 && Math.abs(step) >= 15 && jitter <= Math.max(30, Math.abs(step) * 0.35)) {
        group.stagger = { stepMs: Math.round(step), jitterMs: Math.round(jitter), order: step >= 0 ? 'forward' : 'reverse' };
        stats.staggered++;
      }
    }
    members.forEach((m) => { m.group = id; });
    groups.push(group);
  }
  for (const e of elements) delete e.start;
  stats.groups = groups.length;
  elements.sort((a, b) => comparePaths(a.path, b.path));
  return { version: 1, elements, groups, stats };
}
