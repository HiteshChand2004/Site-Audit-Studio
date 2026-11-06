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
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RecreateError } from '../errors.js';
import { measureFidelity } from '../verify/fidelity.js';
import { releaseSiteRenderer, siteRenderer } from '../generate.js';
import { scanSite } from '../verify/safety.js';
import { verifyFailure, verifySite } from '../verify/site.js';
import { buildDist } from './minify.js';
import { fixAndProve } from '../behavior/preserve/stage.js';

/**
 * The exact copy's pages that keep the original markup, through the as-is fixes and their proof (fixAndProve), in the job's
 * browser. No new address is written (the rebuild writes canonical, sitemap and robots itself), no llms.txt is fetched. A page
 * whose fixes change the look gets its built HTML back; the report lists what was kept, dropped and undone.
 */
export async function fixExactCopy(ctx, distDir) {
  const { ir, site } = ctx.generated;
  const urlOf = new Map(site.pages.map((t) => [t.info.outPath, t.info.url]));
  const pages = ir.pages.filter((p) => p.asis && urlOf.get(p.outPath)).map((p) => ({ outPath: p.outPath, url: urlOf.get(p.outPath) }));
  if (!pages.length) return { pages: 0 };
  const renderer = await siteRenderer(ctx);
  const started = Date.now();
  // Each page as built, put back if the proof stops half way (a page could then be fixed and not yet proved).
  const built = new Map();
  for (const p of pages) built.set(p.outPath, await readFile(path.join(distDir, p.outPath), 'utf8'));
  try {
    const fixes = await fixAndProve({
      browser: renderer.browser, copyDir: distDir, gateDir: path.join(ctx.dir, 'dist-unfixed'), pages,
      siteUrl: pages[0].url, newSiteUrl: null, log: (m) => ctx.progress(0.04, String(m).slice(0, 200)),
    });
    const { gate, ...kept } = fixes;
    return { ...kept, looks: gate.length, ms: Date.now() - started };
  } catch (err) {
    // The fixes are an improvement, never a reason to lose the copy: every page goes back to how it was built.
    for (const [outPath, html] of built) await writeFile(path.join(distDir, outPath), html, 'utf8');
    ctx.report.warnings.push(`The fixes that keep the look could not be made on the exact copy (${String(err?.message ?? err).split('\n')[0].slice(0, 160)}); its pages are as built.`);
    return { error: String(err?.message ?? err).slice(0, 300), ms: Date.now() - started };
  }
}

/** @param {object} ctx  needs ctx.generated (generate step) */
export async function buildStage(ctx) {
  const { report } = ctx;
  const { out, siteAssets, assetsDir, siteDir, stats } = ctx.generated;
  const distDir = path.join(ctx.dir, 'dist');

  ctx.progress(0, 'Building the production site');
  const minify = await buildDist({ files: out.files, assets: siteAssets, assetsDir, distDir });
  report.minify = { dir: 'dist', ...minify };
  // The plain-HTML build is the reference every stack is measured against (and the html output).
  // `scripts`: the build carries the generated reveal script (js/motion.js), so its preview needs a script policy.
  const scripts = Boolean(ctx.generated.ir?.motion?.script);
  report.outputs = { ...report.outputs, html: { status: 'ready', dir: 'dist', ...(scripts && { scripts: true }) } };

  // Exact mode: the pages keep the original's markup (ir/asis.js), so the tree fixes the generate step made never reach them.
  // The fixes "Copy my site" makes (copy/fixAsIs.js, copy/perfAsIs.js) are made on dist/ instead, each page proved unchanged
  // by them at 375 and 1440 px (preserve/stage.js fixAndProve: a fix that changes a pixel is undone), in the job's own
  // browser. Before the safety gate and the verification, so both check the fixed site.
  if (ctx.exact && ctx.generated.ir?.asis) {
    ctx.progress(0.03, 'Fixing what can be fixed without changing the look');
    report.exactFixes = await fixExactCopy(ctx, distDir);
  }

  // Safety gate: anything that could run script or load from another origin fails the job. The one script allowed
  // is the fixed reveal script (verify/appProfiles.js `motion`).
  ctx.progress(0.06, 'Checking the site is safe to preview');
  const scanOpts = scripts ? { app: 'motion' } : {};
  const safety = { site: await scanSite(siteDir, scanOpts), dist: await scanSite(distDir, scanOpts) };
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
  // The last use of the shared renderer: its browser is not held through preview, the exact comparison and the stack build.
  await releaseSiteRenderer(ctx);
}
