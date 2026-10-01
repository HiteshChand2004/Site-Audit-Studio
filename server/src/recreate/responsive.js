// Recreate step 7, "Checking responsive layout" (Phase 4b.6): the finished dist/ is rendered at the sweep
// widths (verify/responsive.js) and compared with the screenshots of the original that the sweep step
// took (sweep.js). The result is report.responsive. This step only measures: it never fails the job.
import path from 'node:path';
import { TimeoutError, withTimeout } from '../audit/util.js';
import { RecreateError } from './errors.js';
import { compareSweepPage, openSweepRenderer, summarizeSweep } from './verify/responsive.js';

// Stop starting pages this long before the step's time limit; the page in progress gets the time left, and the
// step always ends before its limit (a step that hits the limit loses its result).
const MARGIN = 5000;
const HARD_MARGIN = 1500;

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
  const done = [];
  const skipped = [...(sweep.notCaptured ?? [])];
  let renderer;
  try {
    renderer = await openSweepRenderer(path.join(ctx.dir, 'dist'), widths);
    for (const [i, page] of pages.entries()) {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      if (i > 0 && Date.now() > deadline) {
        skipped.push(...pages.slice(i).map((p) => p.path));
        break;
      }
      ctx.progress(i / pages.length, `Measuring ${page.path} (${i + 1} of ${pages.length})`);
      try {
        const result = await withTimeout(
          compareSweepPage({ renderer, workspace: ctx.dir, page, original: sweep.pages[page.slug], widths }),
          Math.max(1000, hardDeadline - Date.now()),
          `Responsive check of ${page.path}`,
        );
        done.push({ path: page.path, outPath: page.outPath, slug: page.slug, widths: result });
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        skipped.push(page.path);
      }
    }
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
