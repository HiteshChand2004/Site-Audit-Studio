// Responsive refinement (Phase 4b.6.2): the sweep screenshots of the original (capture/sweep.js) decide two
// things the three captures (1440 / 768 / 375) cannot, because the IR only knows the layout at those widths:
//   1. the breakpoints - where the tablet and the mobile overrides start. They come from the site's own
//      media queries, else defaults. Each alternative is rendered at the sweep widths it changes and
//      scored against the original; one is taken only when it beats the current by BREAKPOINT_MARGIN points.
//   2. fluid type - font sizes and line heights that lie on one line over the viewport width are written as
//      clamp()/vw (ir/fluid.js); taken only when the whole sweep scores better with them.
//   3. phone shrink - large phone-view type as min(px, vw), so it scales down on screens narrower than 375 px;
//      taken only when the 320 px sweep scores better with it.
// Only css/site.css differs between the variants, so a variant is a served override of that one file:
// nothing is rebuilt, the IR is not touched until a variant has won. Never fails the job.
import path from 'node:path';
import { emitCss, CSS_FILE } from '../emit/css.js';
import { applyFluidType, applyPhoneShrink } from '../ir/fluid.js';
import { compareWidth, openSweepRenderer, renderSweepPage } from './responsive.js';
import { visualSimilarity } from './layout.js';

// The sweep widths each breakpoint decides: the tablet overrides (captured at 768) apply up to `tablet`, so
// 900 / 1024 / 1280 are tablet or desktop; the mobile overrides (captured at 375) up to `mobile`, so 480 / 600
// are mobile or tablet. 320 and 1920 are the same whatever the breakpoint.
const TABLET_WIDTHS = [900, 1024, 1280];
const MOBILE_WIDTHS = [480, 600];
// One alternative per outcome (how many of those widths get the narrower overrides), at the usual values.
const TABLET_ALTERNATIVES = [899.98, 1023.98, 1279.98, 1439.98];
const MOBILE_ALTERNATIVES = [479.98, 599.98, 767.98];
export const BREAKPOINT_MARGIN = 3;
export const FLUID_MARGIN = 1;
export const SHRINK_MARGIN = 1;
// Pages scored per variant (the first pages: the homepage, then the pages it links to).
const MAX_PAGES = 3;

class OutOfTime extends Error {}

const outcome = (widths, boundary) => widths.filter((w) => w <= boundary).length;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * @param {object} o
 * @param {object} o.ir          the finished IR (not modified)
 * @param {string} o.siteDir     the written site (its pages and assets are served; css/site.css is overridden)
 * @param {string} o.workspace   the recreate folder (capture/<slug>/sweep/…)
 * @param {{ widths: number[], pages: Record<string, object> }} o.sweep  ctx.sweep
 * @param {number} [o.deadline]  no new render starts after this time (ms since epoch)
 * @returns {Promise<{ breakpoints: object, rules: object[], fluid: boolean, summary: object }>}
 */
export async function refineResponsive({ ir, siteDir, workspace, sweep, deadline = Infinity }) {
  const pages = ir.pages.filter((p) => sweep.pages[p.slug]?.widths && Object.keys(sweep.pages[p.slug].widths).length).slice(0, MAX_PAGES);
  const summary = { status: 'done', pages: pages.length, renders: 0, breakpoints: null, fluid: null, shrink: null, stopped: null };
  const keep = { breakpoints: ir.breakpoints, rules: ir.rules, fluid: false, shrink: false, summary };
  if (!pages.length) return { ...keep, summary: { ...summary, status: 'skipped', reason: 'no-sweep-pages' } };

  const renderer = await openSweepRenderer(siteDir, sweep.widths);
  const cache = new Map();
  const fluid = applyFluidType(ir.rules);
  const shrink = { stepped: applyPhoneShrink(ir.rules), fluid: applyPhoneShrink(fluid.rules) };
  const rulesOf = (cfg) => {
    const kind = cfg.fluid ? 'fluid' : 'stepped';
    return cfg.shrink ? shrink[kind].rules : cfg.fluid ? fluid.rules : ir.rules;
  };
  const cssOf = (cfg) => emitCss({ ...ir, breakpoints: { ...ir.breakpoints, tablet: cfg.tablet, mobile: cfg.mobile }, rules: rulesOf(cfg) });

  // Mean score of a variant over `widths` (the original's sweep widths only), or null when nothing was measured.
  async function score(cfg, widths) {
    const usable = widths.filter((w) => sweep.widths.includes(w));
    const css = cssOf(cfg);
    renderer.server.overrides.set(CSS_FILE, css);
    const scores = [];
    for (const page of pages) {
      const original = sweep.pages[page.slug];
      const results = await Promise.all(usable.map(async (w) => {
        const o = original.widths[w];
        if (!o) return null;
        const key = `${cfg.tablet}|${cfg.mobile}|${cfg.fluid}|${cfg.shrink ?? false}|${page.slug}|${w}`;
        if (cache.has(key)) return cache.get(key);
        if (Date.now() > deadline) throw new OutOfTime();
        summary.renders++;
        const g = await renderSweepPage(renderer, page.outPath, w);
        const visual = await visualSimilarity(path.join(workspace, 'capture', page.slug, o.file), g.png).catch(() => null);
        const s = compareWidth(w, o, g, visual).score;
        cache.set(key, s);
        return s;
      }));
      scores.push(...results.filter((s) => s != null));
    }
    return mean(scores);
  }

  const current = { tablet: ir.breakpoints.tablet, mobile: ir.breakpoints.mobile, fluid: false, shrink: false };
  let chosen = { ...current };
  try {
    const bp = { tablet: null, mobile: null };
    // Each breakpoint is tried on its own widths, the other one as it is.
    for (const [key, widths, alternatives] of [['tablet', TABLET_WIDTHS, TABLET_ALTERNATIVES], ['mobile', MOBILE_WIDTHS, MOBILE_ALTERNATIVES]]) {
      const usable = widths.filter((w) => sweep.widths.includes(w));
      if (!usable.length) continue;
      const own = outcome(usable, chosen[key]);
      const baseline = await score(chosen, usable);
      if (baseline == null) continue;
      const tried = [{ value: chosen[key], current: true, score: round1(baseline) }];
      let best = { value: chosen[key], score: baseline };
      for (const value of alternatives) {
        if (outcome(usable, value) === own) continue;
        const s = await score({ ...chosen, [key]: value }, usable);
        if (s == null) continue;
        tried.push({ value, current: false, score: round1(s) });
        if (s > best.score) best = { value, score: s };
      }
      const take = best.value !== chosen[key] && best.score >= baseline + BREAKPOINT_MARGIN;
      bp[key] = { widths: usable, baseline: round1(baseline), tried, chosen: take ? best.value : chosen[key], changed: take };
      if (take) chosen = { ...chosen, [key]: best.value };
    }
    summary.breakpoints = bp;

    // Fluid type, on top of the breakpoints that were chosen.
    if (fluid.changed) {
      const stepped = await score(chosen, sweep.widths);
      const smooth = stepped == null ? null : await score({ ...chosen, fluid: true }, sweep.widths);
      const adopted = smooth != null && smooth >= stepped + FLUID_MARGIN;
      summary.fluid = { rules: fluid.changed, properties: fluid.properties, stepped: round1(stepped), fluid: round1(smooth), adopted };
      if (adopted) chosen = { ...chosen, fluid: true };
    }

    // Phone shrink, judged on the narrowest sweep width (the only one it changes).
    const narrow = sweep.widths.filter((w) => w < 375);
    if (narrow.length && shrink[chosen.fluid ? 'fluid' : 'stepped'].changed) {
      const without = await score(chosen, narrow);
      const withShrink = without == null ? null : await score({ ...chosen, shrink: true }, narrow);
      const adopted = withShrink != null && withShrink >= without + SHRINK_MARGIN;
      summary.shrink = { rules: shrink[chosen.fluid ? 'fluid' : 'stepped'].changed, widths: narrow, without: round1(without), with: round1(withShrink), adopted };
      if (adopted) chosen = { ...chosen, shrink: true };
    }
  } catch (err) {
    if (!(err instanceof OutOfTime)) {
      summary.status = 'failed';
      summary.error = err.message.split('\n')[0];
      chosen = { ...current }; // a half-finished search decides nothing
    } else {
      summary.stopped = 'time-limit';
    }
  } finally {
    renderer.server.overrides.delete(CSS_FILE);
    await renderer.close().catch(() => {});
  }

  const changed = chosen.tablet !== current.tablet || chosen.mobile !== current.mobile;
  return {
    breakpoints: changed ? { tablet: chosen.tablet, mobile: chosen.mobile, source: 'sweep' } : ir.breakpoints,
    rules: rulesOf(chosen),
    fluid: chosen.fluid,
    shrink: chosen.shrink,
    summary,
  };
}
