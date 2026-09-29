// Recreate step 3, "Generating site": builds the IR from the captures and the local assets, writes
// the plain HTML site to site/ (pages at their original paths, css/site.css, assets/), then runs a
// short fit pass: the site is rendered at the three views, elements whose box is off get a size fix,
// and the site is written again. A round that lowers the layout score is undone.
// Writes ir/site.json (the IR the other stack emitters will use) and sets ctx.generated.
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emitSite } from './emit/html.js';
import { buildIR, prepareSite, readPageCaptures } from './ir/index.js';
import { isElement } from './ir/tree.js';
import { compareLayout, openRenderer, planFixes, renderPage, viewScore } from './verify/layout.js';

export const FIT_ROUNDS = 2;
// The fit pass stops starting new rounds this long before the step's time limit.
const FIT_MARGIN = 25000;

async function writeSite(siteDir, out, assetsDir, known) {
  for (const [file, content] of out.files) {
    const target = path.join(siteDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  // Downloaded files are hard-linked (no second copy on disk); a copy when linking is not possible.
  for (const file of out.assets) {
    if (!known.has(file)) continue;
    const target = path.join(siteDir, 'assets', file);
    await mkdir(path.dirname(target), { recursive: true });
    await link(path.join(assetsDir, file), target).catch((err) => (err.code === 'EEXIST' ? null : copyFile(path.join(assetsDir, file), target)));
  }
}

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
 * Renders every page of the measurement build (with data-sas-id) in every captured view.
 * @param {(page:object, view:string, result:object)=>Promise<void>|void} onView
 */
export async function measureSite(renderer, ir, site, { screenshot = false, onView } = {}) {
  const measured = emitSite(ir, { ids: true });
  for (const page of ir.pages) renderer.server.overrides.set(page.outPath, measured.files.get(page.outPath));
  try {
    for (const [i, page] of ir.pages.entries()) {
      const tree = site.pages[i];
      await Promise.all(tree.views.map(async (view) => {
        const result = await renderPage(renderer, page.outPath, view, { screenshot });
        await onView(tree, view, result);
      }));
    }
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

  ctx.progress(0, 'Reading captured pages');
  const pages = [];
  for (const info of ctx.pages) pages.push({ info, captures: await readPageCaptures(ctx.dir, info) });
  const site = prepareSite({
    pages,
    assets: ctx.assets ?? { map: {} },
    baseUrl: ctx.baseUrl,
    origin: ctx.discovery?.origin ?? new URL(ctx.audit.url ?? ctx.project.url).origin,
    livePages: ctx.livePages,
    skipped: ctx.discovery?.skipped,
  });
  pages.length = 0;
  for (const t of site.pages) delete t.captures; // large; everything needed is in the trees now

  ctx.progress(0.15, 'Writing pages');
  let { ir, stats } = buildIR(site);
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
    await measureSite(renderer, ir, site, {
      onView: (tree, view, result) => {
        views.push({ tree, view, rects: result.rects, score: viewScore(compareLayout(tree.root, view, result.rects), null) });
      },
    });
    const score = Math.round(views.reduce((n, x) => n + x.score, 0) / Math.max(1, views.length));
    if (round === 0) fit.layoutBefore = score;
    if (saved && score < fit.layoutAfter) {
      // The last round made things worse: undo it.
      restoreFixes(site, saved);
      ({ ir, stats } = buildIR(site));
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
    ({ ir, stats } = buildIR(site));
    out = emitSite(ir);
    await writeSite(siteDir, out, assetsDir, known);
  }

  ctx.progress(0.95, 'Saving the IR');
  await mkdir(path.join(ctx.dir, 'ir'), { recursive: true });
  await writeFile(path.join(ctx.dir, 'ir', 'site.json'), JSON.stringify(ir));
  ctx.generated = { site, ir, siteDir };

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
    droppedImages: stats.droppedImages.length,
    droppedMedia: stats.droppedMedia.length,
    assetFiles: [...out.assets].filter((f) => known.has(f)).length,
    generatedFiles: ir.files.map((f) => f.path),
    fit,
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
  ctx.progress(1, `Generated ${ir.pages.length} ${ir.pages.length === 1 ? 'page' : 'pages'}`);
}
