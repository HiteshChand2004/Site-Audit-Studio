// The self-correction loop: measure the copy against the original, decide what to change, try it, keep it only if
// the page measured closer. Runs inside the generate step, before ir/site.json is written, so every correction
// reaches all four stacks through the one IR.
//
// How a round costs almost nothing: the measurement build links the shared stylesheet (emit/html.js emitSite with
// `ids`, which also puts a data-sas-id on every element), and measureSite installs only the pages into the
// renderer's override map. So a candidate is tried by overriding css/site.css with the current stylesheet plus a
// handful of `[data-sas-id="N"] { ... }` rules - no IR rebuild, no site write, nothing on disk. Only the winning
// declarations are written into node.fix[view].decls at the end, and the IR is rebuilt once.
//
// Why a correction is written for EVERY view the element exists in, each from that view's own captured box: a
// declaration committed for the desktop view lands in the stylesheet's base, where it would also apply to the
// narrower views that have no value of their own. Giving each view its own value removes that leak, makes the
// appended trial rules behave exactly like the committed ones, and is what the capture actually says anyway.
//
// What keeps it honest:
//   - a value only ever comes from the capture, never from our own screenshot, so there is nothing to overfit to;
//   - a pixel region may only drive a correction when it is `coarse` (also different at the layout scale), because
//     a detail-scale-only difference is text anti-aliasing or font rendering;
//   - a round is accepted only if the whole selection improved AND neither component fell AND no single page/view
//     fell more than SLOT_DROP. That last guard is the one the fit pass lacks, and it is how 147 width fixes can
//     add up to nothing by helping one view and hurting another;
//   - nothing is proposed twice for the same element and property, and a rolled-back element is frozen;
//   - correctors only add declarations, never delete what the capture measured, so the search cannot wander.
import { CSS_FILE } from '../emit/css.js';
import { displayOf, isElement, isText } from '../ir/tree.js';
import { MEDIA_VIEWS, VIEW_IDS } from '../views.js';
import { compareLayout, viewScore } from './layout.js';
import { nodesInBox } from './locate.js';
import { toPageBox, visualDiff } from './visualDiff.js';

// Its own budget: the generate step's other work (links, images, the fit pass, refine) keeps what it had.
export const CORRECT_BUDGET = 90000;
// Below this there is no point starting: one round must fit.
export const CORRECT_MIN = 35000;
// Pages worked on at once. Every view of each is measured, so this is PAGES x views renders per round.
export const CORRECT_PAGES = 3;
export const MAX_FIXES_PER_ROUND = 40;
export const MAX_NODES_TOUCHED = 400;
// How many kinds of correction may be refused before the loop gives up on this page set: a refusal is information,
// but a run of them means nothing here is going to pay.
export const MAX_REJECTED_ROUNDS = 3;
// Accept rules, in points of the 0-100 score.
export const ACCEPT_MARGIN = 1;
export const COMPONENT_DROP = 1;
export const SLOT_DROP = 2;
// A rendered page this far from the captured height is a gross failure: it puts every box below it in the wrong
// place at once, so those elements are worked on first.
export const HEIGHT_OFF = 0.15;
export const TARGET = 100;
// The score mixes the element boxes with the perceptual diff; boxes lead because they are the structural truth.
export const W_LAYOUT = 0.6;
export const W_PIXEL = 0.4;
const DEFAULT_BREAKPOINTS = { laptop: 1279.98, tablet: 1023.98, mobile: 767.98 };

const px = (n) => `${Math.round(n)}px`;
const slotKey = (page, view) => `${page}|${view}`;
const round1 = (n) => Math.round(n * 10) / 10;

/** Views of a node the capture actually saw, in the order given. */
const viewsPresent = (node, views) => views.filter((v) => {
  const d = node.views?.[v];
  return d && !d.hidden && d.rect?.[2] > 0 && d.rect?.[3] > 0;
});

const hasOwnText = (node) => (node.children ?? []).some((c) => isText(c) && c.text.trim());
const hasKids = (node) => (node.children ?? []).some((c) => isElement(c));

/** node -> parent, for one page tree. */
function parentMap(root) {
  const parents = new Map();
  const walk = (n) => {
    if (!isElement(n) || n.tag === 'svg') return;
    for (const c of n.children ?? []) {
      if (!isElement(c)) continue;
      parents.set(c, n);
      walk(c);
    }
  };
  walk(root);
  return parents;
}

// --- Correctors -------------------------------------------------------------------------------------------------
// Each looks only at the capture and at the boxes of the current render, and returns
//   { id, target, prop, byView: { <view>: { <decl>: <value> } }, cause }
// or null. `target` may be a different element than the one that measured wrong: a box in the wrong place is
// usually the fault of something above it.

/**
 * An element the capture saw and the copy does not render at all. The biggest single number on a real site
 * (nyaayai's homepage: 124 of them on the desktop view), and often one cause with many victims, so only the
 * topmost one in a chain is touched.
 */
export function missingElement(group, ctx) {
  const views = [...group.perView].filter(([, e]) => e.kind === 'missing').map(([v]) => v);
  if (!views.length) return null;
  const node = group.node;
  if (views.some((v) => ctx.missingAncestor(node, v))) return null;
  const present = viewsPresent(node, ctx.views);
  if (!present.length) return null;

  // An empty box the original kept open by itself: a spacer, a divider, a coloured band. Nothing inside it can
  // give it a size, so the captured one is the only truth there is.
  if (!hasOwnText(node) && !hasKids(node)) {
    const byView = {};
    for (const v of present) {
      const r = node.views[v].rect;
      byView[v] = { width: px(r[2]), height: px(r[3]), 'flex-shrink': '0' };
    }
    return { id: 'empty-box', target: node, prop: 'width', byView };
  }

  // A flex or grid item squashed to nothing, usually by min-width: auto or flex-basis: 0.
  const parent = ctx.parents.get(node);
  if (parent) {
    const byView = {};
    for (const v of present) {
      if (!/flex|grid/.test(displayOf(parent, v) ?? '')) continue;
      byView[v] = { 'min-width': px(node.views[v].rect[2]), 'flex-shrink': '0' };
    }
    if (Object.keys(byView).length) return { id: 'flex-collapse', target: node, prop: 'min-width', byView };
  }

  // It has content and still renders nowhere: give back the display the capture measured.
  const byView = {};
  for (const v of present) {
    const display = node.views[v].style?.display;
    if (display && display !== 'none') byView[v] = { display };
  }
  if (Object.keys(byView).length) return { id: 'missing-display', target: node, prop: 'display', byView };
  return { cause: 'missing-unexplained' };
}

/**
 * The right size in the wrong place. The element itself is fine, so the fault is something before it that came out
 * the wrong height; the fix goes there. Text is never blamed: a line that wraps a pixel differently is a font
 * difference, not a layout error.
 */
export function drift(group, ctx) {
  const offsets = [...group.perView].filter(([, e]) => e.kind === 'offset');
  if (!offsets.length) return null;
  for (const [view, entry] of offsets) {
    const dy = entry.actual[1] - entry.expected[1];
    if (Math.abs(dy) <= 3) continue;
    const culprit = ctx.heightCulprit(group.node, view, dy);
    if (!culprit) {
      entry.cause ??= 'unexplained-offset';
      continue;
    }
    const present = viewsPresent(culprit, ctx.views);
    const byView = {};
    for (const v of present) {
      const want = culprit.views[v].rect[3];
      const got = ctx.renderedRect(culprit, v)?.[3];
      if (got == null) continue;
      // Shorter than it should be: hold it open. Taller: hold it down. Both values come from the capture.
      byView[v] = got < want ? { 'min-height': px(want) } : { height: px(want) };
    }
    if (Object.keys(byView).length) {
      // The cause is the KIND of difference, never the culprit's path: a path per element would make the cause
      // histogram in the report one row per element instead of one row per kind.
      return { id: got_shorter(byView) ? 'drift-min-height' : 'drift-height', target: culprit, prop: 'min-height', byView, cause: 'drift' };
    }
  }
  return null;
}
const got_shorter = (byView) => Object.values(byView).some((d) => 'min-height' in d);

// Properties the capture measured that decide a layout, and the ones that decide how a box is painted. A corrector
// may write one back when the capture has it and the emitted stylesheet does not - which is the honest reading of
// "a rule we failed to carry over", as opposed to inventing a value.
const LAYOUT_PROPS = [
  'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'align-content',
  'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'position', 'overflow', 'white-space',
];
const PAINT_PROPS = [
  'background-color', 'color', 'opacity', 'box-shadow', 'border-radius',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
];
const MAX_RESTORED = 6;
const REPLACED = new Set(['img', 'svg', 'video', 'iframe', 'canvas', 'picture']);

/**
 * A property the capture measured that never reached the stylesheet. The emitted value is looked up on the
 * element's own rule, so this is a fact, not a guess: ir/styles.js prunes a declaration that matches the tag's
 * default, and a value the browser then computes differently (a changed formatting context, a different tag) is
 * exactly the class of difference nothing else in the pipeline can see.
 */
export function restoreDropped(group, ctx) {
  const node = group.node;
  const kinds = new Set([...group.perView.values()].map((e) => e.kind));
  const props = kinds.has('pixel') && kinds.size === 1 ? PAINT_PROPS : LAYOUT_PROPS;
  const byView = {};
  let count = 0;
  for (const v of viewsPresent(node, ctx.views)) {
    const captured = node.views[v].style ?? {};
    for (const prop of props) {
      if (count >= MAX_RESTORED) break;
      const want = captured[prop];
      if (!want || ctx.emitted(node, v, prop) != null) continue;
      // An image the asset step could not download is never faked: it is reported instead.
      if (/^url\(/.test(want)) continue;
      (byView[v] ??= {})[prop] = want;
      count++;
    }
  }
  if (!count) return null;
  const prop = Object.keys(Object.values(byView)[0]).join('+');
  return { id: props === PAINT_PROPS ? 'restore-paint' : 'restore-layout', target: node, prop, byView };
}

/**
 * The children were on one line in the original and are on several in the copy (or the other way round). The row is
 * the thing to fix, not the children.
 */
export function wrapping(group, ctx) {
  const parent = ctx.parents.get(group.node);
  if (!parent) return null;
  const byView = {};
  for (const v of viewsPresent(parent, ctx.views)) {
    if (!/flex/.test(displayOf(parent, v) ?? '')) continue;
    const kids = (parent.children ?? []).filter(isElement).filter((c) => viewsPresent(c, [v]).length);
    if (kids.length < 2) continue;
    const rowsWanted = new Set(kids.map((c) => Math.round(c.views[v].rect[1] / 8))).size;
    const got = kids.map((c) => ctx.renderedRect(c, v)).filter(Boolean);
    if (got.length < 2) continue;
    const rowsGot = new Set(got.map((r) => Math.round(r[1] / 8))).size;
    if (rowsWanted === rowsGot) continue;
    byView[v] = rowsGot > rowsWanted ? { 'flex-wrap': 'nowrap' } : { 'flex-wrap': 'wrap' };
  }
  if (!Object.keys(byView).length) return null;
  return { id: 'flex-wrap', target: parent, prop: 'flex-wrap', byView };
}

/**
 * The children are the right size but the wrong distance apart: the gap between them, measured from the captured
 * boxes, is a value the stylesheet never had.
 */
export function spacing(group, ctx) {
  const parent = ctx.parents.get(group.node);
  if (!parent) return null;
  const byView = {};
  for (const v of viewsPresent(parent, ctx.views)) {
    const display = displayOf(parent, v) ?? '';
    if (!/flex|grid/.test(display)) continue;
    const column = /column/.test(parent.views[v].style?.['flex-direction'] ?? '') || /grid/.test(display);
    const kids = (parent.children ?? []).filter(isElement).filter((c) => viewsPresent(c, [v]).length);
    if (kids.length < 2) continue;
    const axis = column ? 1 : 0;
    const size = column ? 3 : 2;
    const gapsWanted = [];
    const gapsGot = [];
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].views[v].rect;
      const b = kids[i].views[v].rect;
      gapsWanted.push(b[axis] - (a[axis] + a[size]));
      const ra = ctx.renderedRect(kids[i - 1], v);
      const rb = ctx.renderedRect(kids[i], v);
      if (ra && rb) gapsGot.push(rb[axis] - (ra[axis] + ra[size]));
    }
    if (gapsGot.length !== gapsWanted.length || !gapsWanted.length) continue;
    // Only an even spacing is a gap; an uneven one is something else and must not be flattened into one.
    const spread = Math.max(...gapsWanted) - Math.min(...gapsWanted);
    if (spread > 2) continue;
    const want = Math.max(0, Math.round(gapsWanted[0]));
    const got = Math.round(gapsGot.reduce((n, g) => n + g, 0) / gapsGot.length);
    if (Math.abs(want - got) <= 2) continue;
    byView[v] = { [column ? 'row-gap' : 'column-gap']: px(want) };
  }
  if (!Object.keys(byView).length) return null;
  return { id: 'gap', target: parent, prop: 'gap', byView };
}

/**
 * A grid whose columns do not land where the original's did. The track widths come from the children's captured
 * boxes. Only for a grid whose own width is the same in every view: a fluid grid belongs to refine.js.
 */
export function gridTracks(group, ctx) {
  const parent = ctx.parents.get(group.node);
  if (!parent) return null;
  const byView = {};
  for (const v of viewsPresent(parent, ctx.views)) {
    if (!/grid/.test(displayOf(parent, v) ?? '')) continue;
    if (ctx.emitted(parent, v, 'grid-template-columns') != null) continue;
    const kids = (parent.children ?? []).filter(isElement).filter((c) => viewsPresent(c, [v]).length);
    if (kids.length < 2) continue;
    const top = Math.min(...kids.map((c) => c.views[v].rect[1]));
    const firstRow = kids.filter((c) => c.views[v].rect[1] - top <= 2);
    if (firstRow.length < 2) continue;
    const offBy = firstRow.some((c) => {
      const got = ctx.renderedRect(c, v);
      return got && Math.abs(got[0] - c.views[v].rect[0]) > 3;
    });
    if (!offBy) continue;
    byView[v] = { 'grid-template-columns': firstRow.map((c) => px(c.views[v].rect[2])).join(' ') };
  }
  if (!Object.keys(byView).length) return null;
  return { id: 'grid-tracks', target: parent, prop: 'grid-template-columns', byView };
}

/**
 * Taller or shorter than the capture, with no text of its own to explain it.
 *
 * A box is never held down when what is inside it is itself too tall: the child is the thing to fix, and a height
 * on the parent would only clip it - the pixels get worse, the whole round is refused, and a good correction in the
 * same round is thrown out with it. That is exactly what happened on a real site, where 88 of these were proposed
 * at once for pages whose narrow layout was too tall for a reason no height could fix (ir/index.js noReflowViews).
 */
export function wrongHeight(group, ctx) {
  const node = group.node;
  if (hasOwnText(node) || node.tag === 'body' || node.tag === 'html') return null;
  const byView = {};
  for (const [v, entry] of group.perView) {
    if (entry.kind === 'missing') return null;
    const want = node.views[v]?.rect?.[3];
    const got = ctx.renderedRect(node, v)?.[3];
    if (!want || got == null) continue;
    const slack = Math.max(3, want * 0.05);
    if (Math.abs(got - want) <= slack) continue;
    if (got > want && ctx.contentTooTall(node, v)) {
      entry.cause ??= 'taller-content';
      continue;
    }
    byView[v] = got < want ? { 'min-height': px(want) } : { height: px(want) };
  }
  if (!Object.keys(byView).length) return null;
  return { id: 'height', target: node, prop: 'height', byView };
}

/** An image or video drawn at the wrong shape. */
export function aspect(group, ctx) {
  const node = group.node;
  if (!REPLACED.has(node.tag)) return null;
  const byView = {};
  for (const v of viewsPresent(node, ctx.views)) {
    const want = node.views[v].rect;
    const got = ctx.renderedRect(node, v);
    if (!got || !want[3]) continue;
    const wanted = want[2] / want[3];
    const have = got[2] / Math.max(1, got[3]);
    if (Math.abs(wanted - have) < 0.02) continue;
    byView[v] = { 'aspect-ratio': `${Math.round(want[2])} / ${Math.round(want[3])}` };
  }
  if (!Object.keys(byView).length) return null;
  return { id: 'aspect-ratio', target: node, prop: 'aspect-ratio', byView };
}

/**
 * The boxes are where they belong and the pixels still differ. There is nothing to correct in CSS, so the
 * difference is named instead: an image that never downloaded, text drawn by a different font, a loop caught at
 * another moment. This is the half of a 100% target that has to be honest.
 */
export function paintCause(group, ctx) {
  const node = group.node;
  // Only for a difference that is purely about pixels: a box in the wrong place has a cause of its own.
  if ([...group.perView.values()].some((e) => e.kind !== 'pixel')) return null;
  for (const v of ctx.views) {
    const captured = node.views?.[v]?.style ?? {};
    const image = captured['background-image'];
    if (image && /^url\(/.test(image) && ctx.emitted(node, v, 'background-image') == null) {
      return { cause: 'asset-missing' };
    }
  }
  if (REPLACED.has(node.tag)) return { cause: 'image-content' };
  if (hasOwnText(node)) return { cause: 'font-render' };
  return { cause: 'paint-unexplained' };
}

// Order matters: the cause of a difference is fixed before its symptoms, and a parent before its children.
const CORRECTORS = [missingElement, restoreDropped, wrapping, spacing, gridTracks, drift, wrongHeight, aspect, paintCause];

// --- The loop ---------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {(opts: object) => Promise<object>} o.measure  measureSite already bound to this renderer, ir and site
 * @param {object} o.ir
 * @param {object} o.site
 * @param {object} o.ledger
 * @param {string} o.baseCss                    the stylesheet as it stands (emitCss(ir))
 * @param {{ path: string, outPath: string, view: string, score: number, scrollHeight: number }[]} o.candidates
 *        every page/view the fit pass just measured, so the worst ones can be picked without measuring again
 * @param {(tree: object, view: string) => string|null} [o.shotOf]  the original's full-page screenshot
 * @param {number} o.deadline
 * @param {(fraction: number, message?: string) => void} [o.progress]
 * @returns {Promise<object>} a summary for report.generate.correct
 */
export async function correctLayout({
  measure, ir, site, ledger, baseCss, candidates, shotOf = null, deadline = Infinity, progress = () => {},
  // Exact mode overrides these three: its own measurement (verify/exact/correct.js), one page at a time, and a
  // round count instead of a clock.
  round: roundOf = measureRound, pages: pageCount = CORRECT_PAGES, maxRounds = Infinity, minTime = CORRECT_MIN,
} = {}) {
  const out = {
    rounds: 0, applied: 0, reverted: 0, elements: 0,
    scoreBefore: null, scoreAfter: null, pages: [], byCorrector: {}, stopped: null, heightSlots: 0,
  };
  if (!candidates?.length) {
    out.stopped = 'nothing-to-measure';
    return out;
  }
  if (deadline - Date.now() < minTime) {
    out.stopped = 'time-limit';
    return out;
  }

  // Which pages to work on: the ones holding the worst page/view, homepage first. Every view of a chosen page is
  // measured, so a change that helps one view and hurts another cannot pass unnoticed.
  const worstOf = new Map();
  for (const c of candidates) {
    const cur = worstOf.get(c.path);
    if (!cur || c.score < cur.score) worstOf.set(c.path, c);
  }
  const home = candidates.find((c) => c.path === '/');
  const chosen = [...worstOf.values()].sort((a, b) => a.score - b.score).slice(0, pageCount);
  if (!chosen.length) {
    out.stopped = 'nothing-to-measure';
    return out;
  }
  // The homepage is always one of them: it is the page anyone looks at first.
  if (home && !chosen.some((c) => c.path === home.path)) chosen[chosen.length - 1] = worstOf.get(home.path);
  const pagePaths = chosen.map((c) => c.path);
  const only = new Set(chosen.map((c) => c.outPath));
  const treeOf = new Map(site.pages.map((t) => [t.info.path, t]));
  const views = pagePaths.flatMap((p) => treeOf.get(p)?.views ?? []);
  const viewList = [...new Set(views)];
  out.pages = pagePaths;

  const trials = [];                 // accepted declarations, written into the IR at the end
  const tried = new Set();           // `${page}|${cpath}|${corrector}|${prop}` - never offered twice
  let touched = 0;

  const cssWith = (list) => baseCss + trialCss(list, ir);

  let base = await roundOf({ measure, only, site, ledger, css: cssWith(trials), shotOf, round: 0, pages: pagePaths });
  out.scoreBefore = base.score;
  out.scoreAfter = base.score;
  out.heightSlots = base.slots.filter((s) => s.heightOff).length;

  let roundMs = 0;
  for (let round = 1; ; round++) {
    if (base.score >= TARGET) { out.stopped = 'target'; break; }
    if (round > maxRounds) { out.stopped = 'rounds'; break; }
    const left = deadline - Date.now();
    // Never start a round that cannot finish: a half-measured round decides nothing.
    if (left < Math.max(minTime / 2, roundMs * 1.3)) { out.stopped = 'time-limit'; break; }

    const planned = planRound({ ledger, pagePaths, treeOf, base, viewList, tried, touched, ir });
    if (!planned.length) { out.stopped = 'converged'; break; }
    // One corrector per round. A change set that does not pay is refused as a whole, so mixing kinds means a
    // correction that worked is thrown out together with one that did not - measured on a real site, where a
    // batch of 88 height clamps took 3 good flex-wrap fixes down with it.
    const kind = planned[0].id;
    const plan = planned.filter((p) => p.id === kind);
    touched += plan.length;

    progress(Math.min(0.9, round / 6), `Correcting layout (round ${round}: ${kind})`);
    const started = Date.now();
    const candidateTrials = [...trials, ...plan];
    const next = await roundOf({ measure, only, site, ledger, css: cssWith(candidateTrials), shotOf, round, pages: pagePaths });
    roundMs = Date.now() - started;
    out.rounds = round;

    const verdict = judge(base, next);
    for (const p of plan) {
      const stat = (out.byCorrector[p.id] ??= { applied: 0, reverted: 0 });
      stat[verdict.ok ? 'applied' : 'reverted']++;
    }
    if (verdict.ok) {
      trials.push(...plan);
      out.applied += plan.length;
      base = next;
      out.scoreAfter = next.score;
      continue;
    }
    // This kind of correction made things worse somewhere. Put it back, leave those elements alone, and try the
    // next kind: one refused change set costs a round, not the whole pass.
    out.reverted += plan.length;
    (out.rejected ??= []).push({ corrector: kind, count: plan.length, why: verdict.why });
    ledger.freeze(plan.flatMap((p) => p.entries));
    if ((out.rejected?.length ?? 0) >= MAX_REJECTED_ROUNDS) {
      out.stopped = 'rejected';
      break;
    }
  }
  if (!out.stopped) out.stopped = 'converged';

  // Commit: the winning declarations become per-view node fixes, which ir/styles.js writes into the rules every
  // emitter reads. Nothing else in the loop touched the IR.
  for (const t of trials) {
    const node = t.target;
    node.fix ??= {};
    for (const [view, decls] of Object.entries(t.byView)) {
      node.fix[view] = { ...node.fix[view], decls: { ...node.fix[view]?.decls, ...decls } };
    }
  }
  out.elements = new Set(trials.map((t) => t.target)).size;
  out.slots = base.slots.map((s) => ({
    page: s.page, view: s.view, score: s.score, layout: s.layout, pixel: s.pixel,
    ...(s.heightOff && { heightOff: true, capturedHeight: s.capturedHeight, renderedHeight: s.renderedHeight }),
  }));
  // What is still different, with a cause where there is one: the honest half of a 100% target.
  out.ledger = ledger.summary();
  return out;
}

// Causes a person can actually do something about: the copy is missing a file, or the difference is content no
// stylesheet can carry (a canvas, a video, an image's own pixels). Everything else the ledger names is an
// explanation, not a task, and belongs in the fix entry's counts rather than in the manual list.
export const MANUAL_CAUSES = {
  'asset-missing': {
    kind: 'asset',
    title: 'An image the copy could not download is missing from a background',
    detail: 'The original paints it from a file the asset step could not fetch. Add the file and set it as the background, or the area stays plain.',
  },
  'image-content': {
    kind: 'asset',
    title: 'Pictures, video or canvas drawings differ from the original',
    detail: 'What an image, video or canvas draws is its own content, not something a stylesheet can reproduce. Replace the file to match the original exactly.',
  },
};

/**
 * The report rows for a finished correction pass: one `report.fixes` entry naming what each corrector did and what
 * is still different and why, and `report.manual` rows for the causes a person has to act on.
 *
 * This is the honest half of a 100 % target. A difference that was corrected is counted; one that was not is named
 * with its cause instead of quietly disappearing into a score.
 * @param {object} correct  what correctLayout returned
 * @returns {{ fix: object|null, manual: object[] }}
 */
export { slotKey, round1 };

export function correctReport(correct) {
  if (!correct || correct.stopped === 'nothing-to-measure') return { fix: null, manual: [] };
  const ledger = correct.ledger ?? {};
  const byCause = ledger.byCause ?? {};
  const applied = correct.applied ?? 0;
  const open = ledger.open ?? 0;

  // What each corrector did, and what is still different, by cause.
  const items = Object.entries(correct.byCorrector ?? {})
    .map(([corrector, n]) => ({ corrector, applied: n.applied ?? 0, reverted: n.reverted ?? 0 }))
    .sort((a, b) => b.applied - a.applied || b.reverted - a.reverted);
  const openItems = Object.entries(byCause)
    .map(([cause, elements]) => ({ cause, elements, manual: cause in MANUAL_CAUSES }))
    .sort((a, b) => b.elements - a.elements);

  const title = applied
    ? `${applied} layout ${applied === 1 ? 'correction' : 'corrections'} measured against the original`
    : 'The layout was checked against the original; no change measured closer';
  const fix = {
    id: 'layout-correct',
    title,
    status: open ? (applied ? 'partial' : 'open') : 'fixed',
    count: applied,
    open,
    detail: 'Every change was tried on a real render and kept only where the page measured closer to the original on every page and view. What is still different is listed by cause.',
    items: items.slice(0, 20),
    ...(openItems.length && { openItems: openItems.slice(0, 20) }),
    ...(correct.stopped && { stopped: correct.stopped }),
    ...(correct.rejected?.length && { refused: correct.rejected }),
    ...(correct.scoreBefore != null && { score: { before: correct.scoreBefore, after: correct.scoreAfter } }),
  };

  const manual = [];
  for (const [cause, n] of Object.entries(byCause)) {
    const spec = MANUAL_CAUSES[cause];
    if (!spec || !n) continue;
    manual.push({
      kind: spec.kind,
      title: `${spec.title} (${n} ${n === 1 ? 'element' : 'elements'})`,
      detail: spec.detail,
      cause,
      elements: n,
    });
  }
  return { fix, manual };
}

/** The trial stylesheet: one rule per element per view, in the same order the emitter writes its sections. */
export function trialCss(list, ir) {
  if (!list.length) return '';
  const decls = (d) => Object.entries(d).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const forView = (view) => list
    .filter((t) => t.byView[view] && t.target.sid != null)
    .map((t) => `[data-sas-id="${t.target.sid}"] {\n${decls(t.byView[view])}\n}`);
  const parts = ['\n/* Site Audit Studio: candidate corrections under test. */'];
  parts.push(...forView('desktop'));
  for (const view of MEDIA_VIEWS) {
    const rules = forView(view);
    if (rules.length) parts.push(`@media (max-width: ${ir.breakpoints?.[view] ?? DEFAULT_BREAKPOINTS[view]}px) {\n${rules.join('\n')}\n}`);
  }
  return `${parts.join('\n')}\n`;
}

/** Renders the chosen pages with a candidate stylesheet and scores every page/view. */
export async function measureRound({ measure, only, site, ledger, css, shotOf, round }) {
  ledger.beginRound(round);
  const slots = [];
  const rects = new Map();
  await measure({
    only,
    screenshot: Boolean(shotOf),
    extraOverrides: { [CSS_FILE]: css },
    onView: async (tree, view, result) => {
      const cmp = compareLayout(tree.root, view, result.rects, { pairs: true });
      ledger.observe({ page: tree.info.path, view, rows: cmp.pairs });
      rects.set(slotKey(tree.info.path, view), result.rects);

      let diff = null;
      if (shotOf && result.png) {
        const shot = shotOf(tree, view);
        if (shot) diff = await visualDiff(shot, result.png, { regions: true }).catch(() => null);
      }
      // Only a coarse region may blame an element: a detail-scale-only difference is font rendering.
      const width = tree.htmlNode?.views?.[view]?.rect?.[2] ?? null;
      const captured = tree.htmlNode?.views?.[view]?.rect?.[3] ?? null;
      for (const region of diff?.regions ?? []) {
        if (!region.coarse || region.onlyOne) continue;
        const height = Math.max(captured ?? 0, result.scrollHeight ?? 0);
        if (!width || !height) continue;
        const candidates = nodesInBox(tree.root, view, result.rects, toPageBox(region, { width, height }));
        ledger.observePixels({ page: tree.info.path, view, region, candidates });
      }

      const layout = viewScore(cmp, null);
      const pixel = diff ? Math.round(diff.score * 100) : null;
      const heightOff = captured && result.scrollHeight
        ? Math.abs(result.scrollHeight - captured) / captured > HEIGHT_OFF : false;
      slots.push({
        page: tree.info.path, view, layout, pixel, heightOff,
        capturedHeight: captured, renderedHeight: result.scrollHeight ?? null,
        score: round1(pixel == null ? layout : layout * W_LAYOUT + pixel * W_PIXEL),
      });
    },
  });
  // Against the whole site, never only the chosen pages: resolve() drops entries whose page it cannot find.
  ledger.resolve(site);
  const mean = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0);
  return {
    slots,
    rects,
    score: round1(mean(slots.map((s) => s.score))),
    layout: round1(mean(slots.map((s) => s.layout))),
    pixel: slots.every((s) => s.pixel == null) ? null : round1(mean(slots.filter((s) => s.pixel != null).map((s) => s.pixel))),
    by: new Map(slots.map((s) => [slotKey(s.page, s.view), s])),
  };
}

/** Accept only an all-round improvement: better overall, no component down, no single page/view down. */
export function judge(base, next) {
  if (next.score < base.score + ACCEPT_MARGIN) return { ok: false, why: `score ${next.score} is not ${ACCEPT_MARGIN} above ${base.score}` };
  if (next.layout < base.layout - COMPONENT_DROP) return { ok: false, why: `element boxes fell ${round1(base.layout - next.layout)}` };
  if (base.pixel != null && next.pixel != null && next.pixel < base.pixel - COMPONENT_DROP) {
    return { ok: false, why: `the visual diff fell ${round1(base.pixel - next.pixel)}` };
  }
  for (const [key, before] of base.by) {
    const after = next.by.get(key);
    if (after && after.score < before.score - SLOT_DROP) {
      return { ok: false, why: `${key} fell ${round1(before.score - after.score)}` };
    }
  }
  return { ok: true };
}

/** What to try this round, worst first. */
function planRound({ ledger, pagePaths, treeOf, base, viewList, tried, touched, ir }) {
  const plan = [];
  for (const page of pagePaths) {
    const tree = treeOf.get(page);
    if (!tree) continue;
    const parents = parentMap(tree.root);
    const pageSlots = base.slots.filter((s) => s.page === page);
    const grossHeight = pageSlots.some((s) => s.heightOff);
    const ctx = makeContext({ tree, parents, base, page, views: tree.views, ir });

    const groups = groupsFor(ledger, page, viewList);
    // A page rendered far too tall or short is one failure with many victims: the elements whose own height is
    // most wrong are the ones to look at, before anything else on the page.
    groups.sort((a, b) => rank(b, ctx, grossHeight) - rank(a, ctx, grossHeight));

    let perPage = 0;
    for (const group of groups) {
      if (perPage >= MAX_FIXES_PER_ROUND || touched + plan.length >= MAX_NODES_TOUCHED) break;
      for (const corrector of CORRECTORS) {
        const proposal = corrector(group, ctx);
        if (!proposal) continue;
        if (!proposal.byView) {
          for (const e of group.entries) e.cause ??= proposal.cause;
          break;
        }
        const target = proposal.target;
        const key = `${page}|${target.cpath ?? `sid:${target.sid}`}|${proposal.id}|${proposal.prop}`;
        if (tried.has(key)) continue;
        tried.add(key);
        for (const e of group.entries) {
          ledger.markTried(e, proposal.id, proposal.prop);
          if (proposal.cause) e.cause ??= proposal.cause;
        }
        plan.push({ ...proposal, page, entries: group.entries });
        perPage++;
        break;
      }
    }
  }
  return plan;
}

const rank = (group, ctx, grossHeight) => {
  const miss = [...group.perView.values()].some((e) => e.kind === 'missing') ? 100 : 0;
  const blame = Math.max(0, ...[...group.perView.values()].map((e) => e.blame ?? 0)) * 10;
  const worst = Math.max(0, ...[...group.perView.values()].map((e) => 1 - (e.iou ?? 0)));
  const height = grossHeight ? heightWrongness(group.node, ctx) : 0;
  return miss + height + blame + worst;
};

function heightWrongness(node, ctx) {
  let worst = 0;
  for (const v of ctx.views) {
    const want = node.views?.[v]?.rect?.[3];
    const got = ctx.renderedRect(node, v)?.[3];
    if (!want || got == null) continue;
    worst = Math.max(worst, Math.abs(got - want) / Math.max(1, want));
  }
  return Math.min(50, worst * 50);
}

/** The ledger's entries for one page, joined per element so a correction can be written for every view at once. */
function groupsFor(ledger, page, viewList) {
  const byPath = new Map();
  for (const e of ledger.entries.values()) {
    if (e.page !== page || e.frozen || !e.node || !viewList.includes(e.view)) continue;
    if (e.lastSeen !== ledger.round) continue;
    const g = byPath.get(e.cpath) ?? { cpath: e.cpath, node: e.node, perView: new Map(), entries: [] };
    g.perView.set(e.view, e);
    g.entries.push(e);
    byPath.set(e.cpath, g);
  }
  return [...byPath.values()];
}

/** What a corrector may look at: the capture, the parents, the boxes of the current render, and the emitted CSS. */
function makeContext({ tree, parents, base, page, views, ir }) {
  const rectsFor = (view) => base.rects.get(slotKey(page, view)) ?? null;
  const ruleByClass = new Map();
  for (const rule of ir?.rules ?? []) {
    const own = /^\.([\w-]+)$/.exec(rule.selector);
    if (own) ruleByClass.set(own[1], rule);
  }
  // The stylesheet is desktop-first, so a view's value is its own if it has one, else the nearest wider view's.
  const lookupChain = (view) => {
    const i = VIEW_IDS.indexOf(view);
    return (i < 0 ? [view] : VIEW_IDS.slice(0, i + 1)).reverse();
  };
  const renderedRect = (node, view) => {
    const r = rectsFor(view);
    const box = r && node.sid != null ? r[node.sid] : null;
    return box && box[2] > 0 && box[3] > 0 ? box : null;
  };
  return {
    tree,
    parents,
    views,
    renderedRect,
    /**
     * What the generated stylesheet actually says for this element and property in this view, or null when it says
     * nothing. ir/styles.js drops a declaration that equals the tag's default, so a value the capture measured can
     * be missing from the output - and that is the difference no other part of the pipeline can see.
     */
    emitted(node, view, prop) {
      const rule = node.class ? ruleByClass.get(node.class) : null;
      if (!rule) return null;
      for (const v of lookupChain(view)) {
        const parts = v === VIEW_IDS[0] ? rule.parts.base : rule.parts[v];
        if (parts && parts[prop] != null) return parts[prop];
      }
      return null;
    },
    /**
     * Is this box too tall because something inside it is? Then the child is what to fix: a height on the parent
     * clips content, which the pixel comparison rightly refuses.
     */
    contentTooTall(node, view) {
      for (const child of (node.children ?? []).filter(isElement)) {
        const want = child.views?.[view]?.rect?.[3];
        const got = renderedRect(child, view)?.[3];
        if (want && got != null && got > want + Math.max(3, want * 0.05)) return true;
      }
      return false;
    },
    /** Is an ancestor of this node missing from the render too? Then it is the one to fix, not this node. */
    missingAncestor(node, view) {
      let p = parents.get(node);
      while (p) {
        const d = p.views?.[view];
        const visible = d && !d.hidden && d.rect?.[2] > 0 && d.rect?.[3] > 0;
        if (visible && !renderedRect(p, view)) return true;
        p = parents.get(p);
      }
      return false;
    },
    /**
     * The element before this one whose wrong height explains an offset of `dy`: a preceding sibling, then the
     * same question one level up. Text blocks are never blamed.
     */
    heightCulprit(node, view, dy) {
      let current = node;
      let parent = parents.get(current);
      while (parent) {
        const siblings = (parent.children ?? []).filter(isElement);
        const index = siblings.indexOf(current);
        for (let i = index - 1; i >= 0; i--) {
          const s = siblings[i];
          if (hasOwnText(s)) continue;
          const want = s.views?.[view]?.rect?.[3];
          const got = renderedRect(s, view)?.[3];
          if (!want || got == null) continue;
          const delta = got - want;
          if (Math.sign(delta) !== Math.sign(dy)) continue;
          if (Math.abs(delta - dy) <= Math.max(3, Math.abs(dy) * 0.25)) return s;
        }
        current = parent;
        parent = parents.get(current);
      }
      return null;
    },
  };
}
