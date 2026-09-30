// Re-audit (Phase 5): the Analyze pipeline run again on a recreated site, so the fix checklist can
// compare the recreated site (NEW) with the analysis it was built from (OLD).
// The recreate's dist/ build is served on a throwaway 127.0.0.1 port through the preview handler
// (never the app's active preview, which moves when another project is selected). Only that port is
// reachable on loopback: the SSRF policy of the run allows it as an internal port, and everything
// else keeps the user policy (public addresses; loopback only with SAS_ALLOW_LOCALHOST).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { makeOverallPct, runAnalysis, STEPS as AUDIT_STEPS } from '../audit/index.js';
import { db } from '../db/index.js';
import { servePreview } from '../recreate/preview.js';
import { recreateDir } from '../recreate/workspace.js';
import { createNetPolicy, userPolicy } from '../security/netGuard.js';

/** Thrown when a re-audit cannot run at all; the job is marked failed. */
export class ReauditError extends Error {}

// Analyze steps a re-audit leaves out: the recreate already rendered every page for its fidelity score.
export const SKIPPED_STEPS = ['screenshots'];

export const STEPS = [
  { key: 'serve', label: 'Serving the recreated site', weight: 2 },
  ...AUDIT_STEPS.filter((s) => !SKIPPED_STEPS.includes(s.key)),
];
export const PUBLIC_STEPS = STEPS.map(({ key, label }) => ({ key, label }));
export const overallPct = makeOverallPct(STEPS);

/** Folder of one re-audit's raw results (crawl, axe, Lighthouse), inside its recreate. */
export const reauditDir = (projectId, recreateId, reauditId) => path.join(recreateDir(projectId, recreateId), 'reaudit', reauditId);

const selectRecreate = db.prepare(`SELECT result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);

/** URL path of an emitted page: "about/index.html" → "about/", "index.html" → "". */
export const pagePath = (outPath) => outPath.replace(/(^|\/)index\.html$/, '$1');

/**
 * @param {object} o
 * @param {object} o.project  projects row
 * @param {string} o.reauditId
 * @param {string} o.recreateId  a completed recreate of this project
 * @param {(step:string, fraction:number, message?:string)=>void} o.progress
 * @param {string[]} [o.skip]  Analyze steps to leave out (tests also leave out Lighthouse)
 * @returns {Promise<object>} { recreateId, analysisId, origin, pages, audit }
 */
export async function runReaudit({ project, reauditId, recreateId, progress, skip = SKIPPED_STEPS }) {
  progress('serve', 0);
  const row = selectRecreate.get(recreateId, project.id);
  if (!row) throw new ReauditError('This recreate is no longer available. Run Recreate again.');
  const report = JSON.parse(row.result_json);
  const root = path.join(recreateDir(project.id, recreateId), 'dist');
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ReauditError('The recreated site has no production build to audit. Run Recreate again.');
  }

  const served = await servePreview(root);
  try {
    const pages = (report.pages ?? []).map((p) => pagePath(p.outPath));
    const netPolicy = createNetPolicy({ allowLoopback: userPolicy().allowLoopback, internalPorts: [served.port] });
    progress('serve', 1);
    const audit = await runAnalysis({
      project,
      analysisId: reauditId,
      url: `${served.origin}/`,
      // The recreated pages are crawled first (also the ones nothing links to), so the page limit
      // is never spent on a broken internal link; the link check still reports those.
      maxPages: Math.max(1, pages.length),
      seedUrls: pages.map((p) => `${served.origin}/${p}`),
      outDir: reauditDir(project.id, recreateId, reauditId),
      skip,
      netPolicy,
      progress,
    });
    // The analysis contract carries a sample checklist for the OLD site; it means nothing here.
    delete audit.recreate;
    return {
      reauditId,
      recreateId,
      analysisId: report.analysisId ?? null,
      // The throwaway origin the audit ran against (URLs in `audit` use it); it is closed now.
      origin: served.origin,
      pages,
      reauditedAt: new Date().toISOString(),
      audit,
    };
  } finally {
    await served.close();
  }
}
