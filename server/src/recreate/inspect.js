// Recreate step 1, "Inspecting pages": page discovery, then a Playwright capture of every selected
// page at 1440 / 768 / 375. Chromium runs behind the SSRF egress proxy, like Analyze.
// Writes capture/manifest.json and sets ctx.pages / ctx.discovery for the later steps.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import { createSharedCache, sharedCacheEnabled } from '../audit/sharedCache.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { capturePage } from './capture/index.js';
import { discoverPages, SKIP_LABELS } from './discover.js';
import { RecreateError } from './errors.js';
import { causeText, recoverFailure, recoverHit } from './interrupts.js';

// Captures stop starting new pages this long before the step's time limit.
const INSPECT_MARGIN = 15000;
// A page still being captured is abandoned this long before the limit (shorter than INSPECT_MARGIN, so a page that was
// started in time and is merely slow still gets its chance).
const PAGE_LIMIT_MARGIN = 5000;
// Time per page for the hover / focus probing of the desktop view.
const MOTION_BUDGET = 8000;
// Clicking menus, tabs, sliders and dialogs (full-site B.1, capture/clicks.js), after the hover probe.
const CLICK_BUDGET = 15000;
// Time of the whole job kept for the steps after capture (assets, generate, build, preview), for BASE_PAGES pages; more pages
// keep more (ctx.laterReserve, recreate/index.js).
export const LATER_STEPS_RESERVE = 150000;
// A page (not the homepage) is abandoned after max(PAGE_CAP_MIN, PAGE_CAP_FACTOR × the slowest page so far) and tried once
// more at the end of the step, in a fresh browser.
const PAGE_CAP_MIN = 240000;
const PAGE_CAP_FACTOR = 3;

const once = (fn) => {
  let done = null;
  return () => (done ??= fn());
};

/** @param {object} ctx  the pipeline context (recreate/index.js) */
export async function inspectStage(ctx) {
  const { report } = ctx;
  ctx.progress(0, 'Finding pages');
  const discover = () =>
    discoverPages({
      url: ctx.audit.url ?? ctx.project.url,
      limit: ctx.pageLimit,
      all: ctx.allPages,
      signal: ctx.signal,
      onProgress: (f, message) => ctx.progress(0.2 * f, message),
    });
  let discovery;
  const discoverStarted = Date.now();
  try {
    discovery = await discover();
  } catch (err) {
    // The homepage could not be loaded because the computer slept or the network dropped: once more when it is back.
    const network = /Could not load the homepage \((timeout|dns|refused|error)\)/.test(err.message);
    const again = await recoverFailure(ctx, { step: 'inspect', what: 'finding pages', message: err.message, startedAt: discoverStarted, network, progress: (m) => ctx.progress(0, m) });
    if (!again) throw err;
    ctx.progress(0, `Finding pages again (${causeText(again)})`);
    discovery = await discover();
  }

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
  if (sharedCacheEnabled() && !ctx.netCache) {
    ctx.netCache = createSharedCache();
    ctx.defer(() => ctx.netCache.close());
  }

  // The limits follow the work: every page beyond the base set extends this step, the job and the later steps (index.js).
  ctx.scaleToPages?.(discovery.pages.length);

  const captured = new Map(); // discovery index → page (kept in discovery order, the homepage first)
  const failedPages = [];
  const notCaptured = [];
  const stalled = []; // pages abandoned the first time: { i, info }
  const abandoned = []; // their captures, which end when the browser closes
  try {
    browser = await launchBrowser({ proxy: proxy.url });
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

    // One capture of a page; null = abandoned: it stalled past its own cap (a slow server, an animation that never settles)
    // or the step's limit. A stalled page must not hold up the others or take the pages captured so far down with it.
    // Only the homepage waits without a cap (the step's own limit still applies).
    const captureOnce = async (info, i) => {
      // Hover / focus probing (4b.1) takes a few seconds per page: only while the step has time to spare.
      const spare = deadline() - Date.now() - slowest * 2;
      const capture = (ctx.capturePage ?? capturePage)(browser, info, ctx.dir, {
        motionBudgetMs: spare > MOTION_BUDGET * 2 ? MOTION_BUDGET : 0,
        clickBudgetMs: spare > (MOTION_BUDGET + CLICK_BUDGET) * 2 ? CLICK_BUDGET : 0,
        cache: ctx.netCache,
      });
      if (i === 0) return capture;
      const until = Math.min(pageLimit(), Date.now() + Math.max(ctx.pageCapMin ?? PAGE_CAP_MIN, slowest * PAGE_CAP_FACTOR));
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1000, until - Date.now())); });
      const r = await Promise.race([capture, timeout]);
      clearTimeout(timer);
      if (r === null) abandoned.push(capture.catch(() => {}));
      return r;
    };
    // A finished capture: kept when it has the desktop view (the base layout), else the page is reported.
    const keep = (i, info, { views, errors }) => {
      for (const e of errors) report.errors.push({ step: 'inspect', message: `${info.path} (${e.view}): ${e.message}` });
      if (!views.desktop) {
        if (i === 0) throw new RecreateError(`The homepage could not be captured: ${errors[0]?.message ?? 'unknown error'}`);
        failedPages.push({ url: info.url, source: info.source, reason: 'capture-failed' });
        return;
      }
      captured.set(i, { ...info, views });
    };
    const outOfTime = (info) => {
      notCaptured.push(info.path);
      failedPages.push({ url: info.url, source: info.source, reason: 'time-limit' });
    };

    for (const [i, info] of discovery.pages.entries()) {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      if (i > 0 && Date.now() + slowest > deadline()) {
        for (const rest of discovery.pages.slice(i)) outOfTime(rest);
        break;
      }
      const at = 0.2 + 0.75 * (i / total);
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
        continue;
      }
      slowest = Math.max(slowest, Date.now() - started);
      keep(i, info, result);
    }

    // Pages that stalled get one more try, in a fresh browser: closing the first one ends their captures, so a second
    // capture never shares its folder with one that is still writing.
    if (stalled.length && !ctx.signal.aborted) {
      await closeBrowser();
      await Promise.race([Promise.all(abandoned), new Promise((r) => setTimeout(r, 10000))]);
      browser = await launchBrowser({ proxy: proxy.url });
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
        keep(i, info, result);
      }
    }
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
  }));
  const probed = report.pages.filter((p) => p.motion && !p.motion.error);
  report.motion = {
    status: probed.length ? 'captured' : 'skipped',
    pages: probed.length,
    hover: probed.reduce((n, p) => n + p.motion.hover, 0),
    focus: probed.reduce((n, p) => n + p.motion.focus, 0),
    rules: probed.reduce((n, p) => n + p.motion.rules, 0),
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
  };
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
  };
  report.blockedHosts = proxy.blocked();
  for (const s of discovery.skipped.filter((s) => s.reason === 'backend')) {
    report.manual.push({ kind: 'page', title: `${new URL(s.url).pathname} was not recreated`, detail: SKIP_LABELS.backend, url: s.url });
  }

  await writeFile(
    path.join(ctx.dir, 'capture', 'manifest.json'),
    JSON.stringify({ homeUrl: discovery.homeUrl, origin: discovery.origin, pages, discovery: report.discovery }, null, 1),
  );
  ctx.progress(1, `Captured ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
}
