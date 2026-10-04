// Fidelity of the generated site against the captured original, per page and view: layout (element
// boxes) plus a rough visual comparison of the full-page screenshots. Part of the build step; it
// renders the production build (dist/), the one the preview serves. Generated screenshots are kept
// in fidelity/<slug>/ for the visual diff of Phase 4b.
//
// Scores are 0–100. A view, page or the whole site scoring below FIDELITY_THRESHOLD is flagged
// ("low") and listed in the report warnings; the site is still kept, since a low score calls for a
// review in the preview, not for throwing the result away.
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encode } from '../../audit/screenshots.js';
import { measureSite, siteRenderer } from '../generate.js';
import { compareLayout, SCORE_WEIGHTS, viewScore, visualSimilarity } from './layout.js';
import { BANDS, SCALE_WEIGHTS, visualDiff } from './visualDiff.js';

export const FIDELITY_THRESHOLD = 80;
// The perceptual visual diff (visualDiff.js) is stricter than the rough score above: a decent recreate lands at 80–95,
// a visibly broken layout at 55 or less. A view, page or the site under this is flagged (first calibration, 4b.7).
export const DIFF_THRESHOLD = 65;
// Scoring stops starting new pages this long before the build step's time limit: an unscored page
// is reported, never a reason to fail the job.
const DEADLINE_MARGIN = 20000;

const exists = (p) => access(p).then(() => true, () => false);
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const isLow = (score, threshold) => score != null && score < threshold;

/**
 * Adds status flags to a fidelity result and returns the warnings to report.
 * @param {{ score: number|null, pages: object[] }} fidelity
 */
export function flagFidelity(fidelity, threshold = FIDELITY_THRESHOLD) {
  fidelity.threshold = threshold;
  for (const page of fidelity.pages) {
    for (const v of Object.values(page.views)) v.low = isLow(v.score, threshold);
    page.low = isLow(page.score, threshold);
    page.lowViews = Object.entries(page.views).filter(([, v]) => v.low).map(([id]) => id);
  }
  fidelity.low = isLow(fidelity.score, threshold);
  fidelity.lowPages = fidelity.pages.filter((p) => p.low).map((p) => p.path);
  fidelity.status = fidelity.score == null ? 'unknown' : fidelity.low ? 'low' : fidelity.lowPages.length ? 'mixed' : 'ok';

  const warnings = [];
  if (fidelity.low) warnings.push(`Overall fidelity is ${fidelity.score}/100, below the ${threshold} threshold. Compare the preview with the original before using the site.`);
  const low = fidelity.pages.filter((p) => p.low);
  if (low.length) {
    const list = low.slice(0, 5).map((p) => `${p.path} (${p.score})`).join(', ');
    warnings.push(`Fidelity is below ${threshold}/100 on ${low.length} ${low.length === 1 ? 'page' : 'pages'}: ${list}${low.length > 5 ? ', …' : ''}.`);
  }
  return warnings;
}

/**
 * Flags of the perceptual visual diff (fidelity.diff, same idea as flagFidelity) and the warnings to report.
 * @param {{ diff: { score: number|null }, pages: object[] }} fidelity
 */
export function flagDiff(fidelity, threshold = DIFF_THRESHOLD) {
  const diff = fidelity.diff;
  diff.threshold = threshold;
  for (const page of fidelity.pages) {
    if (!page.diff) continue;
    for (const v of Object.values(page.views)) if (v.diff) v.diff.low = isLow(v.diff.score, threshold);
    page.diff.low = isLow(page.diff.score, threshold);
    page.diff.lowViews = Object.entries(page.views).filter(([, v]) => v.diff?.low).map(([id]) => id);
  }
  diff.low = isLow(diff.score, threshold);
  diff.lowPages = fidelity.pages.filter((p) => p.diff?.low).map((p) => p.path);
  diff.status = diff.score == null ? 'unknown' : diff.low ? 'low' : diff.lowPages.length ? 'mixed' : 'ok';
  const warnings = [];
  if (diff.low) warnings.push(`The visual difference score is ${diff.score}/100, below ${threshold}: the recreated pages look clearly different from the originals. See the heatmaps in the report.`);
  else if (diff.lowPages.length) {
    const list = diff.lowPages.slice(0, 5).map((p) => `${p} (${fidelity.pages.find((x) => x.path === p).diff.score})`).join(', ');
    warnings.push(`The visual difference score is below ${threshold} on ${diff.lowPages.length} ${diff.lowPages.length === 1 ? 'page' : 'pages'}: ${list}${diff.lowPages.length > 5 ? ', …' : ''}.`);
  }
  return warnings;
}

/**
 * Scores the site rendered from `root` and sets ctx.report.fidelity.
 * @param {object} ctx  needs ctx.generated (generate step)
 * @param {{ root?: string, progress?: (fraction:number, message?:string)=>void }} [o]
 */
export async function measureFidelity(ctx, { root, progress = ctx.progress } = {}) {
  const { ir, site } = ctx.generated;
  const renderer = await siteRenderer(ctx);
  if (root) renderer.server.setRoot(root);
  const results = new Map();
  let done = 0;
  const total = site.pages.reduce((n, t) => n + t.views.length, 0);
  progress(0, 'Comparing with the original');

  const { started, failed } = await measureSite(renderer, ir, site, {
    screenshot: true,
    deadline: (ctx.stepDeadline ?? Infinity) - DEADLINE_MARGIN,
    onView: async (tree, view, result) => {
      const layout = compareLayout(tree.root, view, result.rects);
      const dir = path.join(ctx.dir, 'fidelity', tree.info.slug);
      await mkdir(dir, { recursive: true });
      const file = `${view}-full.webp`;
      await encode(result.png, path.join(dir, file));
      const original = path.join(ctx.dir, 'capture', tree.info.slug, file);
      const has = await exists(original);
      const visual = has ? await visualSimilarity(original, result.png).catch(() => null) : null;
      // Perceptual diff with a heatmap of where the pages differ (fidelity/<slug>/<view>-diff.webp).
      const diff = has ? await visualDiff(original, result.png, { heatmap: path.join(dir, `${view}-diff.webp`) }).catch(() => null) : null;
      const entry = results.get(tree) ?? {};
      entry[view] = {
        score: viewScore(layout, visual),
        ...layout,
        visual,
        ...(diff && {
          diff: { score: Math.round(diff.score * 100), scales: diff.scales, bands: diff.bands, worst: diff.worst, heightOnlyOne: diff.heightOnlyOne, heatmap: `fidelity/${tree.info.slug}/${view}-diff.webp` },
        }),
        height: { original: tree.htmlNode.views[view]?.rect[3] ?? null, generated: result.scrollHeight },
        screenshot: `fidelity/${tree.info.slug}/${file}`,
      };
      results.set(tree, entry);
      progress(++done / total, `Compared ${done} of ${total} views`);
    },
  });

  const pages = site.pages.map((t) => {
    const views = results.get(t) ?? {};
    const diffs = Object.values(views).map((v) => v.diff?.score).filter((s) => s != null);
    return { path: t.info.path, outPath: t.info.outPath, score: mean(Object.values(views).map((v) => v.score)), ...(diffs.length && { diff: { score: mean(diffs) } }), views };
  });
  const late = pages.slice(started).map((p) => p.path);
  const list = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}`;
  const pagesWord = (n) => (n === 1 ? 'page' : 'pages');
  if (late.length) {
    ctx.report.warnings.push(`Fidelity was not measured for ${late.length} ${pagesWord(late.length)} (time limit of the build step): ${list(late)}.`);
  }
  const broken = failed.map((f) => f.path);
  if (broken.length) {
    ctx.report.warnings.push(`Fidelity was not measured for ${broken.length} ${pagesWord(broken.length)} (the browser could not render ${broken.length === 1 ? 'it' : 'them'}, even in a new browser): ${list(broken)}.`);
  }
  const unscored = [...late, ...broken];
  const fidelity = {
    method: 'Rough, structure-level: element boxes (sizes and positions) and a scaled-down full-page screenshot comparison per view, rendered from the production build.',
    weights: SCORE_WEIGHTS,
    score: mean(pages.map((p) => p.score).filter((s) => s != null)),
    pages,
    unscored,
    ...(failed.length && { failed }),
    // Times the local browser crashed and was replaced during the fit pass and this check (pages were rendered again).
    ...(renderer.recoveries && { browserRestarts: renderer.recoveries }),
    diff: {
      method: 'Perceptual (SSIM-style) comparison of the full-page screenshots: luma structure and mean colour per block at two scales; rows only one page has count as different.',
      scales: SCALE_WEIGHTS,
      bands: BANDS,
      score: mean(pages.map((p) => p.diff?.score).filter((s) => s != null)),
    },
  };
  ctx.report.warnings.push(...flagFidelity(fidelity));
  ctx.report.warnings.push(...flagDiff(fidelity));
  ctx.report.fidelity = fidelity;
}
