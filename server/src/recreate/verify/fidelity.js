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

export const FIDELITY_THRESHOLD = 80;
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

  const rendered = await measureSite(renderer, ir, site, {
    screenshot: true,
    deadline: (ctx.stepDeadline ?? Infinity) - DEADLINE_MARGIN,
    onView: async (tree, view, result) => {
      const layout = compareLayout(tree.root, view, result.rects);
      const dir = path.join(ctx.dir, 'fidelity', tree.info.slug);
      await mkdir(dir, { recursive: true });
      const file = `${view}-full.webp`;
      await encode(result.png, path.join(dir, file));
      const original = path.join(ctx.dir, 'capture', tree.info.slug, file);
      const visual = (await exists(original)) ? await visualSimilarity(original, result.png).catch(() => null) : null;
      const entry = results.get(tree) ?? {};
      entry[view] = {
        score: viewScore(layout, visual),
        ...layout,
        visual,
        height: { original: tree.htmlNode.views[view]?.rect[3] ?? null, generated: result.scrollHeight },
        screenshot: `fidelity/${tree.info.slug}/${file}`,
      };
      results.set(tree, entry);
      progress(++done / total, `Compared ${done} of ${total} views`);
    },
  });

  const pages = site.pages.map((t) => {
    const views = results.get(t) ?? {};
    return { path: t.info.path, outPath: t.info.outPath, score: mean(Object.values(views).map((v) => v.score)), views };
  });
  const unscored = pages.slice(rendered).map((p) => p.path);
  if (unscored.length) {
    ctx.report.warnings.push(`Fidelity was not measured for ${unscored.length} ${unscored.length === 1 ? 'page' : 'pages'} (time limit of the build step): ${unscored.slice(0, 5).join(', ')}${unscored.length > 5 ? ', …' : ''}.`);
  }
  const fidelity = {
    method: 'Rough, structure-level: element boxes (sizes and positions) and a scaled-down full-page screenshot comparison per view, rendered from the production build.',
    weights: SCORE_WEIGHTS,
    score: mean(pages.map((p) => p.score).filter((s) => s != null)),
    pages,
    unscored,
  };
  ctx.report.warnings.push(...flagFidelity(fidelity));
  ctx.report.fidelity = fidelity;
}
