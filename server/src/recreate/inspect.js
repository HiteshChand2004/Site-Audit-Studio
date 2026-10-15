// Recreate step 1, "Inspecting pages": page discovery, then a Playwright capture of every selected
// page at 1440 / 768 / 375. Chromium runs behind the SSRF egress proxy, like Analyze.
// Writes capture/manifest.json and sets ctx.pages / ctx.discovery for the later steps.
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, renderHtml } from '../audit/render.js';
import { projectDir } from '../db/index.js';
import { maxParallel, PAGE_MB, parallelism } from '../audit/resources.js';
import { createSharedCache, sharedCacheEnabled } from '../audit/sharedCache.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { capturePage, networkDir } from './capture/index.js';
import { discoverPages, NOT_FOUND_STATUS, probeNotFound, SKIP_LABELS } from './discover.js';
import { evidenceFor, readHomepageShell, reasonText, recoveredDocument } from './recover.js';
import { pageKey } from '../audit/util.js';
import { USER_AGENT } from '../audit/http.js';
import { RecreateError } from './errors.js';
import { CANVAS_RENDERED_MESSAGE } from '../detection/siteType.js';
import { causeText, recoverFailure, recoverHit } from './interrupts.js';
import { viewsFor } from './views.js';

/** Fewer elements than this in an error answer = nothing of the page rendered (an empty gateway error, a bare status line). */
export const EMPTY_PAGE_NODES = 8;

// Captures stop starting new pages this long before the step's time limit.
const INSPECT_MARGIN = 15000;
// A page still being captured is abandoned this long before the limit (shorter than INSPECT_MARGIN, so a page that was
// started in time and is merely slow still gets its chance).
const PAGE_LIMIT_MARGIN = 5000;
// Time per page for the hover / focus probing of the desktop view.
const MOTION_BUDGET = 8000;
// Clicking menus, tabs, sliders and dialogs (full-site B.1, capture/clicks.js), after the hover probe.
const CLICK_BUDGET = 20000;
// The least a probe is worth running for: below this it only costs time.
const MOTION_BUDGET_MIN = 2500;
const CLICK_BUDGET_MIN = 6000;
// How much further an exact copy may go: the probes stop when they run out of elements to try, so this is a guard
// against a page that never settles rather than a budget - a page with little to probe still finishes in seconds.
export const EXACT_PROBE_FACTOR = 15;

/**
 * How long one page's hover / click probe may run for.
 *
 * The budgets follow the time to spare instead of switching off at a threshold: a page with less time still gets a
 * shorter probe, and below the floor the probe is not worth its page load.
 *
 * An exact copy is the exception, and used not to be. It has no time limit and nothing in it may be cut short, but
 * `full` was a flat ceiling - twenty seconds for the click probe - which an ordinary page ran out of: on a real
 * site the homepage probed 10 of its 23 controls and stopped, so thirteen menus and panels had no recorded open
 * state and could never be rebuilt as working controls in the copy. For an exact copy the ceiling follows the work
 * instead. The probe ends when it runs out of controls - it has its own limit of 30 and its own per-click waits -
 * and the clock is left only as a guard against a page that never settles.
 *
 * @param {number} full  the budget when there is time for it
 * @param {number} min   below this the probe is skipped instead
 * @param {number} need  what this probe and the ones beside it cost together
 * @param {{ spare: number, measured: boolean, exact?: boolean }} o
 */
export function probeBudget(full, min, need, { spare, measured, exact = false }) {
  if (exact) return full * EXACT_PROBE_FACTOR;
  if (spare <= 0) return 0;
  // Before any page has been measured the time that is left says little about what a page costs: the full budget
  // only when it clearly fits, as it was. From the second page on the share follows the time to spare.
  if (!measured) return spare > need * 2 ? full : 0;
  const ms = Math.min(full, Math.round((spare / (need * 2)) * full));
  return ms >= min ? ms : 0;
}
// Time of the whole job kept for the steps after capture (assets, generate, build, preview), for BASE_PAGES pages; more pages
// keep more (ctx.laterReserve, recreate/index.js).
export const LATER_STEPS_RESERVE = 150000;
// A page (not the homepage) is abandoned after max(PAGE_CAP_MIN, PAGE_CAP_FACTOR × the slowest page so far) and tried once
// more at the end of the step, in a fresh browser.
const PAGE_CAP_MIN = 240000;
const PAGE_CAP_FACTOR = 3;

// Pages captured at the same time (see capturePagesAtOnce). Each page opens up to one browser context per view (4), and the
// desktop one spends most of the page's time on probes (hover, clicks, tab states, loops) while the other views are already done,
// so a second and third page fill otherwise idle time. Kept low: the probes measure timing (transitions, autoplay, reveals) and
// must not be starved of CPU.
export const CAPTURE_PAGES_MAX = 3;
// CPU threads per page captured at once (a page's views + its probes keep about this many busy at their peak).
const CPUS_PER_PAGE = 4;

/**
 * How many pages the inspect step captures at once.
 * - SAS_CAPTURE_PAGES (1–8) fixes it; 1 = one page at a time, exactly the behaviour before page-level concurrency.
 * - SAS_MAX_PARALLEL (the cap on browser contexts, audit/resources.js) allows floor(cap / views) pages, at least 1.
 * - Else: up to CAPTURE_PAGES_MAX, one page per CPUS_PER_PAGE threads, and only as many as the free memory holds
 *   (a page = one context per view). A 2–4-thread or short-of-memory machine captures one page at a time, as before.
 * Free memory is checked again before every extra page starts (roomForAnotherPage), so a machine that runs short mid-step
 * falls back to fewer pages at once.
 * @param {{ env?: object, free?: number, cpus?: number }} [o]  overrides (tests)
 */
export function capturePagesAtOnce({ env = process.env, free, cpus = os.cpus()?.length || 1, exact = false } = {}) {
  // One browser context per view, so the views this run captures decide what a page costs: an exact run opens a
  // fifth (views.js EXACT_ONLY_VIEWS) and fewer pages fit beside it.
  const perPage = viewsFor({ exact }).length;
  const forced = Number(env.SAS_CAPTURE_PAGES);
  if (env.SAS_CAPTURE_PAGES !== undefined && env.SAS_CAPTURE_PAGES !== '' && Number.isInteger(forced) && forced >= 1 && forced <= 8) return forced;
  const cap = maxParallel(env);
  if (cap !== Infinity) return Math.max(1, Math.floor(cap / perPage));
  const byCpu = Math.max(1, Math.floor(cpus / CPUS_PER_PAGE));
  const byMemory = parallelism({ perUnitMB: PAGE_MB * perPage, max: CAPTURE_PAGES_MAX, min: 1, cap: Infinity, ...(free !== undefined && { free }) });
  return Math.max(1, Math.min(CAPTURE_PAGES_MAX, byCpu, byMemory));
}

/** Whether the free memory holds one more page capture next to the running ones (one context per view). */
export const roomForAnotherPage = ({ free, exact = false } = {}) =>
  parallelism({ perUnitMB: PAGE_MB * viewsFor({ exact }).length, max: 1, min: 0, cap: Infinity, ...(free !== undefined && { free }) }) >= 1;

// Runs at most `size()` tasks at once (read when a task wants to start); the rest wait in order.
export function limiter(size) {
  let running = 0;
  const waiting = [];
  const pump = () => {
    while (waiting.length && running < Math.max(1, size())) {
      running++;
      const { task, resolve, reject } = waiting.shift();
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        running--;
        pump();
      });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}

const once = (fn) => {
  let done = null;
  return () => (done ??= fn());
};

// The pages the analysis this recreate comes from crawled (its crawl.json); none when it is gone or unreadable.
async function analysisPages(ctx) {
  ctx.analysisFacts = new Map();
  if (!ctx.analysis?.id || !ctx.project?.id) return [];
  try {
    const crawl = JSON.parse(await readFile(path.join(projectDir(ctx.project.id), 'audit', ctx.analysis.id, 'crawl.json'), 'utf8'));
    // What the analysis read of each page: the evidence a page that cannot be rendered later is rebuilt from (recover.js).
    for (const p of crawl.pages ?? []) {
      if (!p.facts) continue;
      for (const u of [p.url, p.requestedUrl].filter(Boolean)) {
        try {
          ctx.analysisFacts.set(pageKey(u), p.facts);
        } catch {
          // not an address
        }
      }
    }
    // Every page it reached is a candidate, also one whose server failed (401 / 403 / 5xx, no answer): an unavailable
    // backend never takes a page out of the copy. Only an address that does not exist (404 / 410) is no page.
    return (crawl.pages ?? []).filter((p) => p.facts || !NOT_FOUND_STATUS.has(p.status)).map((p) => p.url);
  } catch {
    return [];
  }
}

/** @param {object} ctx  the pipeline context (recreate/index.js) */
export async function inspectStage(ctx) {
  const { report } = ctx;
  ctx.progress(0, 'Finding pages');
  const proxy = await startEgressProxy(ctx.netPolicy);
  const closeProxy = once(() => proxy.close());
  ctx.defer(closeProxy);
  let browser;
  // Closed after the step, and before stalled pages get their second try (see below), so it may run more than once.
  const closeBrowser = async () => {
    const b = browser;
    browser = null;
    await b?.close().catch(() => {});
  };
  ctx.defer(closeBrowser);

  // One cache of static files for every browser context of the job: the views of a page, the next pages, and the sweep
  // of the original at more widths (which runs after this step) load a stylesheet, script, image or font once.
  // It is also the job's one network recorder: every response of the original is kept in capture/.network/ (the
  // mirror the verification compares against), whether or not files are shared between contexts (SAS_SHARED_CACHE).
  if (!ctx.netCache) {
    ctx.netCache = createSharedCache({ share: sharedCacheEnabled(), recordDir: networkDir(ctx.dir) });
    ctx.defer(() => ctx.netCache.close());
  }

  // Every page the analysis found is a candidate (its crawl renders pages whose links a script builds), and pages that
  // arrive as an empty shell are rendered here too: no page of the site is missed because its links need JavaScript.
  const knownUrls = await analysisPages(ctx);
  // One browser for every render (launched once, reused by the capture below). Discovery fetches several pages at once
  // (discover.js crawlConcurrency); the renders among them are limited to what the free memory holds (at most 4, as before).
  const renderSlots = limiter(() => parallelism({ max: 4, min: 1 }));
  let launching = null;
  const render = (url) => renderSlots(async () => {
    browser ??= await (launching ??= launchBrowser({ proxy: proxy.url }).finally(() => { launching = null; }));
    return renderHtml(browser, url, { cache: ctx.netCache });
  });
  const discover = () =>
    discoverPages({
      url: ctx.singlePage ?? ctx.audit.url ?? ctx.project.url,
      limit: ctx.pageLimit,
      all: ctx.allPages,
      knownUrls,
      render,
      signal: ctx.signal,
      onProgress: (f, message) => ctx.progress(0.2 * f, message),
    });
  // What the site answers for an address that does not exist. Only an exact copy asks, and only an exact copy
  // recreates that page, so the copy does not answer with a blank 200 where the original answers 404 with a page of
  // its own design.
  let notFound = null;
  if (ctx.exact && !ctx.singlePage) {
    notFound = await probeNotFound(ctx.audit.url ?? ctx.project.url, { signal: ctx.signal }).catch(() => null);
  }

  // A job continuing after an interruption keeps the pages the stopped one found: the same pages, order and capture folders
  // (recreate/checkpoint.js). Otherwise the pages are found, and kept for a resume.
  const resumed = ctx.checkpoint?.discovery() ?? null;
  let discovery = resumed;
  const discoverStarted = Date.now();
  if (!resumed) try {
    discovery = await discover();
  } catch (err) {
    // The homepage could not be loaded because the computer slept or the network dropped: once more when it is back.
    const network = /Could not load the homepage \((timeout|dns|refused|error)\)/.test(err.message);
    const again = await recoverFailure(ctx, { step: 'inspect', what: 'finding pages', message: err.message, startedAt: discoverStarted, network, progress: (m) => ctx.progress(0, m) });
    if (!again) throw err;
    ctx.progress(0, `Finding pages again (${causeText(again)})`);
    discovery = await discover();
  }
  // A 404 page of the site's own design is a page, and an exact copy carries it: captured and rebuilt like any
  // other, emitted as 404.html, which is the file every static host and the MERN server already look for. A bare
  // server message is not worth rebuilding - the status is reported either way.
  if (!resumed && notFound?.ownPage && !discovery.pages.some((p) => p.outPath === '404.html')) {
    discovery.pages.push({
      url: notFound.url,
      path: new URL(notFound.url).pathname,
      outPath: '404.html',
      slug: 'not-found',
      source: 'not-found',
      title: notFound.title,
      depth: 0,
      notFound: true,
    });
  }
  // One page only: that page, and it is the copy's start page (index.html), so the preview, the download, the re-audit
  // and every stack open on it. Its links to the rest of the site lead to local notice pages, like any page not copied.
  if (!resumed && ctx.singlePage) {
    const [page] = discovery.pages;
    discovery.beyondLimit = [...(discovery.beyondLimit ?? []), ...discovery.pages.slice(1).map((p) => ({ url: p.url, reason: 'single-page' }))];
    discovery.pages = page ? [{ ...page, outPath: 'index.html', slug: 'index', source: 'single-page' }] : [];
  }
  if (ctx.singlePage) report.singlePage = { url: ctx.singlePage, path: discovery.pages[0] ? new URL(discovery.pages[0].url).pathname : null };
  if (!resumed) await ctx.checkpoint?.saveDiscovery(discovery);

  // The limits follow the work: every page beyond the base set extends this step, the job and the later steps (index.js).
  ctx.scaleToPages?.(discovery.pages.length);

  const captured = new Map(); // discovery index → page (kept in discovery order, the homepage first)
  const failedPages = [];
  // Pages that could not be recreated even from evidence, with what was missing (report.notRecreated).
  const notRecreated = [];
  const notCaptured = [];
  const stalled = []; // pages abandoned the first time: { i, info }
  const abandoned = []; // their captures, which end when the browser closes
  try {
    browser ??= await launchBrowser({ proxy: proxy.url });
    const total = discovery.pages.length;
    // Pages are captured while they still fit in the step's time limit (judged by the slowest page
    // so far): a slow site or a high page limit then keeps the pages captured so far instead of
    // failing the whole job. The homepage is always captured.
    // Read each time: the limits move later when time is given back after sleep or a network outage (recreate/interrupts.js).
    const limitOf = (margin) => Math.min(ctx.stepDeadline ?? Infinity, (ctx.jobDeadline ?? Infinity) - (ctx.laterReserve ?? LATER_STEPS_RESERVE)) - margin;
    const deadline = () => limitOf(INSPECT_MARGIN);
    // A started page is abandoned a little before the step's own limit (which would fail the job).
    const pageLimit = () => limitOf(PAGE_LIMIT_MARGIN);
    let slowest = 0;
    // How long the finished pages took. The slowest one decides when to stop starting pages (a conservative guess),
    // the typical one decides how much time a page gets for its probes: with the slowest, one bad page took the hover,
    // click and state probes away from every page after it.
    const pageMs = [];
    const typicalPageMs = () => {
      if (!pageMs.length) return 0;
      const sorted = [...pageMs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };

    // One capture of a page; null = abandoned: it stalled past its own cap (a slow server, an animation that never settles)
    // or the step's limit. A stalled page must not hold up the others or take the pages captured so far down with it.
    // Only the homepage waits without a cap (the step's own limit still applies).
    const captureOnce = async (info, i) => {
      // Hover / focus probing (4b.1) takes a few seconds per page: only while the step has time to spare.
      const spare = deadline() - Date.now() - typicalPageMs() * 2;
      // The budgets follow the time to spare instead of switching off at a threshold: a page with less time still gets
      // a shorter hover and click probe. A full budget needs twice what it costs, as before; below the floor the probe
      // is not worth its page load and is skipped.
      const share = (full, min, need) => probeBudget(full, min, need, { spare, measured: pageMs.length > 0, exact: ctx.exact });
      const capture = (ctx.capturePage ?? capturePage)(browser, info, ctx.dir, {
        motionBudgetMs: share(MOTION_BUDGET, MOTION_BUDGET_MIN, MOTION_BUDGET),
        clickBudgetMs: share(CLICK_BUDGET, CLICK_BUDGET_MIN, MOTION_BUDGET + CLICK_BUDGET),
        cache: ctx.netCache,
        // A run with no time limit tries a view that failed or timed out more often (capture/index.js).
        patient: Boolean(ctx.unlimited),
        // An exact copy is measured pixel for pixel, so the capture keeps what the normal one trades away.
        exact: Boolean(ctx.exact),
      });
      if (i === 0) return capture;
      const until = Math.min(pageLimit(), Date.now() + Math.max(ctx.pageCapMin ?? PAGE_CAP_MIN, slowest * PAGE_CAP_FACTOR));
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1000, until - Date.now())); });
      // Cleared also when the capture throws (else its timer kept the process alive for minutes).
      const r = await Promise.race([capture, timeout]).finally(() => clearTimeout(timer));
      if (r === null) abandoned.push(capture.catch(() => {}));
      return r;
    };
    // A finished capture: kept when it has the desktop view (the base layout), else the page is reported.
    const keep = (i, info, { views, errors, retried = 0 }) => {
      // Views the site refused at first and gave on a second try: a site that drops connections is visible in the report.
      if (retried && report.capture) report.capture.retriedViews = (report.capture.retriedViews ?? 0) + retried;
      for (const e of errors) report.errors.push({ step: 'inspect', message: `${info.path} (${e.view}): ${e.message}` });
      if (!views.desktop) {
        if (i === 0) throw new RecreateError(`The homepage could not be captured: ${errors[0]?.message ?? 'unknown error'}`);
        failedPages.push({ url: info.url, source: info.source, reason: 'capture-failed' });
        return;
      }
      // A page drawn on a canvas has no structure to copy (detection/siteType.js): stopped with the reason, never a copy of
      // an empty shell - like a bot-protection challenge.
      if (i === 0 && views.desktop.siteType?.type === 'canvas-rendered') {
        throw Object.assign(new RecreateError(`${CANVAS_RENDERED_MESSAGE} (${views.desktop.siteType.reason})`), { siteType: views.desktop.siteType });
      }
      // An error answer with next to nothing in it (an empty 502 from a gateway, a bare 500) is no evidence of the page:
      // it is rebuilt from evidence instead (recover.js), not kept as a blank page. An error page with content of its own
      // (a "please sign in" page, a designed 500 page) is what the site shows, and is kept as it rendered.
      if (i > 0 && views.desktop.status >= 400 && (views.desktop.nodeCount ?? 0) < EMPTY_PAGE_NODES) {
        failedPages.push({ url: info.url, source: info.source, reason: 'capture-failed', empty: views.desktop.status });
        return;
      }
      captured.set(i, { ...info, views });
      // Kept for a resume: a job that stops later does not capture this page again.
      ctx.checkpoint?.savePage(i, captured.get(i));
    };
    const outOfTime = (info) => {
      notCaptured.push(info.path);
      failedPages.push({ url: info.url, source: info.source, reason: 'time-limit' });
    };

    // One page: captured, captured again when an outage or sleep overlapped it, then kept / reported / set aside as stalled.
    const capturePageOnce = async (info, i, at) => {
      ctx.progress(at, `Capturing ${info.path} (${i + 1} of ${total})`);
      let started = Date.now();
      let result = await captureOnce(info, i);
      // Captured (or failed) while the network was down or the computer slept: the page may be incomplete although no
      // error says so. Once more when the network is back. An abandoned capture is not repeated here (it may still be writing).
      if (result !== null) {
        const hit = await recoverHit(ctx, { step: 'inspect', what: `capture of ${info.path}`, startedAt: started, progress: (m) => ctx.progress(at, m) });
        if (hit) {
          ctx.progress(at, `Capturing ${info.path} again (${causeText(hit)})`);
          started = Date.now();
          result = await captureOnce(info, i);
        }
      }
      if (result === null) {
        stalled.push({ i, info });
        return;
      }
      slowest = Math.max(slowest, Date.now() - started);
      pageMs.push(Date.now() - started);
      keep(i, info, result);
    };
    // An unexpected error in one page (not the homepage, which the job needs) is reported for that page and never stops the
    // others: the page is linked to a local notice page like any page that could not be captured.
    const runPage = (info, i, at) => (i === 0 ? capturePageOnce(info, i, at) : capturePageOnce(info, i, at).catch((err) => {
      if (err instanceof RecreateError || ctx.signal.aborted) throw err;
      keep(i, info, { views: {}, errors: [{ view: 'desktop', message: String(err?.message ?? err).split('\n')[0] }] });
    }));

    // Pages captured before the job was interrupted (checkpoint.js) are reused as they are; only the rest is captured.
    const todo = [];
    for (const [i, info] of discovery.pages.entries()) {
      const saved = ctx.checkpoint?.page(i, info.slug);
      if (saved) captured.set(i, saved);
      else todo.push({ i, info });
    }
    if (captured.size) ctx.progress(0.2 + 0.75 * (captured.size / total), `Reusing ${captured.size} ${captured.size === 1 ? 'page' : 'pages'} captured before the interruption`);
    const base = captured.size;

    // Several pages at once when the machine has room (capturePagesAtOnce); 1 = the original one-page-at-a-time loop.
    const atOnce = Math.max(1, Math.min(Math.max(1, todo.length), ctx.capturePages ?? capturePagesAtOnce({ exact: Boolean(ctx.exact) })));
    // How the pages were captured (additive): pages at once, the most that ran together, starts held back for memory, and
    // where the step's time went (finding pages vs capturing them).
    report.capture = { pagesAtOnce: atOnce, peak: 1, heldBack: 0, discoverMs: Date.now() - discoverStarted, captureMs: null };
    const captureStarted = Date.now();
    if (atOnce === 1) {
      for (const [n, { i, info }] of todo.entries()) {
        if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
        if (i > 0 && Date.now() + slowest > deadline()) {
          for (const rest of todo.slice(n)) outOfTime(rest.info);
          break;
        }
        await runPage(info, i, 0.2 + 0.75 * ((base + n) / total));
      }
    } else {
      // Pages start in discovery order (the homepage first) while fewer than `atOnce` run and the free memory holds one more;
      // each finished page frees its slot for the next. The same time checks as above apply to every start; the order of the
      // captured pages (and of the manifest) stays the discovery order. A page that fails or stalls never stops the others;
      // only a homepage that cannot be captured ends the step (as before), and the browser closing then ends the rest.
      const room = ctx.roomForAnotherPage ?? ((o) => roomForAnotherPage({ ...o, exact: Boolean(ctx.exact) }));
      const inflight = new Set();
      let next = 0;
      let done = 0;
      while (next < todo.length || inflight.size) {
        while (next < todo.length && inflight.size < atOnce) {
          if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
          if (todo[next].i > 0 && Date.now() + slowest > deadline()) {
            for (const rest of todo.slice(next)) outOfTime(rest.info);
            next = todo.length;
            break;
          }
          if (inflight.size > 0 && !room()) {
            report.capture.heldBack++;
            break; // short of memory: wait for a running page to finish
          }
          const { i, info } = todo[next++];
          const task = runPage(info, i, 0.2 + 0.75 * ((base + done) / total)).finally(() => {
            done++;
            inflight.delete(task);
          });
          inflight.add(task);
          report.capture.peak = Math.max(report.capture.peak, inflight.size);
        }
        if (!inflight.size) break;
        await Promise.race(inflight);
      }
    }
    stalled.sort((a, b) => a.i - b.i);

    // Pages that stalled get one more try, in a fresh browser: closing the first one ends their captures, so a second
    // capture never shares its folder with one that is still writing.
    if (stalled.length && !ctx.signal.aborted) {
      await closeBrowser();
      await Promise.race([Promise.all(abandoned), new Promise((r) => setTimeout(r, 10000))]);
      browser ??= await launchBrowser({ proxy: proxy.url });
      for (const [n, { i, info }] of stalled.entries()) {
        if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
        if (Date.now() + slowest > deadline()) {
          for (const rest of stalled.slice(n)) outOfTime(rest.info);
          break;
        }
        ctx.progress(0.95 + 0.05 * (n / stalled.length), `Capturing ${info.path} again (it stalled the first time)`);
        ctx.interrupts?.log(`inspect: ${info.path} stalled the first time → captured again in a fresh browser`);
        const started = Date.now();
        const result = await captureOnce(info, i);
        if (result === null) {
          notCaptured.push(info.path);
          failedPages.push({ url: info.url, source: info.source, reason: 'stalled' });
          continue;
        }
        slowest = Math.max(slowest, Date.now() - started);
      pageMs.push(Date.now() - started);
        keep(i, info, result);
      }
    }

    // A page that could not be rendered at all is still a page of the site: rebuilt from the evidence there is - the
    // site's own header and footer, what the analysis read of the page, a marked empty state where its content would be
    // (recover.js) - and captured through the same pipeline. Only a page out of time is left to the next run.
    const unrendered = failedPages.filter((p) => p.reason === 'capture-failed' || p.reason === 'stalled');
    if (unrendered.length && !ctx.signal.aborted) {
      browser ??= await launchBrowser({ proxy: proxy.url });
      const home = discovery.pages[0];
      const shell = await readHomepageShell(browser, home.url, { cache: ctx.netCache, userAgent: USER_AGENT })
        .catch((err) => ({ error: String(err.message ?? err).split('\n')[0] }));
      for (const [n, failed] of unrendered.entries()) {
        if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
        const i = discovery.pages.findIndex((p) => p.url === failed.url);
        const info = discovery.pages[i];
        if (!info) continue;
        if (!shell?.html) {
          notRecreated.push({ url: info.url, path: info.path, reason: failed.reason, missing: `the homepage's layout could not be read (${shell?.error ?? 'no layout'}), and nothing else of the page was available` });
          continue;
        }
        // Within the step's own limit, like every capture: a page there is no time left for stays a time-limit page.
        const left = pageLimit() - Date.now();
        if (left < Math.max(10000, typicalPageMs())) {
          failed.reason = 'time-limit';
          notCaptured.push(info.path);
          continue;
        }
        ctx.progress(0.97 + 0.03 * (n / unrendered.length), `Rebuilding ${info.path} from what is known about it`);
        const evidence = evidenceFor(info, ctx.analysisFacts?.get(pageKey(info.url)) ?? null);
        const why = reasonText({ reason: failed.reason, degraded: info.degraded });
        const document = recoveredDocument(shell, evidence, why);
        let timer;
        // No limit (an exact or manual run) arms no timer: setTimeout clamps Infinity to 1 ms, which would fire at once.
        const cap = Number.isFinite(left)
          ? new Promise((resolve) => { timer = setTimeout(() => resolve({ views: {}, errors: [{ view: 'desktop', message: 'the rebuilt page did not finish within the time left' }] }), left); })
          : new Promise(() => {});
        const result = await Promise.race([
          (ctx.capturePage ?? capturePage)(browser, info, ctx.dir, { cache: ctx.netCache, exact: Boolean(ctx.exact), document })
            .catch((err) => ({ views: {}, errors: [{ view: 'desktop', message: String(err.message ?? err).split('\n')[0] }] })),
          cap,
        ]).finally(() => clearTimeout(timer));
        if (!result.views?.desktop) {
          notRecreated.push({ url: info.url, path: info.path, reason: failed.reason, missing: `even the page rebuilt from evidence could not be captured (${result.errors?.[0]?.message ?? 'unknown error'})` });
          continue;
        }
        failedPages.splice(failedPages.indexOf(failed), 1);
        keep(i, { ...info, recovered: { reason: failed.reason, why, evidence: [
          ...(shell.header ? ["the site's header from its homepage"] : []),
          ...(shell.footer ? ["the site's footer from its homepage"] : []),
          ...evidence.sources,
        ] } }, result);
      }
    }
    report.capture.captureMs = Date.now() - captureStarted;
  } finally {
    await closeBrowser();
    await closeProxy();
  }
  const pages = [...captured.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);

  if (notCaptured.length) {
    report.warnings.push(`${notCaptured.length} ${notCaptured.length === 1 ? 'page was' : 'pages were'} not captured within the time limit of the inspect step (${notCaptured.slice(0, 5).join(', ')}${notCaptured.length > 5 ? ', …' : ''}); links to ${notCaptured.length === 1 ? 'it' : 'them'} open a notice page in the new site (never the live site). Run Recreate again to try ${notCaptured.length === 1 ? 'it' : 'them'} once more.`);
  }
  ctx.discovery = discovery;
  ctx.pages = pages;
  // Links to these pages open a local notice page (ir/notice.js), never the live site.
  ctx.livePages = [...discovery.beyondLimit, ...failedPages];

  report.pages = pages.map((p) => ({
    url: p.url,
    path: p.path,
    outPath: p.outPath,
    // Folder of the page's capture (capture/<slug>/), also used for its screenshots in the app.
    slug: p.slug,
    title: p.title,
    source: p.source,
    views: Object.keys(p.views),
    // Scroll-reveal elements captured in their revealed state, per view (capture/index.js).
    revealPinned: Object.fromEntries(Object.entries(p.views).map(([v, x]) => [v, x.reveal?.pinned ?? 0])),
    // Hover / focus effects found on the desktop view (capture/<slug>/motion.json, 4b.1); null = not probed.
    motion: p.views.desktop?.motion ?? null,
    // How many interactive parts this page has, and how many the probes examined (capture/census.js).
    coverage: p.views.desktop?.coverage ?? null,
    // The page's server or backend failed: 401 / 403 / 5xx or no answer while the pages were found.
    ...(p.degraded && { degraded: p.degraded }),
    // Its forms or content need a backend (login, account, cart …): the visible page is recreated, not what a server does.
    ...(p.needsBackend && { needsBackend: true }),
    // robots.txt asks crawlers not to read it; it is a page of the site all the same, so it is in the copy.
    ...(p.robotsBlocked && { robotsBlocked: true }),
    // It could not be rendered at all and was rebuilt from evidence (recover.js): why, and from what.
    ...(p.recovered && { recovered: p.recovered }),
    // Data requests that got no usable answer while it was captured: it shows the site's own empty or error state there.
    ...(p.views.desktop?.dataFailed && { dataUnavailable: p.views.desktop.dataFailed }),
    ...(Object.values(p.views).some((v) => v?.coverage && v.view !== 'desktop') && {
      coverageByView: Object.fromEntries(Object.values(p.views)
        .filter((v) => v?.coverage && v.view !== 'desktop')
        .map((v) => [v.view, v.coverage])),
    }),
    // An exact copy probes every view (capture/<view>-motion.json): what each of the others found, by view.
    ...(Object.values(p.views).some((v) => v?.motion && v.motion.view !== 'desktop') && {
      motionByView: Object.fromEntries(Object.values(p.views)
        .filter((v) => v?.motion && v.motion.view && v.motion.view !== 'desktop')
        .map((v) => [v.motion.view, v.motion])),
    }),
  }));
  const probed = report.pages.filter((p) => p.motion && !p.motion.error);
  // What share of each page's interactive parts the probes examined, and why they did not reach the rest.
  const covered = report.pages.map((p) => p.coverage).filter(Boolean);
  if (covered.length) {
    const sum = (k) => covered.reduce((n, c) => n + (c[k] ?? 0), 0);
    const merge = (k) => covered.reduce((o, c) => {
      for (const [name, n] of Object.entries(c[k] ?? {})) o[name] = (o[name] ?? 0) + n;
      return o;
    }, {});
    report.coverage = {
      pages: covered.length,
      interactive: sum('interactive'),
      visible: sum('visible'),
      probed: sum('probed'),
      understood: sum('understood'),
      examined: sum('visible') ? Math.round((Math.min(sum('probed'), sum('visible')) / sum('visible')) * 100) : null,
      byKind: merge('byKind'),
      hidden: merge('hidden'),
      // Every reason is one the capture recorded itself; nothing here is inferred.
      reasons: merge('reasons'),
    };
  }
  report.motion = {
    status: probed.length ? 'captured' : 'skipped',
    pages: probed.length,
    hover: probed.reduce((n, p) => n + p.motion.hover, 0),
    focus: probed.reduce((n, p) => n + p.motion.focus, 0),
    rules: probed.reduce((n, p) => n + p.motion.rules, 0),
    // The shapes of the original's state rules, added up over the pages: `sibling`, `adjacent` and `ancestorHas` are
    // the effects that reach outside the hovered element, and ir/motion.js reports how many of them the copy carries.
    shapes: probed.reduce((o, p) => { for (const [k, n] of Object.entries(p.motion.shapes ?? {})) o[k] = (o[k] ?? 0) + n; return o; }, {}),
    // Stylesheets the pages themselves could not read, and what was recovered from them (capture/foreignCss.js).
    unreadableSheets: probed.reduce((n, p) => n + (p.motion.unreadableSheets ?? 0), 0),
    foreign: probed.reduce((o, p) => {
      for (const [k, n] of Object.entries(p.motion.foreign ?? {})) o[k] = (o[k] ?? 0) + n;
      return o;
    }, {}),
    // Scroll reveals (4b.2): how many elements were measured, by what (declared animation vs sampled frames).
    reveal: ['revealed', 'declared', 'sampled', 'unmeasured', 'replay', 'timed', 'groups', 'staggered'].reduce((o, k) => ({ ...o, [k]: probed.reduce((n, p) => n + (p.motion.reveal?.[k] ?? 0), 0) }), {}),
    // Continuous motion (4b.3): loops found by kind and by what they do.
    loops: {
      ...['css', 'waapi', 'script', 'scrollLinked', 'paused'].reduce((o, k) => ({ ...o, [k]: probed.reduce((n, p) => n + (p.motion.loops?.[k] ?? 0), 0) }), {}),
      patterns: probed.reduce((o, p) => { for (const [k, n] of Object.entries(p.motion.loops?.patterns ?? {})) o[k] = (o[k] ?? 0) + n; return o; }, {}),
    },
    // Interactive parts found by clicking (full-site B.1): menus, tabs, sliders, dialogs by kind.
    clicks: {
      pages: probed.filter((p) => p.motion.clicks).length,
      found: probed.reduce((n, p) => n + (p.motion.clicks?.found ?? 0), 0),
      kinds: probed.reduce((o, p) => { for (const [k, n] of Object.entries(p.motion.clicks?.kinds ?? {})) o[k] = (o[k] ?? 0) + n; return o; }, {}),
      notRestored: probed.reduce((n, p) => n + (p.motion.clicks?.notRestored ?? 0), 0),
      left: probed.filter((p) => p.motion.clicks?.left).map((p) => p.path),
    },
    errors: report.pages.filter((p) => p.motion?.error).map((p) => ({ page: p.path, error: p.motion.error })),
    notProbed: report.pages.filter((p) => !p.motion).map((p) => p.path),
    // An exact copy probes every view, so what each narrow layout has of its own is a number rather than an
    // assumption: a menu that only exists on a phone used to be invisible here.
    ...(report.pages.some((p) => p.motionByView) && {
      views: report.pages.reduce((out, p) => {
        for (const [view, m] of Object.entries(p.motionByView ?? {})) {
          const o = out[view] ??= { pages: 0, hover: 0, focus: 0, rules: 0, clicks: 0, states: 0, notices: 0, loops: 0, reveal: 0, errors: 0 };
          o.pages++;
          if (m.error) o.errors++;
          o.hover += m.hover ?? 0;
          o.focus += m.focus ?? 0;
          o.rules += m.rules ?? 0;
          o.clicks += m.clicks?.found ?? 0;
          o.states += m.states?.states ?? 0;
          o.notices += m.notices?.notices ?? 0;
          o.loops += m.loops?.total ?? 0;
          o.reveal += m.reveal?.revealed ?? 0;
        }
        return out;
      }, {}),
    }),
  };
  // Rules were recovered from a stylesheet the pages could not read and not one of them turned out to do anything:
  // either the parser or the way they are put back into the page has stopped working. Said out loud rather than
  // left as a quietly empty result.
  const foreign = report.motion.foreign ?? {};
  if (foreign.rules > 0 && report.motion.hover === 0 && report.motion.focus === 0) {
    report.warnings.push(`${foreign.rules} hover rules were read from ${foreign.sheets} stylesheet(s) the pages may not read themselves, and none of them changed anything: the copy may be missing those effects.`);
  }
  if (foreign.failed > 0) {
    report.warnings.push(`${foreign.failed} stylesheet(s) the pages may not read could not be read here either; hover effects defined in them are not in the copy.`);
  }
  const revealPages = report.pages.filter((p) => Object.values(p.revealPinned).some((n) => n > 0));
  if (revealPages.length) {
    report.warnings.push(`Scroll-reveal content on ${revealPages.length} ${revealPages.length === 1 ? 'page' : 'pages'} was captured in its revealed state (${revealPages.map((p) => p.path).slice(0, 5).join(', ')}); how they appear is recorded in motion.json (the animation is rebuilt in a later 4b step).`);
  }
  report.discovery = {
    pageLimit: ctx.pageLimit,
    crawled: discovery.crawled,
    sitemap: discovery.sitemap,
    skipped: discovery.skipped.map((s) => ({ ...s, detail: SKIP_LABELS[s.reason] })),
    linksToLive: ctx.livePages.map((p) => ({ url: p.url, reason: p.reason ?? 'beyond-limit' })),
    // What the original answers for an address that does not exist, and whether the copy carries that page.
    ...(notFound && { notFound }),
  };
  report.blockedHosts = proxy.blocked();
  // What a backend would do on a recreated page cannot be copied: said for each page that needs one, never faked.
  for (const p of report.pages.filter((x) => x.needsBackend || x.dataUnavailable || x.recovered)) {
    report.manual.push({
      kind: 'page',
      title: p.recovered ? `${p.path} was rebuilt from what is known about it` : `${p.path} was recreated without its backend`,
      detail: p.recovered
        ? `It could not be loaded (${p.recovered.why}). It keeps the site's frame and what the analysis read of it (${p.recovered.evidence.join(', ')}), with its content shown as not available.`
        : p.dataUnavailable
          ? `Its data did not load while it was copied (${p.dataUnavailable.count} request(s) to ${p.dataUnavailable.hosts.join(', ')} failed): it shows the empty or error state the site itself shows, and its forms do not send anything.`
          : 'Its visible page is recreated; signing in, a cart, an account or anything else its server does needs a real backend, and its forms do not send anything.',
      url: p.url,
    });
  }
  report.notRecreated = notRecreated;
  if (notRecreated.length) {
    report.warnings.push(`${notRecreated.length} page(s) could not be recreated even from evidence (${notRecreated.slice(0, 3).map((p) => p.path).join(', ')}${notRecreated.length > 3 ? ', …' : ''}): see "not recreated" in the report for what was missing.`);
  }
  const recoveredCount = report.pages.filter((p) => p.recovered).length;
  if (recoveredCount) report.warnings.push(`${recoveredCount} page(s) could not be loaded and were rebuilt from what is known about them, with their content marked as not available.`);

  await writeFile(
    path.join(ctx.dir, 'capture', 'manifest.json'),
    // robots / llms too: a rebuild from this capture (recreate/replay.js) writes robots.txt and llms.txt from them.
    JSON.stringify({ homeUrl: discovery.homeUrl, origin: discovery.origin, pages, discovery: { ...report.discovery, robots: discovery.robots ?? null, llms: discovery.llms ?? null } }, null, 1),
  );
  ctx.progress(1, `Captured ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
}
