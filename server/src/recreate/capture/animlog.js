// @ts-check
// The animation log (CLONER_SPEC Phase 1 item 2): what an animation library the page exposes was asked to do, recorded as
// it is asked, so the copy can replay the same calls with the same library (Tier 1) instead of guessing them from motion.
//
// An init script, installed before any of the page's own code, watches the globals a library announces itself with
// (`window.gsap`, `window.ScrollTrigger`, the GSAP 2 names) through property setters. When one appears its entry points are
// wrapped - gsap.to / from / fromTo / set / timeline (and every call chained on a timeline: to / from / fromTo / set / add /
// call / addLabel), ScrollTrigger.create - and each call is logged with:
//   - its targets as the capture's own paths (`body>div:1>h1:1`, the snapshot's rule, so the IR maps them like everything
//     else) plus a stable selector (an id, else the shortest unique class path), and how many elements they were;
//   - its vars made serializable: numbers / strings / booleans kept, elements turned into targets, functions named but not
//     kept (`{ fn: true }`, reported: a function-based value cannot be replayed from data);
//   - the START value of every property it animates, read with the library's own `getProperty` before the call runs: the
//     capture sees a page whose tweens have finished, so a `to()` replayed from that state would not move. The copy plays
//     `fromTo(start, vars)`.
// A library bundled without a global is invisible here (the targeted lift handles it, Phase 2 item 2). Nothing in this file
// names a site, a class or a selector of any site.

/** Calls kept per page; past it the log says how many it dropped. */
export const MAX_LOG = 3000;
export const ANIMLOG_VERSION = 1;
/** desktop → animLog.json, another view → <view>-animLog.json (like capture/index.js motionFile). */
export const animLogFile = (viewId) => (viewId === 'desktop' ? 'animLog.json' : `${viewId}-animLog.json`);

/** Page function, installed with context.addInitScript before the page's own scripts. Self-contained. */
export function installAnimLog() {
  if (/** @type {any} */ (window).__sasAnimLog) return;
  const w = /** @type {any} */ (window);
  const log = [];
  const state = { dropped: 0, seen: {}, timelines: 0, unresolved: 0, depth: 0 };
  w.__sasAnimLog = { log, state };
  const MAX = 3000;
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  // Keys of a vars object that configure the tween rather than animate a property.
  const CONTROL = new Set(['duration', 'delay', 'ease', 'repeat', 'repeatDelay', 'yoyo', 'yoyoEase', 'stagger', 'paused', 'overwrite',
    'immediateRender', 'lazy', 'id', 'data', 'scrollTrigger', 'onStart', 'onUpdate', 'onComplete', 'onRepeat', 'onReverseComplete',
    'onInterrupt', 'callbackScope', 'runBackwards', 'startAt', 'inherit', 'reversed', 'keyframes', 'defaults', 'smoothChildTiming',
    'autoRemoveChildren', 'onStartParams', 'onUpdateParams', 'onCompleteParams', 'onRepeatParams', 'onReverseCompleteParams']);

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
  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  // An id, else the shortest chain of class selectors (up to 3 ancestors) that names this element alone.
  const selectorOf = (el) => {
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const own = (n) => [n.tagName.toLowerCase(), ...[...n.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`)].join('');
    let sel = own(el);
    if (unique(sel)) return sel;
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 3; n = n.parentElement, i++) {
      if (!n.classList.length && !n.id) continue;
      sel = `${n.id ? `#${CSS.escape(n.id)}` : own(n)} ${sel}`;
      if (unique(sel)) return sel;
    }
    return null;
  };
  const isEl = (v) => v && typeof v === 'object' && v.nodeType === 1;
  const elementsOf = (targets) => {
    if (targets == null) return [];
    if (typeof targets === 'string') {
      try {
        return [...document.querySelectorAll(targets)];
      } catch {
        return [];
      }
    }
    if (isEl(targets)) return [targets];
    if (typeof targets === 'object' && typeof targets.length === 'number') return [...targets].flatMap(elementsOf);
    return [];
  };
  const targetsOf = (targets) => {
    const els = elementsOf(targets).filter((el) => el.isConnected);
    return {
      ...(typeof targets === 'string' && { selector: targets.slice(0, 200) }),
      count: els.length,
      // Not elements (a plain object a tween counts on, a window scroll): kept as a kind, replayed only if it is the window.
      ...(!els.length && targets && typeof targets === 'object' && !isEl(targets) && { other: targets === window ? 'window' : 'object' }),
      list: els.slice(0, 200).map((el) => ({ path: pathOf(el), sel: selectorOf(el) })),
    };
  };
  // Serializable copy of a value; functions and the unknown are named, not kept.
  const plain = (v, depth = 0) => {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.slice(0, 500);
    if (typeof v === 'function') {
      state.unresolved++;
      return { fn: true };
    }
    if (isEl(v) || (typeof v === 'object' && typeof v.length === 'number' && v.length && isEl(v[0]))) return { targets: targetsOf(v) };
    if (v === window) return { targets: { other: 'window', count: 0, list: [] } };
    if (depth > 3 || typeof v !== 'object') return { unknown: true };
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => plain(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v).slice(0, 60)) out[k] = plain(v[k], depth + 1);
    return out;
  };
  // The value of every animated property on every target before the call runs (the library's own reading).
  const startOf = (g, targets, vars) => {
    if (!vars || typeof vars !== 'object' || typeof g.getProperty !== 'function') return null;
    const props = Object.keys(vars).filter((k) => !CONTROL.has(k) && typeof vars[k] !== 'function');
    if (!props.length) return null;
    return elementsOf(targets).slice(0, 200).map((el) => {
      const o = {};
      for (const p of props) {
        try {
          o[p] = g.getProperty(el, p);
        } catch {
          // a property the library cannot read on this element
        }
      }
      return o;
    });
  };
  const push = (entry) => {
    if (log.length >= MAX) {
      state.dropped++;
      return;
    }
    // A call made from inside another recorded call is the library using its own API (a tween creating its
    // ScrollTrigger): kept for the record, never replayed on its own.
    log.push({ ...entry, ...(state.depth > 1 && { nested: true }), t: Math.round(performance.now()), scrollY: Math.round(window.scrollY) });
  };
  const record = (lib, method, args, extra) => {
    try {
      const [targets, a, b, c] = args;
      const entry = { lib, method, ...extra };
      if (method === 'fromTo') Object.assign(entry, { targets: targetsOf(targets), fromVars: plain(a), vars: plain(b), position: plain(c) });
      else if (method === 'timeline') Object.assign(entry, { vars: plain(targets) });
      else if (method === 'create') Object.assign(entry, { vars: plain(targets) });
      else if (method === 'add' || method === 'call' || method === 'addLabel') Object.assign(entry, { child: targets?.__sasTl ?? null, label: typeof targets === 'string' ? targets : null, position: plain(a) });
      else Object.assign(entry, { targets: targetsOf(targets), vars: plain(a), position: plain(b) });
      push(entry);
    } catch {
      state.dropped++;
    }
  };

  const wrapMethod = (obj, name, before) => {
    const orig = obj && obj[name];
    if (typeof orig !== 'function' || orig.__sasWrapped) return;
    const wrapped = function (...args) {
      state.depth++;
      try {
        const extra = before ? before(args) : {};
        const result = orig.apply(this, args);
        if (extra !== false) after(result, extra);
        return result;
      } finally {
        state.depth--;
      }
    };
    const after = (result, extra) => {
      if (extra?.timelineOf && result && typeof result === 'object') wrapTimeline(result, extra.timelineOf);
    };
    Object.defineProperty(wrapped, '__sasWrapped', { value: true });
    try {
      obj[name] = wrapped;
    } catch {
      // a frozen object: not hooked
    }
  };
  const tweenEntry = (g, lib, method, tl) => (args) => {
    const [targets, a, b] = args;
    const vars = method === 'fromTo' ? b : a;
    const start = method === 'set' ? null : startOf(g, targets, method === 'fromTo' ? b : vars);
    record(lib, method, args, { ...(tl && { timeline: tl }), ...(start && { start }) });
    return {};
  };
  const wrapTimeline = (tl, id) => {
    if (!tl || tl.__sasTl) return;
    try {
      Object.defineProperty(tl, '__sasTl', { value: id });
    } catch {
      return;
    }
    const g = w.gsap;
    for (const m of ['to', 'from', 'fromTo', 'set']) wrapMethod(tl, m, g ? tweenEntry(g, 'gsap', m, id) : null);
    for (const m of ['add', 'call', 'addLabel']) wrapMethod(tl, m, (args) => (record('gsap', m, args, { timeline: id }), {}));
  };
  const wrapScrollTrigger = (st) => {
    if (!st || typeof st.create !== 'function') return;
    state.seen.ScrollTrigger = true;
    wrapMethod(st, 'create', (args) => (record('ScrollTrigger', 'create', args, {}), {}));
  };
  const wrapGsap = (g) => {
    if (!g || typeof g !== 'object' && typeof g !== 'function') return;
    if (g.__sasHooked) return;
    try {
      Object.defineProperty(g, '__sasHooked', { value: true });
    } catch {
      return;
    }
    state.seen.gsap = String(g.version ?? true);
    for (const m of ['to', 'from', 'fromTo', 'set']) wrapMethod(g, m, tweenEntry(g, 'gsap', m, null));
    wrapMethod(g, 'timeline', (args) => {
      const id = ++state.timelines;
      record('gsap', 'timeline', args, { id });
      return { timelineOf: id };
    });
    // A plugin registered by object (ScrollTrigger from a module): hooked by what it can do, not by its name.
    wrapMethod(g, 'registerPlugin', (args) => {
      for (const p of args) if (p && typeof p.create === 'function' && typeof p.refresh === 'function' && typeof p.getAll === 'function') wrapScrollTrigger(p);
      return {};
    });
  };

  // The globals a library announces itself with: watched by a setter, so the hook is on before its first call.
  const watch = (name, hook) => {
    let value = w[name];
    if (value) hook(value);
    try {
      Object.defineProperty(w, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v) => {
          value = v;
          hook(v);
        },
      });
    } catch {
      // the page defined it non-configurable first
    }
  };
  watch('gsap', wrapGsap);
  watch('ScrollTrigger', wrapScrollTrigger);
  // GSAP 2 names: the same calls (TweenMax.to / from / fromTo / set), TimelineMax / TimelineLite are timelines.
  for (const name of ['TweenMax', 'TweenLite']) watch(name, (t) => {
    if (!t || t.__sasHooked) return;
    try {
      Object.defineProperty(t, '__sasHooked', { value: true });
    } catch {
      return;
    }
    state.seen[name] = true;
    for (const m of ['to', 'from', 'fromTo', 'set']) wrapMethod(t, m, (args) => (record('gsap', m, args, {}), {}));
  });
}

/** Page function: the log so far. */
export function readAnimLog() {
  const s = /** @type {any} */ (window).__sasAnimLog;
  if (!s) return null;
  return { version: 1, entries: s.log, dropped: s.state.dropped, seen: s.state.seen, timelines: s.state.timelines, unresolved: s.state.unresolved };
}

/**
 * Counts for the report: calls per library / method, targets found, ScrollTrigger use, what cannot be replayed from data.
 * @param {{ entries: object[], dropped: number, seen: object, unresolved: number } | null} data
 */
export function summarizeAnimLog(data) {
  if (!data) return null;
  const methods = {};
  let targets = 0;
  let scrollTriggers = 0;
  for (const e of data.entries) {
    if (e.nested) continue;
    methods[`${e.lib}.${e.method}`] = (methods[`${e.lib}.${e.method}`] ?? 0) + 1;
    targets += e.targets?.count ?? 0;
    if (e.method === 'create' || e.vars?.scrollTrigger) scrollTriggers++;
  }
  return { libs: data.seen, calls: data.entries.length, methods, targets, scrollTriggers, dropped: data.dropped, unresolved: data.unresolved };
}
