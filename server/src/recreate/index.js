// The Recreate pipeline (plain HTML/CSS/JS): Inspecting → Extracting assets → Generating →
// Building → Starting preview. It works from the rendered output of the site, never its source.
// All outbound traffic runs under the user SSRF policy, like Analyze.
//
// Each step is a stage function that reads and extends a shared context. A failing step fails
// the job: later steps need its output. The whole job has one time budget
// (SAS_RECREATE_MINUTES, default 12); the workspace is discarded when anything goes wrong.
//
// Steps run one after the other, except a `background` step (the sweep of the original at more widths, the build of the
// project's stack): it runs next to the steps after it instead of making them wait, and is awaited by the step that needs
// its whole result (`join`), or at the end. On a machine short of memory it is awaited before the next browser step.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { userPolicy, withNetPolicy } from '../security/netGuard.js';
import { maxParallel, parallelism } from '../audit/resources.js';
import { TimeoutError } from '../audit/util.js';
import { createInterrupts, extendableTimeout } from './interrupts.js';
import { analysisWarnings, baseUrlOf, isAllPages, latestAnalysis, pageLimitOf } from './inputs.js';
import { RecreateError } from './errors.js';
import { assetsStage } from './assets/index.js';
import { buildStage } from './build/index.js';
import { generateStage } from './generate.js';
import { inspectStage, LATER_STEPS_RESERVE } from './inspect.js';
import { previewStage } from './preview.js';
import { responsiveStage } from './responsive.js';
import { stackStage } from './stack.js';
import { sweepStage } from './sweep.js';
import { commitWorkspace, discardWorkspace, openWorkspace } from './workspace.js';

export { RecreateError };

// weight = share of the progress bar; max = the step's own time limit for up to BASE_PAGES pages; perPage = what each page
// beyond them adds (the limit follows the work: "All pages" may be dozens of pages). Allowances measured on a 2-core laptop
// (capture ~60–140 s per page with one view at a time, the 7-width sweep ~55–75 s), with room to spare: a limit is a safety
// net, a job ends when its work is done.
export const BASE_PAGES = 6;
export const STEPS = [
  // Capture is the slow part on slow sites (a page can take 50 s); it stops starting pages in time to
  // leave the later steps their reserve (inspect.js).
  { key: 'inspect', label: 'Inspecting pages', weight: 35, max: 7 * 60000, perPage: 150000 },
  { key: 'assets', label: 'Extracting assets', weight: 25, max: 4 * 60000, perPage: 15000 },
  // browser: the step renders pages itself, so it shares the machine with a background step only when memory allows.
  { key: 'generate', label: 'Generating site', weight: 15, max: 4 * 60000, browser: true, perPage: 45000 },
  { key: 'build', label: 'Building & verifying', weight: 20, max: 3 * 60000, browser: true, perPage: 45000 },
  { key: 'preview', label: 'Starting preview', weight: 5, max: 30000, perPage: 3000 },
  // Original screenshots at more widths (4b.6): collects only, never fails the job. A background step: it starts right
  // after the capture (`after`) and runs next to the steps above; the last step needs all of it (`join`). It is listed
  // here, where the job waits for it, so the step list of the app only ever moves forward.
  { key: 'sweep', label: 'Capturing more widths', weight: 8, max: 4 * 60000, optional: true, background: true, after: 'inspect', join: 'responsive', perPage: 120000 },
  // Measures the finished build against the sweep screenshots (4b.6): never fails the job.
  { key: 'responsive', label: 'Checking responsive layout', weight: 4, max: 90000, optional: true, perPage: 30000 },
  // The project's stack (React + Vite, Next.js, MERN) built from what the build step left (recreate/stack.js): a background
  // step next to the ones above when a second browser fits, else left to the export after the job. Never fails the job.
  { key: 'stack', label: 'Building the chosen stack', weight: 6, max: 8 * 60000, optional: true, background: true, after: 'build', perPage: 20000 },
];
// What each page beyond BASE_PAGES adds to the whole job, and to the time the capture keeps for the steps after it.
const JOB_PER_PAGE = STEPS.reduce((n, s) => n + (s.perPage ?? 0), 0);
const LATER_PER_PAGE = STEPS.filter((s) => !s.background && s.key !== 'inspect').reduce((n, s) => n + (s.perPage ?? 0), 0);
export const PUBLIC_STEPS = STEPS.map(({ key, label }) => ({ key, label }));

export function overallPct(stepKey, fraction) {
  const total = STEPS.reduce((n, s) => n + s.weight, 0);
  let before = 0;
  for (const s of STEPS) {
    if (s.key === stepKey) return Math.round(((before + s.weight * Math.min(1, Math.max(0, fraction))) / total) * 100);
    before += s.weight;
  }
  return 0;
}

/** Total time limit in ms. SAS_RECREATE_MINUTES accepts 1–60; anything else means 12 (the 10 of Phase 4a + 2 for the responsive sweep). */
export function recreateBudgetMs(env = process.env) {
  const minutes = Number(env.SAS_RECREATE_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 12) * 60000;
}

/** SAS_RECREATE_MINUTES set: a fixed total the user chose. Unset: 12 minutes for BASE_PAGES pages, more for every page beyond. */
export const fixedBudget = (env = process.env) => {
  const minutes = Number(env.SAS_RECREATE_MINUTES);
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 60;
};

// Free memory (beyond what the machine keeps for itself, resources.js) a second browser needs: with less, a background
// step is finished first instead of running next to a step that renders pages. SAS_RECREATE_OVERLAP=1 / 0 decides it
// for a machine whose capacity is known (1: always side by side, 0: never). SAS_MAX_PARALLEL=1 (one browser context at a time)
// also means never, unless SAS_RECREATE_OVERLAP=1 says otherwise.
const SECOND_BROWSER_MB = 900;
export function roomForSecondBrowser(env = process.env) {
  if (env.SAS_RECREATE_OVERLAP === '1') return true;
  if (env.SAS_RECREATE_OVERLAP === '0') return false;
  if (maxParallel(env) === 1) return false;
  return parallelism({ perUnitMB: SECOND_BROWSER_MB, max: 1, min: 0 }) > 0;
}

export const STAGES = {
  inspect: inspectStage,
  sweep: sweepStage,
  assets: assetsStage,
  generate: generateStage,
  build: buildStage,
  preview: previewStage,
  responsive: responsiveStage,
  stack: stackStage,
};

/**
 * @param {object} o
 * @param {object} o.project  projects row
 * @param {string} o.recreateId
 * @param {(step:string, fraction:number, message?:string)=>void} o.progress
 * @param {string[]} [o.warnings]  shown in the report (for example a stale analysis)
 * @param {Record<string, (ctx:object)=>Promise<void>>} [o.stages]  injectable for tests
 * @param {number} [o.budgetMs]
 * @param {() => boolean} [o.canOverlap]  may a background step run next to a browser step (default: by free memory)
 * @param {object} [o.netPolicy]  user projects always get the default user policy
 * @returns {Promise<object>} the recreate report
 */
export function runRecreate({ netPolicy = userPolicy(), ...opts }) {
  return withNetPolicy(netPolicy, () => recreate({ ...opts, netPolicy }));
}

async function recreate({ project, recreateId, progress, warnings = [], stages = STAGES, budgetMs = recreateBudgetMs(), autoBudget = !fixedBudget(), canOverlap = () => roomForSecondBrowser(), netPolicy, interruptOptions = {} }) {
  const analysis = latestAnalysis(project.id);
  if (!analysis) throw new RecreateError('Run Analyze first: Recreate works from a completed analysis.');

  // Moves later when time is given back after sleep or a network outage (recreate/interrupts.js), within its allowance.
  let deadline = Date.now() + budgetMs;
  const controller = new AbortController();
  const disposers = [];
  const dispose = async () => {
    while (disposers.length) await disposers.pop()().catch(() => {});
  };
  // Steps running now (the one in front and background ones): time given back extends their limits too.
  const running = new Set();
  let front = null;

  const dir = await openWorkspace(project.id, recreateId);
  const ctx = {
    project,
    recreateId,
    analysis,
    audit: analysis.audit,
    baseUrl: baseUrlOf(project, analysis.audit),
    pageLimit: pageLimitOf(project.recreate_pages),
    allPages: isAllPages(project.recreate_pages),
    netPolicy,
    dir,
    signal: controller.signal,
    jobDeadline: deadline,
    /** Registers cleanup (browsers, proxies) that runs when the job ends, in reverse order. */
    defer: (fn) => disposers.push(fn),
    /** May a background step run a second browser next to the steps still to come (free memory)? */
    canOverlap,
    progress: null,
    report: {
      recreateId,
      analysisId: analysis.id,
      stack: project.stack ?? 'html',
      outputs: {},
      createdAt: new Date().toISOString(),
      baseUrl: null,
      pages: [],
      fixes: [],
      autoGenerated: [],
      manual: [],
      fidelity: null,
      preview: null,
      warnings: [...warnings],
      errors: [],
    },
  };
  ctx.report.baseUrl = ctx.baseUrl;
  const interrupts = createInterrupts({
    url: ctx.audit.url ?? project.url,
    label: recreateId.slice(0, 8),
    ...interruptOptions,
    onGrant: (ms) => {
      deadline += ms;
      ctx.jobDeadline = deadline;
      for (const r of running) {
        r.timer.extend(ms);
        r.local.stepDeadline += ms;
      }
      if (front) ctx.stepDeadline = front.stepDeadline;
    },
  });
  ctx.interrupts = interrupts;
  disposers.push(async () => interrupts.stop());

  // The limits follow the work: once discovery knows how many pages there are (inspect calls this), every page beyond
  // BASE_PAGES extends the job (unless SAS_RECREATE_MINUTES fixed it), the running capture, the time the capture keeps for
  // the later steps, and the limit each later step starts with.
  ctx.pageScale = 0;
  ctx.laterReserve = LATER_STEPS_RESERVE;
  ctx.scaleToPages = (count) => {
    const extra = Math.max(0, count - BASE_PAGES) - ctx.pageScale;
    if (extra <= 0) return;
    ctx.pageScale += extra;
    ctx.laterReserve = LATER_STEPS_RESERVE + ctx.pageScale * LATER_PER_PAGE;
    if (autoBudget) {
      deadline += extra * JOB_PER_PAGE;
      ctx.jobDeadline = deadline;
    }
    for (const r of running) {
      const add = extra * (r.def.perPage ?? 0);
      r.timer.extend(add);
      r.local.stepDeadline += add;
    }
    if (front) ctx.stepDeadline = front.stepDeadline;
  };

  const minutes = Math.round(budgetMs / 60000);
  const startedAt = Date.now();
  const timings = {};
  // Background steps still running: key → { def, done } (done resolves to the step's error, or null).
  const background = new Map();
  const join = async (key) => {
    const task = background.get(key);
    if (!task) return;
    background.delete(key);
    const err = await task.done;
    if (err) throw err;
  };

  // Runs one step within `limit` ms. An optional step that fails or runs out of time is a warning, never a failed recreate.
  // The limit moves later by the time the computer spent asleep (and by time given back after an outage): the timer lets the
  // pause watcher look before it decides the time is up.
  const runStep = async (def, local, limit) => {
    const started = Date.now();
    let entry = null;
    try {
      await new Promise((resolve, reject) => {
        const timer = extendableTimeout(limit, () => reject(new TimeoutError(def.label, limit)), interrupts.catchUp);
        entry = { timer, local, def };
        running.add(entry);
        Promise.resolve()
          .then(() => stages[def.key](ctx, local))
          .then(resolve, reject)
          .finally(() => timer.clear());
      });
    } catch (err) {
      if (def.optional && !controller.signal.aborted) {
        const reason = err instanceof TimeoutError ? 'did not finish in time' : `failed (${String(err.message).split(/\r?\n/)[0]})`;
        ctx.report.warnings.push(`“${def.label}” ${reason} and was skipped.`);
        return;
      }
      if (!(err instanceof TimeoutError)) throw err;
      throw new RecreateError(
        limit < def.max
          ? `Recreate stopped: the ${minutes}-minute time limit was reached during “${def.label}”.`
          : `“${def.label}” did not finish within its ${Math.round(def.max / 1000)}s limit.`,
      );
    } finally {
      if (entry) {
        entry.timer.clear();
        running.delete(entry);
      }
      timings[def.key] = Date.now() - started;
      progress(def.key, 1);
    }
  };

  // Starts a step: in front (awaited) or in the background (awaited later, by `join`).
  const start = async (def) => {
    progress(def.key, 0);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // An optional step (a measurement) is skipped, never a reason to lose the recreate.
      if (def.optional) {
        ctx.report.warnings.push(`“${def.label}” was skipped: the time limit was reached.`);
        progress(def.key, 1);
        return;
      }
      throw new RecreateError(`Recreate stopped: the ${minutes}-minute time limit was reached.`);
    }
    const limit = Math.min(def.max + ctx.pageScale * (def.perPage ?? 0), remaining);
    // A stage may use the deadline to wind down on its own (skip remaining work) before the hard timeout. A background
    // stage gets its own deadline and progress as its second argument: the shared ones belong to the step in front.
    const local = { stepDeadline: Date.now() + limit, progress: (fraction, message) => progress(def.key, fraction, message) };
    if (def.background) {
      background.set(def.key, { def, done: runStep(def, local, limit).then(() => null, (err) => err) });
      return;
    }
    ctx.progress = local.progress;
    ctx.stepDeadline = local.stepDeadline;
    front = local;
    await runStep(def, local, limit);
    front = null;
  };

  try {
    for (const def of STEPS.filter((s) => !s.background)) {
      // Background steps this step needs in full are awaited first; all of them when it renders pages itself and the
      // machine has no memory to spare for two browsers.
      for (const [key, task] of [...background]) {
        if (task.def.join === def.key || (def.browser && !canOverlap())) {
          // Shown as this step (not as the background one, which is listed later): the step list must not tick the steps in
          // between while they have not run yet.
          progress(def.key, 0, `Waiting for “${task.def.label}” to finish`);
          await join(key);
        }
      }
      await start(def);
      for (const next of STEPS.filter((s) => s.background && s.after === def.key)) await start(next);
    }
    for (const key of [...background.keys()]) await join(key);
    ctx.report.timings = { ...timings, total: Date.now() - startedAt };
    // Sleep / network outages during the job and what was done about them (recreate/interrupts.js).
    ctx.report.interruptions = interrupts.summary();
    // What the shared cache of static files saved the captures (audit/sharedCache.js).
    if (ctx.netCache) ctx.report.sharedCache = ctx.netCache.stats();
    await dispose();
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(ctx.report, null, 1));
    await commitWorkspace(project.id, recreateId);
    return ctx.report;
  } catch (err) {
    controller.abort();
    await dispose();
    // A background step may still be writing into the workspace: it ends on the abort (its browser was just closed).
    await Promise.all([...background.values()].map((task) => task.done));
    await discardWorkspace(project.id, recreateId).catch(() => {});
    throw err;
  }
}
