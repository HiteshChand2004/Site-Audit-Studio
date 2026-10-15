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
import { MOTION_VERSION, applyMotion, cpathIndex, readPageMotion } from './ir/motion.js';
import { addStats, GSAP_VERSION, planReplay, readAnimLogFor, replayIds } from './behavior/gsap.js';
import { addStructuredData } from './ir/structuredData.js';
import { applyExcludes, findExcludable } from './ir/exclude.js';
import { isElement } from './ir/tree.js';
import { RECREATE_VIEWS, VIEW_WIDTHS } from './views.js';
import { hitTestGuard, pointerMapFile } from './verify/hittest.js';
import { launchBrowser } from '../audit/render.js';
import { compareLayout, openRenderer, planFixes, renderPage, viewScore } from './verify/layout.js';
import { createLedger } from './verify/ledger.js';
import { CORRECT_BUDGET, CORRECT_MIN, correctLayout, correctReport } from './verify/correct.js';
import { applyFixesByPath, correctExact, fixesByPath } from './verify/exact/correct.js';
import { openExactRenderer } from './verify/exact/compare.js';
import { boxLookups } from './verify/exact/boxes.js';
import { CSS_FILE } from './emit/css.js';
import { SWEEP_WIDTHS } from './capture/sweep.js';
import { REFINE_PAGES, refineResponsive } from './verify/refine.js';
import { applyAsIs } from './ir/asis.js';

export const FIT_ROUNDS = 2;
// The fit pass stops starting new rounds this long before the step's time limit.
const FIT_MARGIN = 25000;
// The hit-test guard (verify/hittest.js): two renders of every page at two views, twice when it fixed something.
const HIT_TEST_BUDGET_MS = 180000;
// Time for checking the outbound links of every page (fixers/perf.js deadLinks).
const LINK_CHECK_BUDGET = 60000;
// Time for making the responsive image files.
const IMAGES_BUDGET = 60000;
// Time for the WordPress REST lookup.
const WP_BUDGET = 30000;
// Time for the breakpoint / fluid type check against the original's sweep. It renders a page at each judged width
// for every candidate, so the work grows with the widths the sweep captured: a site that declares its own
// boundaries is judged at more of them, and on flexibench that took the check past ninety seconds and it ended
// with `stopped: 'time-limit'` and no verdict at all - the quiet failure this scaling exists to prevent. An exact
// run has no overall limit (recreate/index.js), so this one follows the work instead of standing still.
const REFINE_BASE = 90000;
const REFINE_PER_WIDTH = 15000;
export const refineBudget = (widths = [], { exact = false } = {}) => (exact
  ? REFINE_BASE + REFINE_PER_WIDTH * Math.max(0, widths.length - SWEEP_WIDTHS.length)
  : REFINE_BASE);
// The self-correction loop's own time. It is taken from the step's limit before the refine check, never from it:
// generate is local work (no network, no capture), so a longer generate never changes what was captured.
// SAS_CORRECT=0 turns the loop off; everything else behaves exactly as it did before.
const correctOn = () => process.env.SAS_CORRECT !== '0';
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
export async function measureSite(renderer, ir, site, {
  screenshot = false, onView, deadline = Infinity, only = null, viewsOf = null, extraOverrides = null,
  pagesAtOnce = parallelism({ perUnitMB: PAGE_RENDER_MB, max: PAGES_AT_ONCE }),
} = {}) {
  const measured = emitSite(ir, { ids: true });
  // `only` (a Set of outPaths) measures a few pages instead of the whole site, and `viewsOf` a few views of each:
  // the correction loop re-renders its decision pages many times, and `started` / `failed` are then about that
  // selection. Without them nothing changes for the other callers.
  // Paired by index, never by object identity: two entries of ir.pages may be the same object.
  const selected = ir.pages
    .map((page, i) => ({ page, tree: site.pages[i] }))
    .filter(({ page }) => !only || only.has(page.outPath));
  for (const { page } of selected) renderer.server.overrides.set(page.outPath, measured.files.get(page.outPath));
  // Files to serve beside the pages, re-installed on every call because the override map is cleared below. This is
  // how a candidate stylesheet is tried without rebuilding the IR or writing anything to disk.
  for (const [file, body] of Object.entries(extraOverrides ?? {})) renderer.server.overrides.set(file, body);
  // Per page, in page order whatever order they finish in: undefined = not started (deadline), null = rendered, else its error.
  const outcome = new Array(selected.length);
  try {
    await mapLimit(selected, pagesAtOnce, async ({ page, tree }, i) => {
      // Pages start in order, so the ones left out by the deadline are the last ones.
      if (Date.now() > deadline) return;
      outcome[i] = null;
      try {
        const views = viewsOf ? tree.views.filter((v) => viewsOf(tree).includes(v)) : tree.views;
        await Promise.all(views.map(async (view) => {
          const result = await renderPage(renderer, page.outPath, view, { screenshot });
          await onView(tree, view, result);
        }));
      } catch (err) {
        outcome[i] = err;
      }
    });
    const notStarted = outcome.findIndex((o) => o === undefined);
    const started = notStarted < 0 ? selected.length : notStarted;
    const failed = [];
    let firstError = null;
    outcome.slice(0, started).forEach((err, i) => {
      if (!err) return;
      firstError ??= err;
      failed.push({ path: selected[i].tree.info.path, error: String(err?.message ?? err).split('\n')[0].trim() });
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

/**
 * `sid` -> the path the element had in the original's own snapshot, for every page. This is what lets the exact
 * comparison pair a box of the copy with the box of the original it was built from, rather than guessing from the
 * text it happens to contain.
 */
export function cpathsOf(site) {
  // Per page, because `sid` restarts at 1 in every page (ir/index.js numberNodes). One flat map across the site
  // meant the last page written won every id, so on a real eleven-page site only the homepage - and the 404 page,
  // which is a copy of it - paired boxes by identity at all: 575 of 576 there against 4 to 9 of 40 to 149
  // everywhere else, with the rest left to the weaker guess-by-content path this map exists to replace.
  const pages = {};
  for (const tree of site.pages) {
    const cpaths = {};
    const sized = {};
    const slack = {};
    const walk = (n) => {
      if (!isElement(n)) return;
      if (n.sid != null) {
        if (n.cpath || n.path) cpaths[n.sid] = n.cpath ?? n.path;
        // What the copy sized itself, and the pixel or two it asked for on purpose (ir/styles.js): the exact
        // comparison holds a box the copy sized to a pixel, expects the slack it asked for, and puts the boxes
        // that are as big as their text under a reported budget instead of calling each one a defect.
        if (n.sized) sized[n.sid] = n.sized;
        const asked = n.slack && Object.fromEntries(Object.entries(n.slack).filter(([, v]) => v && Object.keys(v).length));
        if (asked && Object.keys(asked).length) slack[n.sid] = asked;
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree.root);
    pages[tree.info.outPath] = { cpaths, sized, slack };
  }
  return { version: 3, pages };
}

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

/**
 * Canvases (a WebGL scene, a chart, a particle field): what they draw comes from a script the copy never carries, so they
 * cannot be rebuilt. Each one is reported as unsupported, and instead of an empty box the copy shows what the capture saw:
 * the frame (cut from the page's own full screenshot) and, for one that kept drawing, the recording of it as a looping
 * picture (capture/loops.js recordCanvasLoop) - behind the canvas as its background, the loop only for a visitor who does
 * not ask for less motion. A recording, not a reproduction: a canvas that reacts to the visitor does not react in the copy.
 * Both are a motion token (`cN`), so an as-is (exact) page - which keeps the original markup - gets them too.
 * @returns {Promise<{ files: object[], canvases: object[] }>}
 */
async function addCanvasFrames(site, motionByPath, ctx, assetsDir) {
  const files = [];
  const canvases = [];
  const rules = [];
  const keep = async (body, name, generated) => {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const file = `images/${name}-${sha256.slice(0, 10)}.webp`;
    await mkdir(path.join(assetsDir, 'images'), { recursive: true });
    await writeFile(path.join(assetsDir, file), body);
    files.push({ file, kind: 'image', mime: 'image/webp', bytes: body.length, sha256, urls: [], generated });
    return file;
  };
  for (const t of site.pages) {
    const found = motionByPath.get(t.info.path)?.loops?.canvas ?? [];
    if (!found.length) continue;
    const byPath = new Map();
    const walk = (n) => {
      if (!isElement(n)) return;
      for (const p of [n.cpath, ...(n.cpathAlt ?? [])]) if (p && !byPath.has(p)) byPath.set(p, n);
      n.children.forEach(walk);
    };
    walk(t.root);
    const full = path.join(ctx.dir, 'capture', t.info.slug, 'desktop-full.webp');
    for (const c of found) {
      const entry = { page: t.info.path, path: c.path, context: c.context, animated: c.animated ?? null, cover: c.cover, stillFrame: false, recordedLoop: false };
      canvases.push(entry);
      const node = byPath.get(c.path);
      if (!node || node.tag !== 'canvas') continue;
      const rule = { token: `c${rules.length + 1}` };
      try {
        const meta = await sharp(full).metadata();
        const [x, y, w, h] = c.rect;
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const width = Math.min(w, meta.width - left);
        const height = Math.min(h, meta.height - top);
        if (width >= 8 && height >= 8) {
          rule.still = await keep(await sharp(full).extract({ left, top, width, height }).webp({ quality: 85 }).toBuffer(), `canvas-${t.info.slug}`, 'canvas-frame');
          entry.stillFrame = true;
        }
      } catch {
        // no picture to cut it from
      }
      if (c.loop?.file) {
        try {
          rule.loop = await keep(await readFile(path.join(ctx.dir, 'capture', t.info.slug, c.loop.file)), `canvas-loop-${t.info.slug}`, 'canvas-loop');
          entry.recordedLoop = true;
          entry.loop = { frames: c.loop.frames, delayMs: c.loop.delayMs, seamless: c.loop.seamless };
        } catch {
          // the recording was not kept: the still frame stands
        }
      }
      if (!rule.still && !rule.loop) continue;
      rules.push(rule);
      node.motionTokens = [...new Set([...(node.motionTokens ?? []), rule.token])];
    }
  }
  return { files, canvases, rules };
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
  // Exact mode replicates the site as it is: the fixes that change pixels on purpose are left out (recreate/inputs.js
  // isExactMode). Everything that does not touch a pixel - alt text, accessible names, lang, canonical / OG copying,
  // sitemap and robots - still runs.
  const asIs = Boolean(ctx.exact);
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
    asIs,
  });
  pages.length = 0;
  for (const t of site.pages) delete t.captures; // large; everything needed is in the trees now

  // Motion (4b.4): hover, focus, scroll reveal and loops from the motion capture become tokens on the nodes + ir.motion.
  const motionByPath = new Map();
  for (const info of ctx.pages) {
    const found = await readPageMotion(ctx.dir, info);
    if (found) motionByPath.set(info.path, found);
  }
  // Tier 1 replay (behavior/gsap.js): what the page asked its animation library to do, replayed with the same library on
  // the same elements. Planned first, so the measured motion leaves the elements the library animates alone.
  const replayOwned = new Map();
  const replayStats = {};
  const ids = replayIds();
  for (const t of site.pages) {
    const info = ctx.pages.find((p) => p.path === t.info.path);
    const log = info ? await readAnimLogFor(ctx.dir, info) : null;
    if (!log) continue;
    const plan = planReplay(log, cpathIndex(t.root), ids);
    addStats(replayStats, plan.stats);
    if (plan.program) t.anim = plan.program;
    if (plan.owned.size) replayOwned.set(t.info.path, plan.owned);
  }
  const motion = applyMotion(site, motionByPath, { owned: replayOwned });
  site.motion = motion.motion;
  if (Object.keys(replayStats).length) motion.stats.replay = { lib: 'gsap', version: GSAP_VERSION, pages: site.pages.filter((t) => t.anim).length, ...replayStats };

  // Parts of the page that are not the site: the builder's badge, a consent banner, a chat bubble (ir/exclude.js).
  // Only for an exact copy, only on evidence the capture measured, and every one of them reported - the copy must
  // not show someone else's branding, and a banner dismissed on one visit and not another is pixels that differ for
  // no reason of ours.
  const excluded = [];
  if (asIs) {
    for (const t of site.pages) {
      const found = motionByPath.get(t.info.path);
      // A control whose click did not restore the page changed something for good: that is what dismissing is.
      const dismissed = new Set((found?.clicks?.widgets ?? []).filter((w) => w.closes === false).map((w) => w.path));
      // What each control's click changed, so a control that opens the builder's own frame can be told apart.
      const touches = new Map();
      for (const w of found?.clicks?.widgets ?? []) {
        const trigger = w.trigger ?? w.path;
        if (!trigger) continue;
        const changed = touches.get(trigger) ?? new Set();
        for (const kind of ['shown', 'hidden', 'added', 'attrs', 'moved']) for (const c of w.change?.[kind] ?? []) if (c?.path) changed.add(c.path);
        touches.set(trigger, changed);
      }
      const list = findExcludable(t, { dismissed, touches, viewWidths: VIEW_WIDTHS });
      const removed = new Set(applyExcludes(t, list));
      for (const e of list) if (removed.has(e.path)) excluded.push({ page: t.info.path, ...e });
    }
    if (excluded.length) {
      report.exact = { ...report.exact, excluded };
      const kinds = [...new Set(excluded.map((e) => e.reason))].join(', ');
      report.warnings.push(`${excluded.length} ${excluded.length === 1 ? 'part' : 'parts'} of the page that are not the site were left out (${kinds}); each one is listed in the report with the evidence for it.`);
    }
  }

  ctx.progress(0.12, 'Fixing audit issues');
  const axe = ctx.analysis?.id && ctx.project?.id
    ? await readFile(path.join(projectDir(ctx.project.id), 'audit', ctx.analysis.id, 'axe.json'), 'utf8').then(JSON.parse, () => null)
    : null;
  // Outbound links of pages the analysis did not read: dead targets are unlinked like the ones the analysis found.
  ctx.progress(0.13, 'Checking the links of every page');
  const extraBroken = await deadLinks(site, { known: brokenTargets(ctx.audit, ctx.discovery?.skipped, site.pages.map((t) => t.info.url)), ms: Math.max(10000, Math.min(LINK_CHECK_BUDGET, ctx.stepDeadline - Date.now() - FIT_MARGIN * 4)) });
  const treeFixes = applyTreeFixes(site, { audit: ctx.audit, skipped: ctx.discovery?.skipped, axe, extraBroken, asIs });
  // Layout parts other window sizes show (fixers/perf.js markLayouts) are parked by the generated script.
  if (treeFixes.layouts) {
    site.motion = { version: MOTION_VERSION, hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], states: 0, notices: 0, panels: 0, hoverCards: 0, scrolled: [], ...site.motion, layouts: treeFixes.layouts, script: true };
  }
  // After the fixers: headings are final (FAQ questions are read from them).
  const social = await addSocialImages(site, ctx, assetsDir);
  if (social.files.length) await addToManifest(assetsDir, social.files, known, ctx.assets);
  // Canvases: reported as not reproducible, shown as the frame the capture saw (never an empty box passed off as copied).
  const frames = await addCanvasFrames(site, motionByPath, ctx, assetsDir);
  if (frames.files.length) await addToManifest(assetsDir, frames.files, known, ctx.assets);
  if (frames.rules.length) {
    site.motion = { version: MOTION_VERSION, hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], states: 0, notices: 0, panels: 0, hoverCards: 0, scrolled: [], script: false, ...site.motion, canvas: frames.rules };
  }
  // A page that replays its animation library (behavior/gsap.js) ships scripts: the same switch as the generated script,
  // so the preview's script policy, the exact renderer and the safety profile follow.
  if (site.pages.some((t) => t.anim)) {
    site.motion = { version: MOTION_VERSION, hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], states: 0, notices: 0, panels: 0, hoverCards: 0, scrolled: [], ...site.motion, script: true, anim: true };
  }
  if (frames.canvases.length) {
    report.motion = { ...report.motion, unsupported: { ...report.motion?.unsupported, canvas: frames.canvases } };
    const moving = frames.canvases.filter((c) => c.animated).length;
    const looped = frames.canvases.filter((c) => c.recordedLoop).length;
    report.manual.push({
      area: 'Animation',
      title: `${frames.canvases.length} canvas drawing(s) cannot be rebuilt`,
      detail: `What a canvas draws (a WebGL scene, a chart, particles) comes from the site's own script, which the copy does not carry.${moving ? ` ${moving} of them keep moving on the original.` : ''} The copy shows the frame the capture saw${looped ? `, and ${looped} of them play a recording of what they drew as a looping picture (not interactive)` : ''}.`,
      count: frames.canvases.length,
    });
  }
  const structured = addStructuredData(site);
  let irFixes;
  let imageVariants = new Map();
  const build = () => {
    const built = buildIR(site, { asIs });
    irFixes = applyIrFixes(built.ir);
    applyImageVariants(built.ir, imageVariants);
    return built;
  };

  ctx.progress(0.15, 'Writing pages');
  let { ir, stats } = build();
  // Responsive image files (assets/variants.js), made once from the widths the first build shows each image at.
  // As is: every picture is served as the original bytes, in the original format and size, so no pixel of it differs.
  ctx.progress(0.17, asIs ? 'Keeping the original pictures' : 'Making responsive images');
  const images = asIs
    ? { variants: new Map(), files: [], stats: { images: 0, files: 0, originalBytes: 0, servedBytes: 0, skipped: 0, asIs: true } }
    : await makeImageVariants({ ir, assetsDir, deadline: Math.min(Date.now() + IMAGES_BUDGET, ctx.stepDeadline - FIT_MARGIN * 3) });
  if (images.variants.size) {
    imageVariants = images.variants;
    await addToManifest(assetsDir, images.files, known, ctx.assets);
    ({ ir, stats } = build());
  }
  // Exact mode keeps the original's own markup and stylesheets where the capture kept them (ir/asis.js): the site's
  // rules size every element at every width, so the layout passes below - which fit rebuilt px values to the captured
  // widths - have nothing to do and are skipped.
  let asis = null;
  if (asIs) {
    ctx.progress(0.18, 'Keeping the original markup and stylesheets');
    asis = await applyAsIs(ir, { dir: ctx.dir, site, excluded });
    if (asis.pages && asis.rebuilt.length) {
      report.warnings.push(`${asis.rebuilt.length} ${asis.rebuilt.length === 1 ? 'page has' : 'pages have'} no as-is capture and ${asis.rebuilt.length === 1 ? 'was' : 'were'} rebuilt instead (capture the site again to keep their original CSS).`);
    }
    if (asis.missingCssUrls || asis.missing.images || asis.missing.media) {
      report.warnings.push(`${asis.missingCssUrls + asis.missing.images + asis.missing.media} files the original's markup or stylesheets point at could not be downloaded; they are left out of the copy, never linked to the original.`);
    }
  }
  const asisMode = Boolean(ir.asis);
  let out = emitSite(ir);
  await writeSite(siteDir, out, assetsDir, known);

  // Fit pass.
  const fit = { rounds: 0, widthFixes: 0, heightFixes: 0, layoutBefore: null, layoutAfter: null, undone: false, stopped: null };
  // What is still off, element by element. Lives on `site` so rebuilding the IR cannot lose it, and is filled from the
  // measurements the fit pass already takes.
  const ledger = (site.ledger ??= createLedger());
  const renderer = await siteRenderer(ctx);
  let saved = null;
  // The last round's per-page/view measurements, so the correction loop can pick the worst pages without measuring
  // the whole site again.
  let lastViews = [];
  // What this step still has to do after the fit pass: correct the layout against the original, then check the
  // breakpoints. The fit pass used to run until FIT_MARGIN before the step's limit and leave them nothing - on a
  // 64-page rebuild it used the whole step and the correction loop was skipped before it measured anything.
  const refineTime = refineBudget(ctx.sweep?.widths ?? SWEEP_WIDTHS, { exact: asIs });
  const afterFit = correctOn() ? CORRECT_BUDGET + refineTime : 0;
  for (let round = 0; !asisMode && round <= FIT_ROUNDS; round++) {
    // Round 0 only measures, and the correction loop picks its pages from what it measures, so it always runs.
    if (Date.now() > ctx.stepDeadline - FIT_MARGIN - (round ? afterFit : 0)) {
      fit.stopped = 'time-limit';
      break;
    }
    ctx.progress(0.3 + 0.6 * (round / (FIT_ROUNDS + 1)), round ? `Fitting layout (round ${round} of ${FIT_ROUNDS})` : 'Checking layout');
    const views = [];
    ledger.beginRound(round);
    const { failed } = await measureSite(renderer, ir, site, {
      onView: (tree, view, result) => {
        // The same comparison as before, with the per-element pairs kept instead of thrown away: the correction loop
        // and the report both need to know WHICH elements are off, not only how many. No extra render.
        const cmp = compareLayout(tree.root, view, result.rects, { pairs: true });
        ledger.observe({ page: tree.info.path, view, rows: cmp.pairs });
        views.push({ tree, view, rects: result.rects, scrollHeight: result.scrollHeight, score: viewScore(cmp, null) });
      },
    });
    lastViews = views;
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
  fit.ledger = ledger.summary();

  // The self-correction loop (verify/correct.js). The fit pass can only add a width or a min-height, and on a real
  // site it runs out of things it is allowed to do long before the copy matches: this decides what else to change
  // from the per-element differences the ledger now holds, tries each candidate as an override of css/site.css
  // (no rebuild, nothing written), and keeps only what measured closer to the original on every page and view.
  let correct = null;
  if (correctOn() && !asisMode) {
    const correctDeadline = Math.min(Date.now() + CORRECT_BUDGET, ctx.stepDeadline - FIT_MARGIN - refineTime);
    if (correctDeadline - Date.now() >= CORRECT_MIN) {
      ctx.progress(0.75, 'Correcting the layout against the original');
      try {
        correct = await correctLayout({
          measure: (opts) => measureSite(renderer, ir, site, opts),
          ir,
          site,
          ledger,
          baseCss: out.files.get(CSS_FILE),
          candidates: lastViews.map((x) => ({ path: x.tree.info.path, outPath: x.tree.info.outPath, view: x.view, score: x.score, scrollHeight: x.scrollHeight })),
          shotOf: (tree, view) => path.join(ctx.dir, 'capture', tree.info.slug, `${view}-full.webp`),
          deadline: correctDeadline,
          progress: (f, message) => ctx.progress(0.75 + 0.1 * f, message),
        });
      } catch (err) {
        // A correction pass that fails leaves the copy exactly as the fit pass left it.
        correct = { stopped: 'error', error: err.message.split('\n')[0], rounds: 0, applied: 0, reverted: 0 };
        report.warnings.push(`The layout could not be corrected against the original: ${correct.error}`);
      }
      if (correct?.applied) {
        ({ ir, stats } = build());
        out = emitSite(ir);
        await writeSite(siteDir, out, assetsDir, known);
      }
    } else correct = { stopped: 'time-limit', rounds: 0, applied: 0, reverted: 0 };
  }

  // The same loop again, this time steered by the exact comparison (verify/exact/correct.js): every page, one at a
  // time, worst first, five rounds each, measured at every exact viewport against the baseline taken at that same
  // viewport rather than at the four captured views. It measures the build with data-sas-id, which is what lets a box
  // be matched by path - a production build has no ids, which is why the reporting pass after `build` cannot.
  let exactCorrect = null;
  if (asIs && !asisMode && ctx.exactBaseline?.pages?.length) {
    // The loop is the longest part of an exact run, so a previous attempt that got through it and was interrupted
    // afterwards (a crash, a restart, the machine running out of memory) leaves its result in the checkpoint, and the
    // fixes are put back on the trees instead of being measured again - but only if every saved fix lands on the
    // element it was measured on. One that does not means this is not the same tree, and then the trees go back
    // exactly as they were and the loop runs: a page corrected in parts that were never measured together is worse
    // than an uncorrected one.
    const kept = ctx.checkpoint?.corrections?.() ?? null;
    if (kept?.pages) {
      const before = snapshotFixes(site);
      const expected = Object.values(kept.pages).reduce((n, m) => n + Object.keys(m).length, 0);
      let applied = 0;
      let mismatched = 0;
      for (const tree of site.pages) {
        const saved = kept.pages[tree.info.path];
        if (!saved) continue;
        const r = applyFixesByPath(tree, saved);
        applied += r.applied;
        mismatched += r.mismatched.length;
      }
      if (mismatched || applied !== expected) {
        restoreFixes(site, before);
        report.warnings.push(`The corrections kept from the interrupted attempt did not fit this copy (${mismatched || expected - applied} of ${expected}), so they were measured again.`);
      } else {
        // Nothing to put back is a result too: the loop can run for half an hour and accept nothing, and reaching
        // that answer cost the same half hour as reaching any other.
        exactCorrect = { ...kept.report, restoredFrom: { at: kept.at, elements: applied, pages: Object.keys(kept.pages).length } };
        ctx.progress(0.88, 'Keeping what was measured before the interruption');
        report.warnings.push(applied
          ? `Continued after an interruption: the ${applied} corrections measured for ${Object.keys(kept.pages).length} page(s) were kept instead of measured again.`
          : 'Continued after an interruption: the correction loop had already run and accepted nothing, so it was not run again.');
      }
    }

    if (!exactCorrect) {
      ctx.progress(0.78, 'Correcting the copy against the original at every size');
      const idsOut = emitSite(ir, { ids: true });
      // Per sid: the original's own path, so a box pairs by path instead of by content; which of its two sizes the
      // copy wrote itself; and the pixel or two it asked for on purpose. One definition, shared with the report
      // pass - the loop has to judge by the same ruler the report does, or it chases a number nobody reads.
      const lookups = boxLookups(cpathsOf(site));
      const renderer = await openExactRenderer(siteDir, { scripts: Boolean(site.motion?.script) });
      try {
        // The pages with ids are served from memory; everything else (images, fonts, the stylesheet) comes off disk.
        for (const p of ir.pages) {
          const html = idsOut.files.get(p.outPath);
          if (html) renderer.server.overrides.set(p.outPath, html);
        }
        exactCorrect = await correctExact({
          renderer,
          baseline: ctx.exactBaseline,
          site,
          ir,
          ledger,
          baseCss: idsOut.files.get(CSS_FILE),
          workspace: ctx.dir,
          lookups,
          deadline: ctx.stepDeadline,
          progress: (f, message) => ctx.progress(0.78 + 0.1 * f, message),
        });
      } catch (err) {
        exactCorrect = { stopped: 'error', error: String(err.message ?? err).split('\n')[0], rounds: 0, applied: 0, reverted: 0, pages: [] };
        report.warnings.push(`The copy could not be corrected against the original: ${exactCorrect.error}`);
      } finally {
        await renderer.close().catch(() => {});
      }
      // Written the moment the loop is done, before anything else can fail: half an hour of measuring was lost to an
      // interruption a minute later, and the next run measured all of it again. Saved whenever the loop reached the
      // end of its work, even having applied nothing, because that answer cost the same half hour as any other.
      if (exactCorrect && !exactCorrect.error && (exactCorrect.stopped === 'done' || exactCorrect.applied)) {
        await ctx.checkpoint?.saveCorrections?.({
          at: new Date().toISOString(),
          report: exactCorrect,
          pages: Object.fromEntries(site.pages.map((tree) => [tree.info.path, fixesByPath(tree)])),
        });
      }
    }

    if (exactCorrect?.applied) {
      ({ ir, stats } = build());
      out = emitSite(ir);
      await writeSite(siteDir, out, assetsDir, known);
    }
    report.exact = { ...report.exact, correct: exactCorrect };
  }

  // Breakpoints and fluid type, checked against the original's sweep screenshots (verify/refine.js). Only
  // css/site.css changes, so the pages and the fit fixes above stay as they are.
  let refined = null;
  // The sweep may still be running next to this step (recreate/index.js): the check needs its first pages only, so it
  // waits for those (a bounded time) and works with the pages swept by then.
  let sweep = ctx.sweep;
  if (!asisMode && sweep === undefined && ctx.sweepPending) {
    ctx.progress(0.9, 'Waiting for the screenshots of the original at more widths');
    sweep = await ctx.sweepPending(REFINE_PAGES, Math.max(0, Math.min(SWEEP_WAIT, ctx.stepDeadline - FIT_MARGIN - refineTime - Date.now())));
  }
  if (sweep && !asisMode) {
    ctx.progress(0.9, 'Checking the layout between the captured widths');
    try {
      refined = await refineResponsive({
        ir,
        siteDir,
        workspace: ctx.dir,
        sweep,
        bounds: ir.mediaBounds ?? [],
        deadline: Math.min(Date.now() + refineBudget(sweep?.widths ?? SWEEP_WIDTHS, { exact: asIs }), ctx.stepDeadline - FIT_MARGIN),
      });
    } catch (err) {
      report.warnings.push(`The breakpoints could not be checked against the original: ${err.message.split('\n')[0]}`);
    }
    if (refined?.summary?.stopped === 'time-limit' && !refined.summary.breakpoints) {
      report.warnings.push(`The breakpoints were not checked against the original: the check ran out of time after ${refined.summary.renders} renders. The copy keeps the breakpoints it read from the site's own stylesheets.`);
    }
    if (refined && (refined.breakpoints !== ir.breakpoints || refined.fluid || refined.shrink)) {
      ir.breakpoints = refined.breakpoints;
      ir.rules = refined.rules;
      out = emitSite(ir);
      await writeSite(siteDir, out, assetsDir, known);
    }
  }

  // Hit-test guard (verify/hittest.js): every control must receive its click in the copy wherever it did in the original.
  // A layer that takes the click in the copy and holds nothing clickable lets it through; the rest is reported.
  const maps = new Map();
  for (const info of ctx.pages) {
    const byView = {};
    for (const view of ['desktop', 'mobile']) {
      const map = await readFile(path.join(ctx.dir, 'capture', info.slug, pointerMapFile(view)), 'utf8').then(JSON.parse, () => null);
      if (map) byView[view] = map;
    }
    if (Object.keys(byView).length) maps.set(info.outPath, byView);
  }
  if (maps.size) {
    ctx.progress(0.93, 'Checking every control can still be clicked');
    const ids = cpathsOf(site);
    for (const [outPath, cpaths] of Object.entries(site.asisCpaths ?? {})) ids.pages[outPath] = { cpaths };
    try {
      report.hitTest = await hitTestGuard({
        ir, siteDir, maps, cpaths: ids.pages, launchBrowser,
        views: RECREATE_VIEWS.filter((v) => v.id === 'desktop' || v.id === 'mobile'),
        deadline: Math.min(ctx.stepDeadline ?? Infinity, Date.now() + HIT_TEST_BUDGET_MS) - FIT_MARGIN,
      });
      if (report.hitTest.fixed.length) report.warnings.push(`${report.hitTest.fixed.length} layer${report.hitTest.fixed.length === 1 ? '' : 's'} covering a control in the copy now let${report.hitTest.fixed.length === 1 ? 's' : ''} clicks through, as on the original.`);
      if (report.hitTest.unresolved.length) report.warnings.push(`${report.hitTest.unresolved.length} control${report.hitTest.unresolved.length === 1 ? ' is' : 's are'} covered by another element in the copy and not in the original (see the hit-test check).`);
    } catch (err) {
      report.hitTest = { error: String(err?.message ?? err).split('\n')[0] };
    }
  }

  // The published pages carry their own CSS inline (no render-blocking request, no rules of other pages); the layout
  // passes above worked on the shared css/site.css, which stays in the site for reading and for the app stacks.
  out = emitSite(ir, { inlineCss: true });
  await writeSite(siteDir, out, assetsDir, known);

  ctx.progress(0.95, 'Saving the IR');
  await mkdir(path.join(ctx.dir, 'ir'), { recursive: true });
  await writeFile(path.join(ctx.dir, 'ir', 'site.json'), JSON.stringify(ir));
  // Which element of the original each element of the copy came from. The IR keeps `sid` but not `cpath` - four
  // stack emitters read that file and none of them needs it - so the pairing the exact comparison runs on is saved
  // beside it. Without this the comparison after the build can only pair boxes by their text, which on a real page
  // paired 79 of 577 and reported the other 498 as missing and extra at once (`byPath: 0`).
  if (asIs) {
    const saved = cpathsOf(site);
    // A page kept as-is is the original's markup: its elements stand for capture paths of their own (ir/asis.js).
    for (const [outPath, cpaths] of Object.entries(site.asisCpaths ?? {})) saved.pages[outPath] = { cpaths, sized: {}, slack: {} };
    await writeFile(path.join(ctx.dir, 'ir', 'cpaths.json'), JSON.stringify(saved));
  }
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
    ...(asis && { asis }),
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
    correct,
    // Pages and views where the original does not reflow - its layout stays wider than the screen and overflows
    // sideways. The copy keeps those widths instead of shrinking to the screen (ir/index.js noReflowViews), which
    // is the difference between a narrow page that matches and one two or three times too tall.
    noReflow: site.pages.flatMap((t) => (t.noReflow ?? []).map((view) => ({
      page: t.info.path, view, width: Math.round(t.root.views[view]?.rect?.[2] ?? 0), viewport: VIEW_WIDTHS[view] ?? null,
    }))).slice(0, 100),
    responsive: refined?.summary ?? null,
    motion: { ...motion.stats, script: Boolean(ir.motion?.script) },
    images: images.stats,
  };
  if (asIs) {
    report.exact = {
      ...report.exact,
      mode: 'exact',
      asIs: {
        on: true,
        note: 'The copy replicates the site as it is. These fixes were left out on purpose, so the re-audit rows below are choices, not failures.',
        disabled: [
          { id: 'contrast', what: 'Text colours are copied, never corrected', cost: 'The contrast failures of the original stay' },
          { id: 'responsive-images', what: 'Every picture is served as the original bytes, format and size', cost: 'Image size and format savings are not taken' },
          { id: 'page-css', what: 'The stylesheet keeps every @font-face the original declares', cost: 'A larger stylesheet (unused CSS)' },
          { id: 'dom-size', what: 'Unused sprites, and parts only another window size shows, are kept', cost: 'A larger page (DOM size)' },
          { id: 'head-text', what: 'Titles and descriptions are copied as they are', cost: 'Head texts that are too short, too long or shared by several pages stay' },
          { id: 'broken-links', what: 'A link whose target is dead keeps its href', cost: 'Dead links stay as the original has them' },
          { id: 'image-loading', what: "The main image keeps the original's entrance animation", cost: 'The main image is painted a little later' },
        ],
      },
    };
  }
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
  // What the correction loop changed, and what is still different with the cause for it. The causes a person has to
  // act on (a missing file, an image's own pixels) become manual rows; the rest are counted, never dropped.
  const corrected = correctReport(correct);
  if (corrected.fix) report.fixes.push(corrected.fix);
  report.manual.push(...corrected.manual);

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
  // An animation whose keyframes could not be carried over is a visible loss - the element still asks for the
  // animation and nothing happens - so it is named here and goes to "needs a person" rather than disappearing.
  if (site.keyframesClash?.length) {
    const names = site.keyframesClash.map((k) => k.name).join(', ');
    report.warnings.push(`${site.keyframesClash.length} animation name(s) mean different things on different pages (${names}); the copy has one stylesheet, so the first definition is used everywhere.`);
  }
  if (site.keyframesLost?.length) {
    const names = site.keyframesLost.map((k) => k.name).join(', ');
    report.warnings.push(`${site.keyframesLost.length} animation(s) could not be copied because their keyframes are longer than one capture keeps (${names}); the elements that use them will not move.`);
    report.manual.push({
      kind: 'motion',
      title: `${site.keyframesLost.length} animation${site.keyframesLost.length === 1 ? '' : 's'} could not be copied`,
      detail: `These @keyframes are longer than one capture keeps, so anything using them stays still: ${names}. Copy them from the original stylesheet by hand.`,
    });
  }
  if (fit.stopped) report.warnings.push('The layout fit pass stopped early because of the time limit.');
  if (fit.failed?.length) {
    const list = fit.failed.map((f) => f.path);
    report.warnings.push(`The layout of ${list.length} ${list.length === 1 ? 'page' : 'pages'} could not be checked (the browser could not render ${list.length === 1 ? 'it' : 'them'}, even in a new browser): ${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}. ${list.length === 1 ? 'It keeps' : 'They keep'} the layout as generated.`);
  }
  ctx.progress(1, `Generated ${ir.pages.length} ${ir.pages.length === 1 ? 'page' : 'pages'}`);
}
