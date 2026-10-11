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
import { correctLayout, round1, slotKey, trialCss, MIN_ACCEPT_MARGIN, SLOT_DROP, W_LAYOUT, W_PIXEL, HEIGHT_OFF } from '../correct.js';
import { CSS_FILE } from '../../emit/css.js';
import { VIEW_WIDTHS, RECREATE_VIEWS } from '../../views.js';
import { bandClips, exactDir, shootBand, MAX_BANDS } from '../../capture/exact.js';
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
/**
 * The smallest gain the exact loop keeps, set from the noise the capture measured rather than guessed at. The
 * noise floor is the original captured twice at the same width: on a real site it came back **zero** at all
 * eighteen, and against a flat margin of one point that cost five true gains of +0.3 to +0.4 in a single run.
 * A loud measurement still earns a wide margin, which is the point of measuring it.
 */
export const marginForNoise = (noise = {}) => {
  const worst = Math.max(0, ...Object.values(noise).filter((n) => Number.isFinite(n)));
  return Math.max(MIN_ACCEPT_MARGIN, 2 * W_PIXEL * (worst / PIXEL_FLOOR_PCT) * 100);
};

/** A box within this many pixels is where it should be (the same tolerance the comparison reports). */
export const BOX_TOLERANCE = 1;

/**
 * Every node's fixes keyed by its place in the tree, in a form that can be written to the checkpoint: the loop is the
 * most expensive part of a run (half an hour on an eleven-page site) and its result lived only in memory until the
 * whole generate step finished, so an interruption a minute before the end threw all of it away.
 *
 * The key is the element's index path from the root, which a tree built again from the same capture reproduces
 * exactly. `cpath` and the tag travel with each entry as a check: a tree that is not the same tree has to be refused
 * rather than half-corrected.
 */
export function fixesByPath(tree) {
  const out = {};
  const walk = (n, at) => {
    if (!n?.tag) return;
    if (n.fix) out[at] = { fix: n.fix, cpath: n.cpath ?? null, tag: n.tag };
    const kids = (n.children ?? []).filter((c) => c?.tag);
    kids.forEach((c, i) => walk(c, at === '' ? String(i) : `${at}.${i}`));
  };
  walk(tree.root, '');
  return out;
}

/**
 * Puts saved fixes back on a tree. Nothing is guessed at: an entry whose place now holds a different tag, or an
 * element the original knew by another path, is counted as a mismatch so the caller can measure again instead of
 * trusting a half-restored page.
 * @returns {{ applied: number, mismatched: string[] }}
 */
export function applyFixesByPath(tree, saved) {
  const nodes = new Map();
  const walk = (n, at) => {
    if (!n?.tag) return;
    nodes.set(at, n);
    const kids = (n.children ?? []).filter((c) => c?.tag);
    kids.forEach((c, i) => walk(c, at === '' ? String(i) : `${at}.${i}`));
  };
  walk(tree.root, '');
  let applied = 0;
  const mismatched = [];
  for (const [at, entry] of Object.entries(saved ?? {})) {
    const node = nodes.get(at);
    if (!node || node.tag !== entry.tag || (entry.cpath && node.cpath && node.cpath !== entry.cpath)) {
      mismatched.push(at);
      continue;
    }
    node.fix = JSON.parse(JSON.stringify(entry.fix));
    applied++;
  }
  return { applied, mismatched };
}

/** Every node's per-view fixes for one page, so a page that does not hold up can be put back exactly. */
export function snapshotFixes(tree) {
  const saved = new Map();
  const walk = (n) => {
    if (!n?.tag) return;
    if (n.fix) saved.set(n, JSON.parse(JSON.stringify(n.fix)));
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree?.root);
  return saved;
}

export function restoreFixes(tree, saved) {
  const walk = (n) => {
    if (!n?.tag) return;
    if (saved.has(n)) n.fix = JSON.parse(JSON.stringify(saved.get(n)));
    else delete n.fix;
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree?.root);
}

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
  return async function exactRound({ site, ledger, css, round, pages, trials = [], base = null, all = false }) {
    // A declaration is written for one view, so it can only change the slots that view governs: a laptop fix
    // cannot move what a 375 px phone renders. Measuring all eighteen slots every round cost eleven minutes a
    // round on a real site (flexibench, measured) and most of those renders only proved that nothing else moved.
    // So a round is judged on one slot per view and carries the rest forward from the previous measurement, and
    // correctExact then checks every slot of the page once before keeping anything (the verification below) -
    // the same guarantee, paid once per page instead of once per round.
    // Every slot of the pages asked for. Judging a round on one width per view was affordable and wrong: a
    // corrector writes its value for every view an element appears in, and the phone view alone governs nine of
    // these eighteen widths - 320 to 767. On a real site that let six changes through which the full check then
    // found cost 13 to 21 points at widths like 639, 430 and 390, every one of them inside the view that had been
    // judged on 375 alone. A view is not one width, so it is not judged as one.
    const wanted = () => true;
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
          // Not one of the slots this round is judged on: its previous numbers stand where there are any, marked
          // as carried so the report can say which were re-measured.
          if (!wanted(slot)) {
            const previous = base?.slots.find((s) => s.page === pagePath && s.slot === slot.id);
            if (previous) {
              slots.push({ ...previous, carried: true });
              const r = base.rects.get(slotKey(pagePath, view));
              if (r) rects.set(slotKey(pagePath, view), r);
            }
            continue;
          }
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
            const [measured, index] = await Promise.all([
              p.evaluate(collectRects),
              p.evaluate(collectExactBoxes, {}),
            ]);
            rects.set(slotKey(pagePath, view), measured.rects);

            const theirs = JSON.parse(gunzipSync(await readFile(path.join(inDir, slotBaseline.boxes.file))));
            const boxes = compareBoxes(theirs.boxes, index.boxes, { cpathOf });

            // Pixels band by band, at the offsets the baseline used, so a page taller than one band is judged on
            // all of it. This used to compare the first band alone: on a homepage of 18,489 px that is under half
            // the page, and a change that improved the top while spoiling the bottom would have been accepted.
            // One band of each side is in memory at a time, as the report pass does it.
            let diffPx = 0;
            let compared = 0;
            const clips = bandClips(slot, recipe.height);
            const bandRows = Math.min(slotBaseline.bands.length, clips.length);
            for (let band = 0; band < bandRows; band++) {
              const ours = await shootBand(p, slot, clips[band]);
              const r = await exactDiff(path.join(inDir, slotBaseline.bands[band].file), ours).catch(() => null);
              if (!r) continue;
              diffPx += r.diff;
              compared += r.compared;
            }
            // The same formula as the report pass, so the loop chases the number it will be judged by: the rows
            // only one side has count as different in full, rather than being left out of the denominator.
            const heightOnlyOne = Math.abs(slotBaseline.pageHeight - recipe.height) * slot.width;
            const total = compared + heightOnlyOne;
            const numbers = slotScore({
              diffRaw: total ? Math.round(((diffPx + heightOnlyOne) / total) * 1e6) / 1e4 : 0,
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
      measured: slots.filter((s) => !s.carried).length,
      carried: slots.filter((s) => s.carried).length,
      // A slot that could not be measured makes the round unjudgeable, and a score of nothing is what refuses it.
      // Without this the carried slots alone would average out to "no worse" and a change nobody could measure
      // would be accepted - which a stub in the tests found before a site did.
      score: failed ? 0 : round1(mean(slots.map((s) => s.score))),
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
  progress = () => {}, rounds = ROUNDS_PER_PAGE, round: roundOf = null,
}) {
  const treeOf = new Map(site.pages.map((t) => [t.info.path, t]));
  // The measurement, or one given to it: the scoring rules below are what decide whether a change is kept, and a
  // test must be able to check them without a browser.
  const round = roundOf ?? makeExactRound({ renderer, baseline, treeOf, workspace, cpathOf, deadline });
  const out = { pages: [], rounds: 0, applied: 0, reverted: 0, elements: 0, byCorrector: {}, stopped: null, scoreBefore: null, scoreAfter: null, margin: round1(marginForNoise(baseline.noiseFloor)) };

  // Worst page first, measured once with no override, so the loop spends its rounds where they count. This one
  // measures **every** slot, not just the four a round is judged on: it is the before of the whole run, and the
  // per-page verification compares against it. Judge on four and measure the before on four, and a width inside
  // a view would have no number to be compared with - so harm there could not be detected at all.
  const first = await round({
    site, ledger, css: baseCss, round: 0, all: true,
    pages: [...treeOf.keys()].filter((p) => baseline.pages.some((b) => b.path === p)),
  });
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
    const fixesBefore = snapshotFixes(treeOf.get(slot.page));
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
      margin: marginForNoise(baseline.noiseFloor),
      progress: (f, message) => progress((i + f) / order.length, message),
    });
    // A last look at the whole page with exactly the declarations that were accepted, compared slot by slot with
    // how it started: anything worse anywhere and the page goes back to how it was. The rounds now measure every
    // slot themselves, so this re-renders what they already saw - it is kept because it is the only check that
    // reads the *committed* stylesheet rather than a trial override, and because a page quietly made worse is the
    // one failure this mode exists to prevent. It costs eighteen renders on a page that kept something.
    let verified = null;
    if (page.applied) {
      verified = await round({
        site, ledger, css: baseCss + trialCss(page.trials ?? [], ir), round: `verify:${slot.page}`, pages: [slot.page], all: true,
      });
      const dropped = verified.slots.filter((s) => {
        const was = pageSlots.find((p) => p.slot === s.slot);
        return was && s.score < was.score - SLOT_DROP;
      });
      if (dropped.length || verified.score < (page.scoreBefore ?? 0) - 0.5) {
        restoreFixes(treeOf.get(slot.page), fixesBefore);
        out.reverted += page.applied;
        out.applied -= 0;
        page.applied = 0;
        page.stopped = 'verification';
        page.droppedSlots = dropped.map((s) => ({ slot: s.slot, score: s.score }));
      }
    }
    out.pages.push({
      page: slot.page, rounds: page.rounds, applied: page.applied, reverted: page.reverted,
      scoreBefore: page.scoreBefore, scoreAfter: verified?.score ?? page.scoreAfter, stopped: page.stopped,
      ...(verified && { verifiedScore: verified.score, slotsMeasured: verified.measured }),
      ...(page.droppedSlots && { droppedSlots: page.droppedSlots }),
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
  // `scoreBefore` is every slot of every page. A page's own `scoreAfter` is whatever its last round measured, which
  // for an unchanged page is the four judging slots - a different set, and on a real site 8 points apart. Averaging
  // the two together reads as an improvement the loop did not make, so a page that kept nothing contributes the
  // score it started with, and only a verified page (all its slots, after the change) contributes a new one.
  const pageBefore = new Map();
  for (const s of first.slots) {
    const at = pageBefore.get(s.page) ?? { sum: 0, n: 0 };
    pageBefore.set(s.page, { sum: at.sum + s.score, n: at.n + 1 });
  }
  const beforeOf = (page) => {
    const at = pageBefore.get(page);
    return at?.n ? at.sum / at.n : null;
  };
  const after = out.pages.map((p) => (p.applied ? (p.verifiedScore ?? p.scoreAfter) : (beforeOf(p.page) ?? p.scoreBefore)));
  out.scoreAfter = after.length ? round1(after.reduce((n, x) => n + (x ?? 0), 0) / after.length) : out.scoreBefore;
  out.scoreBasis = 'every slot of every page, before and after';
  out.ledger = ledger.summary();
  return out;
}

