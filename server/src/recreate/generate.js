// Recreate step 3, "Generating site": builds the IR from the captures and the local assets (with the
// WordPress REST content when the site is WordPress), applies the fixers (fixers/), writes the plain
// HTML site to site/ (pages at their original paths, css/site.css, assets/), then runs a short fit
// pass: the site is rendered at the three views, elements whose box is off get a size fix, and the
// site is written again. A round that lowers the layout score is undone. The production build, the
// safety gate and the verification of dist/ follow in the build step (build/index.js).
// Writes ir/site.json (the IR the other stack emitters will use) and sets ctx.generated.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { parallelism } from '../audit/resources.js';
import { projectDir } from '../db/index.js';
import { mapLimit } from '../audit/util.js';
import { applyImageVariants, makeImageVariants } from './assets/variants.js';
import { emitSite } from './emit/html.js';
import { writeProject } from './emit/write.js';
import { applyIrFixes, applyTreeFixes, fixReport } from './fixers/index.js';
import { brokenTargets, deadLinks } from './fixers/perf.js';
import { fetchWordPress, isWordPress } from './fixers/wordpress.js';
import { buildIR, prepareSite, readPageCaptures } from './ir/index.js';
import { MOTION_VERSION, applyMotion, readPageMotion } from './ir/motion.js';
import { addStructuredData } from './ir/structuredData.js';
import { isElement } from './ir/tree.js';
import { compareLayout, openRenderer, planFixes, renderPage, viewScore } from './verify/layout.js';
import { REFINE_PAGES, refineResponsive } from './verify/refine.js';

export const FIT_ROUNDS = 2;
// The fit pass stops starting new rounds this long before the step's time limit.
const FIT_MARGIN = 25000;
// Time for checking the outbound links of every page (fixers/perf.js deadLinks).
const LINK_CHECK_BUDGET = 60000;
// Time for making the responsive image files.
const IMAGES_BUDGET = 60000;
// Time for the WordPress REST lookup.
const WP_BUDGET = 30000;
// Time for the breakpoint / fluid type check against the original's sweep.
const REFINE_BUDGET = 90000;
// How long that check waits for the sweep's first pages when the sweep is still running.
const SWEEP_WAIT = 75000;

// Pages measured at once (each with all its views): two when the memory allows four more tabs each.
export const PAGES_AT_ONCE = 2;
const PAGE_RENDER_MB = 600;

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
 * Pages are rendered two at a time when the memory allows (`pagesAtOnce`): each render has its own tab, the site is local
 * and static (no script), so boxes and screenshots do not depend on how many render at once.
 * @param {number} [deadline]  no new page is started after this time (ms since epoch)
 * @returns {Promise<{ started: number, failed: { path: string, error: string }[] }>} pages started before the deadline, pages that failed
 */
export async function measureSite(renderer, ir, site, { screenshot = false, onView, deadline = Infinity, pagesAtOnce = parallelism({ perUnitMB: PAGE_RENDER_MB, max: PAGES_AT_ONCE }) } = {}) {
  const measured = emitSite(ir, { ids: true });
  for (const page of ir.pages) renderer.server.overrides.set(page.outPath, measured.files.get(page.outPath));
  // Per page, in page order whatever order they finish in: undefined = not started (deadline), null = rendered, else its error.
  const outcome = new Array(ir.pages.length);
  try {
    await mapLimit(ir.pages, pagesAtOnce, async (page, i) => {
      // Pages start in order, so the ones left out by the deadline are the last ones.
      if (Date.now() > deadline) return;
      const tree = site.pages[i];
      outcome[i] = null;
      try {
        await Promise.all(tree.views.map(async (view) => {
          const result = await renderPage(renderer, page.outPath, view, { screenshot });
          await onView(tree, view, result);
        }));
      } catch (err) {
        outcome[i] = err;
      }
    });
    const notStarted = outcome.findIndex((o) => o === undefined);
    const started = notStarted < 0 ? ir.pages.length : notStarted;
    const failed = [];
    let firstError = null;
    outcome.slice(0, started).forEach((err, i) => {
      if (!err) return;
      firstError ??= err;
      failed.push({ path: site.pages[i].info.path, error: String(err?.message ?? err).split('\n')[0].trim() });
    });
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

const countTemplates = (n) => (!n || 'text' in n ? 0 : (n.tpl ? 1 : 0) + (n.children ?? []).reduce((s, c) => s + countTemplates(c), 0));

// A page without a usable og:image (none, or the original's could not be downloaded: another host, an error page) shares
// a real picture of itself: the top of its captured desktop screen, cut to the 1200 × 630 social-card size.
async function addSocialImages(site, ctx, assetsDir) {
  const files = [];
  const auto = [];
  for (const t of site.pages) {
    if (t.head.meta.some((m) => m.property === 'og:image')) continue;
    const shot = path.join(ctx.dir, 'capture', t.info.slug, 'desktop-fold.webp');
    try {
      const body = await sharp(await readFile(shot)).resize(1200, 630, { fit: 'cover', position: 'top' }).webp({ quality: 82 }).toBuffer();
      const sha256 = createHash('sha256').update(body).digest('hex');
      const file = `images/og-${t.info.slug}-${sha256.slice(0, 10)}.webp`;
      await mkdir(path.join(assetsDir, 'images'), { recursive: true });
      await writeFile(path.join(assetsDir, file), body);
      files.push({ file, kind: 'image', mime: 'image/webp', bytes: body.length, sha256, urls: [], generated: 'og-image' });
      const url = new URL(`assets/${file}`, `${site.baseUrl}/`).href;
      t.head.meta.push({ property: 'og:image', content: url });
      if (!t.head.meta.some((m) => m.name === 'twitter:image')) t.head.meta.push({ name: 'twitter:image', content: url });
      t.headAuto.push({ field: 'og:image', value: url, source: 'the page\'s own first screen (captured)' });
      auto.push(t.info.path);
    } catch {
      // no capture picture for this page: it stays without one
    }
  }
  return { files, pages: auto };
}

// New files of the site's own (responsive images) join the downloaded ones: the build, the exports to other stacks and a
// rebuild from the saved capture find them through assets/manifest.json.
async function addToManifest(assetsDir, files, known, assets) {
  const file = path.join(assetsDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const have = new Set(manifest.files.map((f) => f.file));
  const added = files.filter((f) => !have.has(f.file));
  manifest.files.push(...added);
  await writeFile(file, JSON.stringify(manifest, null, 2));
  for (const f of files) known.add(f.file);
  if (assets?.files) assets.files.push(...added.filter((f) => !assets.files.some((x) => x.file === f.file)));
}

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

  ctx.progress(0.12, 'Fixing audit issues');
  const axe = ctx.analysis?.id && ctx.project?.id
    ? await readFile(path.join(projectDir(ctx.project.id), 'audit', ctx.analysis.id, 'axe.json'), 'utf8').then(JSON.parse, () => null)
    : null;
  // Outbound links of pages the analysis did not read: dead targets are unlinked like the ones the analysis found.
  ctx.progress(0.13, 'Checking the links of every page');
  const extraBroken = await deadLinks(site, { known: brokenTargets(ctx.audit, ctx.discovery?.skipped), ms: Math.max(10000, Math.min(LINK_CHECK_BUDGET, ctx.stepDeadline - Date.now() - FIT_MARGIN * 4)) });
  const treeFixes = applyTreeFixes(site, { audit: ctx.audit, skipped: ctx.discovery?.skipped, axe, extraBroken });
  // Layout parts other window sizes show (fixers/perf.js markLayouts) are parked by the generated script.
  if (treeFixes.layouts) {
    site.motion = { version: MOTION_VERSION, hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], states: 0, notices: 0, hoverCards: 0, scrolled: [], ...site.motion, layouts: treeFixes.layouts, script: true };
  }
  // After the fixers: headings are final (FAQ questions are read from them).
  const social = await addSocialImages(site, ctx, assetsDir);
  if (social.files.length) await addToManifest(assetsDir, social.files, known, ctx.assets);
  const structured = addStructuredData(site);
  let irFixes;
  let imageVariants = new Map();
  const build = () => {
    const built = buildIR(site);
    irFixes = applyIrFixes(built.ir);
    applyImageVariants(built.ir, imageVariants);
    return built;
  };

  ctx.progress(0.15, 'Writing pages');
  let { ir, stats } = build();
  // Responsive image files (assets/variants.js), made once from the widths the first build shows each image at.
  ctx.progress(0.17, 'Making responsive images');
  const images = await makeImageVariants({ ir, assetsDir, deadline: Math.min(Date.now() + IMAGES_BUDGET, ctx.stepDeadline - FIT_MARGIN * 3) });
  if (images.variants.size) {
    imageVariants = images.variants;
    await addToManifest(assetsDir, images.files, known, ctx.assets);
    ({ ir, stats } = build());
  }
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

  // The published pages carry their own CSS inline (no render-blocking request, no rules of other pages); the layout
  // passes above worked on the shared css/site.css, which stays in the site for reading and for the app stacks.
  out = emitSite(ir, { inlineCss: true });
  await writeSite(siteDir, out, assetsDir, known);

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
    cssBytes: Buffer.byteLength(out.files.get('css/site.css')),
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
    images: images.stats,
  };
  // Each page's own CSS inline (emit/html.js inlineCss): what that changed, for the fix checklist.
  const pageCss = ir.pages.map((p) => Buffer.byteLength(out.files.get(p.outPath).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? ''));
  report.fixes.push({
    id: 'page-css',
    title: 'Each page carries only its own CSS, inline (no render-blocking stylesheet)',
    status: 'fixed',
    count: ir.pages.length,
    open: 0,
    items: [{ sharedBytes: Buffer.byteLength(out.files.get('css/site.css')), largestPageBytes: Math.max(0, ...pageCss), averagePageBytes: Math.round(pageCss.reduce((a, b) => a + b, 0) / Math.max(1, pageCss.length)) }],
  });
  const templates = ir.pages.reduce((n, p) => n + countTemplates(p.body), 0);
  if (templates) {
    report.fixes.push({
      id: 'state-templates',
      title: `${templates} hidden ${templates === 1 ? 'part' : 'parts'} (other tabs / slides / filters, hovered card looks) kept out of the page until shown`,
      status: 'fixed',
      count: templates,
      open: 0,
      items: [],
    });
  }
  if (images.stats.images) {
    report.fixes.push({
      id: 'responsive-images',
      title: `Responsive WebP images for ${images.stats.images} ${images.stats.images === 1 ? 'picture' : 'pictures'}`,
      status: 'fixed',
      count: images.stats.images,
      open: 0,
      items: [{ files: images.stats.files, originalBytes: images.stats.originalBytes, largestServedBytes: images.stats.servedBytes }],
    });
  }
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
    title: `sitemap.xml and robots.txt generated${llms.copied ? ', llms.txt copied' : llms.generated ? ', llms.txt generated' : ''}`,
    status: 'fixed',
    count: llms.copied || llms.generated ? 3 : 2,
    open: 0,
    items: [
      { file: 'sitemap.xml', urls: sitemap.urls.length, excluded: sitemap.excluded },
      { file: 'robots.txt', blocksAll: robots.blocksAll, blockedAiCrawlers: robots.blockedAiCrawlers },
      ...(llms.copied || llms.generated ? [{ file: 'llms.txt', copied: llms.copied, generated: llms.generated, bytes: llms.bytes }] : []),
    ],
  });
  if (llms.generated) report.autoGenerated.push({ page: '/', field: 'llms.txt', value: `${sitemap.urls.length} pages listed`, source: 'page titles and descriptions' });
  if (structured.added.length) {
    report.fixes.push({
      id: 'structured-data',
      title: 'Structured data added (JSON-LD)',
      status: 'fixed',
      count: structured.added.length,
      open: 0,
      items: structured.added,
    });
    for (const a of structured.added) report.autoGenerated.push({ page: a.page, field: 'json-ld', value: a.types.join(', '), source: a.types.includes('FAQPage') ? 'questions and answers on the page' : 'site name, address, icon and social links' });
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
