// Recreate step 4, "Building & verifying" (4a.4 part): a basic fidelity score of the generated site
// against the captured original, per page and view: layout (element boxes) plus a rough visual
// comparison of the full-page screenshots. Generated screenshots are kept in fidelity/<slug>/ as the
// base for the detailed checks of 4a.6 and the visual diff of Phase 4b.
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encode } from '../../audit/screenshots.js';
import { measureSite, siteRenderer } from '../generate.js';
import { compareLayout, SCORE_WEIGHTS, viewScore, visualSimilarity } from './layout.js';

const exists = (p) => access(p).then(() => true, () => false);
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** @param {object} ctx  needs ctx.generated (generate step) */
export async function fidelityStage(ctx) {
  const { ir, site } = ctx.generated;
  const renderer = await siteRenderer(ctx);
  const results = new Map();
  let done = 0;
  const total = site.pages.reduce((n, t) => n + t.views.length, 0);
  ctx.progress(0, 'Comparing with the original');

  await measureSite(renderer, ir, site, {
    screenshot: true,
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
      ctx.progress(++done / total, `Compared ${done} of ${total} views`);
    },
  });

  const pages = site.pages.map((t) => {
    const views = results.get(t) ?? {};
    return { path: t.info.path, outPath: t.info.outPath, score: mean(Object.values(views).map((v) => v.score)), views };
  });
  ctx.report.fidelity = {
    method: 'Rough, structure-level: element boxes (sizes and positions) and a scaled-down full-page screenshot comparison per view.',
    weights: SCORE_WEIGHTS,
    score: mean(pages.map((p) => p.score).filter((s) => s != null)),
    pages,
  };
}
