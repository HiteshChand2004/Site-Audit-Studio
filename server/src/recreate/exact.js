// The step that compares the finished copy with the original, slot by slot, and writes what is left into the report.
//
// Where it sits, and why: this pass measures the build that is actually shipped (dist/), so what it reports is what
// a visitor would get. It changes nothing - `applied: 0` - because a correction has to land in ir/site.json before
// the four stacks are built, which happens earlier; the loop that acts on these numbers therefore lives inside the
// generate step (phase C) and calls the same compareExact against the pre-build site. One engine, two callers: this
// one for the honest final report, that one for correcting.
import path from 'node:path';
import { compareExact, DIFF_LIMIT_PCT } from './verify/exact/compare.js';
import { checkBaseline } from './exactCapture.js';

/** Causes a person has to act on, as opposed to ones the engine could still fix. */
const NEEDS_A_PERSON = new Set(['third-party-frame', 'image-content']);

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

  progress?.(0, `Comparing the copy with the original at ${baseline.slots.length} sizes`);
  const result = await compareExact({
    root: path.join(ctx.dir, 'dist'),
    workspace: ctx.dir,
    baseline,
    pages,
    scripts,
    noise: baseline.noiseFloor ?? {},
    // Parts of the page that are not the site and were left out on purpose (ir/exclude.js): not the copy's fault.
    excluded: report.exact?.excluded ?? [],
    deadline,
    progress: (f, message) => progress?.(f, message),
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
    limit: DIFF_LIMIT_PCT,
    summary: {
      slots: result.slots,
      accepted: result.accepted,
      pct: result.pct,
      diffWorst: result.diffWorst,
      diffMean: result.diffMean,
      pages: result.pages.length,
    },
    pages: result.pages,
    remaining,
    worst: result.worst,
    errors: result.errors.slice(0, 40),
    ...(staleness && { baseline: { ...report.exact?.baseline, check: staleness } }),
  };

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
