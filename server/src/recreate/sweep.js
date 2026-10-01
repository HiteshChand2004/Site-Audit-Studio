// Recreate step 2, "Capturing more widths" (Phase 4b.6): the original pages are screenshotted at the sweep
// widths (capture/sweep.js) right after the main capture. The screenshots feed two later steps: the
// generate step checks its breakpoints and fluid type against them (verify/refine.js), and the last
// step measures the finished build (responsive.js). This step only collects: it never fails the job,
// and it uses the time that is left (the homepage first, then the other pages while they fit).
// Result: ctx.sweep and capture/sweep.json.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import { TimeoutError, withTimeout } from '../audit/util.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { captureSweep, SWEEP_WIDTHS } from './capture/sweep.js';
import { RecreateError } from './errors.js';
import { LATER_STEPS_RESERVE } from './inspect.js';

// Stop starting pages this long before the step's time limit; the page in progress gets the time left.
const MARGIN = 8000;
const HARD_MARGIN = 1500;
// Less time than this left at the start: the sweep is skipped (one page needs about this long).
const MIN_TIME = 20000;

const skipped = (ctx, reason, warning) => {
  ctx.sweep = null;
  ctx.report.sweep = { status: 'skipped', reason };
  if (warning) ctx.report.warnings.push(warning);
};

/** @param {object} ctx  needs ctx.pages (inspect step) */
export async function sweepStage(ctx, { widths = SWEEP_WIDTHS } = {}) {
  const pages = ctx.pages ?? [];
  if (!pages.length) return skipped(ctx, 'no-pages');
  // The time the later steps need (assets, generate, build, preview) is never spent here.
  const deadline = Math.min(ctx.stepDeadline ?? Infinity, (ctx.jobDeadline ?? Infinity) - LATER_STEPS_RESERVE) - MARGIN;
  if (deadline - Date.now() < MIN_TIME) {
    return skipped(ctx, 'time-limit', 'The responsive check was skipped: not enough of the time limit was left. Raise SAS_RECREATE_MINUTES to run it.');
  }

  ctx.progress(0, 'Capturing the original at more widths');
  const captured = {};
  const notCaptured = [];
  let proxy;
  let browser;
  try {
    proxy = await startEgressProxy(ctx.netPolicy);
    browser = await launchBrowser({ proxy: proxy.url });
    let slowest = 0;
    for (const [i, page] of pages.entries()) {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      // The homepage is always tried; the others only while one more page (at the slowest pace) fits.
      if (i > 0 && Date.now() + slowest > deadline) {
        notCaptured.push(...pages.slice(i).map((p) => p.path));
        break;
      }
      ctx.progress(i / pages.length, `Capturing ${page.path} (${i + 1} of ${pages.length})`);
      const started = Date.now();
      try {
        captured[page.slug] = await withTimeout(captureSweep(browser, page, ctx.dir, { widths }), Math.max(1000, (ctx.stepDeadline ?? Infinity) - HARD_MARGIN - Date.now()), `Responsive capture of ${page.path}`);
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        notCaptured.push(page.path);
      }
      slowest = Math.max(slowest, Date.now() - started);
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    // Collecting only: a failing sweep is a note in the report, never a failed recreate.
    return skipped(ctx, 'failed', `The responsive check could not capture the original at more widths: ${err.message.split('\n')[0]}`);
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
  }

  if (!Object.keys(captured).length) return skipped(ctx, 'time-limit', 'The responsive check was skipped: no page finished within the time left.');
  ctx.sweep = { widths, pages: captured, notCaptured };
  ctx.report.sweep = { status: 'done', widths, pages: Object.keys(captured).length, notCaptured };
  await writeFile(path.join(ctx.dir, 'capture', 'sweep.json'), JSON.stringify(ctx.sweep));
  ctx.progress(1, `Captured ${Object.keys(captured).length} ${Object.keys(captured).length === 1 ? 'page' : 'pages'} at ${widths.length} widths`);
}
