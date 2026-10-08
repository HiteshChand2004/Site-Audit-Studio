// Recreate jobs. They share the global one-job-at-a-time lock with Analyze and Re-audit (jobs/manager.js).
// A successful job starts the preview of its production build (the one active preview) and queues a
// re-audit of that build (Phase 5 fix checklist). When the project's stack is not plain HTML, the stack
// output is built inside the job when a second browser fits (recreate/stack.js), else from the saved IR right
// after (queued behind this job, never discarding the recreate).
import path from 'node:path';
import { db, interruptedRecreates } from '../db/index.js';
import { JobManager } from '../jobs/manager.js';
import { startReaudit } from '../reaudit/jobs.js';
import { overallPct, runRecreate, STAGES, STEPS } from './index.js';
import { replayStages } from './replay.js';
import { getEmitter } from './emit/index.js';
import { exportStack, outputRoot, targetStack } from './export/fromIr.js';
import { activePreview, startPreview } from './preview.js';
import { MAX_AUTO_RESUMES, readCheckpoint } from './checkpoint.js';
import { analysisWarnings, latestAnalysis } from './inputs.js';
import { pruneRecreates, recreateDir, tmpDir } from './workspace.js';

export const recreateJobs = new JobManager({
  table: 'recreates',
  noun: 'a recreate',
  steps: STEPS,
  overallPct,
  doneMessage: 'Recreate complete',
  run: async ({ job, project, payload, progress }) => {
    // A rebuild from a saved capture (recreate/replay.js): the site is not opened again, only generate → build → preview run.
    const stages = payload?.reuseFrom
      ? { ...STAGES, ...replayStages(recreateDir(project.id, payload.reuseFrom.recreateId), payload.reuseFrom) }
      : undefined;
    // A resume (recreate/checkpoint.js) continues the stopped recreate payload.resumeFrom names from its kept workspace.
    const report = await runRecreate({ project, recreateId: job.id, progress, warnings: job.warnings, ...(stages && { stages }), ...(payload?.resumeFrom && { resumeFrom: payload.resumeFrom }) });
    // The preview is runtime state: its port is not part of the report. The app asks for it
    // (GET/POST /preview), which also starts it again after a server restart. The stack's own build when the job built it.
    const stack = targetStack(report, project.stack);
    const dir = recreateDir(project.id, job.id);
    await (stack === 'html'
      ? startPreview({ projectId: project.id, recreateId: job.id, root: path.join(dir, 'dist'), scripts: Boolean(report.outputs?.html?.scripts) })
      : startPreview({ projectId: project.id, recreateId: job.id, root: outputRoot(dir, report, stack), scripts: getEmitter(stack)?.scripts ?? false, stack })
    ).catch(() => {});
    return report;
  },
  // Keep the latest completed recreates only; also removes any leftover temporary workspace.
  // Then queue the stack build the job left out (if any) and the re-audit (it runs after anything already waiting for the lock).
  after: async ({ job, project, ok }) => {
    await pruneRecreates(project.id);
    // Stopped by the time limit after making progress: it continues by itself with a fresh budget (a few times at most).
    if (!ok) await autoResume(project, job.id, 'time-limit');
    if (ok && !reportOf(job.id)?.outputs?.[project.stack]) queueStackExport(project, job.id);
    if (ok) queueReaudit(project.id, job.id);
  },
});

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const noteResumed = db.prepare('UPDATE recreates SET error = ? WHERE id = ?');

/**
 * Continues a stopped recreate by itself when it stopped for a reason a new try can get past (`restart`: the server
 * stopped while it ran; `time-limit`: its budget ran out after it made progress), at most MAX_AUTO_RESUMES times in a row.
 * @returns {Promise<object|null>} the new job
 */
export async function autoResume(project, recreateId, reason) {
  if (!project?.authorized) return null;
  const checkpoint = await readCheckpoint(tmpDir(project.id, recreateId));
  if (!checkpoint?.discovery?.pages?.length || (checkpoint.autoResumes ?? 0) >= MAX_AUTO_RESUMES) return null;
  if (reason === 'time-limit' && !(checkpoint.stopped?.reason === 'time-limit' && checkpoint.stopped.progressed)) return null;
  if (reason === 'restart' && checkpoint.stopped) return null; // it stopped on its own before the restart
  try {
    const analysis = latestAnalysis(project.id);
    const job = recreateJobs.start(project, { resumeFrom: { recreateId, auto: true } }, { warnings: analysis ? analysisWarnings(analysis) : [] });
    if (reason === 'restart') noteResumed.run('The server restarted while this job was running: it continues where it stopped.', recreateId);
    console.log(`[recreates ${recreateId}] continues where it stopped (${reason}) as ${job.id}`);
    return job;
  } catch (err) {
    console.warn(`[recreates ${recreateId}] not continued: ${err.message}`);
    return null;
  }
}

/** On server start: the recreates the restart interrupted continue where they stopped (queued under the global lock). */
export async function resumeInterruptedRecreates(rows = interruptedRecreates) {
  const jobs = [];
  for (const row of rows) {
    const job = await autoResume(selectProject.get(row.project_id), row.id, 'restart').catch(() => null);
    if (job) jobs.push(job);
  }
  return jobs;
}
const selectResult = db.prepare('SELECT result_json FROM recreates WHERE id = ?');
const reportOf = (recreateId) => {
  try {
    return JSON.parse(selectResult.get(recreateId)?.result_json ?? 'null');
  } catch {
    return null;
  }
};

function queueReaudit(projectId, recreateId) {
  const project = selectProject.get(projectId); // may have been deleted while the job ran
  if (!project?.authorized) return;
  try {
    startReaudit(project, recreateId);
  } catch (err) {
    // One re-audit per project at a time: one already queued stays (the app offers a manual run).
    console.warn(`[recreates ${recreateId}] re-audit not queued: ${err.message}`);
  }
}

/**
 * Builds the project's stack from the saved IR (plain HTML is the recreate itself). A failure is stored on the
 * recreate (`outputs[stack]`: failed + why) and logged; the recreate and its HTML build stay.
 */
function queueStackExport(project, recreateId) {
  const stack = project.stack;
  if (!stack || stack === 'html' || getEmitter(stack)?.status !== 'ready') return;
  exportStack({ projectId: project.id, recreateId, stack })
    .then(async ({ output }) => {
      // The app shows the stack's own build when it is ready: move this project's preview onto it.
      if (!activePreview(project.id)) return;
      const root = path.join(recreateDir(project.id, recreateId), output.dir, output.dist ?? '');
      await startPreview({ projectId: project.id, recreateId, root, scripts: getEmitter(stack)?.scripts ?? false, stack });
    })
    .catch((err) => console.warn(`[recreates ${recreateId}] ${stack} output not built: ${err.message}`));
}
