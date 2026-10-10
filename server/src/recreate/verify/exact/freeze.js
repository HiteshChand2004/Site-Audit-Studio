// Stopping the moving parts, the same way on both sides, so a carousel half-way through a slide is not reported as a
// difference in the copy.
//
// Blunt first: the original's marquee, driven by its own script, and the copy's rebuilt @keyframes cannot be put at
// the same phase - they are different mechanisms with different phase origins. The one phase both sides can agree on
// is **zero**, which is also the state the copy's keyframes were authored from and the state a first-time visitor
// sees. So "frozen" here means "at the start", reached by three mechanisms:
//
// 1. Before any of the page's script runs, no interval is ever registered and no timer of a second or more ever
//    fires (freezeTimers, below). That stops autoplaying carousels, word rotators and tickers - and our own
//    js/motion.js autoplay, which registers through window.setInterval - with no CSS and no change to the layout.
//    requestAnimationFrame is deliberately left alone: stubbing it would break smooth scrolling, appear effects and
//    the whole reveal machinery the loading recipe depends on.
// 2. At shot time, every animation the browser knows about is put at its start and paused if it repeats, or
//    finished if it runs once (the resting layout *is* the end state of a one-shot entrance, which is what the
//    capture's reveal tracker already relies on).
// 3. Nothing else. In particular NOT Playwright's `animations: 'disabled'`, which resets infinite animations at
//    screenshot time and used to stack every word of a cycling headline (audit/screenshots.js carries that scar),
//    and NOT an injected `animation-play-state: paused` rule, which changes the cascade and can move the layout
//    when an animation with `fill: both` sets a transform at 0%.
//
// What was stopped is reported, never implied: report.exact.frozen lists the timers that were suppressed and every
// animation that was zeroed, finished or left alone, on both sides, so a loop the original has and the copy does not
// shows up as a missing loop rather than as pixels that happen to differ.

/** Bumped when the freeze changes, for the same reason the recipe carries a version. */
export const FREEZE_VERSION = 1;
/** A timer at least this long is a page that means to change itself later, not one still setting itself up. */
export const SLOW_TIMER_MS = 1000;
const MAX_NOTES = 20;
const MAX_ANIMATIONS = 40;

/**
 * Page init script (context.addInitScript): runs before the page's own scripts, in every frame.
 * The shim is the one `capture/states.js firstVisit` has used in production; what it suppresses is counted here so
 * the report can name it.
 */
export function freezeTimers() {
  const later = window.setTimeout;
  const frozen = { intervals: 0, timeouts: 0, notes: [] };
  const note = (kind, fn, ms) => {
    frozen[kind === 'interval' ? 'intervals' : 'timeouts']++;
    if (frozen.notes.length >= 20) return;
    const name = typeof fn === 'function' && fn.name ? ` (${fn.name})` : '';
    frozen.notes.push(`${kind} ${Math.round(Number(ms) || 0)}ms${name}`);
  };
  window.__sasFrozen = frozen;
  window.setInterval = function (fn, ms) {
    note('interval', fn, ms);
    return 0;
  };
  window.setTimeout = function (fn, ms, ...args) {
    if (Number(ms) >= 1000) {
      note('timeout', fn, ms);
      return 0;
    }
    return later(fn, ms, ...args);
  };
}

/** Page function: every animation at its start, paused if it repeats, finished if it runs once. */
function stopAnimations(max) {
  const out = { zeroed: 0, finished: 0, scrollLinked: 0, failed: 0, total: 0, items: [] };
  let list;
  try {
    list = document.getAnimations();
  } catch {
    return out;
  }
  out.total = list.length;
  for (const animation of list) {
    const effect = animation.effect;
    const target = effect && effect.target;
    const timing = (effect && effect.getComputedTiming && effect.getComputedTiming()) || {};
    const timeline = (animation.timeline && animation.timeline.constructor && animation.timeline.constructor.name) || '';
    const scrollLinked = /ScrollTimeline|ViewTimeline/.test(timeline);
    const iterations = timing.iterations === Infinity ? 'infinite' : Number(timing.iterations) || 1;
    const repeats = iterations === 'infinite' || iterations > 1;
    const item = {
      name: animation.animationName || animation.transitionProperty || '',
      tag: target && target.tagName ? target.tagName.toLowerCase() : null,
      text: target && target.textContent ? target.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : '',
      iterations,
      action: 'left',
    };
    try {
      if (scrollLinked) {
        // Both sides sit at their own progress 0 while the page is at the top, and the IR does not rebuild these
        // anyway: left alone, and named as a residual.
        out.scrollLinked++;
      } else if (repeats) {
        // Pause first, then set the time. Setting currentTime on a *running* animation moves its start time and it
        // keeps going, so pausing afterwards captures however long the round trip took - one frame of drift, which
        // is a pixel or two of a marquee and exactly the kind of difference this freeze exists to remove. A paused
        // animation holds the time it is given.
        animation.pause();
        animation.currentTime = 0;
        item.action = 'zeroed';
        out.zeroed++;
      } else {
        animation.finish();
        item.action = 'finished';
        out.finished++;
      }
    } catch {
      item.action = 'failed';
      out.failed++;
    }
    if (out.items.length < max) out.items.push(item);
  }
  return out;
}

/**
 * Puts the page at offset zero and reads back what was stopped. Called on both sides, after the loading recipe and
 * before the screenshot.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ version: number, animations: object, timers: { intervals: number, timeouts: number, notes: string[] } }>}
 */
export async function freezePage(page) {
  const animations = await page.evaluate(stopAnimations, MAX_ANIMATIONS).catch(() => null);
  const timers = await page
    .evaluate(() => (window.__sasFrozen ? { ...window.__sasFrozen } : null))
    .catch(() => null);
  return {
    version: FREEZE_VERSION,
    animations: animations ?? { zeroed: 0, finished: 0, scrollLinked: 0, failed: 0, total: 0, items: [] },
    // No shim means the context was made without it: said plainly rather than reported as "nothing was moving".
    timers: timers ?? { intervals: 0, timeouts: 0, notes: [], installed: false },
  };
}

/** Both sides' numbers for the report, with the one thing that matters: what moved on one side only. */
export function frozenSummary(original, copy) {
  const kinds = (f) => ({
    timers: (f?.timers?.intervals ?? 0) + (f?.timers?.timeouts ?? 0),
    zeroed: f?.animations?.zeroed ?? 0,
    finished: f?.animations?.finished ?? 0,
    scrollLinked: f?.animations?.scrollLinked ?? 0,
  });
  const a = kinds(original);
  const b = kinds(copy);
  return {
    version: FREEZE_VERSION,
    original: a,
    copy: b,
    // A loop the original repeats and the copy has none of is a loop the copy is missing, not a pixel difference.
    loopsOnlyOriginal: Math.max(0, a.zeroed - b.zeroed),
    loopsOnlyCopy: Math.max(0, b.zeroed - a.zeroed),
    timersOnlyOriginal: Math.max(0, a.timers - b.timers),
    items: {
      original: (original?.animations?.items ?? []).slice(0, MAX_NOTES),
      copy: (copy?.animations?.items ?? []).slice(0, MAX_NOTES),
    },
  };
}
