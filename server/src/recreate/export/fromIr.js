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
import { recreateDir } from '../workspace.js';

const refuse = (status, message) => Object.assign(new RecreateError(message), { status });

/** The stacks a stored report can be downloaded as: reports from before Phase 6 only know their own. */
export const reportOutputs = (report) => report.outputs ?? { [report.stack ?? 'html']: { status: 'ready', dir: 'dist' } };

const selectRow = db.prepare(`SELECT result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);
const updateRow = db.prepare('UPDATE recreates SET result_json = ? WHERE id = ?');

async function runExport({ projectId, recreateId, stack }) {
  const row = selectRow.get(recreateId, projectId);
  if (!row?.result_json) throw refuse(404, 'Recreate not found.');
  const report = JSON.parse(row.result_json);
  const outputs = reportOutputs(report);
  const emitter = getEmitter(stack);
  if (!emitter) throw refuse(400, `Unknown stack "${stack}".`);
  if (outputs[stack]?.status === 'ready') return { report, output: outputs[stack], created: false };
  if (emitter.status !== 'ready' || !emitter.emit) throw refuse(409, `The ${emitter.label} stack is not available yet.`);
  if (emitter.toolchain) {
    const tool = await toolchainStatus(emitter.toolchain);
    if (!tool.installed) throw refuse(409, `The ${emitter.label} toolchain is not installed. Run: ${tool.setup}`);
  }

  const dir = recreateDir(projectId, recreateId);
  const irFile = path.join(dir, 'ir', 'site.json');
  const ir = await readFile(irFile, 'utf8').then(JSON.parse, () => null);
  if (!ir) throw refuse(404, 'The saved IR of this recreate is gone (only the latest recreates keep their files). Run Recreate again.');
  const manifest = await readFile(path.join(dir, 'assets', 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  if (!manifest) throw refuse(404, 'The downloaded assets of this recreate are gone. Run Recreate again.');
  const known = new Set((manifest.files ?? []).map((f) => f.file));

  const target = path.join(dir, 'stacks', stack);
  const tmp = `${target}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  try {
    const out = emitter.emit(ir, {});
    await writeProject(tmp, out, { assetsDir: path.join(dir, 'assets'), known, assetsTarget: emitter.assetsTarget });
    const assets = [...out.assets].filter((f) => known.has(f));
    const built = (await emitter.build?.({ dir: tmp, ir, out, assets, report, htmlDist: path.join(dir, 'dist') })) ?? {};
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
    const output = { status: 'ready', dir: `stacks/${stack}`, from: 'ir', exportedAt: new Date().toISOString(), files: out.files.size, ...built };
    report.outputs = { ...outputs, [stack]: output };
    const json = JSON.stringify(report);
    updateRow.run(json, recreateId);
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
    return { report, output, created: true };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    // A failed emit or build is remembered (the app shows why and offers a retry); nothing else is kept.
    if (err instanceof RecreateError) {
      const failed = { status: 'failed', error: err.message, at: new Date().toISOString() };
      report.outputs = { ...outputs, [stack]: failed };
      updateRow.run(JSON.stringify(report), recreateId);
      await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 1)).catch(() => {});
    }
    throw err;
  }
}

/** Exports `stack` from the saved IR of a completed recreate (once; an existing output is returned). */
export const exportStack = (opts) => exclusive(() => runExport(opts));
