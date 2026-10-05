// Recreate step 3, "Generating site": builds the IR from the captures and the local assets (with the
// WordPress REST content when the site is WordPress), applies the fixers (fixers/), writes the plain
// HTML site to site/ (pages at their original paths, css/site.css, assets/), then runs a short fit
// pass: the site is rendered at the three views, elements whose box is off get a size fix, and the
// site is written again. A round that lowers the layout score is undone. The production build, the
// safety gate and the verification of dist/ follow in the build step (build/index.js).
// Writes ir/site.json (the IR the other stack emitters will use) and sets ctx.generated.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emitSite } from './emit/html.js';
import { writeProject } from './emit/write.js';
import { applyIrFixes, applyTreeFixes, fixReport } from './fixers/index.js';
import { fetchWordPress, isWordPress } from './fixers/wordpress.js';
import { buildIR, numberNodes, prepareSite, readPageCaptures } from './ir/index.js';
import { applyMotion, readPageMotion } from './ir/motion.js';
import { applyWidgets, readPageClicks } from './ir/widgets.js';
import { isElement } from './ir/tree.js';
import { compareLayout, openRenderer, planFixes, renderPage, viewScore } from './verify/layout.js';
import { REFINE_PAGES, refineResponsive } from './verify/refine.js';

export const FIT_ROUNDS = 2;
// The fit pass stops starting new rounds this long before the step's time limit.
const FIT_MARGIN = 25000;
// Time for the WordPress REST lookup.
const WP_BUDGET = 30000;
// Time for the breakpoint / fluid type check against the original's sweep.
const REFINE_BUDGET = 90000;
// How long that check waits for the sweep's first pages when the sweep is still running.
const SWEEP_WAIT = 75000;

const writeSite = (siteDir, out, assetsDir, known) => writeProject(siteDir, out, { assetsDir, known });

/** Opens the shared renderer for the generated site once per job (closed when the job ends). */
export async function siteRenderer(ctx) {
  if (!ctx.renderer) {
    ctx.renderer = await openRenderer(path.join(ctx.dir, 'site'));
    const renderer = ctx.renderer;
    ctx.defer(() => renderer.close());
  }
  return ctx.renderer;
}

/**
 * Renders every page of the measurement build (with data-sas-id) in every captured view. A page that cannot be rendered
 * (the browser crashed twice on it, or it never loaded) is listed in `failed` and the other pages go on: one page never
 * throws away the work of the whole job. Only when no page renders at all is the error raised (the build itself is broken).
 * @param {(page:object, view:string, result:object)=>Promise<void>|void} onView
 * @param {number} [deadline]  no new page is started after this time (ms since epoch)
 * @returns {Promise<{ started: number, failed: { path: string, error: string }[] }>} pages started before the deadline, pages that failed
 */
export async function measureSite(renderer, ir, site, { screenshot = false, onView, deadline = Infinity } = {}) {
  const measured = emitSite(ir, { ids: true });
  for (const page of ir.pages) renderer.server.overrides.set(page.outPath, measured.files.get(page.outPath));
  const failed = [];
  let firstError = null;
  try {
    let started = ir.pages.length;
    for (const [i, page] of ir.pages.entries()) {
      if (Date.now() > deadline) {
        started = i;
        break;
      }
      const tree = site.pages[i];
      try {
        await Promise.all(tree.views.map(async (view) => {
          const result = await renderPage(renderer, page.outPath, view, { screenshot });
          await onView(tree, view, result);
        }));
      } catch (err) {
        firstError ??= err;
        failed.push({ path: tree.info.path, error: String(err?.message ?? err).split('\n')[0].trim() });
      }
    }
    if (started && failed.length === started) throw firstError;
    return { started, failed };
  } finally {
    renderer.server.overrides.clear();
  }
}

const snapshotFixes = (site) => {
  const saved = new Map();
  const walk = (n) => {
    if (!isElement(n)) return;
    if (n.fix) saved.set(n, structuredClone(n.fix));
    n.children.forEach(walk);
  };
  site.pages.forEach((t) => walk(t.root));
  return saved;
};
const restoreFixes = (site, saved) => {
  const walk = (n) => {
    if (!isElement(n)) return;
    if (saved.has(n)) n.fix = saved.get(n);
    else delete n.fix;
    n.children.forEach(walk);
  };
  site.pages.forEach((t) => walk(t.root));
};

/** @param {object} ctx  pipeline context: needs ctx.pages (inspect) and ctx.assets (assets) */
export async function generateStage(ctx) {
  const { report } = ctx;
  const siteDir = path.join(ctx.dir, 'site');
  const assetsDir = path.join(ctx.dir, 'assets');
  const known = new Set((ctx.assets?.files ?? []).map((f) => f.file));

  const origin = ctx.discovery?.origin ?? new URL(ctx.audit.url ?? ctx.project.url).origin;

  // WordPress: clean content from the REST API, when the analysis detected WordPress.
  let wp = null;
  if (isWordPress(ctx.audit)) {
    ctx.progress(0, 'Reading WordPress content');
    wp = await fetchWordPress({ origin, pages: ctx.pages, signal: ctx.signal, deadline: Math.min(Date.now() + WP_BUDGET, ctx.stepDeadline - FIT_MARGIN * 2) });
  }

  ctx.progress(0.05, 'Reading captured pages');
  const pages = [];
  for (const info of ctx.pages) pages.push({ info, captures: await readPageCaptures(ctx.dir, info) });
  const site = prepareSite({
    pages,
    assets: ctx.assets ?? { map: {} },
    baseUrl: ctx.baseUrl,
    origin,
    livePages: ctx.livePages,
    skipped: ctx.discovery?.skipped,
    wp,
    robots: ctx.discovery?.robots ?? null,
    llms: ctx.discovery?.llms ?? null,
  });
  pages.length = 0;
  for (const t of site.pages) delete t.captures; // large; everything needed is in the trees now

  // Motion (4b.4): hover, focus, scroll reveal and loops from the motion capture become tokens on the nodes + ir.motion.
  const motionByPath = new Map();
  for (const info of ctx.pages) {
    const found = await readPageMotion(ctx.dir, info);
    if (found) motionByPath.set(info.path, found);
  }
  const motion = applyMotion(site, motionByPath);
  site.motion = motion.motion;
  // Interactive parts (full-site C.1): menus, dropdowns, accordions, tabs, sliders and dialogs the click capture found.
  // They are driven by the same generated script as the scroll reveal, so a site with them carries js/motion.js.
  const clicksByPath = new Map();
  for (const info of ctx.pages) {
    const found = await readPageClicks(ctx.dir, info);
    if (found) clicksByPath.set(info.path, found);
  }
  const widgets = applyWidgets(site, clicksByPath);
  site.widgets = widgets.widgets;
  // Content inserted for script-built panels (C.8) gets measurement ids like every other node.
  for (const t of site.pages) if (t.renumber) {
    t.nodes = numberNodes(t.root);
    delete t.renumber;
  }
  if (site.widgets) site.motion = { version: 1, hover: [], focus: [], reveal: [], delays: [], loops: [], ...(site.motion ?? {}), script: true };

  ctx.progress(0.12, 'Fixing audit issues');
  const treeFixes = applyTreeFixes(site, { audit: ctx.audit, skipped: ctx.discovery?.skipped });
  let irFixes;
  const build = () => {
    const built = buildIR(site);
    irFixes = applyIrFixes(built.ir);
    return built;
  };

  ctx.progress(0.15, 'Writing pages');
  let { ir, stats } = build();
  let out = emitSite(ir);
  await writeSite(siteDir, out, assetsDir, known);

  // Fit pass.
  const fit = { rounds: 0, widthFixes: 0, heightFixes: 0, layoutBefore: null, layoutAfter: null, undone: false, stopped: null };
  const renderer = await siteRenderer(ctx);
  let saved = null;
  for (let round = 0; round <= FIT_ROUNDS; round++) {
    if (Date.now() > ctx.stepDeadline - FIT_MARGIN) {
      fit.stopped = 'time-limit';
      break;
    }
    ctx.progress(0.3 + 0.6 * (round / (FIT_ROUNDS + 1)), round ? `Fitting layout (round ${round} of ${FIT_ROUNDS})` : 'Checking layout');
    const views = [];
    const { failed } = await measureSite(renderer, ir, site, {
      onView: (tree, view, result) => {
        views.push({ tree, view, rects: result.rects, score: viewScore(compareLayout(tree.root, view, result.rects), null) });
      },
    });
    // A page the browser could not render keeps the layout it has (no fixes planned for it this round).
    for (const f of failed) if (!fit.failed?.some((x) => x.path === f.path)) (fit.failed ??= []).push(f);
    const score = Math.round(views.reduce((n, x) => n + x.score, 0) / Math.max(1, views.length));
    if (round === 0) fit.layoutBefore = score;
    if (saved && score < fit.layoutAfter) {
      // The last round made things worse: undo it.
      restoreFixes(site, saved);
      ({ ir, stats } = build());
      out = emitSite(ir);
      await writeSite(siteDir, out, assetsDir, known);
      fit.undone = true;
      fit.rounds--;
      break;
    }
    fit.layoutAfter = score;
    if (round === FIT_ROUNDS) break;
    saved = snapshotFixes(site);
    let widths = 0;
    let heights = 0;
    for (const x of views) {
      const planned = planFixes(x.tree.root, x.view, x.rects);
      widths += planned.widths;
      heights += planned.heights;
    }
    if (!widths && !heights) break;
    fit.rounds++;
    fit.widthFixes += widths;
    fit.heightFixes += heights;
    ({ ir, stats } = build());
    out = emitSite(ir);
    await writeSite(siteDir, out, assetsDir, known);
  }

  // Breakpoints and fluid type, checked against the original's sweep screenshots (verify/refine.js). Only
  // css/site.css changes, so the pages and the fit fixes above stay as they are.
  let refined = null;
  // The sweep may still be running next to this step (recreate/index.js): the check needs its first pages only, so it
  // waits for those (a bounded time) and works with the pages swept by then.
  let sweep = ctx.sweep;
  if (sweep === undefined && ctx.sweepPending) {
    ctx.progress(0.9, 'Waiting for the screenshots of the original at more widths');
    sweep = await ctx.sweepPending(REFINE_PAGES, Math.max(0, Math.min(SWEEP_WAIT, ctx.stepDeadline - FIT_MARGIN - REFINE_BUDGET - Date.now())));
  }
  if (sweep) {
    ctx.progress(0.9, 'Checking the layout between the captured widths');
    try {
      refined = await refineResponsive({
        ir,
        siteDir,
        workspace: ctx.dir,
        sweep,
        deadline: Math.min(Date.now() + REFINE_BUDGET, ctx.stepDeadline - FIT_MARGIN),
      });
    } catch (err) {
      report.warnings.push(`The breakpoints could not be checked against the original: ${err.message.split('\n')[0]}`);
    }
    if (refined && (refined.breakpoints !== ir.breakpoints || refined.fluid || refined.shrink)) {
      ir.breakpoints = refined.breakpoints;
      ir.rules = refined.rules;
      out = emitSite(ir);
      await writeSite(siteDir, out, assetsDir, known);
    }
  }

  ctx.progress(0.95, 'Saving the IR');
  await mkdir(path.join(ctx.dir, 'ir'), { recursive: true });
  await writeFile(path.join(ctx.dir, 'ir', 'site.json'), JSON.stringify(ir));
  const siteAssets = [...out.assets].filter((f) => known.has(f));
  ctx.generated = { site, ir, out, stats, siteDir, siteAssets, assetsDir };

  const fixed = fixReport(treeFixes, irFixes);
  report.fixes.push(...fixed.fixes);
  if (wp) {
    const recreated = { page: 0, post: 0 };
    for (const t of site.pages) if (t.wp) recreated[t.wp.item.type === 'post' ? 'post' : 'page']++;
    report.wordpress = {
      api: wp.api,
      reachable: wp.reachable,
      ...(wp.error && { error: wp.error }),
      totals: wp.totals,
      recreated,
      pages: treeFixes.wordpress.map((w) => ({ page: w.page, blocks: w.blocks, matched: w.matched, updated: w.updated.length, keptWithMarkup: w.kept, notRendered: w.missing })),
    };
    if (!wp.reachable) report.warnings.push(`WordPress was detected but its REST API did not answer (${wp.error}); the rendered text was used.`);
    const notRecreated = (wp.totals.posts ?? 0) - recreated.post + (wp.totals.pages ?? 0) - recreated.page;
    if (wp.reachable && notRecreated > 0) {
      report.manual.push({
        kind: 'cms',
        title: `${notRecreated} WordPress ${notRecreated === 1 ? 'entry was' : 'posts and pages were'} not recreated`,
        detail: `The REST API lists ${wp.totals.posts ?? 0} posts and ${wp.totals.pages ?? 0} pages; ${recreated.post + recreated.page} of them were recreated (page limit). Import the rest from ${wp.api}.`,
      });
    }
  }

  // Report.
  const treeStats = site.pages.reduce((a, t) => ({
    elements: a.elements + t.nodes,
    variantsMerged: a.variantsMerged + t.stats.variantsMerged,
    wrappersRemoved: a.wrappersRemoved + t.stats.wrappersRemoved,
    viewOnly: a.viewOnly + t.stats.viewOnly,
  }), { elements: 0, variantsMerged: 0, wrappersRemoved: 0, viewOnly: 0 });
  report.generate = {
    stack: 'html',
    pages: ir.pages.length,
    ...treeStats,
    classes: stats.classes,
    // The CSS the pages carry (D.6: inline in each page, plus css/pages/*.css for large pages): page files and sheets.
    cssBytes: [...out.files].reduce((n, [file, text]) => n + (file.endsWith('.css') ? Buffer.byteLength(text) : (/<style>([\s\S]*?)<\/style>/.exec(text)?.[1]?.length ?? 0)), 0),
    breakpoints: ir.breakpoints,
    links: stats.links,
    liveLinks: [...stats.liveLinks].slice(0, 100).map(([url, reason]) => ({ url, reason })),
    // Same-site links to what is not part of the copy: each opens a local notice page (ir/notice.js), never the live site.
    noticePages: [...stats.notices].slice(0, 200).map(([url, reason]) => ({ url, reason })),
    noticePageCount: stats.notices.size,
    droppedImages: stats.droppedImages.length,
    droppedMedia: stats.droppedMedia.length,
    assetFiles: siteAssets.length,
    generatedFiles: ir.files.map((f) => f.path),
    fit,
    responsive: refined?.summary ?? null,
    motion: { ...motion.stats, script: Boolean(ir.motion?.script) },
    widgets: widgets.stats,
  };
  const byPath = new Map(site.pages.map((t) => [t.info.path, t]));
  report.pages = report.pages.map((p) => {
    const t = byPath.get(p.path);
    const page = ir.pages.find((x) => x.path === p.path);
    if (!t || !page) return p;
    return {
      ...p,
      head: {
        title: page.head.title,
        description: page.head.description,
        canonical: page.head.canonical,
        autoGenerated: t.headAuto.map((a) => a.field),
        missing: t.headMissing,
      },
      links: page.stats.links,
    };
  });
  for (const t of site.pages) for (const a of t.headAuto) report.autoGenerated.push({ page: t.info.path, ...a });
  report.autoGenerated.push(...fixed.auto);
  const { sitemap, robots, llms } = site.crawlFiles;
  report.fixes.push({
    id: 'crawl-files',
    title: `sitemap.xml and robots.txt generated${llms.copied ? ', llms.txt copied' : llms.generated ? ', llms.txt generated from the pages' : ''}`,
    status: 'fixed',
    count: llms.copied || llms.generated ? 3 : 2,
    open: 0,
    items: [
      { file: 'sitemap.xml', urls: sitemap.urls.length, excluded: sitemap.excluded },
      { file: 'robots.txt', blocksAll: robots.blocksAll, blockedAiCrawlers: robots.blockedAiCrawlers },
      ...(llms.copied ? [{ file: 'llms.txt', copied: true, bytes: llms.bytes }] : []),
      ...(llms.generated ? [{ file: 'llms.txt', generated: true, bytes: llms.bytes }] : []),
    ],
  });
  if (llms.generated) report.autoGenerated.push({ page: '/', field: 'llms.txt', value: `${llms.bytes} bytes`, source: 'the pages of the site (titles and descriptions)', review: true });
  // Structured data, FAQ schema and theme-color added (full-site D.3).
  // Security and caching headers for static hosts (D.7, ir/crawlFiles.js): cannot be measured on the local preview.
  report.fixes.push({
    id: 'deploy-headers',
    title: 'Security and caching headers prepared for the host (_headers)',
    status: 'fixed',
    count: 1,
    open: 0,
    detail: 'HTTPS (HSTS), content security policy, nosniff, referrer and frame policies, and long caching for assets, in the _headers file Netlify and Cloudflare Pages read. Other hosts: set the same headers there.',
    items: [{ file: '_headers' }],
  });
  const headData = site.crawlFiles?.headData;
  if (headData && (headData.organization || headData.website || headData.faq.length || headData.themeColor)) {
    const items = [
      ...(headData.organization ? [{ type: 'Organization', page: '/' }] : []),
      ...(headData.website ? [{ type: 'WebSite', page: '/' }] : []),
      ...headData.faq.map((f) => ({ type: 'FAQPage', page: f.page, questions: f.questions })),
      ...(headData.themeColor ? [{ type: 'theme-color', pages: headData.themeColor }] : []),
    ];
    report.fixes.push({ id: 'head-data', title: 'Structured data and theme colour added', status: 'fixed', count: items.length, open: 0, items });
  }
  // Titles and descriptions rewritten so every page passes the length and uniqueness checks (full-site D.1).
  const headTexts = site.crawlFiles?.headTexts;
  if (headTexts && headTexts.titles + headTexts.descriptions > 0) {
    report.fixes.push({
      id: 'head-texts',
      title: 'Titles and descriptions fixed (length, duplicates)',
      status: 'fixed',
      count: headTexts.titles + headTexts.descriptions,
      open: 0,
      items: [{ titles: headTexts.titles, descriptions: headTexts.descriptions }],
    });
  }
  if (llms.tooLarge) report.warnings.push('The original /llms.txt is larger than 256 KB and was not copied; copy it by hand.');
  report.autoGenerated.push(
    { page: '/', field: 'sitemap.xml', value: `${sitemap.urls.length} URLs on ${ir.baseUrl}`, source: 'recreated pages' },
    { page: '/', field: 'robots.txt', value: robots.blocksAll ? 'Disallow: / (all crawlers)' : `Allow: /${robots.blockedAiCrawlers.length ? `; blocks ${robots.blockedAiCrawlers.join(', ')}` : ''}`, source: robots.source },
  );
  for (const page of ir.pages.filter((x) => x.stats.forms)) {
    report.manual.push({
      kind: 'form',
      title: `Form on ${page.path} needs a backend`,
      detail: 'The form was recreated as markup only and its submit action was removed. Connect a form backend.',
      url: page.url,
    });
  }
  if (site.truncated) report.warnings.push('A page has more elements than one capture keeps (6,000); only the first 6,000 were recreated.');
  if (fit.stopped) report.warnings.push('The layout fit pass stopped early because of the time limit.');
  if (fit.failed?.length) {
    const list = fit.failed.map((f) => f.path);
    report.warnings.push(`The layout of ${list.length} ${list.length === 1 ? 'page' : 'pages'} could not be checked (the browser could not render ${list.length === 1 ? 'it' : 'them'}, even in a new browser): ${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}. ${list.length === 1 ? 'It keeps' : 'They keep'} the layout as generated.`);
  }
  ctx.progress(1, `Generated ${ir.pages.length} ${ir.pages.length === 1 ? 'page' : 'pages'}`);
}
