// The step that compares the finished copy with the original, slot by slot, and writes what is left into the report.
//
// Where it sits, and why: this pass measures the build that is actually shipped (dist/), so what it reports is what
// a visitor would get. It changes nothing - `applied: 0` - because a correction has to land in ir/site.json before
// the four stacks are built, which happens earlier; the loop that acts on these numbers therefore lives inside the
// generate step (phase C) and calls the same compareExact against the pre-build site. One engine, two callers: this
// one for the honest final report, that one for correcting.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { emitSite } from './emit/html.js';
import { compareExact, DIFF_LIMIT_PCT } from './verify/exact/compare.js';
import { checkBaseline } from './exactCapture.js';
import { BOX_TOLERANCE_PX, boxLookups, TEXT_BUDGET_PX } from './verify/exact/boxes.js';
import { viewForWidth } from './verify/exact/correct.js';

/** Causes a person has to act on, as opposed to ones the engine could still fix. */
const NEEDS_A_PERSON = new Set(['third-party-frame', 'image-content']);

/**
 * The shipped pages re-emitted with `data-sas-id`, plus what generate saved beside the IR about every one of those
 * ids: the original path it came from, which of its two sizes the copy wrote itself, and the pixel or two it asked
 * for on purpose. The first pairs a box with the one it was built from; the other two decide how exactly that box
 * can be held to it.
 * Returns null when either is missing (a workspace from before this existed, or a pruned IR), and the comparison
 * then pairs by content as it used to - reported as such, never silently.
 * @returns {Promise<{ pages: Map<string, string>, lookups: object, views: string[], breakpoints: object }|null>}
 */
async function withIds(ctx) {
  const dir = path.join(ctx.dir, 'ir');
  const [ir, saved] = await Promise.all([
    readFile(path.join(dir, 'site.json'), 'utf8').then(JSON.parse),
    readFile(path.join(dir, 'cpaths.json'), 'utf8').then(JSON.parse),
  ]);
  const lookups = boxLookups(saved);
  if (!ir?.pages?.length || !lookups.pairs) return null;
  // As shipped: each page with its own stylesheet inline. The shared css/site.css is not what a visitor gets, and in an
  // as-is copy it holds every page's own sheets one after another, so one page's rules land on another's elements.
  const out = emitSite(ir, { ids: true, inlineCss: true });
  const pages = new Map();
  for (const p of ir.pages) {
    const html = out.files.get(p.outPath);
    if (html) pages.set(p.outPath, html);
  }
  // The views this copy was built from, not the registry: a copy built from four has no fifth media query.
  const views = [...new Set(ir.pages.flatMap((p) => p.views ?? []))];
  return pages.size ? { pages, lookups, views, breakpoints: ir.breakpoints ?? null } : null;
}

export async function exactStage(ctx, local = {}) {
  if (!ctx.exact) return;
  const { report } = ctx;
  const progress = local.progress ?? ctx.progress;
  const deadline = local.stepDeadline ?? ctx.stepDeadline ?? Infinity;
  const baseline = ctx.exactBaseline;
  if (!baseline?.pages?.length) {
    report.warnings.push('The copy could not be compared with the original: the original was not measured.');
    return;
  }

  const pages = (report.pages ?? []).filter((p) => baseline.pages.some((b) => b.slug === p.slug));
  if (!pages.length) return;
  // The copy's own script is the only one that can exist here (verify/safety.js fails the job otherwise), and it is
  // what puts states and parked layouts in place - so it runs, unless this build ships none or safety said no.
  const scripts = Boolean(report.outputs?.html?.scripts) && report.safety?.safe !== false;

  // How a box of the copy is paired with the box of the original it was built from. The shipped HTML carries no
  // identity, so pairing fell back to the text an element contains: on the homepage that paired 79 of 577 boxes and
  // called the other 498 missing and extra at the same time. The same pages re-emitted with `data-sas-id` pair by
  // that id instead. It is one attribute that cannot paint, every byte else - CSS, assets, markup - is the build
  // itself, and `boxBasis` says so in the report rather than leaving it to be assumed.
  const paired = await withIds(ctx).catch(() => null);
  progress?.(0, `Comparing the copy with the original at ${baseline.slots.length} sizes`);
  const result = await compareExact({
    root: path.join(ctx.dir, 'dist'),
    workspace: ctx.dir,
    baseline,
    pages,
    scripts,
    overrides: paired?.pages ?? null,
    lookups: paired?.lookups ?? null,
    viewAt: paired ? (width) => viewForWidth(width, paired.views.length ? paired.views : undefined, paired.breakpoints) : null,
    noise: baseline.noiseFloor ?? {},
    // Parts of the page that are not the site and were left out on purpose (ir/exclude.js): not the copy's fault.
    excluded: report.exact?.excluded ?? [],
    deadline,
    progress: (f, message) => progress?.(f, message),
    // A page at a time into the checkpoint: this pass costs about four minutes a page, and an interruption on the
    // last page used to throw away every page before it.
    done: (slug) => ctx.checkpoint?.exactPage?.(slug) ?? null,
    onPage: (result) => ctx.checkpoint?.saveExactPage?.(result.slug, result),
  });

  // Is the baseline still what the live site looks like? One conditional request per page, no browser.
  const staleness = await checkBaseline({
    recipeVersion: report.exact?.recipeVersion,
    capturedAt: report.exact?.baseline?.capturedAt,
    pages: baseline.pages,
  }).catch(() => null);

  const remaining = Object.entries(result.causes).map(([cause, count]) => ({
    cause,
    count,
    kind: NEEDS_A_PERSON.has(cause) ? 'needs-a-person' : 'tool-defect',
  })).sort((a, b) => b.count - a.count);

  report.exact = {
    ...report.exact,
    jsMode: scripts ? 'on' : 'off',
    boxBasis: paired ? 'the build, re-emitted with element ids so a box can be paired with the one it came from' : 'the build as shipped; boxes paired by the text they contain, which pairs fewer of them',
    limit: DIFF_LIMIT_PCT,
    // How the boxes were graded, in plain terms, because the acceptance rule cannot be read without it: a length
    // the copy wrote itself has to be within a pixel, a length the text inside the box decides is held to a
    // budget and counted under the cause `font-metric`. Without the map the second is all there is.
    boxGrading: paired?.lookups.graded
      ? `${paired.lookups.graded} element(s) carry what the copy wrote for their own size, so those are held to ${BOX_TOLERANCE_PX} px; a size the text decides is held to ${TEXT_BUDGET_PX} px and counted as font-metric`
      : 'not available for this build: every text box is held to the font-metric budget, and only images, frames and video to the pixel',
    summary: {
      slots: result.slots,
      accepted: result.accepted,
      pct: result.pct,
      diffWorst: result.diffWorst,
      diffMean: result.diffMean,
      pages: result.pages.length,
      boxes: result.boxes,
    },
    pages: result.pages,
    remaining,
    worst: result.worst,
    errors: result.errors.slice(0, 40),
    ...(staleness && { baseline: { ...report.exact?.baseline, check: staleness } }),
  };

  if (result.reused) {
    report.warnings.push(`Continued after an interruption: ${result.reused} of ${result.pages.length} page(s) kept the comparison measured before it, and were not measured again.`);
  }
  if (result.accepted < result.slots) {
    const left = result.slots - result.accepted;
    report.warnings.push(`${left} of ${result.slots} page sizes are not an exact match yet (worst ${result.diffWorst}% of pixels); see "Exact comparison" in the report.`);
  }
  if (staleness?.status === 'stale') {
    report.warnings.push(`The original has changed since it was measured (${staleness.reasons.join('; ')}). Measure it again for a fair comparison.`);
  }
  for (const r of remaining.filter((x) => x.kind === 'needs-a-person')) {
    report.manual.push({
      area: 'Exact comparison',
      what: r.cause === 'third-party-frame'
        ? 'Part of the page is a frame from another company (a map, a video, a booking widget). The copy keeps the same frame, but what it draws is theirs, so those pixels cannot be compared.'
        : 'Part of the page is drawn by a picture, a video or a canvas. What it draws is its own content, which no stylesheet can carry.',
      count: r.count,
    });
  }
}
