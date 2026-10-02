// `audit.recreate` of GET /api/projects/:id/audit (Phase 5.3): the fix checklist of the project's latest
// re-audit, built at read time so it always reflects the latest recreate, re-audit and analysis.
//
// Real (a re-audit finished):
//   { isDummy: false, status: 'done'|'queued'|'running', reauditId, recreateId, analysisId, reauditedAt,
//     stack, stackLabel (the build that was audited: html, react-vite, nextjs, mern),
//     stale, staleReasons: ('recreate'|'analysis'|'stack')[], job, lastError,
//     checklist: [{ key, status: 'fixed'|'open'|'manual', title, detail }],   ← the original 3-status contract
//     version, summary, scores, metrics, categories, items, scope, notes }      ← the full comparison (compare/)
//   stale 'recreate': a newer recreate exists that this checklist is not about;
//   stale 'analysis': the audit shown is a newer analysis than the one the checklist compared against;
//   stale 'stack': the project's stack output is ready (or changed) since the build this checklist audited.
//   `checklist.stack` (in `items` metadata below) is { id, label, jsBytes: { before, after } }, additive.
// Sample (no re-audit finished yet): the labelled dummy checklist plus the re-audit state, so the app can
// show progress or offer a run: { isDummy: true, status: 'not-started'|'queued'|'running'|'failed',
//   recreateId (latest completed recreate, or null), job, lastError, checklist }.
import { db } from '../db/index.js';
import { buildDummyAudit } from '../dummy/audit.js';
import { targetStack } from '../recreate/export/fromIr.js';
import { reauditJobs } from './jobs.js';

const latestDoneRecreate = db.prepare(`
  SELECT id, result_json FROM recreates WHERE project_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1
`);
const latestDoneReaudit = db.prepare(`
  SELECT id, started_at, result_json FROM reaudits
  WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL
  ORDER BY started_at DESC LIMIT 1
`);
const latestAttempt = db.prepare(`
  SELECT id, status, error, started_at FROM reaudits WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
`);

// The 3-status list of the original contract: anything still failing (improved, regressed) is "open";
// rows that pass on both sides or cannot be measured on a preview (n/a) are left out.
const LEGACY = { fixed: 'fixed', improved: 'open', open: 'open', regressed: 'open', manual: 'manual' };

/** The compact checklist of the original contract, from the full checklist items. */
export function legacyChecklist(items = []) {
  return items
    .filter((it) => LEGACY[it.status])
    .map((it) => ({ key: it.key, status: LEGACY[it.status], title: it.title, detail: it.after?.detail ?? it.detail ?? null }));
}

const jobView = (job) => job && { id: job.id, status: job.status, step: job.step, pct: job.pct, message: job.message };

/**
 * @param {object} project  projects row
 * @param {object} audit    the audit JSON GET /audit returns (real or dummy)
 * @returns {object} audit.recreate
 */
export function recreateSection(project, audit) {
  const latestRecreate = latestDoneRecreate.get(project.id);
  const recreateId = latestRecreate?.id ?? null;
  const job = jobView(reauditJobs.active(project.id));
  const done = latestDoneReaudit.get(project.id);
  const attempt = latestAttempt.get(project.id);
  // The latest attempt failed after (or without) the latest result.
  const lastError = attempt?.status === 'failed' && (!done || attempt.started_at >= done.started_at) ? attempt.error : null;

  if (!done) {
    const sample = buildDummyAudit(project).recreate;
    return {
      ...sample,
      isDummy: true,
      status: job?.status ?? (lastError ? 'failed' : 'not-started'),
      recreateId,
      job,
      lastError,
    };
  }

  const result = JSON.parse(done.result_json);
  const c = result.checklist ?? {};
  const staleReasons = [];
  if (result.recreateId !== recreateId) staleReasons.push('recreate');
  if (audit?.analysisId && result.analysisId && audit.analysisId !== result.analysisId) staleReasons.push('analysis');
  // The same recreate, but the build the project would be audited on now is not the one that was audited.
  if (result.recreateId === recreateId && latestRecreate?.result_json) {
    const now = targetStack(JSON.parse(latestRecreate.result_json), project.stack);
    if ((result.stack ?? 'html') !== now) staleReasons.push('stack');
  }
  return {
    isDummy: false,
    status: job?.status ?? 'done',
    reauditId: result.reauditId,
    stack: result.stack ?? 'html',
    stackLabel: result.stackLabel ?? null,
    recreateId: result.recreateId,
    analysisId: result.analysisId,
    reauditedAt: result.reauditedAt,
    stale: staleReasons.length > 0,
    staleReasons,
    job,
    lastError,
    checklist: legacyChecklist(c.items),
    version: c.version ?? null,
    summary: c.summary ?? null,
    scores: c.scores ?? null,
    metrics: c.metrics ?? null,
    categories: c.categories ?? [],
    items: c.items ?? [],
    scope: c.scope ?? null,
    output: c.stack ?? null,
    notes: c.notes ?? [],
    // Motion measured on both sides (4b.8): { pages, reveal, hover, loops, failed, skipped } or null.
    motion: c.motion ?? null,
  };
}
