// Recreate step 2, "Capturing more widths" (Phase 4b.6): the original pages are screenshotted at the sweep
// widths (capture/sweep.js) right after the main capture. The screenshots feed two later steps: the
// generate step checks its breakpoints and fluid type against them (verify/refine.js), and the last
// step measures the finished build (responsive.js). This step only collects: it never fails the job,
// and it uses the time that is left (the homepage first, then the other pages while they fit). The pipeline
// runs it next to the steps after it (recreate/index.js): they do not wait for screenshots they do not need yet.
// Result: ctx.sweep and capture/sweep.json.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import { parallelism } from '../audit/resources.js';
import { TimeoutError, withTimeout } from '../audit/util.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { captureSweep, SWEEP_PARALLEL, SWEEP_WIDTHS } from './capture/sweep.js';
import { RecreateError } from './errors.js';
import { causeText, recoverHit } from './interrupts.js';
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

/**
 * @param {object} ctx  needs ctx.pages (inspect step)
 * @param {{ widths?: number[], stepDeadline?: number, progress?: Function }} [local]  the step's own time limit and progress
 *   (the pipeline runs this step next to the following ones, so the shared ctx.stepDeadline / ctx.progress are not its own)
 */
export async function sweepStage(ctx, local = {}) {
  const { widths = SWEEP_WIDTHS, progress = ctx.progress } = local;
  // Read each time: the limits move later when time is given back after sleep or a network outage (recreate/interrupts.js).
  const stepDeadline = () => local.stepDeadline ?? ctx.stepDeadline ?? Infinity;
  const pages = ctx.pages ?? [];
  if (!pages.length) return skipped(ctx, 'no-pages');
  // The time the later steps need (assets, generate, build, preview) is never spent here.
  const deadline = () => Math.min(stepDeadline(), (ctx.jobDeadline ?? Infinity) - (ctx.laterReserve ?? LATER_STEPS_RESERVE)) - MARGIN;
  if (deadline() - Date.now() < MIN_TIME) {
    return skipped(ctx, 'time-limit', 'The responsive check was skipped: not enough of the time limit was left. Raise SAS_RECREATE_MINUTES to run it.');
  }

  progress(0, 'Capturing the original at more widths');
  const captured = {};
  const notCaptured = [];
  // The generate step checks its breakpoints against the first pages only: it may take the pages swept so far
  // (ctx.sweepPending) instead of waiting for the whole sweep.
  let tried = 0;
  let finished = false;
  let failed = false;
  const waiters = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  const finish = () => {
    finished = true;
    wake();
  };
  ctx.sweepPending = async (count, ms) => {
    const until = Date.now() + ms;
    while (!finished && tried < Math.min(count, pages.length) && Date.now() < until) {
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, Math.max(0, until - Date.now())).unref?.();
      });
    }
    if (finished) return ctx.sweep ?? null;
    return Object.keys(captured).length ? { widths, pages: { ...captured }, notCaptured: [], partial: true } : null;
  };

  let proxy;
  let browser;
  const close = async () => {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
  };
  // A job that ends early (a failing step, the time limit) closes the browser, which ends the page in progress.
  ctx.defer?.(close);
  try {
    proxy = await startEgressProxy(ctx.netPolicy);
    browser = await launchBrowser({ proxy: proxy.url });
    let slowest = 0;
    for (const [i, page] of pages.entries()) {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      // The homepage is always tried; the others only while one more page (at the slowest pace) fits.
      if (i > 0 && Date.now() + slowest > deadline()) {
        notCaptured.push(...pages.slice(i).map((p) => p.path));
        break;
      }
      progress(i / pages.length, `Capturing ${page.path} (${i + 1} of ${pages.length})`);
      const started = Date.now();
      // Widths captured at once: by the memory that is free now (other steps of the job may be running next to this one).
      const sweepOnce = () =>
        withTimeout(captureSweep(browser, page, ctx.dir, { widths, parallel: parallelism({ max: SWEEP_PARALLEL, min: 2 }), cache: ctx.netCache }), Math.max(1000, stepDeadline() - HARD_MARGIN - Date.now()), `Responsive capture of ${page.path}`);
      try {
        let result = await sweepOnce();
        // Taken while the network was down or the computer slept (widths may be missing or incomplete): once more when
        // the network is back. A page that ran out of time is not repeated (its capture may still be writing).
        const hit = await recoverHit(ctx, { step: 'sweep', what: `widths of ${page.path}`, startedAt: started, progress: (m) => progress(i / pages.length, m) });
        if (hit) {
          progress(i / pages.length, `Capturing ${page.path} again (${causeText(hit)})`);
          result = await sweepOnce();
        }
        captured[page.slug] = result;
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        notCaptured.push(page.path);
      }
      slowest = Math.max(slowest, Date.now() - started);
      tried = i + 1;
      wake();
    }
  } catch (err) {
    failed = true;
    if (ctx.signal.aborted) throw err;
    // Collecting only: a failing sweep is a note in the report, never a failed recreate.
    return skipped(ctx, 'failed', `The responsive check could not capture the original at more widths: ${err.message.split('\n')[0]}`);
  } finally {
    await close();
    // No result is coming: whoever waits for the first pages gets none.
    if (failed || !Object.keys(captured).length) finish();
  }

  if (!Object.keys(captured).length) return skipped(ctx, 'time-limit', 'The responsive check was skipped: no page finished within the time left.');
  ctx.sweep = { widths, pages: captured, notCaptured };
  finish();
  ctx.report.sweep = { status: 'done', widths, pages: Object.keys(captured).length, notCaptured };
  await writeFile(path.join(ctx.dir, 'capture', 'sweep.json'), JSON.stringify(ctx.sweep));
  progress(1, `Captured ${Object.keys(captured).length} ${Object.keys(captured).length === 1 ? 'page' : 'pages'} at ${widths.length} widths`);
}
