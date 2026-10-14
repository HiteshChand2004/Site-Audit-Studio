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
import { DYN_STEP_MS, paintsNothing } from '../recreate/capture/interactions.js';
import { isScrollReveal } from '../recreate/ir/motion.js';

// A long page: settling (≤ 8 s), loops (a scroll window at a time, ≤ 12 × 2.5 s, + ≤ 9 s of slow movers), hover (≤ 15 s) and
// focus. 40 s was set before the loop probe scrolled the page; a 6600 px page took 46 s and was reported as failed.
export const PAGE_BUDGET_MS = 90000;
const MAX_PAGES = 6;
// A little more than the capture of the original had (8 s): the probes go through the candidates in the same order, so the
// recreate must get at least as far, or an element the original reached would look missing just because time ran out.
const HOVER_BUDGET_MS = 10000;
// ...and when the original's probe went further (an unlimited or exact capture probes every candidate), the copy gets the
// time to probe as many: ~1.5 s per element (aim, a transition of up to 1 s, the read back), at most a minute a page.
// A fixed 10 s probed 11 of 40 elements on the copy where the capture had probed all 40, and the row read as lost hovers.
export const HOVER_MS_PER_PROBE = 1500;
export const HOVER_BUDGET_MAX_MS = 60000;

/** The hover budget the copy needs to get as far as the original's probe did. */
export function hoverBudgetFor(oldMotion) {
  const probed = oldMotion?.stats?.probed ?? 0;
  return Math.max(HOVER_BUDGET_MS, Math.min(HOVER_BUDGET_MAX_MS, probed * HOVER_MS_PER_PROBE));
}
/**
 * The click budget the copy needs to try every control the original's click probe tried (~1.5 s each: aim, click, settle,
 * read, put back), 10 s to a minute a page; none when the original had no control to click.
 */
export const CLICK_MS_PER_PROBE = 1500;
export function clickBudgetFor(oldMotion) {
  const probed = oldMotion?.clicks?.stats?.probed ?? 0;
  return probed ? Math.max(10000, Math.min(60000, probed * CLICK_MS_PER_PROBE)) : 0;
}
// The recreated site is served from loopback with nothing else to load: a quiet network shows within a second (was 3 s).
const NETWORK_QUIET_MS = 1000;

/** The original's motion.json per page: Map<slug, object> (only pages that have one). */
export async function readOldMotion(recreateFolder, reportPages, excluded = []) {
  const out = new Map();
  for (const p of reportPages ?? []) {
    if (!p.slug) continue;
    try {
      const motion = JSON.parse(await readFile(path.join(recreateFolder, 'capture', p.slug, 'motion.json'), 'utf8'));
      // A part the copy left out on purpose (an exact copy's ir/exclude.js: the builder's own controls) is not a hover
      // the copy lost.
      const gone = excluded.filter((e) => !e.page || e.page === p.path).map((e) => e.path).filter(Boolean);
      const kept = (h) => !gone.some((x) => h.path === x || String(h.path ?? '').startsWith(`${x}>`));
      if (gone.length) for (const kind of ['hover', 'focus']) if (Array.isArray(motion[kind])) motion[kind] = motion[kind].filter(kept);
      if (gone.length && Array.isArray(motion.clicks?.widgets)) motion.clicks.widgets = motion.clicks.widgets.filter((w) => kept({ path: w.trigger }));
      out.set(p.slug, motion);
    } catch { /* not captured for this page */ }
  }
  return out;
}

/**
 * Measures the recreated pages. Never throws for one page failing: that page is left out (and listed in `failed`).
 * @param {{ origin: string, pages: { slug: string, urlPath: string, hoverBudgetMs?: number }[], deadline?: number, signal?: AbortSignal }} o
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
          measureMotion(page, { budgetMs: p.hoverBudgetMs ?? HOVER_BUDGET_MS, focus: false, clickBudgetMs: p.clickBudgetMs ?? 0 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_BUDGET_MS + Math.max(0, (p.hoverBudgetMs ?? HOVER_BUDGET_MS) - HOVER_BUDGET_MS) + (p.clickBudgetMs ?? 0))),
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

// Tag + the first letters of the text without any white space: the original's markup often has no space between blocks
// ("10+Government Agencies") where the copy's has one, and the CSS-rule probe reads textContent while the mouse probe reads
// innerText. Neither is a different element.
const hoverKey = (h) => `${h.tag}|${String(h.text ?? '').toLowerCase().replace(/\s+/g, '').slice(0, 40)}`;
// Names the two loop probes give the same motion (a recorded path vs the rebuilt keyframes).
const PATTERN_FAMILY = { oscillate: 'float', float: 'float', sway: 'float', drift: 'marquee', marquee: 'marquee', ticker: 'marquee', spin: 'spin' };
// A fade in and out: the original's script-driven opacity oscillation, rebuilt as an opacity-only CSS animation
// (a small span classifies as 'other', a big one as 'blink').
const fades = (l) => (l.pattern === 'oscillate' && l.params?.channel === 'opacity') || l.pattern === 'blink'
  || (l.pattern === 'other' && (l.params?.properties ?? []).length > 0 && l.params.properties.every((p) => p === 'opacity'));
const loopFamily = (l) => (fades(l) ? 'fade' : PATTERN_FAMILY[l.pattern] ?? l.pattern);

/** What the comparison counts on one side. */
export function summarize(motion) {
  // The reveals the recreate rebuilds (ir/motion.js isScrollReveal), counted the same way on both sides.
  const reveal = (motion.reveal?.elements ?? []).filter(isScrollReveal);
  const hover = motion.hover ?? [];
  const loops = (motion.loops?.loops ?? motion.loops ?? []).filter((l) => !l.timeline);
  return {
    reveal: { count: reveal.length, durations: reveal.map((e) => e.timing?.duration), replay: reveal.filter((e) => e.replay).length },
    // Every channel of a hover is compared, each namespaced so a property the original changed on a neighbour is not
    // counted as satisfied by the copy changing it on the hovered element itself. Without this, an effect that reaches
    // outside the hovered element could be lost and the row would still read as passing.
    hover: {
      keys: hover.map(hoverKey),
      entries: hover,
      props: new Map(hover.map((h) => [hoverKey(h), [
        ...Object.keys(h.changes ?? {}),
        ...(h.kids ?? []).flatMap((k) => Object.keys(k.changes ?? {}).map((p) => `kid:${p}`)),
        ...(h.sibs ?? []).flatMap((x) => Object.keys(x.changes ?? {}).map((p) => `${x.rel ?? 'sib'}:${p}`)),
        ...Object.entries(h.pseudo ?? {}).flatMap(([which, c]) => Object.keys(c ?? {}).map((p) => `${which}:${p}`)),
      ]])),
    },
    // By pattern family only: a loop the original drove with script has no duration (and is named from its recorded path),
    // while its rebuilt CSS animation has one (and is named from its keyframes).
    loops: { keys: loops.map(loopFamily), count: loops.length },
  };
}

// Two computed values are the same end state when they are the same shape (functions, units, keywords) and every number in
// them is within 1.5 (px, channel) or 2 % of the other: computed styles round, and sub-pixel layout differs a hair.
const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/gi;
const skeleton = (v) => String(v ?? '').replace(NUMBER, '#').replace(/\s+/g, ' ').trim();
// The same colour written in another colour space (a browser keeps `oklab(…)` as the site wrote it; a stylesheet the copy
// writes may carry it as `rgba(…)`): every colour is put as rgba(r, g, b, a) on the 0-255 scale before comparing.
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
const fromLinear = ([r, g, b], alpha) => `rgba(${clamp255(gamma(r))}, ${clamp255(gamma(g))}, ${clamp255(gamma(b))}, ${+alpha.toFixed(3)})`;
function oklabToRgba(L, a, b, alpha) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return fromLinear([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s], alpha);
}
function labToRgba(L, a, b, alpha) {
  // CIE Lab (D50) -> XYZ -> D65 (Bradford) -> linear sRGB.
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const [X, Y, Z] = [f(fx) * 0.96422, (L > 8 ? fy ** 3 : L / (24389 / 27)), f(fz) * 0.82521];
  const [x, y, z] = [0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z, -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z, 0.0122982 * X - 0.0204830 * Y + 1.3299098 * Z];
  return fromLinear([3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.9692660 * x + 1.8760108 * y + 0.0415560 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z], alpha);
}
const num = (v, scale = 1) => (String(v).endsWith('%') ? (parseFloat(v) / 100) * scale : parseFloat(v));
export function normalizeColors(value) {
  return String(value ?? '')
    .replace(/#([0-9a-f]{3,8})\b/gi, (all, h) => {
      const x = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
      if (x.length !== 6 && x.length !== 8) return all;
      const n = (i) => parseInt(x.slice(i, i + 2), 16);
      return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${x.length === 8 ? +(n(6) / 255).toFixed(3) : 1})`;
    })
    .replace(/(oklab|oklch|lab|lch)\(\s*([^)]*)\)/gi, (all, fn, body) => {
      const [main, alphaPart] = body.split('/');
      const [p, q, r] = main.trim().split(/\s+/);
      const alpha = alphaPart ? num(alphaPart.trim(), 1) : 1;
      const f = fn.toLowerCase();
      if (f === 'oklab') return oklabToRgba(num(p, 1), num(q, 0.4), num(r, 0.4), alpha);
      if (f === 'oklch') {
        const h = (parseFloat(r) * Math.PI) / 180;
        return oklabToRgba(num(p, 1), num(q, 0.4) * Math.cos(h), num(q, 0.4) * Math.sin(h), alpha);
      }
      if (f === 'lab') return labToRgba(num(p, 100), num(q, 125), num(r, 125), alpha);
      const h = (parseFloat(r) * Math.PI) / 180;
      return labToRgba(num(p, 100), num(q, 150) * Math.cos(h), num(q, 150) * Math.sin(h), alpha);
    })
    .replace(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)/gi, (all, r, g, b, a) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a == null ? 1 : +num(a, 1).toFixed(3)})`);
}

export function sameValue(a, b) {
  if (a === b) return true;
  a = normalizeColors(a);
  b = normalizeColors(b);
  if (a === b) return true;
  if (skeleton(a) !== skeleton(b)) return false;
  const x = String(a ?? '').match(NUMBER) ?? [];
  const y = String(b ?? '').match(NUMBER) ?? [];
  // 1.5 is a pixel or a colour channel; a small unitless number (opacity, a scale) is held to 0.02.
  const tol = (v) => (Math.abs(v) <= 1.5 ? 0.02 : Math.max(1.5, Math.abs(v) * 0.02));
  return x.length === y.length && x.every((v, i) => Math.abs(Number(v) - Number(y[i])) <= tol(Number(v)));
}

/** How long an effect takes, in ms: what was measured when a script ran it, else the longest transition it declares. */
export function hoverDuration(h) {
  if (h?.scriptedMs != null) return h.scriptedMs;
  const parts = String(h?.transition?.duration ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return Math.round(Math.max(0, ...parts.map((s) => (s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000) || 0)));
}

/**
 * What is different between the original's hover and the copy's on one element: an end value of a property the original
 * changed (on the element, its pseudo-elements and its children, by property), or the time it takes (beyond 60 ms or a
 * quarter of the original's). A matching key with the same properties is not enough: the copy must end where the
 * original ends, as fast.
 * @returns {string[]}  readable differences (empty: the same)
 */
export function hoverDifferences(was, now) {
  const out = [];
  const compare = (label, a = {}, b = {}) => {
    for (const [prop, [, end]] of Object.entries(a)) {
      const got = b?.[prop]?.[1];
      if (got === undefined) out.push(`${label}${prop} does not change`);
      else if (!sameValue(end, got) && !(paintsNothing(prop, end) && paintsNothing(prop, got))) out.push(`${label}${prop} ends at ${String(got).slice(0, 60)} (original ${String(end).slice(0, 60)})`);
    }
  };
  compare('', was.changes, now.changes);
  for (const [which, c] of Object.entries(was.pseudo ?? {})) compare(`::${which} `, c, now.pseudo?.[which]);
  const kidsNow = new Map((now.kids ?? []).map((k) => [Object.keys(k.changes ?? {}).sort().join(','), k]));
  for (const k of was.kids ?? []) {
    const twin = kidsNow.get(Object.keys(k.changes ?? {}).sort().join(','));
    if (twin) compare('child ', k.changes, twin.changes);
    else out.push(`a child's ${Object.keys(k.changes ?? {}).join(', ')} does not change`);
  }
  // The other way round: the copy also changes a child, a neighbour or the parent the original leaves alone - hovering one
  // card must not move another, nor the row around it.
  const kidsWas = new Set((was.kids ?? []).map((k) => Object.keys(k.changes ?? {}).sort().join(',')));
  for (const k of now.kids ?? []) {
    const props = Object.keys(k.changes ?? {}).sort().join(',');
    if (!kidsWas.has(props)) out.push(`also changes a child's ${props.replace(/,/g, ', ')} (the original does not)`);
  }
  const sibsWas = new Set((was.sibs ?? []).map((x) => `${x.rel}:${Object.keys(x.changes ?? {}).sort().join(',')}`));
  for (const x of now.sibs ?? []) {
    const props = Object.keys(x.changes ?? {}).sort().join(',');
    if (!sibsWas.has(`${x.rel}:${props}`)) out.push(`also changes its ${x.rel === 'ancestor' ? 'parent' : `${x.rel === 'prev' ? 'previous' : 'next'} sibling`}'s ${props.replace(/,/g, ', ')} (the original does not)`);
  }
  const [d0, d1] = [hoverDuration(was), hoverDuration(now)];
  // A time measured on a script-driven effect is read every DYN_STEP_MS, so it is only that precise.
  const step = was?.scriptedMs != null || now?.scriptedMs != null ? DYN_STEP_MS + 10 : 0;
  if (Math.abs(d0 - d1) > Math.max(60, d0 * 0.25, step)) out.push(`takes ${d1} ms (original ${d0} ms)`);
  return out;
}

// ---- clicks: what each control does (capture/clicks.js on both sides) ----------------------------------------------

/** A control as a visitor names it: its visible text (or label), lower case, no white space. */
export const clickKey = (w) => String(w?.text ?? '').toLowerCase().replace(/\s+/g, '').slice(0, 40) || `${w?.tag ?? ''}#unnamed`;
const CLOSES = { toggle: 'a second click', escape: 'Escape', outside: 'a click outside' };

/**
 * What a control of the copy does differently from the same control of the original: it does nothing, it does not close
 * again the way the original's did (a second click, Escape, a click outside), or it keeps several items open where the
 * original kept one at a time (or the other way round).
 * @returns {string[]}
 */
export function clickDifferences(was, now) {
  if (!now) {
    // On the original this click only took something away (the open answer of a FAQ closing): say that, not just "nothing".
    const closesOnly = (was.change?.hidden?.length ?? 0) > 0 && !(was.change?.shown?.length || was.change?.added?.length);
    return [closesOnly ? 'clicking it does not close what it closes on the original' : 'does nothing in the copy'];
  }
  const out = [];
  // What the click opened going away again (closesOwn, capture/clicks.js restore); a capture made before it was read has `closes` only.
  const wasCloses = was.closesOwn ?? was.closes;
  const nowCloses = now.closesOwn ?? now.closes;
  if (wasCloses && wasCloses !== nowCloses) {
    out.push(`${CLOSES[wasCloses] ?? wasCloses} does not close it again (it does on the original)`);
  }
  if (was.exclusive === true && now.exclusive === false) out.push('several items stay open (the original keeps one open at a time)');
  if (was.exclusive === false && now.exclusive === true) out.push('opening one closes the others (the original keeps them open)');
  return out;
}

/** Pairs every control of the original with the copy's control of the same name that behaves most alike. */
export function compareClicks(oldWidgets = [], newWidgets = [], probedNames = null) {
  // A control the copy's probe never reached (its time ran out, or it probed other equal controls instead) is not checked:
  // that is no evidence the copy's control does nothing.
  const reached = probedNames ? new Set(probedNames.map((t) => clickKey({ text: t }))) : null;
  const byKey = new Map();
  for (const w of newWidgets) byKey.set(clickKey(w), [...(byKey.get(clickKey(w)) ?? []), w]);
  const rows = [];
  for (const was of oldWidgets) {
    const twins = byKey.get(clickKey(was)) ?? [];
    let pick = -1;
    for (let i = 0; i < twins.length; i++) if (pick < 0 || clickDifferences(was, twins[i]).length < clickDifferences(was, twins[pick]).length) pick = i;
    const now = pick >= 0 ? twins.splice(pick, 1)[0] : null;
    if (!now && reached && !reached.has(clickKey(was))) {
      rows.push({ was, now, diff: [], unchecked: true });
      continue;
    }
    rows.push({ was, now, diff: clickDifferences(was, now) });
  }
  return rows;
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
  const matchedHover = { count: 0, agree: 0, same: 0, differences: [] };
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
    // The copy's entries by key, in order, so each original hover is held against the copy's hover on the same element.
    const entriesNow = new Map();
    for (const h of sn.hover.entries) entriesNow.set(hoverKey(h), [...(entriesNow.get(hoverKey(h)) ?? []), h]);
    for (const [i, k] of so.hover.keys.entries()) {
      if ((pool.get(k) ?? 0) <= 0) continue;
      pool.set(k, pool.get(k) - 1);
      matchedHover.count++;
      const before = so.hover.entries[i];
      // Several elements with the same name ("Home" in the header and in the footer): the copy's one that matches best, not
      // the next in order - the copy is probed in its own order.
      const twins = entriesNow.get(k) ?? [];
      let pick = 0;
      for (let c = 1; c < twins.length; c++) if (hoverDifferences(before, twins[c]).length < hoverDifferences(before, twins[pick]).length) pick = c;
      const after = twins.splice(pick, 1)[0];
      const diff = after ? hoverDifferences(before, after) : ['not measured'];
      if (!diff.length) matchedHover.same++;
      else if (matchedHover.differences.length < 12) {
        matchedHover.differences.push({ page: slug, element: `${before.tag ?? ''} "${String(before.text ?? '').slice(0, 30)}"`, diff: diff.slice(0, 3) });
      }
      const was = new Set(so.hover.props.get(k));
      const now = new Set(sn.hover.props.get(k));
      const same = [...was].filter((p) => now.has(p)).length;
      if (!was.size || same / was.size >= 0.5) matchedHover.agree++;
    }
    o.loops.push(...so.loops.keys);
    n.loops.push(...sn.loops.keys);
  }
  const items = [];
  const summary = { pages: both.length, reveal: { before: o.reveal, after: n.reveal }, hover: { before: o.hover.length, after: n.hover.length, matched: matchedHover.count, sameEnd: matchedHover.same }, loops: { before: o.loops.length, after: n.loops.length } };

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
  // Clicks: every control the original's click probe found is clicked on the copy the same way, and the two compared.
  const clicks = { total: 0, same: 0, differences: [], unchecked: 0 };
  for (const slug of both) {
    const was = oldPages.get(slug)?.clicks?.widgets ?? [];
    const now = newPages.get(slug)?.clicks?.widgets;
    if (!was.length || !now) continue; // not measured on the copy: no verdict either way
    for (const r of compareClicks(was, now, newPages.get(slug)?.clicks?.probedNames ?? null)) {
      if (r.unchecked) {
        clicks.unchecked++;
        continue;
      }
      clicks.total++;
      if (!r.diff.length) clicks.same++;
      else if (clicks.differences.length < 12) clicks.differences.push({ page: slug, element: `${r.was.tag ?? ''} "${String(r.was.text ?? '').slice(0, 30)}"`, kind: r.was.kind, diff: r.diff });
    }
  }
  if (clicks.total) {
    const ratio = clicks.same / clicks.total;
    const shown = clicks.differences.slice(0, 3).map((d) => `${d.element}: ${d.diff[0]}`).join('; ');
    items.push({
      ...row('motion.clicks', 'Click interactions kept', ratio,
        { detail: `${plural(clicks.total, 'control')} open, switch or move something when clicked (menus, FAQ answers, tabs, dialogs, …).`, count: clicks.total },
        { detail: `${clicks.same} of them do the same on the recreated site, and close again the same way.${shown ? ` Differs: ${shown}.` : ''}`, count: clicks.same },
        clicks.unchecked ? `${plural(clicks.unchecked, 'control')} not reached on the copy in the time given (not counted).` : null),
      differences: clicks.differences,
    });
  }
  // Parts that change by themselves (capture/feeds.js): each one the original had is paired with one of the copy that
  // changes at about the same pace (within max(150 ms, 25 %)) - the copy must keep changing after it loaded, not only
  // show the moment the capture caught.
  const feeds = { before: 0, kept: 0, paces: [] };
  for (const slug of both) {
    const was = oldPages.get(slug)?.feeds?.areas ?? [];
    const now = [...(newPages.get(slug)?.feeds ?? [])];
    feeds.before += was.length;
    for (const a of was) {
      const i = now.findIndex((b) => Math.abs(b.ms - a.ms) <= Math.max(150, a.ms * 0.25));
      if (i < 0) continue;
      feeds.kept++;
      feeds.paces.push(`${now[i].ms} ms (original ${a.ms} ms)`);
      now.splice(i, 1);
    }
  }
  if (feeds.before) {
    const ratio = feeds.kept / feeds.before;
    items.push(row('motion.feeds', 'Parts that change by themselves kept', ratio,
      { detail: `${plural(feeds.before, 'part')} of the page change on their own (a feed, a ticker, a highlight that moves on).`, count: feeds.before },
      { detail: `${feeds.kept} of them keep changing on the recreated site${feeds.paces.length ? `: every ${feeds.paces.slice(0, 3).join(', ')}` : ''}.`, count: feeds.kept },
      'The copy replays the updates the capture saw, in order, and starts over after the last one: it is not live data.'));
  }
  // Elements that follow the mouse (capture/pointer.js): each original follower needs one in the copy with the same ratio to
  // the mouse's moves (within max(0.05, 25 %)) and, where it eases, a time constant within max(60 ms, 40 %).
  const followers = { before: 0, kept: 0, differences: [] };
  for (const slug of both) {
    const was = oldPages.get(slug)?.pointer?.followers ?? [];
    const now = [...(newPages.get(slug)?.pointer?.followers ?? [])];
    followers.before += was.length;
    for (const f of was) {
      const close = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(a) * 0.25);
      const i = now.findIndex((g) => close(f.kx, g.kx) && close(f.ky, g.ky));
      if (i < 0) {
        followers.differences.push({ page: slug, element: f.path, diff: [`does not follow the mouse in the copy (the original moves ${f.kx} × the mouse's move)`] });
        continue;
      }
      const g = now.splice(i, 1)[0];
      if (Math.abs(f.tauMs - g.tauMs) > Math.max(60, f.tauMs * 0.4)) followers.differences.push({ page: slug, element: f.path, diff: [`catches up in about ${g.tauMs} ms (original ${f.tauMs} ms)`] });
      else followers.kept++;
    }
  }
  if (followers.before) {
    items.push({
      ...row('motion.pointer', 'Effects that follow the mouse kept', followers.kept / followers.before,
        { detail: `${plural(followers.before, 'element')} follow the mouse (a custom cursor, mouse parallax).`, count: followers.before },
        { detail: `${followers.kept} of them follow it the same way on the recreated site.`, count: followers.kept }),
      differences: followers.differences.slice(0, 12),
    });
  }
  // Not only whether the copy reacts, but whether it ends where the original ends, as fast.
  if (matchedHover.count) {
    const ratio = matchedHover.same / matchedHover.count;
    const shown = matchedHover.differences.slice(0, 3).map((d) => `${d.element}: ${d.diff[0]}`).join('; ');
    items.push({
      ...row('motion.hover-match', 'Hover end states and timing match', ratio,
        { detail: `${plural(matchedHover.count, 'hover effect')} found on both sides.`, count: matchedHover.count },
        { detail: `${matchedHover.same} of them end in the same values, at the same speed.${shown ? ` Differs: ${shown}.` : ''}`, count: matchedHover.same }),
      differences: matchedHover.differences,
    });
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
