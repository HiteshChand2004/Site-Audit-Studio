// The Analyze pipeline: fetch → [robots/sitemap ‖ render + axe ‖ screenshots] → crawl → link check →
// Lighthouse mobile/desktop → stack detection, analyzers and report assembly. Independent work runs side by side
// (how much, by the free memory: resources.js); Lighthouse runs alone, with time kept for it, so a slow step
// before it shortens that step instead of costing the scores.
// All outbound traffic runs under one SSRF policy: Node fetches check it at connect time, and
// Chromium/Lighthouse go through a local egress proxy that checks it (security/).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../db/index.js';
import { buildContext, detectStack, globalNames, toTechStack } from '../detection/engine.js';
import { detectManualRebuild } from '../detection/manual.js';
import { analyzeA11y } from './analyzers/a11y.js';
import { analyzeAeo } from './analyzers/aeo.js';
import { analyzeCrawl } from './analyzers/crawlChecks.js';
import { buildMetrics, buildScores } from './analyzers/metrics.js';
import { analyzeSeo, crawlErrorsItem } from './analyzers/seo.js';
import { buildWeaknesses } from './analyzers/weaknesses.js';
import { assembleAudit } from './assemble.js';
import { crawl } from './crawler.js';
import { extractPage } from './extract.js';
import { computeFrame } from './frame.js';
import { fetchPage, isBotChallenge, isHtml } from './http.js';
import { runLighthouse } from './lighthouse/run.js';
import { checkLinks } from './linkChecker.js';
import { launchBrowser, renderHome, renderHtml } from './render.js';
import { loadLlmsTxt, loadRobots, parseRobots } from './robots.js';
import { captureScreenshots, VIEWS } from './screenshots.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { userPolicy, withNetPolicy } from '../security/netGuard.js';
import { freeMemoryMB, parallelism } from './resources.js';
import { createSharedCache, sharedCacheEnabled } from './sharedCache.js';
import { loadSitemaps } from './sitemap.js';
import { limiter, withTimeout } from './util.js';

// weight = share of the progress bar; max = the step's own time limit.
export const STEPS = [
  { key: 'fetch', label: 'Fetching homepage', weight: 3, max: 25000 },
  { key: 'robots', label: 'robots.txt & sitemap', weight: 3, max: 30000 },
  // robots, render and screenshots start together and the screenshots go on next to the crawl and the link check (see
  // analyzeSite), so their limits do not add up. The screenshots are listed where they are awaited: the step list of the
  // app shows the earliest step still running and only ever moves forward.
  { key: 'render', label: 'Rendering + accessibility', weight: 14, max: 110000, expected: 15000 },
  { key: 'crawl', label: 'Crawling pages', weight: 18, max: 75000 },
  { key: 'links', label: 'Checking links', weight: 14, max: 50000 },
  { key: 'screenshots', label: 'Screenshots (desktop, tablet, mobile)', weight: 8, max: 80000, expected: 25000 },
  { key: 'lighthouse-mobile', label: 'Lighthouse · mobile', weight: 20, max: 120000, expected: 40000 },
  { key: 'lighthouse-desktop', label: 'Lighthouse · desktop', weight: 20, max: 120000, expected: 35000 },
  { key: 'report', label: 'Building report', weight: 8, max: 30000 },
];
export const PUBLIC_STEPS = STEPS.map(({ key, label }) => ({ key, label }));

// Cap for one analysis (a healthy site takes about a minute; this is for slow sites and busy machines). Steps that would start
// after it are skipped and reported.
const TOTAL_BUDGET_MS = 6 * 60 * 1000;
// Free memory under which the browser steps were probably starved (several browsers, an editor, other apps open): the
// analysis then says so next to its timeouts, so the cause is visible in the report.
const LOW_MEMORY_MB = 1000;
// Time kept for the two Lighthouse runs, the most valuable part of an analysis and the last to run: every step before them
// (including the crawl and the link check, which return what they have) is cut short instead of using it up.
export const LIGHTHOUSE_RESERVE_MS = 120 * 1000;
// A crashed Lighthouse run is tried once more only when at least this much time is left for it.
const LIGHTHOUSE_RETRY_MIN_MS = 45 * 1000;

/**
 * Time limits of one analysis, from the environment (server/.env). The defaults suit a normal machine; a slow or busy one
 * (little free memory, a slow connection) can give every limit more room instead of losing checks to timeouts.
 * SAS_TIMEOUT_SCALE (1–4, default 1) multiplies every step limit, the page-load and accessibility-scan waits, the time kept for
 * Lighthouse and the total; SAS_ANALYZE_MINUTES (1–30) sets the total on its own. Anything out of range means the default.
 */
export function analyzeTiming(env = process.env) {
  const s = Number(env.SAS_TIMEOUT_SCALE);
  const scale = Number.isFinite(s) && s >= 1 && s <= 4 ? s : 1;
  const m = Number(env.SAS_ANALYZE_MINUTES);
  const budgetMs = Number.isFinite(m) && m >= 1 && m <= 30 ? m * 60000 : Math.round(TOTAL_BUDGET_MS * scale);
  return { scale, budgetMs, lighthouseReserveMs: Math.round(LIGHTHOUSE_RESERVE_MS * scale) };
}

/** Time a step may use: its own limit, but never the time kept for the steps that must still run after it. */
export function stepBudget({ max, now, deadline, reserve = 0 }) {
  return Math.min(max, deadline - now - reserve);
}

/** Progress (0–100) through a list of weighted steps. */
export function makeOverallPct(steps) {
  const total = steps.reduce((n, s) => n + s.weight, 0);
  return (stepKey, fraction) => {
    let before = 0;
    for (const s of steps) {
      if (s.key === stepKey) return Math.round(((before + s.weight * Math.min(1, Math.max(0, fraction))) / total) * 100);
      before += s.weight;
    }
    return 0;
  };
}

export const overallPct = makeOverallPct(STEPS);

/** `url` moved from origin `from` to origin `to` (unchanged when it is on another origin). */
function rebaseOrigin(url, from, to) {
  try {
    const u = new URL(url);
    return u.origin === new URL(from).origin ? `${to}${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

/** Thrown when the site cannot be analyzed at all; the job is marked failed. */
export class AnalysisError extends Error {}

const NETWORK_ERRORS = {
  dns: 'The domain name could not be resolved (DNS lookup failed).',
  refused: 'The server refused the connection.',
  timeout: 'The site did not respond in time.',
  ssl: 'The site has an invalid TLS/SSL certificate.',
  'too-many-redirects': 'The homepage redirects too many times.',
};

/** Public URL of a stored screenshot (routes/screens.js). */
export const screenUrl = (projectId, analysisId, file) => `/api/projects/${projectId}/analyses/${analysisId}/screens/${file}`;

function publicScreenshots(projectId, analysisId, shots) {
  if (!shots || !Object.keys(shots.views).length) return null;
  const views = {};
  for (const [id, v] of Object.entries(shots.views)) {
    views[id] = {
      ...v,
      fold: { ...v.fold, url: screenUrl(projectId, analysisId, v.fold.file) },
      full: { ...v.full, url: screenUrl(projectId, analysisId, v.full.file) },
    };
  }
  return { analysisId, capturedAt: shots.capturedAt, views };
}

async function fetchHome(url, scale = 1) {
  let home = await fetchPage(url, { timeout: 20000 * scale });
  // A server that is slow to wake up (a cold start, a busy moment) gets one more try before the analysis is given up.
  if (home.error === 'timeout') home = await fetchPage(url, { timeout: 30000 * scale });
  if (home.error === 'blocked') throw new AnalysisError(home.message);
  if (home.error) throw new AnalysisError(`Could not reach ${url}. ${NETWORK_ERRORS[home.error] ?? 'Network error.'}`);
  if (isBotChallenge(home)) {
    throw new AnalysisError(
      'The site answered with a bot-protection challenge (for example Cloudflare). Allowlist this server or pause the challenge for the audit; Site Audit Studio does not bypass bot protection.',
    );
  }
  if (home.status >= 400) throw new AnalysisError(`The homepage returned HTTP ${home.status}.`);
  if (!isHtml(home)) throw new AnalysisError(`The URL is not an HTML page (${home.contentType || 'unknown content type'}).`);
  return home;
}

/**
 * @param {object} o
 * @param {object} o.project
 * @param {string} o.analysisId
 * @param {number} o.maxPages
 * @param {(step:string, fraction:number, message?:string)=>void} o.progress
 * @param {object} [o.netPolicy]  SSRF policy. User projects always get the default user policy;
 *   only platform code (Phase 5 re-audit of its own preview servers) passes an internal one.
 * The options below are for the re-audit of a recreated site (reaudit/); Analyze never sets them.
 * @param {string} [o.url]  the site to analyze (default: the project URL)
 * @param {string} [o.outDir]  where the raw results go (default: data/projects/<id>/audit/<analysisId>/)
 * @param {string[]} [o.skip]  step keys to leave out without an error (for example 'screenshots')
 * @param {string[]} [o.seedUrls]  pages the crawl must visit besides the ones it finds itself
 * @param {string} [o.deployOrigin]  the origin the analyzed site will be published at: sitemaps that
 *   robots.txt lists there are read from the analyzed site instead (a recreate names its future home)
 * @returns {Promise<object>} the audit JSON
 */
export function runAnalysis({ netPolicy = userPolicy(), ...opts }) {
  return withNetPolicy(netPolicy, () => analyze({ ...opts, netPolicy }));
}

async function analyze({ project, analysisId, maxPages, progress, netPolicy, url = project.url, outDir: dir, skip = [], seedUrls = [], deployOrigin = null }) {
  const timing = analyzeTiming();
  const freeAtStart = freeMemoryMB();
  const deadline = Date.now() + timing.budgetMs;
  const errors = [];
  const skipped = new Set(skip);
  const outDir = dir ?? path.join(projectDir(project.id), 'audit', analysisId);
  await mkdir(outDir, { recursive: true });
  const save = (name, data) => writeFile(path.join(outDir, name), JSON.stringify(data, null, 1)).catch(() => {});

  // Runs one step with its time limit. Failures are recorded and the pipeline continues with `fallback`.
  // A step the caller skips returns `fallback` without an error or progress.
  // `reserve`: time that must stay for the steps after this one (Lighthouse); this step gets what is left of its own limit.
  async function step(key, fn, fallback = null, { reserve = 0 } = {}) {
    if (skipped.has(key)) return fallback;
    const def = STEPS.find((s) => s.key === key);
    progress(key, 0);
    const budget = stepBudget({ max: def.max * timing.scale, now: Date.now(), deadline, reserve });
    if (budget < 5000) {
      errors.push({
        step: key,
        message: reserve && deadline - Date.now() >= 5000 ? 'Skipped: the time that is left is kept for the checks after it.' : 'Skipped: the analysis time budget ran out.',
      });
      progress(key, 1);
      return fallback;
    }
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), budget);
    // Steps without their own progress get a time-based estimate so the bar keeps moving.
    const started = Date.now();
    const ticker = def.expected
      ? setInterval(() => progress(key, Math.min(0.9, (Date.now() - started) / def.expected)), 1000)
      : null;
    try {
      return await withTimeout(fn(controller.signal, budget), budget + 10000, def.label);
    } catch (err) {
      errors.push({ step: key, message: err.message });
      return fallback;
    } finally {
      clearTimeout(abortTimer);
      if (ticker) clearInterval(ticker);
      progress(key, 1);
    }
  }

  // 1. Homepage. Failing here fails the whole analysis.
  progress('fetch', 0, `Fetching ${url}`);
  const home = await fetchHome(url, timing.scale);
  const origin = new URL(home.url).origin;
  progress('fetch', 1);

  const proxy = await startEgressProxy(netPolicy);
  try {
    const audit = await analyzeSite({ project, analysisId, maxPages, progress, errors, outDir, save, step, home, origin, proxy, skipped, seedUrls, deployOrigin, timing });
    noteLowMemory(audit.errors, freeAtStart);
    return audit;
  } finally {
    await proxy.close();
  }
}

/** Timeouts on a machine that was short of memory when the analysis started: the report names the likely cause and the remedy. */
export function noteLowMemory(errors, freeMB) {
  if (!(freeMB < LOW_MEMORY_MB)) return;
  if (!errors.some((e) => /timed out|time limit|time budget|time that is left/i.test(e.message))) return;
  errors.push({
    step: 'memory',
    message: `Only ${Math.round(freeMB)} MB of memory was free when the analysis started, so the browser steps were slowed down. Close other apps (browsers, editors, a running Recreate) and analyze again, or give a slow machine more time with SAS_TIMEOUT_SCALE in server/.env.`,
  });
}

async function analyzeSite({ project, analysisId, maxPages, progress, errors, outDir, save, step, home, origin, proxy, skipped, seedUrls, deployOrigin, timing }) {
  // The time kept for Lighthouse: the steps before it (and the crawl / link check, which can return what they have) never use it up.
  const reserve = { reserve: timing.lighthouseReserveMs };
  const scale = timing.scale;

  // 2-4. Independent work runs side by side. robots.txt / sitemap are plain HTTP; the homepage render (with axe) and the three
  // screenshot views each have their own browser context; the crawl needs the robots rules and the rendered homepage. Run one
  // after the other this was the longest part of an analysis, and every slow step pushed the later ones over the time limit.
  const emptyRobots = { status: 'error', sitemaps: [], blockedAiCrawlers: [], blocksAll: false, isAllowed: parseRobots(`${origin}/robots.txt`, '').isAllowed };
  let browser = null;
  let browserTask = null;
  const getBrowser = () => (browserTask ??= launchBrowser({ proxy: proxy.url }).then((b) => (browser = b)));
  // The homepage is loaded in four browser contexts (the render and three screenshot views) and the crawl may render more
  // pages of the site: they share the static files, so a stylesheet, script, image or font is downloaded once.
  const cache = sharedCacheEnabled() ? createSharedCache() : null;
  // Views captured at once: all three when the machine has the memory for them, fewer when it is already short of it.
  const viewsAtOnce = parallelism({ max: VIEWS.length });
  // Pages the crawl renders at once (client-rendered sites only): it runs while the screenshots are still being taken.
  const renderSlot = limiter(parallelism({ max: 3 }));
  // Really short of memory (room for one page at a time): the screenshots wait for the homepage render instead of competing
  // with it. Side by side, both slowed each other down until neither finished in its time limit.
  const oneAtATime = viewsAtOnce === 1;

  const robotsTask = step(
    'robots',
    async () => {
      const [r, l] = await Promise.all([loadRobots(origin), loadLlmsTxt(origin)]);
      progress('robots', 0.5, 'Reading sitemap');
      const sitemaps = deployOrigin ? r.sitemaps.map((u) => rebaseOrigin(u, deployOrigin, origin)) : r.sitemaps;
      return { robots: r, llms: l, sitemap: await loadSitemaps(origin, sitemaps) };
    },
    { robots: emptyRobots, sitemap: { status: 'missing', urls: [], sources: [], fromRobots: false }, llms: { found: false } },
    reserve,
  );
  const renderTask = step('render', async () => renderHome(await getBrowser(), home.url, { globals: globalNames(), cache, scale }), null, reserve);
  // The views already taken are kept when the step runs out of time (deadline): one slow view must not lose the other two.
  const shots$ = () =>
    step(
      'screenshots',
      async (_signal, budget) =>
        captureScreenshots(await getBrowser(), home.url, outDir, { timeout: Math.max(5000, Math.min(30000 * scale, budget - 5000)), parallel: viewsAtOnce, deadline: Date.now() + budget - 2000, cache }),
      null,
      reserve,
    );
  const shotsTask = oneAtATime ? renderTask.then(shots$, shots$) : shots$();

  let crawlResult;
  let shots = null;
  let linksTask = null;
  let robots;
  let sitemap;
  let llms;
  let render = null;
  try {
    ({ robots, sitemap, llms } = await robotsTask);
    render = await renderTask;
    if (render?.axeError) errors.push({ step: 'render', message: `Accessibility scan failed: ${render.axeError}` });
    if (render?.axe) save('axe.json', render.axe);

    const renderForCrawl = browser
      ? (url) => (render && url === home.url ? Promise.resolve({ html: render.html }) : renderSlot(() => renderHtml(browser, url, { cache, scale })))
      : undefined;
    crawlResult = await step(
      'crawl',
      (signal) =>
        crawl({
          home,
          maxPages,
          robots,
          sitemapUrls: sitemap.urls,
          seedUrls,
          render: renderForCrawl,
          signal,
          onProgress: (done, total) => progress('crawl', done / Math.max(total, 1), `Crawled ${done} of ${total} pages`),
        }),
      null,
      reserve,
    );
    if (!crawlResult) {
      const facts = extractPage(home.body, home.url);
      crawlResult = { pages: [{ url: home.url, status: home.status, depth: 0, facts: { ...facts, rawTextLength: facts.textLength } }], skippedByRobots: 0 };
    }
    // 5. Links: plain HTTP, so it runs while the last screenshots are still being taken.
    linksTask = step(
      'links',
      (signal) => checkLinks({ pages: crawlResult.pages, signal, onProgress: (done, total) => progress('links', done / total, `Checked ${done} of ${total} links`) }),
      { checked: 0, total: 0, broken: [], unverified: [] },
      reserve,
    );
    shots = await shotsTask;
    for (const e of shots?.errors ?? []) errors.push({ step: 'screenshots', message: `${e.view}: ${e.message}` });
  } finally {
    // The browser is closed before Lighthouse: it runs on a quiet machine.
    await shotsTask.catch(() => {});
    await browser?.close().catch(() => {});
    await cache?.close();
  }
  const links = await linksTask;
  const allPages = crawlResult.pages;
  const pages = allPages.filter((p) => p.facts);
  const homePage = { ...pages[0], headers: home.headers };

  // 6. Lighthouse (one at a time and nothing else running: parallel work would distort each other's performance numbers).
  // A run that dies (not one that times out) usually died of memory pressure: it gets one more try when the time allows.
  const lighthouse = (key, formFactor, reserveMs = 0) =>
    step(key, async (_signal, budget) => {
      const started = Date.now();
      const options = (timeout) => ({ timeout, outFile: path.join(outDir, `lighthouse-${formFactor}.json`), proxy: proxy.url });
      try {
        return await runLighthouse(home.url, formFactor, options(budget));
      } catch (err) {
        const left = budget - (Date.now() - started) - 3000;
        if (/timed out/i.test(err.message) || left < LIGHTHOUSE_RETRY_MIN_MS) throw err;
        return runLighthouse(home.url, formFactor, options(left));
      }
    }, null, { reserve: reserveMs });
  // The mobile run leaves half of the reserve to the desktop run, so a slow first run never costs the second one.
  const mobile = await lighthouse('lighthouse-mobile', 'mobile', timing.lighthouseReserveMs / 2);
  const desktop = await lighthouse('lighthouse-desktop', 'desktop');

  // 7. Detection, analyzers, report
  progress('report', 0, 'Detecting tech stack');
  const ctx = buildContext({ headers: home.headers, rawHtml: home.body, render, assets: homePage.facts.assets, origin });
  const detections = await detectStack(ctx).catch((err) => {
    errors.push({ step: 'report', message: `Stack detection failed: ${err.message}` });
    return [];
  });
  const manualRebuild = await detectManualRebuild(ctx, detections, render).catch(() => []);
  progress('report', 0.6, 'Writing report');

  save('crawl.json', {
    pages: allPages,
    skippedByRobots: crawlResult.skippedByRobots,
    truncated: crawlResult.truncated,
    robots: { ...robots, isAllowed: undefined },
    sitemap,
    llms,
    links,
    // Homepage text after JavaScript (the "Content without JavaScript" check; the fix checklist re-scores it).
    renderedTextLength: render?.textLength ?? null,
  });

  const audit = assembleAudit({
    project,
    analysisId,
    url: home.url,
    frame: computeFrame(home.headers, { url: home.url, html: render?.html || home.body }),
    screenshots: publicScreenshots(project.id, analysisId, shots),
    metrics: buildMetrics(mobile, 'mobile'),
    metricsByDevice: { mobile: buildMetrics(mobile, 'mobile'), desktop: buildMetrics(desktop, 'desktop') },
    scores: buildScores(mobile, desktop),
    techStack: toTechStack(detections),
    weaknesses: buildWeaknesses(detections, mobile),
    seo: [...analyzeSeo(pages, homePage), crawlErrorsItem(allPages)],
    aeo: analyzeAeo({ pages, home: homePage, robots, llms, renderedTextLength: render?.textLength ?? null }),
    crawl: analyzeCrawl({ robots, sitemap, homeFacts: homePage.facts }),
    links,
    accessibility: analyzeA11y(render?.axe),
    manualRebuild,
    pagesCrawled: pages.length,
    blockedHosts: proxy.blocked(),
    errors,
  });
  progress('report', 1);
  return audit;
}
