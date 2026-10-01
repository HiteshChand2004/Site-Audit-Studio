// Recreate step 4, "Building & verifying":
//   1. production build: dist/ = the generated site with minified CSS/JS (build/minify.js), written
//      atomically; a failure fails the job with the file that broke it;
//   2. safety gate: site/ and dist/ are parsed again (verify/safety.js); any finding fails the job,
//      so an unsafe site is never kept or previewed;
//   3. verification of dist/ (verify/site.js): every file present, no broken internal link, no
//      missing or remote asset, no HTML error; findings of that kind fail the job, HTML warnings and
//      missing anchors are reported;
//   4. fidelity of dist/ against the original (verify/fidelity.js), flagged below the threshold.
// A failing job discards the whole workspace (index.js), so no partial output is ever saved.
import path from 'node:path';
import { RecreateError } from '../errors.js';
import { measureFidelity } from '../verify/fidelity.js';
import { scanSite } from '../verify/safety.js';
import { verifyFailure, verifySite } from '../verify/site.js';
import { buildDist } from './minify.js';

/** @param {object} ctx  needs ctx.generated (generate step) */
export async function buildStage(ctx) {
  const { report } = ctx;
  const { out, siteAssets, assetsDir, siteDir, stats } = ctx.generated;
  const distDir = path.join(ctx.dir, 'dist');

  ctx.progress(0, 'Building the production site');
  const minify = await buildDist({ files: out.files, assets: siteAssets, assetsDir, distDir });
  report.minify = { dir: 'dist', ...minify };
  // The plain-HTML build is the reference every stack is measured against (and the html output).
  report.outputs = { ...report.outputs, html: { status: 'ready', dir: 'dist' } };

  // Safety gate: anything that could run script or load from another origin fails the job.
  ctx.progress(0.06, 'Checking the site is safe to preview');
  const safety = { site: await scanSite(siteDir), dist: await scanSite(distDir) };
  report.safety = {
    safe: safety.site.safe && safety.dist.safe,
    checked: safety.site.checked,
    issues: [...safety.site.issues, ...safety.dist.issues.map((i) => ({ ...i, file: `dist/${i.file}` }))],
    sanitized: {
      svgFiles: ctx.assets?.svg ?? null,
      inlineSvg: { changed: stats.safety.svgChanged, removed: stats.safety.svg },
      htmlAttributes: stats.safety.attrs,
      htmlElements: stats.safety.elements,
    },
  };
  if (!report.safety.safe) {
    const first = report.safety.issues[0];
    throw new RecreateError(`The generated site failed the safety check (${first.file}: ${first.detail}); it was not kept.`);
  }

  ctx.progress(0.1, 'Verifying links, assets and HTML');
  const expected = [...out.files.keys(), ...siteAssets.map((f) => `assets/${f}`)];
  const verify = await verifySite(distDir, { expected });
  report.verify = { dir: 'dist', ...verify };
  if (!verify.ok) throw new RecreateError(verifyFailure(verify));
  if (verify.html.warnings) {
    report.warnings.push(`${verify.html.warnings} HTML validation ${verify.html.warnings === 1 ? 'warning' : 'warnings'} (usually markup carried over from the original page); see the verification report.`);
  }
  if (verify.anchors.length) {
    report.warnings.push(`${verify.anchors.length} in-page ${verify.anchors.length === 1 ? 'link points' : 'links point'} to an anchor that does not exist (for example ${verify.anchors[0].file} → ${verify.anchors[0].href}).`);
  }

  // Fidelity of the production build.
  await measureFidelity(ctx, { root: distDir, progress: (f, message) => ctx.progress(0.15 + 0.85 * f, message) });
}
