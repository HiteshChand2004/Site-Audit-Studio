// Recreate step 6, "Checking responsive layout" (Phase 4b.6): the layout between the three captured
// widths (1440 / 768 / 375) rests on heuristics, so every page is screenshotted at the sweep widths
// (capture/sweep.js), the recreated dist/ is rendered at the same widths (verify/responsive.js) and the
// two are compared. The result is report.responsive. This step only measures: it never fails the job, and
// it uses the time that is left (the homepage first, then the other pages while they fit).
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import { TimeoutError, withTimeout } from '../audit/util.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { captureSweep, SWEEP_WIDTHS } from './capture/sweep.js';
import { RecreateError } from './errors.js';
import { compareSweepPage, openSweepRenderer, summarizeSweep } from './verify/responsive.js';

// Stop starting pages this long before the step's time limit; the page in progress gets the time left.
const MARGIN = 8000;
// Less time than this left at the start: the sweep is skipped (one page needs about this long).
const MIN_TIME = 25000;

const skip = (ctx, reason, message) => {
  ctx.report.responsive = { status: 'skipped', reason };
  ctx.report.warnings.push(message);
};

/** @param {object} ctx  needs ctx.pages (inspect step) and the finished dist/ */
export async function responsiveStage(ctx, { widths = SWEEP_WIDTHS } = {}) {
  const pages = ctx.pages ?? [];
  if (!pages.length || !ctx.report.outputs?.html) {
    ctx.report.responsive = { status: 'skipped', reason: 'no-pages' };
    return;
  }
  const deadline = (ctx.stepDeadline ?? Infinity) - MARGIN;
  if (deadline - Date.now() < MIN_TIME) {
    skip(ctx, 'time-limit', 'The responsive layout check was skipped: not enough of the time limit was left. Raise SAS_RECREATE_MINUTES to run it.');
    return;
  }

  ctx.progress(0, 'Measuring the layout between the captured widths');
  const done = [];
  const skipped = [];
  let proxy;
  let browser;
  let renderer;
  try {
    proxy = await startEgressProxy(ctx.netPolicy);
    browser = await launchBrowser({ proxy: proxy.url });
    renderer = await openSweepRenderer(path.join(ctx.dir, 'dist'), widths);
    let slowest = 0;
    for (const [i, page] of pages.entries()) {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      // The homepage is always tried; the others only while one more page (at the slowest pace) fits.
      if (i > 0 && Date.now() + slowest > deadline) {
        skipped.push(...pages.slice(i).map((p) => p.path));
        break;
      }
      ctx.progress(i / pages.length, `Measuring ${page.path} (${i + 1} of ${pages.length})`);
      const started = Date.now();
      try {
        const left = Math.max(5000, deadline - Date.now());
        const result = await withTimeout((async () => {
          const original = await captureSweep(browser, page, ctx.dir, { widths });
          return compareSweepPage({ renderer, workspace: ctx.dir, page, original, widths });
        })(), left, `Responsive check of ${page.path}`);
        done.push({ path: page.path, outPath: page.outPath, slug: page.slug, widths: result });
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        skipped.push(page.path);
      }
      slowest = Math.max(slowest, Date.now() - started);
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    // Measuring only: a failing sweep is a note in the report, never a failed recreate.
    const error = err.message.split('\n')[0];
    ctx.report.responsive = { status: 'failed', error };
    ctx.report.warnings.push(`The responsive layout check could not run: ${error}`);
    return;
  } finally {
    await renderer?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
  }

  if (!done.length) {
    skip(ctx, 'time-limit', 'The responsive layout check was skipped: no page finished within the time left.');
    return;
  }
  const { responsive, warnings } = summarizeSweep(done, widths, { skipped });
  if (!responsive.measured) {
    const first = done.flatMap((p) => Object.values(p.widths)).find((w) => w.error)?.error ?? 'no width could be measured';
    ctx.report.responsive = { status: 'failed', error: first };
    ctx.report.warnings.push(`The responsive layout check could not measure any page: ${first}`);
    return;
  }
  ctx.report.responsive = responsive;
  ctx.report.warnings.push(...warnings);
  ctx.progress(1, `Measured ${done.length} ${done.length === 1 ? 'page' : 'pages'} at ${widths.length} widths`);
}
