// @ts-check
// The visibility guard (CLONER_SPEC Phase 4 item 4) and the animation count comparison (Phase 4 item 3).
//
// Nothing the original shows may stay invisible in the copy. The capture recorded, in the settled original page, which
// elements with text or a picture are visible (capture/visibility.js `visibility.json`); here every page of the copy is
// rendered with its scripts running at the desktop and phone views (verify/copyRender.js, shared with the hit-test guard),
// scrolled through like the capture's recipe (an element seen visible at any step counts as shown: a reveal plays when its
// element comes into view), back at the top, running one-shot animations waited for. Every element the original showed
// and the copy holds at opacity 0, visibility hidden, zero size or transformed off the page is a failure. It is fixed with
// the safe fallback - the hidden property of the element that causes it is let go (`data-sas-show`, emit/visibilityCss.js)
// and a reveal / entrance that held it hidden is taken off it - and the copy is measured again.
//   - left alone: elements the original also had hidden (a closed accordion's answer, a menu, another slide), elements the
//     copy hides with `display: none` (another state, a parked layout, another width's version: reported, never forced
//     on), and parts of a click widget the copy has closed (its own open / close rules decide them);
//   - paired with the original by capture path (sid → cpath, generate.js cpathsOf) and the same text (or the same kind of
//     picture), so a path that means another element in another layout is never "fixed".
// The animation comparison reads document.getAnimations() and the CSSOM on the copy the same way (desktop) and lists
// the differences per page; it reports, it does not fail.
import { readVisibility, summarizeAnimations, MAX_ANIMATIONS } from '../capture/visibility.js';
import { scanAnimations } from '../capture/loops.js';
import { scrollThrough, scrollToY } from '../capture/index.js';
import { SHOW_ATTR } from '../emit/visibilityCss.js';
import { nodeBySid, openCopyRenderer, withMotion } from './copyRender.js';

/** Elements the copy reads per page and view (more than the original: state copies, extras). */
export const MAX_COPY_ELEMENTS = 8000;
/** How long an element stays in view at each scroll step (js/motion.js's observer, a reveal's start). */
const STEP_DWELL_MS = 150;
/** One-shot animations still running at the top are waited for up to this long; one that ends later is stuck. */
const FINISH_WAIT_MS = 3000;
/** Reveal / entrance tokens taken off an element they held invisible (ir/motion.js: rv, rl, rp, rN, dN). */
const REVEAL_TOKEN = /^(rv|rl|rp|r\d+|d\d+)$/;

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
const MEDIA = new Set(['img', 'svg', 'video', 'canvas']);

/**
 * Pairs the copy's reading with the original's: the elements the original showed that the copy does not.
 * @param {object[]} original  visibility.json of one page and view
 * @param {object[]} copy      the copy's reading, each entry with `cpath` (the capture path its element came from)
 * @returns {{ checked: number, unpaired: number, invisible: object[] }}
 */
export function compareVisibility(original, copy) {
  const byPath = new Map();
  for (const c of copy ?? []) if (c.cpath) (byPath.get(c.cpath) ?? byPath.set(c.cpath, []).get(c.cpath)).push(c);
  const invisible = [];
  let checked = 0;
  let unpaired = 0;
  for (const o of original ?? []) {
    if (!o.visible || !o.path) continue;
    // The same element: the same text, or the same kind of picture (a tag may change: a → span, div → nav).
    const same = (byPath.get(o.path) ?? []).filter((c) => (o.text ? norm(c.text) === norm(o.text) : MEDIA.has(c.tag) && MEDIA.has(o.tag)));
    if (!same.length) {
      unpaired++;
      continue;
    }
    checked++;
    if (same.some((c) => c.visible)) continue;
    const c = same[0];
    invisible.push({ path: o.path, tag: o.tag, text: o.text ?? null, sid: c.sid, reason: c.reason ?? 'unknown', by: c.by ?? null });
  }
  return { checked, unpaired, invisible };
}

/**
 * Why the copy hides it, and whether the safe fallback may show it.
 * @param {{ reason: string, by?: { prop?: string, motion?: string|null, isIn?: boolean, attrs?: string[] }|null }} entry
 * @returns {{ cause: string, fix: boolean, strip?: boolean, token?: string }}
 */
export function causeOf(entry) {
  const by = entry.by ?? {};
  const tokens = String(by.motion ?? '').split(/\s+/).filter(Boolean);
  const attrs = by.attrs ?? [];
  if (entry.reason === 'display') {
    if (attrs.includes('data-w-lay')) return { cause: 'layout parked', fix: false };
    if (attrs.includes('hidden') || attrs.some((a) => /^data-w-(set|i|tpl|hcopy|hrest|panel|note)/.test(a))) return { cause: 'state template not shown', fix: false };
    if (attrs.includes('data-sas-v')) return { cause: 'version of another width shown', fix: false };
    if (by.prop === 'details') return { cause: 'closed <details>', fix: false };
    return { cause: 'hidden by display: none', fix: false };
  }
  // A part of a click widget (wN area, wNpK part, a state switch): open / closed is its own rules' business.
  if (attrs.some((a) => /^data-w-/.test(a)) || tokens.some((t) => /^w(\d+(p\d+)?|t|h)$/.test(t))) return { cause: 'panel closed in the copy', fix: false };
  if (entry.reason === 'offscreen') return { cause: 'placed off the page', fix: false };
  // Moving by design: a rebuilt loop (lN: a ticker, a float), a scroll-scrubbed effect, an element a library's replay or a
  // Framer appear entrance animates (data-sas-a), one that follows the pointer, a self-changing part, an autoplay. What
  // it hides, it hides for a moment of its own movement (a ticker's logo slid off to the side); letting the property go
  // with !important would stop the movement itself - a frozen ticker (found on a real Framer site). Reported, never forced.
  const moving = tokens.some((t) => /^l\d+$/.test(t))
    || attrs.some((a) => ['data-sas-a', 'data-w-scrub', 'data-w-follow', 'data-w-feed', 'data-w-auto', 'data-w-video'].includes(a));
  if (moving) return { cause: 'moving by design (a loop, a replay or a scrubbed effect)', fix: false };
  const token = { opacity: 'opacity', visibility: 'visibility', transform: 'transform', size: by.prop, clipped: by.prop }[entry.reason];
  if (!token || !['opacity', 'visibility', 'transform', 'height', 'width'].includes(token)) return { cause: 'hidden', fix: false };
  if (tokens.includes('rv') && !by.isIn) return { cause: 'reveal never triggered', fix: true, strip: true, token };
  if (tokens.includes('rl') || tokens.includes('rv')) return { cause: 'entrance did not finish', fix: true, strip: true, token };
  if (attrs.includes('data-framer-appear-id')) return { cause: 'appear config missing', fix: true, token };
  return { cause: entry.reason === 'clipped' ? 'collapsed parent' : entry.reason === 'size' ? 'zero size' : `hidden style (${entry.reason})`, fix: true, token };
}

/** The media conditions of `phone:` / `wide:` tokens, from the copy's breakpoints (none for a one-view copy). */
export function showMedia(breakpoints) {
  const bp = breakpoints ?? {};
  const wideFrom = bp.laptop ?? bp.tablet;
  return {
    phone: Number.isFinite(bp.mobile) ? `(max-width: ${bp.mobile}px)` : null,
    wide: Number.isFinite(wideFrom) ? `(min-width: ${Math.ceil(wideFrom)}px)` : null,
  };
}

/** Lets go of a hidden property on an IR node (attribute, or the root tag of an inline SVG's markup). */
function addShow(node, tokens) {
  const read = node.t === 'svg' && typeof node.raw === 'string'
    ? node.raw.match(/^\s*<svg\b[^>]*?\sdata-sas-show="([^"]*)"/i)?.[1] ?? ''
    : String(node.attrs?.[SHOW_ATTR] ?? '');
  const merged = [...new Set([...read.split(/\s+/).filter(Boolean), ...tokens])].join(' ');
  if (node.t === 'svg' && typeof node.raw === 'string') {
    node.raw = read
      ? node.raw.replace(/(^\s*<svg\b[^>]*?\sdata-sas-show=")[^"]*"/i, `$1${merged}"`)
      : node.raw.replace(/^(\s*<svg\b)/i, `$1 ${SHOW_ATTR}="${merged}"`);
  } else node.attrs = { ...(node.attrs ?? {}), [SHOW_ATTR]: merged };
}
function stripReveal(node) {
  const value = node.attrs?.['data-motion'];
  if (typeof value !== 'string') return [];
  const all = value.split(/\s+/).filter(Boolean);
  const kept = all.filter((t) => !REVEAL_TOKEN.test(t));
  if (kept.length === all.length) return [];
  if (kept.length) node.attrs['data-motion'] = kept.join(' ');
  else delete node.attrs['data-motion'];
  return all.filter((t) => REVEAL_TOKEN.test(t));
}

/** Page function: the longest wait (ms) for the one-shot animations still running to end, ignoring ones far off. */
function oneShotsLeft(limit) {
  let left = 0;
  for (const a of document.getAnimations()) {
    const t = a.effect?.getComputedTiming?.();
    if (!t || !Number.isFinite(t.iterations) || a.playState !== 'running') continue;
    const end = Number(t.endTime) - Number(t.localTime ?? 0);
    if (end > 0 && end <= limit) left = Math.max(left, end);
  }
  return left;
}

/**
 * Settles the copy like the capture settled the original, then reads it: visibility (with what was seen during the
 * scroll) and, when asked, the animations.
 * @param {import('playwright').Page} tab
 * @param {{ width: number, height: number }} view
 * @param {{ animations?: boolean }} o
 */
export async function readSettledCopy(tab, view, { animations = false } = {}) {
  await tab.evaluate(readVisibility, { max: MAX_COPY_ELEMENTS, record: true });
  await tab.mouse.move(Math.min(20, view.width / 4), Math.round(view.height / 2)).catch(() => {});
  await scrollThrough(tab, {
    step: Math.max(400, Math.floor(view.height * 0.85)),
    viewportHeight: view.height,
    onStep: async () => {
      await tab.waitForTimeout(STEP_DWELL_MS);
      await tab.evaluate(readVisibility, { max: MAX_COPY_ELEMENTS, record: true });
    },
  });
  if ((await scrollToY(tab, 0)) > 1) await tab.evaluate(() => window.scrollTo(0, 0));
  await tab.waitForTimeout(300);
  const anims = animations ? summarizeAnimations(await tab.evaluate(scanAnimations, { all: true, max: MAX_ANIMATIONS })) : null;
  for (let i = 0; i < 2; i++) {
    const left = await tab.evaluate(oneShotsLeft, FINISH_WAIT_MS);
    if (!(left > 0)) break;
    await tab.waitForTimeout(Math.min(FINISH_WAIT_MS, left + 50));
  }
  const visibility = await tab.evaluate(readVisibility, { max: MAX_COPY_ELEMENTS });
  return { visibility, animations: anims };
}

/**
 * One page's animations, original against copy: counts per type, CSS animation and @keyframes names, :hover / :focus
 * rule counts. Names of rebuilt animations differ by design in a rebuilt copy (`m-…`), so a name only one side has is
 * listed, not judged.
 */
export function compareAnimations(original, copy) {
  const minus = (a, b) => (a ?? []).filter((x) => !(b ?? []).includes(x));
  const types = [...new Set([...Object.keys(original.byType ?? {}), ...Object.keys(copy.byType ?? {})])];
  const counts = Object.fromEntries(types.map((t) => [t, { original: original.byType?.[t] ?? 0, copy: copy.byType?.[t] ?? 0 }]));
  const differs = Object.values(counts).some((c) => c.original !== c.copy);
  const out = {
    counts,
    names: { missing: minus(original.names, copy.names), extra: minus(copy.names, original.names) },
    keyframes: { missing: minus(original.keyframes, copy.keyframes), extra: minus(copy.keyframes, original.keyframes) },
    hover: { original: original.hover ?? 0, copy: copy.hover ?? 0 },
    focus: { original: original.focus ?? 0, copy: copy.focus ?? 0 },
    ...(original.unreadableSheets && { unreadableSheets: original.unreadableSheets }),
  };
  out.same = !differs && !out.names.missing.length && !out.names.extra.length;
  return out;
}

export const ANIMATIONS_NOTE = 'document.getAnimations() lists CSS animations, CSS transitions and Web Animations: CSS animation and @keyframes '
  + 'names are compared by name (a rebuilt copy renames what it rebuilds, m-…), transitions and Web Animations (what GSAP / '
  + 'Framer Motion run as WAAPI) by count. Motion a script writes as inline styles every frame is not an animation object '
  + 'and is checked by the motion rows of the re-audit instead. A transition only shows while it runs.';

/**
 * The guard. Changes the IR in place (`data-sas-show`, reveal tokens taken off, `ir.motion.show`).
 * @param {{ ir: any, siteDir: string, records: Map<string, Record<string, object[]>>, animations?: Map<string, object>,
 *   cpaths: Record<string, { cpaths: Record<string, string> }>, views: import('./copyRender.js').View[],
 *   launchBrowser: () => Promise<any>, deadline?: number, renderer?: import('./copyRender.js').CopyRenderer }} o
 *   records: page outPath → view id → visibility.json; animations: page outPath → animations.json (desktop)
 */
export async function visibilityGuard({ ir, siteDir, records, animations = new Map(), cpaths, views, launchBrowser, deadline = Infinity, renderer = undefined }) {
  const report = { pages: 0, renders: 0, checked: 0, unpaired: 0, invisible: 0, fixed: [], unresolved: [], afterFix: 0, errors: [] };
  const anim = { pages: [], note: ANIMATIONS_NOTE };
  const pages = ir.pages.filter((p) => records.get(p.outPath));
  report.pages = pages.length;
  if (!pages.length) return { visibility: report, animations: anim };
  const own = renderer ? null : await openCopyRenderer({ siteDir, launchBrowser });
  const render = /** @type {import('./copyRender.js').CopyRenderer} */ (renderer ?? own);
  const measure = (list, { withAnimations }) => render.each({
    ir, pages: list, views, deadline,
    want: (page, view) => records.get(page.outPath)?.[view.id] ?? null,
    visit: async (tab, page, view, original) => {
      const sidPath = cpaths[page.outPath]?.cpaths ?? {};
      const read = await readSettledCopy(tab, view, { animations: withAnimations && view.id === 'desktop' && animations.has(page.outPath) });
      const copy = read.visibility.map((c) => ({ ...c, cpath: c.sid ? sidPath[c.sid] ?? null : null }));
      return { ...compareVisibility(original, copy), copyAnimations: read.animations };
    },
  });
  try {
    const first = await measure(pages, { withAnimations: true });
    // Per page and culprit: the views it hides an element in, the tokens to let go of, the entries it explains.
    const plans = new Map();
    for (const r of first) {
      if (r.error) {
        report.errors.push({ page: r.page.path, view: r.view, error: r.error });
        continue;
      }
      report.renders++;
      report.checked += r.checked;
      report.unpaired += r.unpaired;
      report.invisible += r.invisible.length;
      if (r.copyAnimations) anim.pages.push({ page: r.page.path, ...compareAnimations(animations.get(r.page.outPath), r.copyAnimations) });
      for (const e of r.invisible) {
        const why = causeOf(e);
        const where = { page: r.page.path, view: r.view, element: e.path, tag: e.tag, text: e.text, reason: e.reason, cause: why.cause, culprit: e.by?.path ?? null };
        const node = why.fix && e.by?.sid ? nodeBySid(r.page.body, e.by.sid) : null;
        if (!why.fix || !node) {
          report.unresolved.push({ ...where, ...(why.fix && { cause: `${why.cause} (the element hiding it is not in the copy's own markup)` }) });
          continue;
        }
        const key = `${r.page.outPath}|${e.by.sid}`;
        const plan = plans.get(key) ?? plans.set(key, { page: r.page, node, tokens: new Map(), strip: false, entries: [] }).get(key);
        (plan.tokens.get(why.token) ?? plan.tokens.set(why.token, new Set()).get(why.token)).add(r.view);
        plan.strip ||= Boolean(why.strip);
        plan.entries.push(where);
      }
    }
    if (plans.size) {
      const media = showMedia(ir.breakpoints);
      const checkedViews = new Set(views.map((v) => v.id));
      for (const plan of plans.values()) {
        // Hidden in every view the guard checks (or no layouts to tell apart): let go everywhere; else in that layout only.
        const tokens = [...plan.tokens].map(([token, inViews]) => {
          if ([...checkedViews].every((v) => inViews.has(v)) || !media.phone || !media.wide) return token;
          return inViews.has('mobile') ? `phone:${token}` : `wide:${token}`;
        });
        addShow(plan.node, tokens);
        const stripped = plan.strip ? stripReveal(plan.node) : [];
        for (const e of plan.entries) report.fixed.push({ ...e, applied: tokens, ...(stripped.length && { removedMotion: stripped }) });
      }
      withMotion(ir, { show: media.phone || media.wide ? media : true });
      // Measured again with the fallback in: what is still invisible is reported as such.
      const again = await measure([...new Set([...plans.values()].map((p) => p.page))], { withAnimations: false });
      const fixedKeys = new Set(report.fixed.map((f) => `${f.page}|${f.view}|${f.element}`));
      for (const r of again) {
        if (r.error) continue;
        for (const e of r.invisible) {
          if (!fixedKeys.has(`${r.page.path}|${r.view}|${e.path}`)) continue;
          report.afterFix++;
          report.unresolved.push({ page: r.page.path, view: r.view, element: e.path, tag: e.tag, text: e.text, reason: e.reason, cause: `${causeOf(e).cause} (still hidden after the fallback)`, culprit: e.by?.path ?? null });
        }
      }
    }
  } finally {
    await own?.close();
  }
  return { visibility: report, animations: anim };
}
