// Export a completed recreate as another stack WITHOUT capturing again: the saved IR (ir/site.json) and
// the downloaded assets are all an emitter needs. Output goes to <recreate>/stacks/<stack>/, written as
// <stack>.tmp and renamed when the emitter (and its build, if it has one) succeeded, so a failed export
// never leaves a half-written project. The recreate's report gains `outputs[stack]`.
// Runs under the global job lock: stack builds drive Chromium and a toolchain like every other job.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../db/index.js';
import { exclusive } from '../../jobs/manager.js';
import { toolchainStatus } from '../../toolchains/index.js';
import { RecreateError } from '../errors.js';
import { getEmitter } from '../emit/index.js';
import { writeProject } from '../emit/write.js';
import { emitSite } from '../emit/html.js';
import { buildDist } from '../build/minify.js';
import { optimized } from '../optimize.js';
import { recreateDir } from '../workspace.js';

const refuse = (status, message) => Object.assign(new RecreateError(message), { status });

/** The stacks a stored report can be downloaded as: reports from before Phase 6 only know their own. */
export const reportOutputs = (report) => report.outputs ?? { [report.stack ?? 'html']: { status: 'ready', dir: 'dist' } };

/** The folder an output is served, previewed and audited from (the plain-HTML build is `dist`, an app's is e.g. `stacks/nextjs/out`). */
export function outputRoot(dir, report, stack) {
  const out = reportOutputs(report)[stack];
  return path.join(dir, out?.dir ?? 'dist', out?.dist ?? '');
}

/** The output to preview and re-audit: `wanted` (the project's stack) when it is ready, the plain-HTML build otherwise. */
export const targetStack = (report, wanted = report.stack) => (reportOutputs(report)[wanted]?.status === 'ready' ? wanted : 'html');

/**
 * The pages of an output: [{ outPath (in the original site), path (its URL path in this output, "/about/") }].
 * Stacks that move a page (Next.js: about.html → /about/) record the mapping; for the others it is the original layout.
 */
export function outputPages(report, stack) {
  const given = reportOutputs(report)[stack]?.pages;
  if (given?.length) return given.map(({ outPath, path: urlPath }) => ({ outPath, path: urlPath }));
  return (report.pages ?? []).map((p) => ({ outPath: p.outPath, path: `/${p.outPath.replace(/(^|\/)index\.html$/, '$1')}` }));
}

const selectRow = db.prepare(`SELECT result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);
const updateRow = db.prepare('UPDATE recreates SET result_json = ? WHERE id = ?');

/** Can a recreate be built as `stack` right now (emitter ready, its toolchain installed)? Throws why not. */
export async function checkStackReady(stack) {
  const emitter = getEmitter(stack);
  if (!emitter) throw refuse(400, `Unknown stack "${stack}".`);
  if (emitter.status !== 'ready' || !emitter.emit) throw refuse(409, `The ${emitter.label} stack is not available yet.`);
  if (emitter.toolchain) {
    const tool = await toolchainStatus(emitter.toolchain);
    if (!tool.installed) throw refuse(409, `The ${emitter.label} toolchain is not installed. Run: ${tool.setup}`);
  }
  return emitter;
}

/** The `outputs[stack]` entry of a failed emit or build: why, in words the app shows (an unexpected error goes to the log). */
export function failedOutput(stack, err) {
  if (!(err instanceof RecreateError)) console.error(`[export ${stack}] ${err.stack ?? err}`);
  return { status: 'failed', error: err instanceof RecreateError ? err.message : 'The build failed unexpectedly (see the server log).', at: new Date().toISOString() };
}

/**
 * Emits `stack` from the recreate folder `dir` (ir/site.json, assets/manifest.json, and the plain-HTML dist/ it is checked
 * against) and builds it into <dir>/stacks/<stack>/ (written as <stack>.tmp, renamed once everything succeeded).
 * Used by an export of a completed recreate and by the recreate job itself, inside its workspace (recreate/stack.js).
 * A missing IR or asset manifest is refused with status 404 before anything is written.
 * @param {{ dir: string, stack: string, report: object, signal?: AbortSignal, progress?: (fraction: number, message?: string) => void,
 *   built?: { files: Map<string, string>, assets: string[] }, htmlReady?: Promise<void> }} o
 *   built: what the recreate job's own build step wrote to dist/ (its emitted files and assets): when the plain-HTML emit of the
 *   saved IR is exactly that, dist/ is the reference as it stands instead of being built a second time (optimize-create-copy,
 *   SAS_COPY_OPT_STACK_REF)
 *   htmlReady: resolves once the job's build step has written dist/ (the stack build started before it ended)
 * @returns {Promise<object>} the `outputs[stack]` entry
 */
export async function buildStackOutput({ dir, stack, report, signal, progress, built: jobBuild = null, htmlReady = null }) {
  const emitter = getEmitter(stack);
  const ir = await readFile(path.join(dir, 'ir', 'site.json'), 'utf8').then(JSON.parse, () => null);
  if (!ir) throw refuse(404, 'The saved IR of this recreate is gone (only the latest recreates keep their files). Run Recreate again.');
  const manifest = await readFile(path.join(dir, 'assets', 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  if (!manifest) throw refuse(404, 'The downloaded assets of this recreate are gone. Run Recreate again.');
  const known = new Set((manifest.files ?? []).map((f) => f.file));

  const target = path.join(dir, 'stacks', stack);
  const tmp = `${target}.tmp`;
  const reference = path.join(dir, 'stacks', `${stack}.html-ref.tmp`);
  await rm(tmp, { recursive: true, force: true });
  // Where the time goes (outputs[stack].ms): writing the project, the plain-HTML reference, the stack's build + checks.
  const ms = {};
  let mark = Date.now();
  const lap = (k) => { const now = Date.now(); ms[k] = now - mark; mark = now; };
  try {
    const out = emitter.emit(ir, {});
    await writeProject(tmp, out, { assetsDir: path.join(dir, 'assets'), known, assetsTarget: emitter.assetsTarget });
    const assets = [...out.assets].filter((f) => known.has(f));
    // The stack is checked against the plain-HTML build of the same IR written by this same code: the dist/ of the
    // recreate may come from an older version of the emitter (a copy made yesterday), and any change in how a page is
    // written would then look like a difference of the stack.
    lap('emit');
    // The recreate's own dist/: when the job's build step is still writing it (the stack started early, recreate/stack.js),
    // the reference is a promise of it, which the emitter's build awaits only for its equivalence check.
    const jobDist = () => {
      if (!htmlReady) return path.join(dir, 'dist');
      const ready = htmlReady.then(() => path.join(dir, 'dist'));
      ready.catch(() => {}); // a build that fails before it is awaited ends the job anyway
      return ready;
    };
    let htmlDist = null;
    if (emitter.build) {
      try {
        const html = emitSite(ir, { inlineCss: true });
        const htmlAssets = [...html.assets].filter((f) => known.has(f));
        // Inside the job that has just built dist/ from this same IR with this same code: the same emitted files and assets
        // make the same build, so dist/ is the reference as it stands (nothing writes it after the build step).
        if (jobBuild && optimized('STACK_REF') && sameBuild(html.files, htmlAssets, jobBuild)) {
          ms.htmlReferenceReused = true;
          htmlDist = jobDist();
        } else {
          await buildDist({ files: html.files, assets: htmlAssets, assetsDir: path.join(dir, 'assets'), distDir: reference });
          htmlDist = reference;
        }
      } catch {
        // An IR the HTML emitter cannot write (none from a real recreate): the recreate's own dist/ stays the reference.
      }
    }
    htmlDist ??= jobDist();
    lap('htmlReference');
    const built = (await emitter.build?.({ dir: tmp, ir, out, assets, report, htmlDist, ...(signal && { signal }), ...(progress && { progress }) })) ?? {};
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
    lap('build');
    return { status: 'ready', dir: `stacks/${stack}`, from: 'ir', exportedAt: new Date().toISOString(), files: out.files.size, ...built, ms };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await rm(reference, { recursive: true, force: true }).catch(() => {});
  }
}

/** Are the emitted files and assets of a plain-HTML build exactly those the job's build step wrote dist/ from? */
function sameBuild(files, assets, built) {
  if (files.size !== built.files.size || assets.length !== built.assets.length) return false;
  for (const [file, text] of files) if (built.files.get(file) !== text) return false;
  const have = new Set(built.assets);
  return assets.every((f) => have.has(f));
}

async function runExport({ projectId, recreateId, stack }) {
  const row = selectRow.get(recreateId, projectId);
  if (!row?.result_json) throw refuse(404, 'Recreate not found.');
  const report = JSON.parse(row.result_json);
  const outputs = reportOutputs(report);
  if (!getEmitter(stack)) throw refuse(400, `Unknown stack "${stack}".`);
  if (outputs[stack]?.status === 'ready') return { report, output: outputs[stack], created: false };
  await checkStackReady(stack);

  const dir = recreateDir(projectId, recreateId);
  try {
    const output = await buildStackOutput({ dir, stack, report });
    report.outputs = { ...outputs, [stack]: output };
    const json = JSON.stringify(report);
    updateRow.run(json, recreateId);
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
    return { report, output, created: true };
  } catch (err) {
    // The IR or the assets are gone: refused, nothing recorded (a retry cannot help).
    if (err.status === 404) throw err;
    // A failed emit or build is remembered (the app shows why and offers a retry); nothing else is kept.
    report.outputs = { ...outputs, [stack]: failedOutput(stack, err) };
    updateRow.run(JSON.stringify(report), recreateId);
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 1)).catch(() => {});
    throw err;
  }
}

/** Exports `stack` from the saved IR of a completed recreate (once; an existing output is returned). */
export const exportStack = (opts) => exclusive(() => runExport(opts));
