// Motion in the fix checklist (Phase 4b.8): does the recreated site move like the original?
// The original's motion was captured by Recreate (capture/<slug>/motion.json: scroll reveal, loops, hover). Here the recreated
// pages are measured with the same probes (capture/measure.js) on the throwaway server the re-audit already runs, and the two
// are compared by kind. Elements cannot be paired by path (the recreate has other markup), so they are paired by what a visitor
// sees: tag + text for hover, pattern + duration for loops; scroll reveals are compared by count.
// Rows: category `motion`, key `motion.<kind>`, status decided here (the original has the effect, so reproduced = pass).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import { measureMotion } from '../recreate/capture/measure.js';
import { isScrollReveal } from '../recreate/ir/motion.js';

const PAGE_BUDGET_MS = 40000;
const MAX_PAGES = 6;
// A little more than the capture of the original had (8 s): the probes go through the candidates in the same order, so the
// recreate must get at least as far, or an element the original reached would look missing just because time ran out.
const HOVER_BUDGET_MS = 10000;
// The recreated site is served from loopback with nothing else to load: a quiet network shows within a second (was 3 s).
const NETWORK_QUIET_MS = 1000;

/** The original's motion.json per page: Map<slug, object> (only pages that have one). */
export async function readOldMotion(recreateFolder, reportPages) {
  const out = new Map();
  for (const p of reportPages ?? []) {
    if (!p.slug) continue;
    try {
      out.set(p.slug, JSON.parse(await readFile(path.join(recreateFolder, 'capture', p.slug, 'motion.json'), 'utf8')));
    } catch { /* not captured for this page */ }
  }
  return out;
}

/**
 * Measures the recreated pages. Never throws for one page failing: that page is left out (and listed in `failed`).
 * @param {{ origin: string, pages: { slug: string, urlPath: string }[], deadline?: number, signal?: AbortSignal }} o
 * @returns {Promise<{ pages: Map<string, object>, failed: { slug: string, error: string }[], skipped: string[] }>}
 */
export async function measureNewMotion({ origin, pages, deadline = Infinity, signal }) {
  const result = { pages: new Map(), failed: [], skipped: [] };
  if (!pages.length) return result;
  const browser = await launchBrowser();
  try {
    for (const p of pages.slice(0, MAX_PAGES)) {
      if (signal?.aborted || Date.now() + 15000 > deadline) {
        result.skipped.push(p.slug);
        continue;
      }
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: true, serviceWorkers: 'block' });
      // Only the throwaway server is reachable: the recreated site makes no other request.
      await context.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort('blockedbyclient')));
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/${p.urlPath}`, { waitUntil: 'load', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: NETWORK_QUIET_MS }).catch(() => {});
        const measured = await Promise.race([
          // No focus pass: the comparison (motionItems) reads reveals, loops and hover only; the hover probe keeps its time.
          measureMotion(page, { budgetMs: HOVER_BUDGET_MS, focus: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_BUDGET_MS)),
        ]);
        result.pages.set(p.slug, measured);
      } catch (err) {
        result.failed.push({ slug: p.slug, error: String(err?.message ?? err).split('\n')[0] });
      } finally {
        await context.close().catch(() => {});
      }
    }
    result.skipped.push(...pages.slice(MAX_PAGES).map((p) => p.slug));
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

// ---- comparison ---------------------------------------------------------------------------------------------------

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A multiset of keys → how many of `a` have a partner in `b`.
function overlap(a, b) {
  const pool = new Map();
  for (const k of b) pool.set(k, (pool.get(k) ?? 0) + 1);
  let matched = 0;
  for (const k of a) {
    if ((pool.get(k) ?? 0) > 0) {
      pool.set(k, pool.get(k) - 1);
      matched++;
    }
  }
  return matched;
}

/** What the comparison counts on one side. */
export function summarize(motion) {
  // The reveals the recreate rebuilds (ir/motion.js isScrollReveal), counted the same way on both sides.
  const reveal = (motion.reveal?.elements ?? []).filter(isScrollReveal);
  const hover = motion.hover ?? [];
  const loops = (motion.loops?.loops ?? motion.loops ?? []).filter((l) => !l.timeline);
  return {
    reveal: { count: reveal.length, durations: reveal.map((e) => e.timing?.duration), replay: reveal.filter((e) => e.replay).length },
    hover: { keys: hover.map((h) => `${h.tag}|${h.text ?? ''}`), props: new Map(hover.map((h) => [`${h.tag}|${h.text ?? ''}`, Object.keys(h.changes ?? {})])) },
    // By pattern only: a loop the original drove with script has no duration, while its rebuilt CSS animation has one.
    loops: { keys: loops.map((l) => l.pattern), count: loops.length },
  };
}

const tone = (ratio) => (ratio >= 0.9 ? 'pass' : ratio >= 0.5 ? 'open' : 'regressed');
const row = (key, title, ratio, before, after, note) => ({
  key, category: 'motion', title, preset: tone(ratio),
  before: { status: 'pass', detail: before.detail, count: before.count },
  after: { status: ratio >= 0.9 ? 'pass' : ratio >= 0.5 ? 'warn' : 'fail', detail: after.detail, count: after.count },
  ...(note && { note }),
});

/**
 * Checklist rows: for each kind the original has, how much of it the recreated site reproduces (pages measured on both sides).
 * @param {Map<string, object>} oldPages  slug → the original's motion.json
 * @param {Map<string, object>} newPages  slug → measured motion of the recreated page
 * @returns {{ items: object[], summary: object }}
 */
export function motionItems(oldPages, newPages) {
  const both = [...oldPages.keys()].filter((slug) => newPages.has(slug));
  const o = { reveal: 0, replay: 0, hover: [], loops: [], durations: [], hoverProps: new Map() };
  const n = { reveal: 0, replay: 0, hover: [], loops: [], durations: [] };
  const matchedHover = { count: 0, agree: 0 };
  for (const slug of both) {
    const so = summarize(oldPages.get(slug));
    const sn = summarize(newPages.get(slug));
    o.reveal += so.reveal.count;
    n.reveal += sn.reveal.count;
    o.replay += so.reveal.replay;
    n.replay += sn.reveal.replay;
    o.durations.push(...so.reveal.durations);
    n.durations.push(...sn.reveal.durations);
    o.hover.push(...so.hover.keys);
    n.hover.push(...sn.hover.keys);
    // Matched hover elements whose changed properties agree (at least half of the original's).
    const pool = new Map();
    for (const k of sn.hover.keys) pool.set(k, (pool.get(k) ?? 0) + 1);
    for (const k of so.hover.keys) {
      if ((pool.get(k) ?? 0) <= 0) continue;
      pool.set(k, pool.get(k) - 1);
      matchedHover.count++;
      const was = new Set(so.hover.props.get(k));
      const now = new Set(sn.hover.props.get(k));
      const same = [...was].filter((p) => now.has(p)).length;
      if (!was.size || same / was.size >= 0.5) matchedHover.agree++;
    }
    o.loops.push(...so.loops.keys);
    n.loops.push(...sn.loops.keys);
  }
  const items = [];
  const summary = { pages: both.length, reveal: { before: o.reveal, after: n.reveal }, hover: { before: o.hover.length, after: n.hover.length }, loops: { before: o.loops.length, after: n.loops.length } };

  if (o.reveal) {
    const ratio = Math.min(1, n.reveal / o.reveal);
    const dOld = median(o.durations);
    const dNew = median(n.durations);
    const timing = dOld != null && dNew != null ? ` Typical duration ${Math.round(dNew)} ms (original ${Math.round(dOld)} ms).` : '';
    items.push(row('motion.reveal', 'Scroll-reveal animations kept', ratio,
      { detail: `${plural(o.reveal, 'element')} fade or slide in as they scroll into view${o.replay ? `; ${o.replay} repeat when they leave` : ''}.`, count: o.reveal },
      { detail: `${n.reveal} found on the recreated site.${timing}`, count: n.reveal },
      ratio < 0.9 ? 'Some reveals could not be rebuilt (effects that run at page load or by script are not reproduced).' : null));
  }
  if (o.hover.length) {
    const matched = overlap(o.hover, n.hover);
    const ratio = matched / o.hover.length;
    items.push(row('motion.hover', 'Hover effects kept', ratio,
      { detail: `${plural(o.hover.length, 'element')} change on hover (colour, shadow, movement, …).`, count: o.hover.length },
      { detail: `${matched} of them react on the recreated site${matched ? ` (${matchedHover.agree} with the same changes)` : ''}.`, count: matched },
      ratio < 0.9 ? 'Hover effects driven by script (they add or remove elements) are not reproduced.' : null));
  }
  if (o.loops.length) {
    const matched = overlap(o.loops, n.loops);
    const ratio = matched / o.loops.length;
    items.push(row('motion.loops', 'Looping animations kept', ratio,
      { detail: `${plural(o.loops.length, 'animation')} run continuously (spinners, tickers, pulses, …).`, count: o.loops.length },
      { detail: `${matched} of them run on the recreated site.`, count: matched },
      ratio < 0.9 ? 'Marquees driven by script, scroll-linked animations and some pseudo-element loops are not rebuilt.' : null));
  }
  return { items, summary };
}
