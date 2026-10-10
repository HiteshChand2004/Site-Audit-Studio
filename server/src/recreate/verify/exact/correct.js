// The correction loop, steered by the exact comparison.
//
// The loop itself is not rewritten: verify/correct.js already plans changes from nine correctors, tries them as a
// served stylesheet override targeting [data-sas-id="N"] (no rebuild per round), judges a round by whether the whole
// selection improved with no single slot falling more than two points, remembers what was tried, freezes what failed
// and commits the winners into node.fix[view].decls, which one line in ir/styles.js turns into real declarations for
// all four stacks. What exact mode changes is three things:
//
// - **How a round is measured.** Not four captured views against the capture's own rects, but every exact viewport
//   against the baseline taken at that same viewport (capture/exact.js): the pixels that really differ and the boxes
//   that really moved, at 320, 360, 375, … 1920, and 1 px either side of the site's own breakpoints.
// - **How much it may work on.** Every page, one page at a time, worst first - not the three the fast pass picks.
// - **When it stops.** Five rounds per page, as the user asked, rather than a ninety-second clock.
//
// A correction found at a width is written to the IR view that governs that width (viewForWidth), because that is
// where a declaration has to live to apply there: an exact slot is a width, and the IR speaks in views.
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { MAX_HEIGHT } from '../../../audit/screenshots.js';
import { collectRects } from '../layout.js';
import { correctLayout, round1, slotKey, W_LAYOUT, W_PIXEL, HEIGHT_OFF } from '../correct.js';
import { CSS_FILE } from '../../emit/css.js';
import { VIEW_WIDTHS, RECREATE_VIEWS } from '../../views.js';
import { bandFile, exactDir, MAX_BANDS } from '../../capture/exact.js';
import { collectExactBoxes, compareBoxes } from './boxes.js';
import { exactDiff } from './pixels.js';
import { freezePage } from './freeze.js';
import { settleExact } from './recipe.js';

/** Rounds one page may spend being corrected (the user's number). */
export const ROUNDS_PER_PAGE = 5;
/** A page whose pixels differ by this much or less at every slot is not worth a round. */
export const GOOD_ENOUGH_PCT = 0.5;
/** How a pixel percentage becomes a score out of 100: 0 % is 100, this much or worse is 0. */
export const PIXEL_FLOOR_PCT = 5;
/** A box within this many pixels is where it should be (the same tolerance the comparison reports). */
export const BOX_TOLERANCE = 1;

/**
 * The IR view that governs a width. An exact slot is a width (1025, 430); a declaration has to live in the view
 * whose media query covers it, or it will not apply there.
 */
export function viewForWidth(width, views = RECREATE_VIEWS) {
  const ordered = [...views].sort((a, b) => VIEW_WIDTHS[b.id ?? b] - VIEW_WIDTHS[a.id ?? a]);
  for (const v of ordered) {
    const id = v.id ?? v;
    if (width >= VIEW_WIDTHS[id]) return id;
  }
  return (ordered.at(-1)?.id ?? ordered.at(-1)) ?? 'mobile';
}

/**
 * The box comparison as the ledger reads it: the same rows the fit pass hands it (verify/layout.js pairs), so one
 * ledger, one planner and one set of correctors serve both passes.
 */
export function exactRows(compare, { tolerance = BOX_TOLERANCE } = {}) {
  const rows = [];
  for (const row of compare.worst ?? []) {
    const [ex, ey, ew, eh] = row.expected;
    const [ax, ay, aw, ah] = row.actual;
    const widthOk = Math.abs(aw - ew) <= tolerance;
    const heightOk = Math.abs(ah - eh) <= tolerance;
    rows.push({
      sid: null,
      cpath: row.path,
      tag: row.tag,
      // The same vocabulary verify/layout.js uses: what is wrong with this box, not what kind of box it is.
      kind: !widthOk || !heightOk ? 'size' : 'offset',
      expected: row.expected,
      actual: row.actual,
      widthOk,
      heightOk,
      iou: null,
      delta: row.delta,
      offBy: row.off,
      ...(Math.abs(ax - ex) > tolerance || Math.abs(ay - ey) > tolerance ? { moved: true } : {}),
    });
  }
  for (const m of compare.missingItems ?? []) {
    rows.push({ sid: null, cpath: m.path, tag: m.tag, kind: 'missing', expected: m.rect, actual: null, widthOk: false, heightOk: false, iou: 0 });
  }
  return rows;
}

/** One slot's numbers, in the shape the loop's judge() and planner expect. */
export function slotScore({ diffRaw, boxes, heightOriginal, heightCopy }) {
  const paired = boxes?.paired ?? 0;
  const missing = boxes?.missing ?? 0;
  const extra = boxes?.extra ?? 0;
  const within = boxes?.within ?? 0;
  const known = paired + missing + extra;
  // Of everything the original paints, the share the copy paints in the right place.
  const layout = known ? round1((within / known) * 100) : 100;
  const pixel = round1(Math.max(0, 100 - (diffRaw / PIXEL_FLOOR_PCT) * 100));
  const heightOff = heightOriginal
    ? Math.abs(heightCopy - heightOriginal) / heightOriginal > HEIGHT_OFF
    : false;
  return {
    layout,
    pixel,
    heightOff,
    capturedHeight: heightOriginal,
    renderedHeight: heightCopy,
    score: round1(layout * W_LAYOUT + pixel * W_PIXEL),
  };
}

/**
 * Measures the copy at every exact slot of the chosen pages, against the baselines taken at those same slots, with
 * one stylesheet override in place. Same return shape as verify/correct.js measureRound, so the loop is unchanged.
 */
export function makeExactRound({ renderer, baseline, treeOf, workspace, cpathOf = null, deadline = Infinity }) {
  const byPage = new Map(baseline.pages.map((p) => [p.path, p]));
  return async function exactRound({ site, ledger, css, round, pages }) {
    ledger.beginRound(round);
    const slots = [];
    const rects = new Map();
    let failed = 0;
    let lastError = null;
    renderer.server.overrides.set(CSS_FILE, css);
    try {
      for (const pagePath of pages) {
        const tree = treeOf.get(pagePath);
        const saved = byPage.get(pagePath);
        if (!tree || !saved) continue;
        const inDir = exactDir(workspace, tree.info.slug);
        for (const slotBaseline of saved.slots) {
          if (Date.now() > deadline) break;
          const slot = baseline.slots.find((s) => s.id === slotBaseline.id);
          if (!slot || !slotBaseline.bands?.length) continue;
          const view = viewForWidth(slot.width);
          // A slot that cannot be measured is counted and skipped, never guessed at: a round judged on half its
          // slots could accept a change that made the others worse. With nothing measured at all the round scores
          // zero, so the loop refuses it rather than treating silence as success.
          let context;
          try {
            context = await renderer.context(slot);
          } catch {
            failed++;
            continue;
          }
          try {
            const p = await context.newPage();
            await p.goto(`${renderer.origin}/${tree.info.outPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const recipe = await settleExact(p, slot, { cap: MAX_HEIGHT * MAX_BANDS, deadline });
            await freezePage(p);
            // The measurement build carries data-sas-id, so the boxes can be matched by path - which a production
            // build cannot do, and which is why the loop measures this build rather than dist/.
            const [measured, index, png] = await Promise.all([
              p.evaluate(collectRects),
              p.evaluate(collectExactBoxes, {}),
              p.screenshot({ type: 'png', fullPage: true, scale: 'css', animations: 'allow', clip: { x: 0, y: 0, width: slot.width, height: Math.min(recipe.height, MAX_HEIGHT) } }),
            ]);
            rects.set(slotKey(pagePath, view), measured.rects);

            const theirs = JSON.parse(gunzipSync(await readFile(path.join(inDir, slotBaseline.boxes.file))));
            const boxes = compareBoxes(theirs.boxes, index.boxes, { cpathOf });
            const diff = await exactDiff(path.join(inDir, bandFile(slotBaseline.id, 0)), png).catch(() => null);
            const numbers = slotScore({
              diffRaw: diff?.pct ?? 0,
              boxes,
              heightOriginal: slotBaseline.pageHeight,
              heightCopy: recipe.height,
            });
            // What is wrong, element by element, into the one ledger the planner and the correctors read.
            ledger.observe({ page: pagePath, view, rows: exactRows(boxes) });
            slots.push({ page: pagePath, view, slot: slot.id, width: slot.width, ...numbers });
          } catch (err) {
            failed++;
            lastError ??= String(err.message ?? err).split('\n')[0];
          } finally {
            await context.close().catch(() => {});
          }
        }
      }
    } finally {
      renderer.server.overrides.delete(CSS_FILE);
    }
    ledger.resolve(site);
    const mean = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0);
    return {
      slots,
      rects,
      ...(failed && { failed, error: lastError }),
      score: round1(mean(slots.map((s) => s.score))),
      layout: round1(mean(slots.map((s) => s.layout))),
      pixel: round1(mean(slots.map((s) => s.pixel))),
      // Keyed by page and view, as the loop expects; several slots can share a view, and the worst of them stands
      // for it, because a declaration written for that view has to hold at every width inside it.
      by: new Map(slots.map((s) => [slotKey(s.page, s.view), s])
        .map(([k, s]) => [k, slots.filter((x) => slotKey(x.page, x.view) === k).reduce((a, b) => (a.score <= b.score ? a : b), s)])),
    };
  };
}

/**
 * Corrects every page against the exact baselines, one page at a time, worst first, five rounds each.
 * @returns {Promise<object>} one report row per page plus the totals
 */
export async function correctExact({
  renderer, baseline, site, ir, ledger, baseCss, workspace, cpathOf = null, deadline = Infinity,
  progress = () => {}, rounds = ROUNDS_PER_PAGE,
}) {
  const treeOf = new Map(site.pages.map((t) => [t.info.path, t]));
  const round = makeExactRound({ renderer, baseline, treeOf, workspace, cpathOf, deadline });
  const out = { pages: [], rounds: 0, applied: 0, reverted: 0, elements: 0, byCorrector: {}, stopped: null, scoreBefore: null, scoreAfter: null };

  // Worst page first, measured once with no override, so the loop spends its rounds where they count.
  const first = await round({ site, ledger, css: baseCss, round: 0, pages: [...treeOf.keys()].filter((p) => baseline.pages.some((b) => b.path === p)) });
  if (!first.slots.length) {
    out.stopped = 'nothing-to-measure';
    return out;
  }
  out.scoreBefore = first.score;
  const worst = new Map();
  for (const s of first.slots) {
    const cur = worst.get(s.page);
    if (!cur || s.score < cur.score) worst.set(s.page, s);
  }
  const order = [...worst.values()].sort((a, b) => a.score - b.score);

  for (const [i, slot] of order.entries()) {
    if (Date.now() > deadline) {
      out.stopped = 'time-limit';
      break;
    }
    // A page already matching at every slot is left alone: a round on it can only risk what is right.
    const pageSlots = first.slots.filter((s) => s.page === slot.page);
    if (pageSlots.every((s) => s.pixel >= 100 - (GOOD_ENOUGH_PCT / PIXEL_FLOOR_PCT) * 100 && s.layout >= 100 && !s.heightOff)) continue;
    progress(i / order.length, `Correcting ${slot.page} against the original (${i + 1} of ${order.length})`);
    const page = await correctLayout({
      ir,
      site,
      ledger,
      baseCss,
      // The loop picks pages by score from these; one page at a time, so this is that page's slots.
      candidates: pageSlots.map((s) => ({ path: s.page, outPath: treeOf.get(s.page)?.info.outPath, score: s.score, view: s.view })),
      deadline,
      round,
      pages: 1,
      maxRounds: rounds,
      minTime: 0,
      progress: (f, message) => progress((i + f) / order.length, message),
    });
    out.pages.push({
      page: slot.page, rounds: page.rounds, applied: page.applied, reverted: page.reverted,
      scoreBefore: page.scoreBefore, scoreAfter: page.scoreAfter, stopped: page.stopped,
      ...(page.rejected && { rejected: page.rejected }),
    });
    out.rounds += page.rounds;
    out.applied += page.applied;
    out.reverted += page.reverted;
    out.elements += page.elements;
    for (const [id, stat] of Object.entries(page.byCorrector)) {
      const o = (out.byCorrector[id] ??= { applied: 0, reverted: 0 });
      o.applied += stat.applied;
      o.reverted += stat.reverted;
    }
  }
  out.stopped ??= 'done';
  out.scoreAfter = out.pages.length ? round1(out.pages.reduce((n, p) => n + (p.scoreAfter ?? 0), 0) / out.pages.length) : out.scoreBefore;
  out.ledger = ledger.summary();
  return out;
}

