// The project's stack (React + Vite, Next.js, MERN) built inside the Recreate job (as-is step 5). It needs only what the
// `build` step left in the workspace (ir/site.json, assets/manifest.json, dist/ as the reference), so it starts right after
// it and runs next to preview / sweep / responsive instead of being queued behind the whole job. The output lands where an
// export puts it (stacks/<stack>/ once the workspace is committed, `report.outputs[stack]`).
// Never fails the recreate: a failed build is recorded as `outputs[stack]: failed` (like an export). It is left to the
// export queued after the job (recreate/jobs.js) when the stack cannot be built now: plain HTML (nothing to do), a stack
// or toolchain not ready, no memory for a second browser next to the steps still running, or too little time left.
import { buildStackOutput, checkStackReady, failedOutput } from './export/fromIr.js';
import { RecreateError } from './errors.js';

// Below this much time left in the step, the build is not started here (a Next.js build + equivalence check takes ~1.5 min).
export const STACK_MIN_MS = 3 * 60000;
// The build is stopped this long before the step's limit, so it ends (and removes its temporary folder) before the job goes on.
const STOP_MARGIN_MS = 5000;

/**
 * @param {object} ctx  recreate context (report, dir, signal, canOverlap)
 * @param {{ stepDeadline: number, progress: Function }} local  the step's own limit and progress (it runs in the background)
 */
export async function stackStage(ctx, local) {
  const stack = ctx.report.stack;
  const later = (why) => {
    ctx.report.stackBuild = { inJob: false, reason: why };
    local.progress(1, 'Built after the copy is finished');
  };
  if (!stack || stack === 'html') return local.progress(1);
  try {
    await checkStackReady(stack);
  } catch (err) {
    return later(err.message);
  }
  if (ctx.report.outputs?.html?.status !== 'ready') return later('The plain-HTML build is missing.');
  if (!(ctx.canOverlap?.() ?? true)) return later('Not enough free memory for a second browser.');
  if (local.stepDeadline - Date.now() < STACK_MIN_MS) return later('Not enough time left in the job.');

  // Stops on the job's abort and in time before the step's limit (which moves later after sleep: read it live).
  const controller = new AbortController();
  const stop = () => controller.abort();
  ctx.signal.addEventListener('abort', stop, { once: true });
  const timer = setInterval(() => {
    if (Date.now() > local.stepDeadline - STOP_MARGIN_MS) stop();
  }, 1000);
  const started = Date.now();
  try {
    local.progress(0, 'Building the chosen stack');
    // What the build step wrote dist/ from: the stack's reference is dist/ itself when the same IR emits the same files.
    const built = ctx.generated && { files: ctx.generated.out.files, assets: ctx.generated.siteAssets };
    const output = await buildStackOutput({ dir: ctx.dir, stack, report: ctx.report, signal: controller.signal, progress: local.progress, built });
    ctx.report.outputs = { ...ctx.report.outputs, [stack]: output };
    ctx.report.stackBuild = { inJob: true, ms: Date.now() - started };
  } catch (err) {
    if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
    // Stopped for time: not a failure of the stack, the export after the job builds it as before.
    if (controller.signal.aborted) return later('Not finished in the time left; built after the copy is finished.');
    ctx.report.outputs = { ...ctx.report.outputs, [stack]: failedOutput(stack, err) };
    ctx.report.stackBuild = { inJob: true, ms: Date.now() - started };
  } finally {
    clearInterval(timer);
    ctx.signal.removeEventListener('abort', stop);
  }
}
