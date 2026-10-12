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
import { correctLayout, round1, slotKey, MIN_ACCEPT_MARGIN, SLOT_DROP, W_LAYOUT, W_PIXEL, HEIGHT_OFF } from '../correct.js';
import { CSS_FILE } from '../../emit/css.js';
import { VIEW_WIDTHS, RECREATE_VIEWS } from '../../views.js';
import { bandClips, exactDir, shootBand, MAX_BANDS } from '../../capture/exact.js';
import { collectExactBoxes, compareBoxes } from './boxes.js';
import { exactDiff } from './pixels.js';
import { freezePage } from './freeze.js';
import { settleExact } from './recipe.js';

/** Rounds one page may spend being corrected (the user's number). */
export const ROUNDS_PER_PAGE = 3;
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

/** ", 4m12s so far" - a measurement of eighteen widths takes minutes, and silence reads as a hang. */
const elapsed = (since) => {
  const s = Math.round((Date.now() - since) / 1000);
  return s < 10 ? '' : `, ${s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`} so far`;
};

/** A box within this many pixels is where it should be (the same tolerance the comparison reports). */
export const BOX_TOLERANCE = 1;

/**
 * One page's slice of a measurement, in the shape `correctLayout` takes as its starting round. The slots and rects
 * are that page's; the scores are recomputed over them, because a whole-run mean is not this page's mean.
 *
 * This is what stops the same stylesheet being measured twice. `correctExact` measures every slot of every page to
 * pick an order, and `correctLayout` then opened its own round 0 over the same widths with the identical CSS - 198
 * renders a run, about forty minutes, and two chances for one stylesheet to produce two answers.
 */
export function pageBase(measured, page) {
  const slots = (measured?.slots ?? []).filter((s) => s.page === page);
  if (!slots.length) return null;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rects = new Map();
  for (const [k, v] of measured.rects ?? []) if (k.startsWith(`${page}|`)) rects.set(k, v);
  const worstPerView = new Map();
  for (const s of slots) {
    const k = slotKey(s.page, s.view);
    const cur = worstPerView.get(k);
    if (!cur || s.score < cur.score) worstPerView.set(k, s);
  }
  return {
    slots,
    rects,
    measured: slots.length,
    carried: 0,
    score: round1(mean(slots.map((s) => s.score))),
    layout: round1(mean(slots.map((s) => s.layout))),
    pixel: round1(mean(slots.map((s) => s.pixel))),
    by: worstPerView,
  };
}

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
 *
 * `views` is the set the copy actually has, which is not always the registry: an exact run captures a view between
 * the tablet and the phone, so 700-767 belongs to that view when it exists and to the phone when it does not.
 * Passing the registry to a copy built from four views would write declarations into a media query the copy has no
 * styles for, which is why the callers pass the views of the page in hand.
 */
export function viewForWidth(width, views = RECREATE_VIEWS, breakpoints = null) {
  const ids = [...views]
    .map((v) => v.id ?? v)
    .sort((a, b) => VIEW_WIDTHS[b] - VIEW_WIDTHS[a]);
  // With the copy's own breakpoints the answer is exact: the media queries stack widest first, so the narrowest one
  // that still matches has the last word. Without them the view widths are the best guess, and they give the same
  // answer for the four-view set, where each breakpoint sits a hundredth below the next view's width. They do not
  // for a set with a view at 700: a width of 640 is governed by that view's query (max-width 767.98), while its own
  // width would have named the phone - whose query ends at 639.98, so the declaration would never have applied.
  if (breakpoints) {
    const matching = ids.filter((id) => breakpoints[id] != null && width <= breakpoints[id]);
    if (matching.length) return matching.sort((a, b) => breakpoints[a] - breakpoints[b])[0];
    return ids[0] ?? 'desktop';
  }
  for (const id of ids) if (width >= VIEW_WIDTHS[id]) return id;
  return ids.at(-1) ?? 'mobile';
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
export function makeExactRound({
  renderer, baseline, treeOf, workspace, cpathOf = null, deadline = Infinity, views = null, breakpoints = null,
  progress = null,
}) {
  const byPage = new Map(baseline.pages.map((p) => [p.path, p]));
  // The original's band screenshots, read once each. A page is measured over several rounds and every round reads
  // the same eighteen-or-so files; the bytes are small (a few hundred KB each) and the cache is emptied between
  // pages so a run never holds more than one page's worth.
  const bytes = new Map();
  const bandBytes = async (file) => {
    let got = bytes.get(file);
    if (!got) {
      got = await readFile(file);
      bytes.set(file, got);
    }
    return got;
  };
  // Emptied when the round moves to another page, so a run never holds more than one page's bands.
  let bytesFor = null;

  return async function exactRound({ site, ledger, css, round, pages, trials = [], base = null, all = false, label = null }) {
    // Every slot of the pages asked for. Judging a round on one width per view was affordable and wrong: a
    // corrector writes its value for every view an element appears in, and the phone view alone governs nine of
    // these eighteen widths - 320 to 767. On a real site that let six changes through which the full check then
    // found cost 13 to 21 points at widths like 639, 430 and 390, every one of them inside the view that had been
    // judged on 375 alone. A view is not one width, so it is not judged as one.
    const key = pages.join('|');
    if (bytesFor !== key) {
      bytes.clear();
      bytesFor = key;
    }
    ledger.beginRound(round);
    const slots = [];
    const rects = new Map();
    let failed = 0;
    let lastError = null;
    // What this round has to get through, so it can say where it is. A round of eighteen widths takes minutes and
    // used to report nothing at all until it ended, which is indistinguishable from a job that has hung - and is
    // what one looked like.
    const total = pages.reduce((n, p) => n + (byPage.get(p)?.slots?.length ?? 0), 0);
    const startedAt = Date.now();
    let done = 0;
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
          // The views this page has, not the registry: a copy built from four views has no fifth media query.
          const view = viewForWidth(slot.width, views ?? tree.views ?? RECREATE_VIEWS, breakpoints);
          done += 1;
          progress?.((done - 1) / Math.max(1, total),
            label ? `${label}: ${slot.width}px (${done} of ${total}${elapsed(startedAt)})` : `${slot.width}px (${done} of ${total}${elapsed(startedAt)})`);
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
              // The original's band is the same file on every round of this page, so it is read once and kept as
              // bytes: `exactDiff` takes either, and given a path it reads the file again on every call.
              const r = await exactDiff(await bandBytes(path.join(inDir, slotBaseline.bands[band].file)), ours)
                .catch(() => null);
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
  // Which views this copy was built from: the width a declaration has to be written for depends on it.
  const siteViews = [...new Set(site.pages.flatMap((t) => t.views ?? []))];
  // The measurement, or one given to it: the scoring rules below are what decide whether a change is kept, and a
  // test must be able to check them without a browser.
  const round = roundOf ?? makeExactRound({
    renderer, baseline, treeOf, workspace, cpathOf, deadline,
    views: siteViews.length ? siteViews : null,
    breakpoints: ir?.breakpoints ?? null,
    // Per width, so a stage of eighteen renders says where it is instead of looking like a hang for minutes.
    // The page being corrected is held here rather than threaded through correctLayout, which has no idea it is
    // one page of eleven: without it a width reads "1440px (3 of 18)" and says nothing about where that is.
    progress: (f, message) => (at
      ? progress(at.from + (f / Math.max(1, at.pages)), at.where + ': ' + message)
      : progress(f, message)),
  });
  // Which page the loop is on, for the per-width messages the round emits (set in the page loop below).
  let at = null;
  const out = { pages: [], rounds: 0, applied: 0, reverted: 0, elements: 0, byCorrector: {}, stopped: null, scoreBefore: null, scoreAfter: null, margin: round1(marginForNoise(baseline.noiseFloor)) };

  // Worst page first, measured once with no override. This measures **every** slot of every page: it is the before
  // of the whole run, the order comes out of it, and each page's rounds are read against it - so a width that is
  // never measured here is a width whose harm could never be detected.
  const first = await round({
    site, ledger, css: baseCss, round: 0, all: true,
    label: 'Measuring the copy against the original',
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
  // Worst width first, so the rounds are spent where the copy is furthest off - but the homepage goes first or
  // second whatever it scores. The fast pass forces it in because it only corrects three pages; exact mode dropped
  // that when it started correcting every page, and the result was that an interrupted run could leave the one
  // page anybody looks at untouched. On the last run it was tenth of eleven.
  const home = site.pages[0]?.info?.path;
  const order = [...worst.values()].sort((a, b) => a.score - b.score);
  const homeAt = order.findIndex((s) => s.page === home);
  if (homeAt > 0) order.unshift(...order.splice(homeAt, 1));
  out.order = order.map((s) => ({ page: s.page, worstSlot: s.slot, worstWidth: s.width, worstScore: s.score }));

  for (const [i, slot] of order.entries()) {
    if (Date.now() > deadline) {
      out.stopped = 'time-limit';
      break;
    }
    // A page already matching at every slot is left alone: a round on it can only risk what is right.
    const pageSlots = first.slots.filter((s) => s.page === slot.page);
    if (pageSlots.every((s) => s.pixel >= 100 - (GOOD_ENOUGH_PCT / PIXEL_FLOOR_PCT) * 100 && s.layout >= 100 && !s.heightOff)) continue;
    at = { where: `${slot.page} (${i + 1} of ${order.length})`, from: i / order.length, pages: order.length };
    const where = `${slot.page} (${i + 1} of ${order.length})`;
    progress(i / order.length, `Correcting ${where} against the original`);
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
      // This page's slice of the measurement above, with the stylesheet it was measured on. correctLayout would
      // otherwise open its own round 0 over the same eighteen widths with the identical CSS.
      base: pageBase(first, slot.page),
      progress: (f, message) => progress((i + f) / order.length, `${where}: ${message}`),
    });
    // What the rounds already established, read slot by slot against how the page started: anything worse anywhere
    // and the page goes back to how it was. There is no separate verification render - the last accepted round
    // measured every width of this page with exactly the declarations that were kept, which is the same stylesheet
    // a verification pass would have built and the same eighteen widths it would have measured.
    let verified = null;
    if (page.applied) {
      verified = { slots: page.slots ?? [], score: page.scoreAfter };
      const dropped = verified.slots.filter((s) => {
        const was = pageSlots.find((p) => p.slot === s.slot);
        return was && s.score < was.score - SLOT_DROP;
      });
      if (dropped.length || (verified.score ?? 0) < (page.scoreBefore ?? 0) - 0.5) {
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

