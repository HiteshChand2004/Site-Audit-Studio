// Build + verification of a generated React + Vite project (the emitter's `build` hook):
//   1. safety of the source (verify/safety.js scanProject): the code we wrote has no script sink;
//   2. the build with the pinned toolchain: vite build, the server build, then the prerender script
//      (every page written to dist/ at its original path);
//   3. safety of dist/ with the app rules: only our own /_app bundle may run, no remote script;
//   4. verification of dist/ (files, links, assets, HTML), like the plain-HTML build;
//   5. equivalence with the plain-HTML build: same DOM and pixels with JavaScript off, and the pages
//      hydrate without errors with it on (verify/equivalence.js). The plain-HTML build was scored against
//      the original, so an equivalent build has the same fidelity.
// Any failure of 1–5 except hydration fails the export; nothing is kept.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { RecreateError } from '../../errors.js';
import { compareBuilds } from '../../verify/equivalence.js';
import { scanProject, scanSite } from '../../verify/safety.js';
import { verifyFailure, verifySite } from '../../verify/site.js';
import { runToolchain } from '../../build/toolchain.js';
import { pagePath } from './index.js';

const BUILD_MS = 4 * 60000;

const firstIssue = (scan, where) => `${where}: ${scan.issues[0].file ?? ''} ${scan.issues[0].detail}`.replace(/\s+/g, ' ');

async function bundleSizes(dist) {
  const dir = path.join(dist, '_app');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.js'));
  let bytes = 0;
  let gzip = 0;
  for (const f of files) {
    const buf = await readFile(path.join(dir, f));
    bytes += buf.length;
    gzip += gzipSync(buf).length;
  }
  const css = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.css'));
  let cssBytes = 0;
  for (const f of css) cssBytes += (await stat(path.join(dir, f))).size;
  return { js: { files: files.length, bytes, gzipBytes: gzip }, css: { files: css.length, bytes: cssBytes } };
}

/**
 * @param {{ dir: string, ir: object, assets: string[], report: object, htmlDist: string, signal?: AbortSignal,
 *   progress?: (fraction: number, message?: string) => void, toolchain?: string }} o
 *   assets: asset files written into the project (relative to assets/)
 * @returns {Promise<object>} fields for the stack's report entry
 */
export async function buildReact({ dir, ir, assets, report, htmlDist, signal, progress = () => {}, toolchain = 'react-vite' }) {
  progress(0, 'Checking the generated source');
  const source = await scanProject(dir);
  if (!source.safe) throw new RecreateError(`The generated React source failed the safety check (${firstIssue(source, 'source')}); it was not kept.`);

  progress(0.05, 'Building with Vite');
  const started = Date.now();
  const built = await runToolchain({
    dir,
    toolchain,
    timeoutMs: BUILD_MS,
    signal,
    steps: [
      { label: 'The Vite build', args: ['vite', 'build'] },
      { label: 'The Vite server build', args: ['vite', 'build', '--ssr', 'src/entry-server.jsx', '--outDir', '.ssr'] },
      { label: 'The prerender', args: ['scripts/prerender.mjs'] },
    ],
  });
  const dist = path.join(dir, 'dist');

  progress(0.4, 'Checking the build is safe');
  const content = new Set([...(await readdir(path.join(dir, 'src', 'pages'))), ...(await readdir(path.join(dir, 'src', 'components')).catch(() => []))].map((f) => f.replace(/\.jsx$/, '')));
  const safety = await scanSite(dist, { app: true, contentChunk: (rel) => [...content].some((n) => rel.startsWith(`_app/${n}-`)) });
  if (!safety.safe) throw new RecreateError(`The React build failed the safety check (${firstIssue(safety, 'dist')}); it was not kept.`);

  progress(0.45, 'Verifying links, assets and HTML');
  const expected = [...ir.pages.map((p) => p.outPath), ...assets.map((f) => `assets/${f}`), ...ir.files.map((f) => f.path)];
  const verify = await verifySite(dist, { expected });
  if (!verify.ok) throw new RecreateError(verifyFailure(verify).replace('The generated site', 'The React build'));

  const pages = ir.pages.map((p) => ({ path: pagePath(p.outPath), outPath: p.outPath }));
  const equivalence = await compareBuilds({
    referenceRoot: htmlDist,
    candidateRoot: dist,
    pages,
    progress: (f, message) => progress(0.5 + 0.5 * f, message),
  });
  if (!equivalence.ok) {
    const bad = equivalence.pages.find((p) => p.dom !== 'equal');
    const low = equivalence.pages.flatMap((p) => Object.entries(p.views).filter(([, v]) => v.visual != null && v.visual < equivalence.visual.threshold).map(([view, v]) => ({ p, view, v })))[0];
    throw new RecreateError(bad
      ? `The React build is not the same page as the plain-HTML build on ${bad.path} (${bad.difference.view} view, line ${bad.difference.index}: ${JSON.stringify(bad.difference.reference)} vs ${JSON.stringify(bad.difference.candidate)}); it was not kept.`
      : `The React build looks different from the plain-HTML build on ${low.p.path} (${low.view} view, ${Math.round(low.v.visual * 100)}% match); it was not kept.`);
  }

  const warnings = [];
  const failed = equivalence.hydration?.pages.filter((p) => !p.ok) ?? [];
  if (failed.length) {
    const first = failed[0];
    warnings.push(`${failed.length} ${failed.length === 1 ? 'page does' : 'pages do'} not hydrate cleanly (for example ${first.path}: ${first.errors[0] ?? (first.domChanged ? 'the DOM changed' : 'not hydrated')}). React renders ${failed.length === 1 ? 'it' : 'them'} again in the browser, so the page still works.`);
  }
  const bundle = await bundleSizes(dist);
  progress(1, 'React build verified');
  return {
    dist: 'dist',
    build: { toolchain, ms: Date.now() - started, steps: built.steps, ...bundle },
    safety: { safe: true, source: { checked: source.checked }, dist: safety.checked },
    verify: { ok: true, checked: verify.checked, html: verify.html, anchors: verify.anchors.length },
    equivalence: { dom: equivalence.dom, visual: equivalence.visual, pages: equivalence.pages },
    hydration: equivalence.hydration,
    fidelity: { score: report.fidelity?.score ?? null, basis: 'equivalent-to-html', threshold: report.fidelity?.threshold ?? null },
    warnings,
  };
}
