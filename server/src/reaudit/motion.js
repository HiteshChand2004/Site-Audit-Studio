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
import { loopsTimeOf, LOOPS_MAX_MS } from '../recreate/capture/loops.js';
import { DYN_STEP_MS, FIRST_MS, paintsNothing } from '../recreate/capture/interactions.js';
import { isScrollReveal } from '../recreate/ir/motion.js';
import { HOLD_FORMS } from '../recreate/behavior/preserve/complete.js';

// A long page: settling (≤ 8 s), loops (a scroll window at a time, ≤ 12 × 2.5 s, + ≤ 9 s of slow movers), hover (≤ 15 s) and
// focus. 40 s was set before the loop probe scrolled the page; a 6600 px page took 46 s and was reported as failed.
// A page's time = this base (load, the reveal tracker, the self-changing and pointer probes, and the margin the probes take
// beyond their budgets under load) + what the loop capture needs on THIS page (capture/loops.js loopsTimeFor: a long page is
// scrolled a window at a time, every canvas recorded) + the hover and click budgets. A fixed 90 s cut a one-page copy off
// whose loop capture alone took 48 s (12 scroll windows + 9 s of slow movers), and the re-audit had no motion rows for it.
export const PAGE_BUDGET_MS = 90000;
/** The time one page is given: the base, the loop capture's own estimate (the most it can take when unknown), hover, clicks. */
export function motionTimeFor({ hoverBudgetMs = HOVER_BUDGET_MS, clickBudgetMs = 0, loopsMs = LOOPS_MAX_MS } = {}) {
  return PAGE_BUDGET_MS + loopsMs + hoverBudgetMs + clickBudgetMs;
}
const MAX_PAGES = 6;
// A little more than the capture of the original had (8 s): the probes go through the candidates in the same order, so the
// recreate must get at least as far, or an element the original reached would look missing just because time ran out.
const HOVER_BUDGET_MS = 10000;
// ...and when the original's probe went further (an unlimited or exact capture probes every candidate), the copy gets the
// time to probe as many: ~1.5 s per element (aim, a transition of up to 1 s, the read back), at most a minute a page.
// A fixed 10 s probed 11 of 40 elements on the copy where the capture had probed all 40, and the row read as lost hovers.
export const HOVER_MS_PER_PROBE = 1500;
export const HOVER_BUDGET_MAX_MS = 60000;

/**
 * The hover budget the copy needs to get as far as the original's probe did - and, whatever else it reaches, to measure every
 * element the original saw hovering (hoverFirstFor), which the copy's probe takes first: a script-driven hover is read step by
 * step and its revert waited for, ~FIRST_MS each. A page whose five hovers sat after five links that do nothing (each costing
 * the probe its revert wait) was measured as "0 of 5" with time to spare for none of them.
 */
export function hoverBudgetFor(oldMotion) {
  const probed = oldMotion?.stats?.probed ?? 0;
  const first = hoverFirstFor(oldMotion).length;
  return Math.max(HOVER_BUDGET_MS, Math.min(HOVER_BUDGET_MAX_MS, Math.max(probed * HOVER_MS_PER_PROBE, first * FIRST_MS)));
}
/** The tag|text keys (hoverKey) of the mouse-probed hovers of the original: what the copy's probe must reach. */
export function hoverFirstFor(oldMotion) {
  return [...new Set((oldMotion?.hover ?? []).filter((h) => h?.source !== 'css' && h?.tag).map(hoverKey))];
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
      // A capture made before the click probe recorded a link's href: read it, and whether its #id target exists, from the
      // capture's own snapshot of the page.
      const widgets = motion.clicks?.widgets ?? [];
      const needJumps = widgets.some((w) => w.tag === 'a' && w.href == null);
      // A capture with mouse followers: which elements move by their own CSS animation, from the snapshot (movesByItself).
      const needMoving = (motion.pointer?.followers ?? []).length > 0;
      if (needJumps || needMoving) {
        const snap = await readFile(path.join(recreateFolder, 'capture', p.slug, 'desktop.json'), 'utf8').then(JSON.parse, () => null);
        if (needJumps && snap?.body) markJumps(widgets, snap.body);
        if (needMoving && snap?.body) motion.selfMoving = selfMovingFromSnapshot(snap);
      }
      out.set(p.slug, motion);
    } catch { /* not captured for this page */ }
  }
  return out;
}

// The properties that move an element's box (what the pointer probe reads: its centre).
const MOVES = /^(transform|translate|left|top|right|bottom|inset|margin|offset)/;
const movingKeyframes = (frames) => (frames ?? []).some((k) => Object.keys(k?.props ?? k ?? {}).some((p) => MOVES.test(p)));

/**
 * Paths of elements that move by an animation of their own on one side: the loops that side recorded (capture/loops.js;
 * the copy's measurement holds them too) whose keyframes change a moving property, or a script loop moving on x / y; plus
 * `selfMoving` (readOldMotion: an older capture's snapshot, an infinite CSS animation whose @keyframes move the box).
 * An element there - or inside one - is not counted as a mouse follower: the pointer probe can read such a loop as one
 * when it happens to move in step with the mouse.
 */
export function movesByItself(motion) {
  const out = new Set(motion?.selfMoving ?? []);
  for (const l of motion?.loops?.loops ?? motion?.loops ?? []) {
    if (!l?.path || l.timeline) continue;
    const channel = l.params?.channel;
    if (movingKeyframes(l.keyframes) || channel === 'x' || channel === 'y' || (l.params?.properties ?? []).some((p) => MOVES.test(p))) out.add(l.path);
  }
  return out;
}
const isSelfMoving = (path, set) => [...set].some((p) => path === p || String(path).startsWith(`${p}>`));

/**
 * Paths in a capture snapshot (capture/<slug>/desktop.json) running an infinite CSS animation whose @keyframes (the
 * snapshot's own `keyframes` list) move the box. For captures whose loop record is missing or incomplete.
 */
export function selfMovingFromSnapshot(snap) {
  const moving = new Set();
  for (const k of snap?.keyframes ?? []) {
    if (k?.name && /\b(transform|translate|left|top|right|bottom|inset|margin|offset[-\w]*)\s*:/.test(String(k.css ?? ''))) moving.add(k.name);
  }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    const names = String(n.style?.['animation-name'] ?? '').split(',').map((s) => s.trim());
    const counts = String(n.style?.['animation-iteration-count'] ?? '').split(',').map((s) => s.trim());
    if (n.path && names.some((name, i) => moving.has(name) && (counts[i] ?? counts[0]) === 'infinite')) out.push(n.path);
    for (const c of n.children ?? []) walk(c);
  };
  walk(snap?.body);
  return out;
}

/** The element id a jump link names (`#main` → `main`), or null for anything else (a bare `#`, another page, a script). */
export function jumpId(href) {
  const h = String(href ?? '').trim();
  if (!/^#./.test(h)) return null;
  try {
    return decodeURIComponent(h.slice(1));
  } catch {
    return h.slice(1);
  }
}
const isTop = (id) => String(id).toLowerCase() === 'top';

/**
 * Marks the click widgets of an older capture from its snapshot (capture/<slug>/desktop.json body): a link's `href`, and
 * `jump` when it names an element the page held (by id or name, or `#top`) and the page did not suppress the click (`stay`).
 * Changes the widgets in place.
 */
export function markJumps(widgets, body) {
  const byPath = new Map();
  const ids = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.path) byPath.set(n.path, n);
    if (n.attrs?.id) ids.add(n.attrs.id);
    if (n.attrs?.name) ids.add(n.attrs.name);
    for (const c of n.children ?? []) walk(c);
  };
  walk(body);
  for (const w of widgets) {
    if (w.tag !== 'a' || w.href != null) continue;
    const href = byPath.get(w.trigger)?.attrs?.href;
    if (href == null) continue;
    w.href = href;
    const id = jumpId(href);
    if (id && !w.stay && (ids.has(id) || isTop(id))) w.jump = true;
  }
  return widgets;
}

/**
 * An as-is copy keeps the original's own files (as-is/lifted, lifted from the capture's record and served offline like the
 * copy). Its reveals and loops are measured with the copy's own probe (measureNewMotion), so both sides of those two rows come
 * from one instrument: the capture's reveal probe ran on the live site with other rules (it tracked tiny spans the copy's probe
 * never counts), and a copy that ships the original's reveal code read as "81 → 27". Hover, focus and clicks stay the
 * capture's (the copy's probe budgets follow them). A page the lifted run did not measure keeps the capture's values.
 * @param {Map<string, object>} oldMotion  readOldMotion's result, changed in place
 * @param {Map<string, object>} lifted  measureNewMotion(...).pages of the lifted original
 * @returns {string[]} the slugs whose reveals and loops now come from the lifted original
 */
export function useLiftedBefore(oldMotion, lifted) {
  const used = [];
  for (const [slug, m] of lifted ?? []) {
    const old = oldMotion.get(slug);
    if (!old || !m) continue;
    // What the live capture had is kept beside it: when the saved files show fewer, the row says both numbers (liveVsSaved).
    oldMotion.set(slug, { ...old, reveal: m.reveal, loops: m.loops, measuredFrom: 'lifted', live: { reveal: old.reveal, loops: old.loops } });
    used.push(slug);
  }
  return used;
}
/** The #id targets of the original's jump links on a page (its motion.json, after readOldMotion), for the copy's check. */
export function jumpTargetsOf(oldMotion) {
  return [...new Set((oldMotion?.clicks?.widgets ?? []).filter((w) => w.jump).map((w) => jumpId(w.href)).filter(Boolean))];
}
/** Page function: id → whether the page holds an element of that id or name (`top` always: a browser scrolls to the top). */
export function targetsPresent(ids) {
  const out = {};
  for (const id of ids) out[id] = !!(document.getElementById(id) || document.getElementsByName(id)[0] || String(id).toLowerCase() === 'top');
  return out;
}

/**
 * The lifted original's pages to measure: the copy's targets with no click probing, and hover probing only where the copy
 * missed some of the original's hovers (`missed`: slug → those hover entries, missedHovers) - those are taken first, so the
 * row can tell whether the original's own files, served without its server, draw them at all. Elsewhere only reveals and
 * loops are used.
 */
export const liftedTargets = (targets, missed = null) => targets.map((t) => {
  const miss = missed?.get(t.slug) ?? [];
  return { slug: t.slug, urlPath: t.urlPath, clickBudgetMs: 0,
    hoverBudgetMs: miss.length ? Math.max(HOVER_BUDGET_MS, Math.min(HOVER_BUDGET_MAX_MS, miss.length * FIRST_MS)) : 1,
    hoverFirst: miss.length ? [...new Set(miss.map(hoverKey))] : [] };
});

/** What a hover changes: its own properties, its children's, its neighbours' and its pseudo-elements', each namespaced. */
function hoverProps(h) {
  return [
    ...Object.keys(h.changes ?? {}),
    ...(h.kids ?? []).flatMap((k) => Object.keys(k.changes ?? {}).map((p) => `kid:${p}`)),
    ...(h.sibs ?? []).flatMap((x) => Object.keys(x.changes ?? {}).map((p) => `${x.rel ?? 'sib'}:${p}`)),
    ...Object.entries(h.pseudo ?? {}).flatMap(([which, c]) => Object.keys(c ?? {}).map((p) => `${which}:${p}`)),
  ];
}

/**
 * Pairs the original's hovers on one page with the copy's: by name first (hoverKey: tag + visible text; several with one
 * name = the copy's closest), then an unpaired one by the same element - the same path and tag - whose hover changes the
 * same properties: a label the page's script writes from data (a button reading "Create your free account" for one
 * visitor and "Start practice meeting" for another) is the same hover on the same element.
 * @returns {{ pairs: [object, object, 'name' | 'path'][], missing: object[] }}
 */
export function pairHovers(was, now) {
  const left = [...(now ?? [])];
  const pairs = [];
  const rest = [];
  for (const h of was ?? []) {
    const twins = left.filter((g) => hoverKey(g) === hoverKey(h));
    if (!twins.length) {
      rest.push(h);
      continue;
    }
    let pick = twins[0];
    for (const t of twins.slice(1)) if (hoverDifferences(h, t).length < hoverDifferences(h, pick).length) pick = t;
    left.splice(left.indexOf(pick), 1);
    pairs.push([h, pick, 'name']);
  }
  const missing = [];
  for (const h of rest) {
    const props = [...new Set(hoverProps(h))].sort().join('|');
    const i = h.path ? left.findIndex((g) => g.path === h.path && g.tag === h.tag && [...new Set(hoverProps(g))].sort().join('|') === props) : -1;
    if (i < 0) missing.push(h);
    else pairs.push([h, left.splice(i, 1)[0], 'path']);
  }
  return { pairs, missing };
}

/** The original's hovers the copy misses, per page (pairHovers): slug → entries. Only pages measured on both sides. */
export function missedHovers(oldPages, newPages) {
  const out = new Map();
  for (const [slug, m] of newPages ?? []) {
    const old = oldPages.get(slug);
    if (!old || !m) continue;
    const { missing } = pairHovers(summarize(old).hover.entries, summarize(m).hover.entries);
    if (missing.length) out.set(slug, missing);
  }
  return out;
}

const dataPath = (p) => {
  let s = String(p ?? '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep it as written
  }
  return s.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '') || '/';
};
/**
 * The copy page's failed data requests (measureNewMotion `dataFailed`) to an address of the site's own backend (`backend`:
 * the paths its server answered with data while it was captured): the proof that the page's script drew it without its
 * server's answer. Nothing without a backend list - a failed request alone could be a file the copy lacks.
 * @returns {{ path: string, status: number }[]}
 */
export function backendFailures(dataFailed, backend) {
  if (!backend?.size) return [];
  const own = new Set([...backend].map(dataPath));
  return (dataFailed ?? []).filter((f) => f?.path && own.has(dataPath(f.path)));
}
const failedText = (fs) => fs.slice(0, 3).map((f) => `${f.path} ${f.status ? f.status : 'no answer'}`).join(', ');

/**
 * Measures the recreated pages. Never throws for one page failing: that page is left out (and listed in `failed`).
 * @param {{ origin: string, pages: { slug: string, urlPath: string, hoverBudgetMs?: number, hoverFirst?: string[] }[], deadline?: number, signal?: AbortSignal }} o
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
      // Only the throwaway server is reachable: the recreated site makes no other request, and an as-is copy's form guard
      // holds every form (the click probe may press a submit button).
      await context.addInitScript(HOLD_FORMS);
      await context.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort('blockedbyclient')));
      try {
        const page = await context.newPage();
        // The page's own data requests that failed (fetch / XHR to this server answering an error, or not at all): what its
        // script drew without the answer it asks for (motionItems: a hover only that answer draws).
        const dataFailed = new Map();
        const isData = (req) => ['fetch', 'xhr'].includes(req.resourceType()) && req.url().startsWith(`${origin}/`);
        const pathOfReq = (req) => new URL(req.url()).pathname;
        page.on('response', (res) => {
          if (res.status() >= 400 && isData(res.request())) dataFailed.set(pathOfReq(res.request()), { path: pathOfReq(res.request()), status: res.status() });
        });
        page.on('requestfailed', (req) => {
          if (isData(req) && !dataFailed.has(pathOfReq(req))) dataFailed.set(pathOfReq(req), { path: pathOfReq(req), status: 0 });
        });
        await page.goto(`${origin}/${p.urlPath}`, { waitUntil: 'load', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: NETWORK_QUIET_MS }).catch(() => {});
        // The #id targets of the original's jump links (jumpTargetsOf): does the copy's page still hold each one? Read at load,
        // before any probe changes the page.
        const jumpTargets = p.jumpTargets?.length ? await page.evaluate(targetsPresent, p.jumpTargets).catch(() => null) : null;
        const loopsMs = await loopsTimeOf(page).catch(() => LOOPS_MAX_MS);
        const allowedMs = motionTimeFor({ hoverBudgetMs: p.hoverBudgetMs ?? HOVER_BUDGET_MS, clickBudgetMs: p.clickBudgetMs ?? 0, loopsMs });
        const started = Date.now();
        let timer;
        try {
          const measured = await Promise.race([
            // No focus pass: the comparison (motionItems) reads reveals, loops and hover only; the hover probe keeps its time.
            measureMotion(page, { budgetMs: p.hoverBudgetMs ?? HOVER_BUDGET_MS, focus: false, clickBudgetMs: p.clickBudgetMs ?? 0, hoverFirst: p.hoverFirst ?? [] }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${Math.round(allowedMs / 1000)} s`)), allowedMs); }),
          ]);
          result.pages.set(p.slug, { ...measured, ...(jumpTargets && { jumpTargets }), ...(dataFailed.size && { dataFailed: [...dataFailed.values()] }), timing: { ms: Date.now() - started, allowedMs, loopsMs } });
        } finally {
          clearTimeout(timer);
        }
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

/**
 * How many of the original's loops run on the copy, paired by the element that moves: the same capture path first (an
 * exact copy keeps the original markup), then the same tag at about the same place and size, and only then by the kind of
 * motion. Pairing by kind alone counted 2 of 16 on a copy that ran all 16: the original's script motion is recorded as a
 * drift or a trace, the copy's rebuilt keyframes read back as another kind. The place allows for the motion itself (half
 * the element's size, at least 60 px): a moving element is read at another moment on each side.
 */
export function matchLoops(original, copy) {
  const center = (r) => [r[0] + r[2] / 2, r[1] + r[3] / 2];
  const samePath = (x, y) => !!x.path && x.path === y.path;
  const samePlace = (x, y) => {
    if (!x.rect || !y.rect || x.tag !== y.tag) return false;
    const [ax, ay] = center(x.rect);
    const [bx, by] = center(y.rect);
    const area = (r) => Math.max(1, r[2] * r[3]);
    const ratio = area(y.rect) / area(x.rect);
    return Math.hypot(ax - bx, ay - by) <= Math.max(60, 0.5 * Math.max(x.rect[2], x.rect[3])) && ratio > 0.5 && ratio < 2;
  };
  const sameKind = (x, y) => loopFamily(x) === loopFamily(y);
  const free = new Set(copy.map((_, j) => j));
  const done = new Set();
  let matched = 0;
  for (const same of [samePath, samePlace, sameKind]) {
    original.forEach((x, i) => {
      if (done.has(i)) return;
      for (const j of free) {
        if (!same(x, copy[j])) continue;
        free.delete(j);
        done.add(i);
        matched++;
        return;
      }
    });
  }
  return matched;
}

/**
 * The hover entries of one side without the ones that are a descendant's own hover read through a container: the mouse probe
 * hovered a box (a list item) that changes nothing of itself, and everything it saw change sits on descendants that each have
 * a hover rule of their own (a CSS-rule entry on that element covering every property seen). The probe read that descendant
 * at some moment of its transition, so the two sides differ only in when they were read; the descendant's own entry is the
 * one compared. A container that changes anything else (its own style, a pseudo-element, a neighbour, the DOM, a descendant
 * with no rule of its own) is kept.
 */
export function withoutChildHovers(hover = []) {
  const rules = new Map();
  for (const h of hover) if (h?.source === 'css' && h.path) rules.set(h.path, new Set(Object.keys(h.changes ?? {})));
  const empty = (o) => !o || !Object.keys(o).length;
  const throughChild = (h) => h?.source !== 'css' && empty(h.changes) && !(h.sibs ?? []).length && !h.domDelta
    && Object.values(h.pseudo ?? {}).every(empty) && (h.kids ?? []).length > 0
    && h.kids.every((k) => rules.has(k.path) && Object.values(k.pseudo ?? {}).every(empty)
      && Object.keys(k.changes ?? {}).every((p) => rules.get(k.path).has(p)));
  return hover.filter((h) => !throughChild(h));
}

/** What the comparison counts on one side. */
export function summarize(motion) {
  // The reveals the recreate rebuilds (ir/motion.js isScrollReveal), counted the same way on both sides.
  const reveal = (motion.reveal?.elements ?? []).filter(isScrollReveal);
  const hover = withoutChildHovers(motion.hover ?? []);
  const loops = (motion.loops?.loops ?? motion.loops ?? []).filter((l) => !l.timeline);
  return {
    reveal: { count: reveal.length, durations: reveal.map((e) => e.timing?.duration), replay: reveal.filter((e) => e.replay).length },
    // Every channel of a hover is compared, each namespaced so a property the original changed on a neighbour is not
    // counted as satisfied by the copy changing it on the hovered element itself. Without this, an effect that reaches
    // outside the hovered element could be lost and the row would still read as passing.
    hover: {
      keys: hover.map(hoverKey),
      entries: hover,
      props: new Map(hover.map((h) => [hoverKey(h), hoverProps(h)])),
    },
    // By pattern family only: a loop the original drove with script has no duration (and is named from its recorded path),
    // while its rebuilt CSS animation has one (and is named from its keyframes).
    loops: { keys: loops.map(loopFamily), count: loops.length, entries: loops },
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
/**
 * Each child the original's hover changes, with the copy's child it is: the same place under the hovered element first (its
 * path relative to the element), else, among the copy's children not yet taken that change the same properties, the one whose
 * end values agree most. Several children changing the same properties to different values (one text turns blue, another
 * white) are each held against their own counterpart, never all against the last one.
 * @returns {[any, any|null][]}
 */
export function pairKids(was, now) {
  const rel = (h, k) => {
    const p = String(k?.path ?? k?.rel ?? '');
    const base = String(h?.path ?? '');
    return base && p.startsWith(`${base}>`) ? p.slice(base.length + 1) : p || null;
  };
  const props = (k) => Object.keys(k.changes ?? {}).sort().join(',');
  const free = [...(now.kids ?? [])];
  const take = (k) => {
    free.splice(free.indexOf(k), 1);
    return k;
  };
  const kids = was.kids ?? [];
  const pairs = kids.map((k) => {
    const r = rel(was, k);
    const same = r ? free.find((n) => rel(now, n) === r && props(n) === props(k)) : null;
    return [k, same ? take(same) : null];
  });
  const agree = (a, b) => Object.entries(a.changes ?? {}).filter(([prop, [, end]]) => sameValue(end, b.changes?.[prop]?.[1])).length;
  for (const pair of pairs) {
    if (pair[1]) continue;
    const k = pair[0];
    const options = free.filter((n) => props(n) === props(k));
    if (!options.length) continue;
    pair[1] = take(options.reduce((best, n) => (agree(k, n) > agree(k, best) ? n : best)));
  }
  return pairs;
}

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
  for (const [k, twin] of pairKids(was, now)) {
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
export function clickDifferences(was, now, closesRead = true) {
  if (!now) {
    // On the original this click only took something away (the open answer of a FAQ closing): say that, not just "nothing".
    const closesOnly = (was.change?.hidden?.length ?? 0) > 0 && !(was.change?.shown?.length || was.change?.added?.length);
    return [closesOnly ? 'clicking it does not close what it closes on the original' : 'does nothing in the copy'];
  }
  const out = [];
  // What the click opened going away again (closesOwn, capture/clicks.js restore); a capture made before it was read has `closes` only.
  // `closesRead` false: the two readings cannot be compared (detailsRead), so no verdict on closing.
  const wasCloses = was.closesOwn ?? was.closes;
  const nowCloses = now.closesOwn ?? now.closes;
  if (closesRead && wasCloses && wasCloses !== nowCloses) {
    out.push(`${CLOSES[wasCloses] ?? wasCloses} does not close it again (it does on the original)`);
  }
  if (was.exclusive === true && now.exclusive === false) out.push('several items stay open (the original keeps one open at a time)');
  if (was.exclusive === false && now.exclusive === true) out.push('opening one closes the others (the original keeps them open)');
  return out;
}

/**
 * A link to a place on the same page (the probe's `anchor` reason) whose click showed, hid, added and rewrote nothing: it
 * scrolled, and what changed (another link marked current by the page's scroll-spy, a section revealing itself) is the page
 * reacting to where it now stands. Which link loses the mark depends on where the probe left the page, so its exact change is
 * no evidence either way; one entry per name is enough.
 */
export const scrollOnlyClick = (w) => w?.tag === 'a' && (w.reasons ?? []).includes('anchor')
  && !(w.change?.shown?.length || w.change?.hidden?.length || w.change?.added?.length || w.change?.text?.length);

/**
 * Pairs every control of the original with the copy's control of the same name that behaves most alike.
 * A jump link (`jump`: `#id` of an element on the page, capture/clicks.js or markJumps) is no click interaction: what its
 * click changed is what the scroll brought into view. It is left out on both sides (`leftOut: 'jump'`) - as long as the copy's
 * page still holds its target (`targetsNow`, id → present, measureNewMotion). A target the copy lost is a real "does nothing";
 * a target nobody checked (an older measurement) is not counted (`unchecked`).
 */
export function compareClicks(oldWidgets = [], newWidgets = [], probedNames = null, targetsNow = null, probedPaths = null) {
  // A control the copy's probe never reached (its time ran out, or it probed other equal controls instead) is not checked:
  // that is no evidence the copy's control does nothing. How many controls of each name the copy's probe clicked: that many of
  // the original's controls of the name can be judged, and no more - one "Learn more" probed is not every "Learn more" probed.
  const left = probedNames ? new Map() : null;
  for (const t of probedNames ?? []) left.set(clickKey({ text: t }), (left.get(clickKey({ text: t })) ?? 0) + 1);
  const spend = (was) => {
    if (left?.has(clickKey(was))) left.set(clickKey(was), left.get(clickKey(was)) - 1);
  };
  const canJudge = (was) => !left || (left.get(clickKey(was)) ?? 0) > 0;
  // Where the copy's probe clicked (an as-is copy keeps the original's markup, so a control is at the same path on both sides).
  const clickedAt = probedPaths ? new Set(probedPaths) : null;
  const pool = newWidgets.filter((w) => !w.jump);
  const take = (w) => pool.splice(pool.indexOf(w), 1)[0];
  const best = (was, list) => list.reduce((b, w) => (b == null || clickDifferences(was, w, detailsRead(was, w)).length < clickDifferences(was, b, detailsRead(was, b)).length ? w : b), null);
  // One control the original's probe recorded twice (once after a reload, once in a group) is one control: its readings are
  // held against the copy together, and the one that matches best counts, once.
  const byTrigger = new Map();
  const oldList = [];
  for (const w of oldWidgets) {
    if (w.trigger && !w.jump && byTrigger.has(w.trigger)) {
      byTrigger.get(w.trigger).push(w);
      continue;
    }
    const readings = [w];
    if (w.trigger && !w.jump) byTrigger.set(w.trigger, readings);
    oldList.push(readings);
  }
  const rows = [];
  const judge = (readings, now) => {
    const was = now ? readings.reduce((b, w) => (clickDifferences(w, now, detailsRead(w, now)).length < clickDifferences(b, now, detailsRead(b, now)).length ? w : b)) : readings[0];
    spend(was);
    const row = { was, now, diff: clickDifferences(was, now, detailsRead(was, now)) };
    // A FAQ answer's second click read before the probe knew how the answer started: not a verdict (detailsRead).
    if (now && !detailsRead(was, now) && was.tag === 'summary' && (was.closesOwn ?? was.closes) !== (now.closesOwn ?? now.closes)) row.detailsUnread = true;
    return row;
  };
  const rowOf = new Map();
  // 1. The same control (the same path) on both sides, wherever the probes went in between.
  for (const readings of oldList) {
    const was = readings[0];
    if (was.jump || scrollOnlyClick(was) || !was.trigger) continue;
    const there = pool.filter((w) => w.trigger === was.trigger);
    if (there.length) rowOf.set(readings, judge(readings, take(best(was, there))));
    else if (clickedAt?.has(was.trigger)) rowOf.set(readings, judge(readings, null));
  }
  const scrollSeen = new Set();
  const jumpSeen = new Set();
  for (const readings of oldList) {
    if (rowOf.has(readings)) {
      rows.push(rowOf.get(readings));
      continue;
    }
    const was = readings[0];
    if (was.jump) {
      const id = jumpId(was.href);
      const key = `${clickKey(was)}|${id}`;
      if (jumpSeen.has(key)) continue;
      jumpSeen.add(key);
      const present = targetsNow?.[id];
      if (present === false) rows.push({ was, now: null, diff: [`does nothing in the copy (its target #${id} is not on the copy's page)`] });
      else if (present === true) rows.push({ was, now: null, diff: [], leftOut: 'jump' });
      else rows.push({ was, now: null, diff: [], unchecked: true });
      continue;
    }
    // 2. Then by name, among the copy's controls not paired by path.
    const twins = pool.filter((w) => clickKey(w) === clickKey(was));
    // An in-page link that only scrolled: counted once per name, kept when the copy's link of that name did anything
    // when clicked (its own mark depends on the scroll position too), "does nothing" only when the copy has none at all.
    if (scrollOnlyClick(was)) {
      if (scrollSeen.has(clickKey(was))) continue;
      scrollSeen.add(clickKey(was));
      if (twins.length) {
        spend(was);
        rows.push({ was, now: take(twins[0]), diff: [] });
        continue;
      }
    }
    if (twins.length) {
      rows.push(judge(readings, take(best(was, twins))));
      continue;
    }
    // 3. No partner: "does nothing" only while the copy's probe clicked as many controls of this name as are judged.
    if (!canJudge(was)) {
      rows.push({ was, now: null, diff: [], unchecked: true });
      continue;
    }
    rows.push(judge(readings, null));
  }
  return rows;
}

/**
 * Whether a FAQ answer's second click can be compared: both readings know how the `<details>` started (`detailsFrom`,
 * capture/clicks.js). Without it the reading depends on whether the answer was open when the probe reached it (the probe's own
 * earlier clicks, the page's one-at-a-time rule): identical files read "closes" once and "does not close" the next time.
 * Not a `<details>` control = true (compared as always).
 */
export function detailsRead(was, now) {
  if (was?.tag !== 'summary') return true;
  return was.detailsFrom != null && now?.detailsFrom != null;
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
export function motionItems(oldPages, newPages, { lifted = null, backend = null } = {}) {
  const both = [...oldPages.keys()].filter((slug) => newPages.has(slug));
  const o = { reveal: 0, replay: 0, hover: [], loops: [], durations: [], hoverProps: new Map() };
  const n = { reveal: 0, replay: 0, hover: [], loops: [], durations: [] };
  let loopsMatched = 0;
  const matchedHover = { count: 0, agree: 0, same: 0, differences: [] };
  // Hovers the copy misses that only the site's server makes the page draw: not counted, each with its proof (below).
  const serverDrawn = [];
  const saved = { pages: 0, liveReveal: 0, savedReveal: 0, liveLoops: 0, savedLoops: 0 };
  for (const slug of both) {
    const so = summarize(oldPages.get(slug));
    const sn = summarize(newPages.get(slug));
    // Measured on the original's saved files (useLiftedBefore): what the live capture counted on that page, for the note.
    const live = oldPages.get(slug)?.live;
    if (live) {
      const sl = summarize({ reveal: live.reveal, loops: live.loops });
      saved.pages++;
      saved.liveReveal += sl.reveal.count;
      saved.savedReveal += so.reveal.count;
      saved.liveLoops += sl.loops.count;
      saved.savedLoops += so.loops.count;
    }
    o.reveal += so.reveal.count;
    n.reveal += sn.reveal.count;
    o.replay += so.reveal.replay;
    n.replay += sn.reveal.replay;
    o.durations.push(...so.reveal.durations);
    n.durations.push(...sn.reveal.durations);
    // Each original hover held against the copy's hover on the same element (pairHovers: by name, several with one name =
    // the copy's closest - the copy is probed in its own order -, then by path when the page's script labels it otherwise).
    const { pairs, missing } = pairHovers(so.hover.entries, sn.hover.entries);
    // A hover the copy misses is not counted against it only with both proofs: the original's own files, served the same way
    // without its server and measured with the copy's probe (lifted), do not draw it either, AND a data request of the page to
    // the site's own backend failed in the copy (the answer the page's script draws it from). Without either, it stays missing.
    const failed = backendFailures(newPages.get(slug)?.dataFailed, backend);
    const liftedHover = lifted?.get(slug) ? summarize(lifted.get(slug)).hover.entries : null;
    const alsoMissing = failed.length && liftedHover && missing.length ? new Set(pairHovers(missing, liftedHover).missing) : new Set();
    for (const h of missing) if (alsoMissing.has(h)) serverDrawn.push({ page: slug, element: `${h.tag ?? ''} "${String(h.text ?? '').slice(0, 30)}"`, path: h.path, failed: failed.slice(0, 3) });
    const counted = so.hover.entries.filter((h) => !alsoMissing.has(h));
    o.hover.push(...counted.map(hoverKey));
    n.hover.push(...sn.hover.keys);
    o.hoverMatched = (o.hoverMatched ?? 0) + pairs.length;
    for (const [before, after] of pairs) {
      matchedHover.count++;
      const diff = hoverDifferences(before, after);
      if (!diff.length) matchedHover.same++;
      else if (matchedHover.differences.length < 12) {
        matchedHover.differences.push({ page: slug, element: `${before.tag ?? ''} "${String(before.text ?? '').slice(0, 30)}"`, diff: diff.slice(0, 3) });
      }
      // Matched hover elements whose changed properties agree (at least half of the original's).
      const was = new Set(hoverProps(before));
      const now = new Set(hoverProps(after));
      const same = [...was].filter((p) => now.has(p)).length;
      if (!was.size || same / was.size >= 0.5) matchedHover.agree++;
    }
    o.loops.push(...so.loops.keys);
    loopsMatched += matchLoops(so.loops.entries, sn.loops.entries);
    n.loops.push(...sn.loops.keys);
  }
  const items = [];
  const summary = { pages: both.length, reveal: { before: o.reveal, after: n.reveal }, hover: { before: o.hover.length, after: n.hover.length, matched: matchedHover.count, sameEnd: matchedHover.same }, loops: { before: o.loops.length, after: n.loops.length } };

  // The "before" measured on the original's saved files (an as-is copy, useLiftedBefore) showing fewer than the live capture:
  // both numbers stay in the row, so a part lost when the site was captured or lifted is never hidden by the fairer count.
  const liveVsSaved = (live, kept, what) => (saved.pages && live > kept
    ? `The original was measured from its saved files with the copy's own probe: live capture ${live}, original's saved files ${kept} ${what}.`
    : null);
  const notes = (...xs) => xs.filter(Boolean).join(' ') || null;
  const revealLive = liveVsSaved(saved.liveReveal, saved.savedReveal, 'reveals');
  if (o.reveal || revealLive) {
    const ratio = o.reveal ? Math.min(1, n.reveal / o.reveal) : 1;
    const dOld = median(o.durations);
    const dNew = median(n.durations);
    const timing = dOld != null && dNew != null ? ` Typical duration ${Math.round(dNew)} ms (original ${Math.round(dOld)} ms).` : '';
    items.push({
      ...row('motion.reveal', 'Scroll-reveal animations kept', ratio,
        { detail: `${plural(o.reveal, 'element')} fade or slide in as they scroll into view${o.replay ? `; ${o.replay} repeat when they leave` : ''}.`, count: o.reveal },
        { detail: `${n.reveal} found on the recreated site.${timing}`, count: n.reveal },
        notes(ratio < 0.9 ? 'Some reveals could not be rebuilt (effects that run at page load or by script are not reproduced).' : null, revealLive)),
      ...(saved.pages && { live: { before: saved.liveReveal, saved: saved.savedReveal } }),
    });
  }
  if (o.hover.length || serverDrawn.length) {
    const matched = Math.min(o.hoverMatched ?? 0, o.hover.length);
    const ratio = o.hover.length ? matched / o.hover.length : 1;
    const drawn = serverDrawn.length;
    const allFailed = [...new Map(serverDrawn.flatMap((d) => d.failed).map((f) => [f.path, f])).values()];
    const drawnNote = drawn
      ? `${plural(drawn, 'hover effect')} (${serverDrawn.slice(0, 3).map((d) => d.element).join(', ')}) ${drawn === 1 ? 'is' : 'are'} on ${drawn === 1 ? 'an element' : 'elements'} the page's own script draws only from its server's answer, and that request failed in the copy (${failedText(allFailed)}); the original's own files, served the same way without that server, do not draw ${drawn === 1 ? 'it' : 'them'} either: not counted.`
      : null;
    items.push({
      ...row('motion.hover', 'Hover effects kept', ratio,
        { detail: o.hover.length ? `${plural(o.hover.length, 'element')} change on hover (colour, shadow, movement, …).` : 'No hover effect left to compare.', count: o.hover.length },
        { detail: `${matched} of them react on the recreated site${matched ? ` (${matchedHover.agree} with the same changes)` : ''}.`, count: matched },
        notes(ratio < 0.9 ? 'Hover effects driven by script (they add or remove elements) are not reproduced.' : null, drawnNote)),
      ...(drawn && { serverDrawn: serverDrawn.slice(0, 12) }),
    });
  }
  // Clicks: every control the original's click probe found is clicked on the copy the same way, and the two compared.
  const clicks = { total: 0, same: 0, differences: [], unchecked: 0, detailsUnread: 0, jumps: 0, notChecked: [] };
  const named = (r) => `${r.was.tag ?? ''} "${String(r.was.text ?? '').slice(0, 30)}"`;
  for (const slug of both) {
    const was = oldPages.get(slug)?.clicks?.widgets ?? [];
    const nowClicks = newPages.get(slug)?.clicks;
    const now = nowClicks?.widgets;
    if (!was.length || !now) continue; // not measured on the copy: no verdict either way
    for (const r of compareClicks(was, now, nowClicks?.probedNames ?? null, newPages.get(slug)?.jumpTargets ?? null, nowClicks?.probedPaths ?? null)) {
      if (r.leftOut === 'jump') {
        clicks.jumps++;
        continue;
      }
      // Not checked: no verdict, but never hidden - counted and named in the row.
      if (r.unchecked || r.detailsUnread) {
        if (r.unchecked) clicks.unchecked++;
        else clicks.detailsUnread++;
        if (clicks.notChecked.length < 12) clicks.notChecked.push({ page: slug, element: named(r), why: r.unchecked ? 'not reached' : 'second click not comparable' });
        continue;
      }
      clicks.total++;
      if (!r.diff.length) clicks.same++;
      else if (clicks.differences.length < 12) clicks.differences.push({ page: slug, element: named(r), kind: r.was.kind, diff: r.diff });
    }
  }
  if (clicks.total || clicks.unchecked || clicks.detailsUnread) {
    // Nothing checked at all is no pass: the row stays open, saying why.
    const ratio = clicks.total ? clicks.same / clicks.total : 0.5;
    const shown = clicks.differences.slice(0, 3).map((d) => `${d.element}: ${d.diff[0]}`).join('; ');
    const unread = [
      clicks.unchecked ? `${clicks.unchecked} not checked (the probe ran out of time)` : null,
      clicks.detailsUnread ? `${clicks.detailsUnread} FAQ ${clicks.detailsUnread === 1 ? 'answer' : 'answers'} open in the copy but ${clicks.detailsUnread === 1 ? 'its' : 'their'} second click not checked (the reading depends on whether the answer was open when the probe reached it)` : null,
    ].filter(Boolean).join('; ');
    items.push({
      ...row('motion.clicks', 'Click interactions kept', ratio,
        { detail: `${plural(clicks.total + clicks.unchecked + clicks.detailsUnread, 'control')} open, switch or move something when clicked (menus, FAQ answers, tabs, dialogs, …).`, count: clicks.total + clicks.unchecked + clicks.detailsUnread },
        { detail: `${clicks.total ? `${clicks.same} of the ${clicks.total} checked do the same on the recreated site, and close again the same way.` : 'None could be checked on the recreated site.'}${shown ? ` Differs: ${shown}.` : ''}${unread ? ` ${unread[0].toUpperCase()}${unread.slice(1)}.` : ''}`, count: clicks.same },
        [unread ? `${unread[0].toUpperCase()}${unread.slice(1)}: not counted either way.` : null,
          clicks.jumps ? `${plural(clicks.jumps, 'link')} that only jump to a place on the same page left out (the place is on the copy's page too).` : null]
          .filter(Boolean).join(' ') || null),
      differences: clicks.differences,
      ...(clicks.notChecked.length && { notChecked: clicks.notChecked, unchecked: clicks.unchecked + clicks.detailsUnread }),
      ...(clicks.jumps && { jumps: clicks.jumps }),
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
  // An element that moves by an animation of its own (movesByItself) is no follower, on either side: the probe read its loop
  // moving in step with the mouse by chance. Left out and said so.
  const followers = { before: 0, kept: 0, differences: [], ownAnimation: [] };
  for (const slug of both) {
    const ownOld = movesByItself(oldPages.get(slug));
    const ownNew = movesByItself(newPages.get(slug));
    const was = (oldPages.get(slug)?.pointer?.followers ?? []).filter((f) => {
      if (!isSelfMoving(f.path, ownOld)) return true;
      followers.ownAnimation.push({ page: slug, element: f.path });
      return false;
    });
    const now = (newPages.get(slug)?.pointer?.followers ?? []).filter((g) => !isSelfMoving(g.path, ownNew));
    followers.before += was.length;
    for (const f of was) {
      const close = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(a) * 0.25);
      const i = now.findIndex((g) => close(f.kx, g.kx) && close(f.ky, g.ky));
      if (i < 0) {
        const axis = Math.abs(f.ky) > Math.abs(f.kx) ? `${f.ky} × the mouse's vertical move` : `${f.kx} × the mouse's horizontal move`;
        followers.differences.push({ page: slug, element: f.path, diff: [`does not follow the mouse in the copy (the original moves ${axis})`] });
        continue;
      }
      const g = now.splice(i, 1)[0];
      if (Math.abs(f.tauMs - g.tauMs) > Math.max(60, f.tauMs * 0.4)) followers.differences.push({ page: slug, element: f.path, diff: [`catches up in about ${g.tauMs} ms (original ${f.tauMs} ms)`] });
      else followers.kept++;
    }
  }
  if (followers.before || followers.ownAnimation.length) {
    const own = followers.ownAnimation.length;
    const ownNote = own ? `${plural(own, 'element')} the probe saw move with the mouse ${own === 1 ? 'moves' : 'move'} by ${own === 1 ? 'its' : 'their'} own animation, not with the mouse: not counted.` : null;
    items.push({
      ...row('motion.pointer', 'Effects that follow the mouse kept', followers.before ? followers.kept / followers.before : 1,
        { detail: followers.before ? `${plural(followers.before, 'element')} follow the mouse (a custom cursor, mouse parallax).` : 'No element follows the mouse.', count: followers.before },
        { detail: followers.before ? `${followers.kept} of them follow it the same way on the recreated site.` : 'Nothing to follow it on the recreated site either.', count: followers.kept },
        ownNote),
      differences: followers.differences.slice(0, 12),
      ...(own && { ownAnimation: followers.ownAnimation.slice(0, 12) }),
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
  const loopsLive = liveVsSaved(saved.liveLoops, saved.savedLoops, 'loops');
  if (o.loops.length || loopsLive) {
    const matched = Math.min(loopsMatched, o.loops.length);
    const ratio = o.loops.length ? matched / o.loops.length : 1;
    items.push({
      ...row('motion.loops', 'Looping animations kept', ratio,
        { detail: `${plural(o.loops.length, 'animation')} run continuously (spinners, tickers, pulses, …).`, count: o.loops.length },
        { detail: `${matched} of them run on the recreated site.`, count: matched },
        notes(ratio < 0.9 ? 'Marquees driven by script, scroll-linked animations and some pseudo-element loops are not rebuilt.' : null, loopsLive)),
      ...(saved.pages && { live: { before: saved.liveLoops, saved: saved.savedLoops } }),
    });
  }
  return { items, summary };
}
