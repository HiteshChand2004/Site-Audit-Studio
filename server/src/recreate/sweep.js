// Recreate step 2, "Capturing more widths" (Phase 4b.6): the original pages are screenshotted at the sweep
// widths (capture/sweep.js) right after the main capture. The screenshots feed two later steps: the
// generate step checks its breakpoints and fluid type against them (verify/refine.js), and the last
// step measures the finished build (responsive.js). This step only collects: it never fails the job,
// and it uses the time that is left (the homepage first, then the other pages while they fit). The pipeline
// runs it next to the steps after it (recreate/index.js): they do not wait for screenshots they do not need yet.
// Result: ctx.sweep and capture/sweep.json.
//
// Several pages at once (optimize-create-copy, `SWEEP`): a page's widths were already shot side by side, but the pages one
// after the other, and the sweep, started only after the whole capture, was the longest step left (the job waited for it).
// Now pages are swept side by side (sweepPagesAtOnce: by CPU threads and free memory, 1 on a small machine), and the capture
// step hands each page over as soon as it is captured (createSweeper): it is swept while the capture still runs only when a
// capture slot is idle (the last pages of a capture), so the capture's own CPU share never shrinks. What one page's sweep
// takes and writes is unchanged. SAS_COPY_OPT_SWEEP=0 (or SAS_COPY_OPTIMIZE=0): the one-page-at-a-time step below.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import os from 'node:os';
import { maxParallel, PAGE_MB, parallelism } from '../audit/resources.js';
import { TimeoutError, withTimeout } from '../audit/util.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { captureSweep, SWEEP_PARALLEL, SWEEP_WIDTHS } from './capture/sweep.js';
import { RecreateError } from './errors.js';
import { causeText, recoverHit } from './interrupts.js';
import { LATER_STEPS_RESERVE } from './inspect.js';
import { optimized } from './optimize.js';

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
  if (!optimized('SWEEP')) return sweepStageSerial(ctx, local);
  // The sweeper the capture step started (pages already handed over, some maybe swept), or a new one.
  const sweeper = ctx.earlySweep ?? createSweeper(ctx, { widths: local.widths });
  delete ctx.earlySweep;
  return sweeper.run(local);
}

/** The sweep one page after the other (the step before the speed-up, kept as the fallback). */
export async function sweepStageSerial(ctx, local = {}) {
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

// Pages swept at once after the capture (each shoots its widths side by side, up to SWEEP_PARALLEL tabs). Kept low: the
// sweep runs next to the steps that build and measure the copy, and a page loaded on a starved CPU may be shot before its
// lazy content arrives.
export const SWEEP_PAGES_MAX = 2;
// CPU threads per page swept at once (its widths load and scroll side by side).
const CPUS_PER_PAGE = 4;
const PAGE_SWEEP_MB = PAGE_MB * SWEEP_PARALLEL;

/**
 * How many pages the sweep shoots at once: SAS_MAX_PARALLEL allows floor(cap / SWEEP_PARALLEL) (≥ 1); else up to
 * SWEEP_PAGES_MAX, one page per CPUS_PER_PAGE threads and as many as the free memory holds. 1 when the speed-up is off.
 * @param {{ env?: object, free?: number, cpus?: number }} [o]  overrides (tests)
 */
export function sweepPagesAtOnce({ env = process.env, free, cpus = os.cpus()?.length || 1 } = {}) {
  if (!optimized('SWEEP', env)) return 1;
  const cap = maxParallel(env);
  if (cap !== Infinity) return Math.max(1, Math.floor(cap / SWEEP_PARALLEL));
  const byCpu = Math.max(1, Math.floor(cpus / CPUS_PER_PAGE));
  const byMemory = parallelism({ perUnitMB: PAGE_SWEEP_MB, max: SWEEP_PAGES_MAX, min: 1, cap: Infinity, ...(free !== undefined && { free }) });
  return Math.max(1, Math.min(SWEEP_PAGES_MAX, byCpu, byMemory));
}

const roomForAnotherSweep = () => parallelism({ perUnitMB: PAGE_SWEEP_MB, max: 1, min: 0, cap: Infinity }) >= 1;

const SETTLED = new Set(['done', 'timeout', 'late']);

/**
 * The sweep of a job, page by page as pages arrive. The capture step creates it (ctx.earlySweep) and hands over each page
 * it keeps (`add`), letting it use the capture slots that are idle (`setSlots`); the sweep step then `run`s it to the end
 * with its own limits. Without a capture step that feeds it, `run` takes ctx.pages.
 * Pages are swept in page order among those handed over; a page starts only while one more (at the slowest pace so far)
 * fits the time left (the first page of the site is always tried), as in the serial step.
 * @param {object} ctx  recreate context
 * @param {{ widths?: number[] }} [o]
 */
export function createSweeper(ctx, { widths = SWEEP_WIDTHS } = {}) {
  const items = new Map(); // slug → { i, page, status: queued | running | done | timeout | late, early }
  const captured = {};
  let slots = () => 0;
  let accepting = true;
  let local = null; // the step's own limit and progress, once it runs
  let running = 0;
  let slowest = 0;
  let outOfTime = false;
  let error = null;
  let finished = false;
  let browser = null;
  let proxy = null;
  let launching = null;
  let settle = null;
  const allSettled = new Promise((resolve) => { settle = resolve; });
  const waiters = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());

  // Before the step runs only the job's limit applies (the step in front is the capture, whose limit is not the sweep's).
  const stepDeadline = () => (local ? local.stepDeadline ?? ctx.stepDeadline ?? Infinity : Infinity);
  const deadline = () => Math.min(stepDeadline(), (ctx.jobDeadline ?? Infinity) - (ctx.laterReserve ?? LATER_STEPS_RESERVE)) - MARGIN;
  const hardLimit = () => Math.min(stepDeadline(), ctx.jobDeadline ?? Infinity) - HARD_MARGIN;
  const progress = (fraction, message) => local?.progress?.(fraction, message);
  const ordered = () => [...items.values()].sort((a, b) => a.i - b.i);
  const settledCount = () => [...items.values()].filter((x) => SETTLED.has(x.status)).length;

  const close = async () => {
    const b = browser ?? (launching && (await launching.catch(() => null)));
    browser = null;
    await b?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    proxy = null;
  };
  // A job that ends early (a failing step, the time limit) closes the browser, which ends the pages in progress.
  ctx.defer?.(close);

  const ensureBrowser = () => (launching ??= (async () => {
    proxy = await startEgressProxy(ctx.netPolicy);
    browser = await launchBrowser({ proxy: proxy.url });
    return browser;
  })());

  const checkDone = () => {
    if (accepting || running) return;
    if (error || outOfTime || ctx.signal?.aborted || ordered().every((x) => SETTLED.has(x.status))) settle();
  };

  async function sweepPage(item) {
    const { page } = item;
    const total = Math.max(1, items.size);
    progress(settledCount() / total, `Capturing ${page.path} (${item.i + 1} of ${total})`);
    const started = Date.now();
    try {
      const b = await ensureBrowser();
      // Widths captured at once: by the memory that is free now (other steps of the job may be running next to this one).
      const once = () =>
        withTimeout(captureSweep(b, page, ctx.dir, { widths, parallel: parallelism({ max: SWEEP_PARALLEL, min: 2 }), cache: ctx.netCache }), Math.max(1000, hardLimit() - Date.now()), `Responsive capture of ${page.path}`);
      let result = await once();
      // Taken while the network was down or the computer slept: once more when the network is back (as in the serial step).
      const hit = await recoverHit(ctx, { step: 'sweep', what: `widths of ${page.path}`, startedAt: started, progress: (m) => progress(settledCount() / total, m) });
      if (hit) {
        progress(settledCount() / total, `Capturing ${page.path} again (${causeText(hit)})`);
        result = await once();
      }
      captured[page.slug] = result;
      item.status = 'done';
    } catch (err) {
      item.status = 'timeout';
      // Anything but running out of time (the browser could not start, …) ends the sweep: a note in the report.
      if (!(err instanceof TimeoutError)) error ??= err;
    }
    slowest = Math.max(slowest, Date.now() - started);
  }

  function pump() {
    if (!error && !ctx.signal?.aborted) {
      for (;;) {
        const next = ordered().find((x) => x.status === 'queued');
        if (!next || running >= Math.max(0, slots())) break;
        // The first page of the site is always tried; the others only while one more page (at the slowest pace) fits.
        if (next.i > 0 && Date.now() + slowest > deadline()) {
          outOfTime = true;
          break;
        }
        if (running > 0 && !roomForAnotherSweep()) break; // short of memory: wait for a running page
        next.status = 'running';
        next.early = !local;
        running++;
        sweepPage(next).finally(() => {
          running--;
          wake();
          pump();
        });
      }
    }
    if (outOfTime) for (const x of items.values()) if (x.status === 'queued') x.status = 'late';
    checkDone();
  }

  // The generate step checks its breakpoints against the first pages only: it may take the pages swept so far instead of
  // waiting for the whole sweep. The first `count` pages (page order) must have been tried, as in the serial step.
  async function pending(count, ms) {
    const pages = ctx.pages ?? [];
    const prefix = () => {
      let n = 0;
      for (const p of pages) {
        if (!SETTLED.has(items.get(p.slug)?.status)) break;
        n++;
      }
      return n;
    };
    const until = Date.now() + ms;
    while (!finished && prefix() < Math.min(count, pages.length) && Date.now() < until) {
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, Math.max(0, until - Date.now())).unref?.();
      });
    }
    if (finished) return ctx.sweep ?? null;
    const part = Object.fromEntries(pages.slice(0, prefix()).filter((p) => captured[p.slug]).map((p) => [p.slug, captured[p.slug]]));
    return Object.keys(part).length ? { widths, pages: part, notCaptured: [], partial: true } : null;
  }

  const done = (fn) => {
    finished = true;
    wake();
    return fn?.();
  };

  return {
    /** A captured page (its index in discovery order, the page entry). */
    add(i, page) {
      if (!accepting || items.has(page.slug)) return;
      items.set(page.slug, { i, page, status: outOfTime ? 'late' : 'queued' });
      pump();
    },
    /** How many pages may be swept now (read whenever one could start). */
    setSlots(fn) {
      slots = fn;
      pump();
    },
    /** The sweep step: takes ctx.pages (the captured pages), sweeps what is left with its own limits, writes the result. */
    async run(step = {}) {
      local = { stepDeadline: step.stepDeadline, progress: step.progress ?? ctx.progress };
      const pages = ctx.pages ?? [];
      // Only the captured pages are swept (a page handed over is always one of them), in page order.
      const index = new Map(pages.map((p, i) => [p.slug, i]));
      for (const [slug, x] of items) if (!index.has(slug) && x.status === 'queued') items.delete(slug);
      pages.forEach((p, i) => { if (!items.has(p.slug)) items.set(p.slug, { i, page: p, status: 'queued' }); });
      for (const [slug, x] of items) x.i = index.get(slug) ?? x.i;
      accepting = false;
      ctx.sweepPending = pending;
      const early = [...items.values()].filter((x) => x.early).length;
      if (!pages.length) return done(() => skipped(ctx, 'no-pages'));
      if (!early && deadline() - Date.now() < MIN_TIME) {
        outOfTime = true;
        return done(() => skipped(ctx, 'time-limit', 'The responsive check was skipped: not enough of the time limit was left. Raise SAS_RECREATE_MINUTES to run it.'));
      }
      progress(0, 'Capturing the original at more widths');
      slots = () => sweepPagesAtOnce();
      pump();
      try {
        await allSettled;
      } finally {
        await close();
      }
      if (ctx.signal?.aborted) throw new RecreateError('Recreate was stopped.');
      if (error) return done(() => skipped(ctx, 'failed', `The responsive check could not capture the original at more widths: ${error.message.split('\n')[0]}`));
      const notCaptured = ordered().filter((x) => x.status !== 'done').map((x) => x.page.path);
      const result = Object.fromEntries(ordered().filter((x) => captured[x.page.slug]).map((x) => [x.page.slug, captured[x.page.slug]]));
      if (!Object.keys(result).length) return done(() => skipped(ctx, 'time-limit', 'The responsive check was skipped: no page finished within the time left.'));
      ctx.sweep = { widths, pages: result, notCaptured };
      done();
      ctx.report.sweep = { status: 'done', widths, pages: Object.keys(result).length, notCaptured, pagesAtOnce: sweepPagesAtOnce(), early };
      await writeFile(path.join(ctx.dir, 'capture', 'sweep.json'), JSON.stringify(ctx.sweep));
      progress(1, `Captured ${Object.keys(result).length} ${Object.keys(result).length === 1 ? 'page' : 'pages'} at ${widths.length} widths`);
    },
  };
}
