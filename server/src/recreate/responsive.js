// Recreate step 7, "Checking responsive layout" (Phase 4b.6): the finished dist/ is rendered at the sweep
// widths (verify/responsive.js) and compared with the screenshots of the original that the sweep step
// took (sweep.js). The result is report.responsive. This step only measures: it never fails the job.
import path from 'node:path';
import { parallelism } from '../audit/resources.js';
import { mapLimit, TimeoutError, withTimeout } from '../audit/util.js';
import { RecreateError } from './errors.js';
import { PAGES_AT_ONCE } from './generate.js';
import { compareSweepPage, openSweepRenderer, summarizeSweep } from './verify/responsive.js';

// Stop starting pages this long before the step's time limit; the page in progress gets the time left, and the
// step always ends before its limit (a step that hits the limit loses its result).
const MARGIN = 5000;
const HARD_MARGIN = 1500;
// Memory one page needs here (its widths render side by side, up to four tabs).
const PAGE_RENDER_MB = 600;

/** @param {object} ctx  needs ctx.sweep (sweep step), ctx.pages and the finished dist/ */
export async function responsiveStage(ctx) {
  const { sweep } = ctx;
  if (!sweep || !ctx.report.outputs?.html) {
    ctx.report.responsive = { status: 'skipped', reason: sweep ? 'no-build' : 'no-sweep' };
    return;
  }
  const widths = sweep.widths;
  const pages = (ctx.pages ?? []).filter((p) => sweep.pages[p.slug]);
  const deadline = (ctx.stepDeadline ?? Infinity) - MARGIN;
  const hardDeadline = (ctx.stepDeadline ?? Infinity) - HARD_MARGIN;

  ctx.progress(0, 'Measuring the layout between the captured widths');
  const skipped = [...(sweep.notCaptured ?? [])];
  // Per page, in page order whatever order they finish in: the result, 'late' (not started: time limit) or 'timeout'.
  const outcome = new Array(pages.length);
  let finished = 0;
  let renderer;
  try {
    renderer = await openSweepRenderer(path.join(ctx.dir, 'dist'), widths);
    // Two pages at a time when the memory allows (each renders its widths side by side, every render in a tab of its own):
    // the site is local and static, so what is measured does not depend on how many render at once.
    await mapLimit(pages, parallelism({ perUnitMB: PAGE_RENDER_MB, max: PAGES_AT_ONCE }), async (page, i) => {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      // Pages start in order: once one is too late, so are the ones after it.
      if (i > 0 && (Date.now() > deadline || outcome.slice(0, i).includes('late'))) {
        outcome[i] = 'late';
        return;
      }
      ctx.progress(finished / pages.length, `Measuring ${page.path} (${i + 1} of ${pages.length})`);
      try {
        outcome[i] = await withTimeout(
          compareSweepPage({ renderer, workspace: ctx.dir, page, original: sweep.pages[page.slug], widths }),
          Math.max(1000, hardDeadline - Date.now()),
          `Responsive check of ${page.path}`,
        );
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        outcome[i] = 'timeout';
      }
      finished++;
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    // Measuring only: a failing check is a note in the report, never a failed recreate.
    const error = err.message.split('\n')[0];
    ctx.report.responsive = { status: 'failed', error };
    ctx.report.warnings.push(`The responsive layout check could not run: ${error}`);
    return;
  } finally {
    await renderer?.close().catch(() => {});
  }

  const done = [];
  pages.forEach((page, i) => {
    const result = outcome[i];
    if (result && typeof result === 'object') done.push({ path: page.path, outPath: page.outPath, slug: page.slug, widths: result });
    else skipped.push(page.path);
  });
  const { responsive, warnings } = summarizeSweep(done, widths, { skipped });
  if (!responsive.measured) {
    const first = done.flatMap((p) => Object.values(p.widths)).find((w) => w.error)?.error ?? 'no width could be measured';
    ctx.report.responsive = { status: 'failed', error: first };
    ctx.report.warnings.push(`The responsive layout check could not measure any page: ${first}`);
    return;
  }
  ctx.report.responsive = { ...responsive, refined: ctx.report.generate?.responsive ?? null };
  ctx.report.warnings.push(...warnings);
  ctx.progress(1, `Measured ${done.length} ${done.length === 1 ? 'page' : 'pages'} at ${widths.length} widths`);
}
