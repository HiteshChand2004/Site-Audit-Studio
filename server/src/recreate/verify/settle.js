// @ts-check
// A picture of a page that never moves on its own shows one clear moment of every animation that repeats. Playwright's
// `animations: 'disabled'` cancels repeating animations, so each element falls back to its own resting style: a headline
// whose words are stacked in one place and shown one at a time by an animation then shows EVERY word on top of the others
// (panscience.xyz: "We build" + five words in one blur). Pausing everything at time zero is no better there: each word starts
// faded out, so no word shows at all.
//
// So the repeating animations are paused together and moved through one cycle of the longest of them, and the moment kept is
// the one where the most animated elements are fully shown and none is half-way through a fade (one word of a rotator, a
// carousel slide at rest). One-off animations and transitions are finished (their end is the resting layout), as
// `animations: 'disabled'` did; scroll-linked ones are left where the scroll put them. The picture is then taken with
// `animations: 'allow'`, which keeps the paused moment as it is.

/** Points tried across one cycle. */
export const SETTLE_STEPS = 60;
/** The longest cycle looked through (a slow loop beyond it is looked at over its first 30 s). */
export const SETTLE_MAX_MS = 30000;

/**
 * Runs in the page. Pauses its repeating animations at the clearest moment and finishes the others; `window.__sasSettled`
 * keeps what it paused, for `resumeAnimations`.
 * @param {{ steps: number, maxMs: number }} o
 */
export function settleAnimations({ steps, maxMs }) {
  const out = { loops: 0, finished: 0, at: /** @type {number|null} */ (null), span: 0 };
  let list = [];
  try {
    list = document.getAnimations();
  } catch {
    return out;
  }
  const loops = [];
  for (const a of list) {
    const timeline = (a.timeline && a.timeline.constructor && a.timeline.constructor.name) || '';
    if (/ScrollTimeline|ViewTimeline/.test(timeline)) continue;
    const timing = (a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming()) || {};
    const repeats = timing.iterations === Infinity || Number(timing.iterations) > 1;
    try {
      if (repeats) {
        if (a.playState === 'running') {
          a.pause();
          loops.push(a);
        }
      } else if (a.playState !== 'paused') {
        a.finish();
        out.finished++;
      }
    } catch { /* an animation that cannot be moved stays as it is */ }
  }
  /** @type {any} */ (window).__sasSettled = loops;
  out.loops = loops.length;
  if (!loops.length) return out;
  let span = 0;
  for (const a of loops) {
    const t = a.effect.getComputedTiming();
    const cycle = (Number(t.delay) || 0) + (Number(t.duration) || 0);
    if (Number.isFinite(cycle)) span = Math.max(span, cycle);
  }
  span = Math.min(Math.max(span, 1), maxMs);
  const targets = [...new Set(loops.map((a) => a.effect && a.effect.target).filter((el) => el && el.nodeType === 1))];
  // Fully shown counts for, half-faded counts against (twice as much): a crossfade between two words is never the pick.
  const score = () => {
    let s = 0;
    for (const el of targets) {
      const o = parseFloat(getComputedStyle(el).opacity);
      if (o > 0.95) s += 1;
      else if (o > 0.05) s -= 2;
    }
    return s;
  };
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const at = (span * i) / steps;
    for (const a of loops) {
      try { a.currentTime = at; } catch { /* left where it is */ }
    }
    const s = score();
    if (s > bestScore) {
      bestScore = s;
      best = at;
    }
  }
  for (const a of loops) {
    try { a.currentTime = best; } catch { /* left where it is */ }
  }
  out.at = Math.round(best);
  out.span = Math.round(span);
  return out;
}

/** Runs in the page: plays again what settleAnimations paused (the capture goes on using the page after its pictures). */
export function resumeAnimations() {
  const loops = /** @type {any} */ (window).__sasSettled || [];
  for (const a of loops) {
    try { a.play(); } catch { /* gone */ }
  }
  /** @type {any} */ (window).__sasSettled = [];
  return loops.length;
}

/**
 * Settles the page's animations for a picture; never throws (a page that cannot be settled is pictured as it is).
 * @param {import('playwright').Page} page
 */
export async function settlePage(page) {
  return page.evaluate(settleAnimations, { steps: SETTLE_STEPS, maxMs: SETTLE_MAX_MS }).catch(() => null);
}

/** @param {import('playwright').Page} page */
export async function resumePage(page) {
  return page.evaluate(resumeAnimations).catch(() => 0);
}
