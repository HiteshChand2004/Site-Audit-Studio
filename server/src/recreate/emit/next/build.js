// Build + verification of a generated Next.js project (the emitter's `build` hook). Same stages as the
// React + Vite build (emit/react/build.js), with Next's own output: `next build` writes the static site to out/.
//   1. safety of the code around the pages; 2. `next build` with the pinned toolchain; 3. safety of out/ with the
//   Next profile (its own bundles and JSON data pushes only, verify/appProfiles.js); 4. verification of out/;
//   5. equivalence with the plain-HTML build (pages that moved are compared at their new URL, and the HTML build's
//   links are read through the same move), then hydration. A DOM or visual difference fails the export.
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { RecreateError } from '../../errors.js';
import { runToolchain } from '../../build/toolchain.js';
import { compareBuilds } from '../../verify/equivalence.js';
import { scanProject, scanSite } from '../../verify/safety.js';
import { verifyFailure, verifySite } from '../../verify/site.js';

const BUILD_MS = 6 * 60000;

const firstIssue = (scan, where) => `${where}: ${scan.issues[0].file ?? ''} ${scan.issues[0].detail}`.replace(/\s+/g, ' ');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function bundleSizes(dist) {
  const files = await walk(path.join(dist, '_next', 'static'));
  const size = { js: { files: 0, bytes: 0, gzipBytes: 0 }, css: { files: 0, bytes: 0 } };
  for (const f of files) {
    if (f.endsWith('.js')) {
      const buf = await readFile(f);
      size.js.files++;
      size.js.bytes += buf.length;
      size.js.gzipBytes += gzipSync(buf).length;
    } else if (f.endsWith('.css')) {
      size.css.files++;
      size.css.bytes += (await stat(f)).size;
    }
  }
  return size;
}

/**
 * @param {{ dir: string, ir: object, out: { routes: object[], urlChanges: object[], urlMap: object }, assets: string[], report: object,
 *   htmlDist: string, signal?: AbortSignal, progress?: (fraction: number, message?: string) => void }} o
 * @returns {Promise<object>} fields for the stack's report entry
 */
export async function buildNext({ dir, ir, out, assets, report, htmlDist, signal, progress = () => {} }) {
  progress(0, 'Checking the generated source');
  const source = await scanProject(dir);
  if (!source.safe) throw new RecreateError(`The generated Next.js source failed the safety check (${firstIssue(source, 'source')}); it was not kept.`);

  progress(0.05, 'Building with Next.js');
  const started = Date.now();
  const built = await runToolchain({
    dir,
    toolchain: 'next',
    timeoutMs: BUILD_MS,
    signal,
    steps: [{ label: 'The Next.js build', args: ['node_modules/next/dist/bin/next', 'build'] }],
  });
  await rm(path.join(dir, '.next'), { recursive: true, force: true });
  const dist = path.join(dir, 'out');

  progress(0.4, 'Checking the build is safe');
  const safety = await scanSite(dist, { app: 'next' });
  if (!safety.safe) throw new RecreateError(`The Next.js build failed the safety check (${firstIssue(safety, 'out')}); it was not kept.`);

  progress(0.45, 'Verifying links, assets and HTML');
  const expected = [...out.routes.map((r) => r.nextOutPath), ...assets.map((f) => `assets/${f}`), ...ir.files.map((f) => f.path)];
  const verify = await verifySite(dist, { expected });
  if (!verify.ok) throw new RecreateError(verifyFailure(verify).replace('The generated site', 'The Next.js build'));

  const equivalence = await compareBuilds({
    referenceRoot: htmlDist,
    candidateRoot: dist,
    pages: out.routes.map((r) => ({ path: r.route, outPath: r.outPath, candidateOutPath: r.nextOutPath })),
    urlMap: out.urlMap,
    progress: (f, message) => progress(0.5 + 0.5 * f, message),
  });
  if (!equivalence.ok) {
    const bad = equivalence.pages.find((p) => p.dom !== 'equal');
    const low = equivalence.pages.flatMap((p) => Object.entries(p.views).filter(([, v]) => v.visual != null && v.visual < equivalence.visual.threshold).map(([view, v]) => ({ p, view, v })))[0];
    throw new RecreateError(bad
      ? `The Next.js build is not the same page as the plain-HTML build on ${bad.path} (${bad.difference.view} view, line ${bad.difference.index}: ${JSON.stringify(bad.difference.reference)} vs ${JSON.stringify(bad.difference.candidate)}); it was not kept.`
      : `The Next.js build looks different from the plain-HTML build on ${low.p.path} (${low.view} view, ${Math.round(low.v.visual * 100)}% match); it was not kept.`);
  }

  const warnings = [];
  const failed = equivalence.hydration?.pages.filter((p) => !p.ok) ?? [];
  if (failed.length) {
    const first = failed[0];
    warnings.push(`${failed.length} ${failed.length === 1 ? 'page does' : 'pages do'} not hydrate cleanly (for example ${first.path}: ${first.errors[0] ?? (first.domChanged ? 'the DOM changed' : 'not hydrated')}). React renders ${failed.length === 1 ? 'it' : 'them'} again in the browser, so the page still works.`);
  }
  if (out.urlChanges.length) {
    warnings.push(`${out.urlChanges.length} page ${out.urlChanges.length === 1 ? 'URL changes' : 'URLs change'} in the static export (for example ${out.urlChanges[0].from} → ${out.urlChanges[0].to}); redirects are in public/_redirects and vercel.json.`);
  }
  const bundle = await bundleSizes(dist);
  progress(1, 'Next.js build verified');
  return {
    dist: 'out',
    pages: out.routes.map((r) => ({ outPath: r.outPath, path: r.route, file: r.nextOutPath })),
    build: { toolchain: 'next', ms: Date.now() - started, steps: built.steps, ...bundle },
    safety: { safe: true, source: { checked: source.checked }, dist: safety.checked },
    verify: { ok: true, checked: verify.checked, html: verify.html, anchors: verify.anchors.length },
    equivalence: { dom: equivalence.dom, visual: equivalence.visual, pages: equivalence.pages },
    hydration: equivalence.hydration,
    fidelity: { score: report.fidelity?.score ?? null, basis: 'equivalent-to-html', threshold: report.fidelity?.threshold ?? null },
    urlChanges: out.urlChanges,
    warnings,
  };
}
