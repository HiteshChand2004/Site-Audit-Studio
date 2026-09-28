// The Analyze pipeline: fetch → robots/sitemap → render + axe → screenshots → crawl → link check →
// Lighthouse mobile/desktop → stack detection, analyzers and report assembly.
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
import { captureScreenshots } from './screenshots.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { userPolicy, withNetPolicy } from '../security/netGuard.js';
import { loadSitemaps } from './sitemap.js';
import { withTimeout } from './util.js';

// weight = share of the progress bar; max = the step's own time limit.
export const STEPS = [
  { key: 'fetch', label: 'Fetching homepage', weight: 3, max: 25000 },
  { key: 'robots', label: 'robots.txt & sitemap', weight: 3, max: 30000 },
  { key: 'render', label: 'Rendering + accessibility', weight: 14, max: 75000, expected: 15000 },
  { key: 'screenshots', label: 'Screenshots (desktop, tablet, mobile)', weight: 8, max: 60000, expected: 25000 },
  { key: 'crawl', label: 'Crawling pages', weight: 18, max: 75000 },
  { key: 'links', label: 'Checking links', weight: 14, max: 50000 },
  { key: 'lighthouse-mobile', label: 'Lighthouse · mobile', weight: 20, max: 95000, expected: 40000 },
  { key: 'lighthouse-desktop', label: 'Lighthouse · desktop', weight: 20, max: 95000, expected: 35000 },
  { key: 'report', label: 'Building report', weight: 8, max: 30000 },
];
export const PUBLIC_STEPS = STEPS.map(({ key, label }) => ({ key, label }));

// Hard cap for one analysis. Steps that would start after it are skipped and reported.
const TOTAL_BUDGET_MS = 5 * 60 * 1000;

export function overallPct(stepKey, fraction) {
  const total = STEPS.reduce((n, s) => n + s.weight, 0);
  let before = 0;
  for (const s of STEPS) {
    if (s.key === stepKey) return Math.round(((before + s.weight * Math.min(1, Math.max(0, fraction))) / total) * 100);
    before += s.weight;
  }
  return 0;
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

async function fetchHome(url) {
  const home = await fetchPage(url, { timeout: 20000 });
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
 * @returns {Promise<object>} the audit JSON
 */
export function runAnalysis({ netPolicy = userPolicy(), ...opts }) {
  return withNetPolicy(netPolicy, () => analyze({ ...opts, netPolicy }));
}

async function analyze({ project, analysisId, maxPages, progress, netPolicy }) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const errors = [];
  const outDir = path.join(projectDir(project.id), 'audit', analysisId);
  await mkdir(outDir, { recursive: true });
  const save = (name, data) => writeFile(path.join(outDir, name), JSON.stringify(data, null, 1)).catch(() => {});

  // Runs one step with its time limit. Failures are recorded and the pipeline continues with `fallback`.
  async function step(key, fn, fallback = null) {
    const def = STEPS.find((s) => s.key === key);
    progress(key, 0);
    const budget = Math.min(def.max, deadline - Date.now());
    if (budget < 5000) {
      errors.push({ step: key, message: 'Skipped: the analysis time budget ran out.' });
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
  progress('fetch', 0, `Fetching ${project.url}`);
  const home = await fetchHome(project.url);
  const origin = new URL(home.url).origin;
  progress('fetch', 1);

  const proxy = await startEgressProxy(netPolicy);
  try {
    return await analyzeSite({ project, analysisId, maxPages, progress, errors, outDir, save, step, home, origin, proxy });
  } finally {
    await proxy.close();
  }
}

async function analyzeSite({ project, analysisId, maxPages, progress, errors, outDir, save, step, home, origin, proxy }) {
  // 2. robots.txt, sitemap, llms.txt
  const emptyRobots = { status: 'error', sitemaps: [], blockedAiCrawlers: [], blocksAll: false, isAllowed: parseRobots(`${origin}/robots.txt`, '').isAllowed };
  const { robots, sitemap, llms } = await step(
    'robots',
    async () => {
      const [r, l] = await Promise.all([loadRobots(origin), loadLlmsTxt(origin)]);
      progress('robots', 0.5, 'Reading sitemap');
      return { robots: r, llms: l, sitemap: await loadSitemaps(origin, r.sitemaps) };
    },
    { robots: emptyRobots, sitemap: { status: 'missing', urls: [], sources: [], fromRobots: false }, llms: { found: false } },
  );

  // 3 + 4. Render the homepage (with axe), then crawl, sharing one browser.
  let browser = null;
  let render = null;
  let shots = null;
  let crawlResult;
  try {
    render = await step('render', async () => {
      browser = await launchBrowser({ proxy: proxy.url });
      return renderHome(browser, home.url, { globals: globalNames() });
    });
    if (render?.axeError) errors.push({ step: 'render', message: `Accessibility scan failed: ${render.axeError}` });
    if (render?.axe) save('axe.json', render.axe);

    shots = browser
      ? await step('screenshots', (_signal, budget) => captureScreenshots(browser, home.url, outDir, { timeout: Math.max(5000, Math.min(30000, budget - 5000)) }))
      : (errors.push({ step: 'screenshots', message: 'Skipped: the browser could not be started.' }), null);
    for (const e of shots?.errors ?? []) errors.push({ step: 'screenshots', message: `${e.view}: ${e.message}` });

    const renderForCrawl = browser
      ? (url) => (render && url === home.url ? Promise.resolve({ html: render.html }) : renderHtml(browser, url))
      : undefined;
    crawlResult = await step('crawl', (signal) =>
      crawl({
        home,
        maxPages,
        robots,
        sitemapUrls: sitemap.urls,
        render: renderForCrawl,
        signal,
        onProgress: (done, total) => progress('crawl', done / Math.max(total, 1), `Crawled ${done} of ${total} pages`),
      }),
    );
  } finally {
    await browser?.close().catch(() => {});
  }
  if (!crawlResult) {
    const facts = extractPage(home.body, home.url);
    crawlResult = { pages: [{ url: home.url, status: home.status, depth: 0, facts: { ...facts, rawTextLength: facts.textLength } }], skippedByRobots: 0 };
  }
  const allPages = crawlResult.pages;
  const pages = allPages.filter((p) => p.facts);
  const homePage = { ...pages[0], headers: home.headers };

  // 5. Links
  const links = await step(
    'links',
    (signal) => checkLinks({ pages: allPages, signal, onProgress: (done, total) => progress('links', done / total, `Checked ${done} of ${total} links`) }),
    { checked: 0, total: 0, broken: [], unverified: [] },
  );

  // 6. Lighthouse (sequential: parallel runs would distort each other's performance numbers)
  const mobile = await step('lighthouse-mobile', (_signal, budget) =>
    runLighthouse(home.url, 'mobile', { timeout: budget, outFile: path.join(outDir, 'lighthouse-mobile.json'), proxy: proxy.url }),
  );
  const desktop = await step('lighthouse-desktop', (_signal, budget) =>
    runLighthouse(home.url, 'desktop', { timeout: budget, outFile: path.join(outDir, 'lighthouse-desktop.json'), proxy: proxy.url }),
  );

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
