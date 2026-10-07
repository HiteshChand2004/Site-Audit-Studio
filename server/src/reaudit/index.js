// Re-audit (Phase 5): the Analyze pipeline run again on a recreated site, then the fix checklist:
// the recreated site (NEW) compared with the analysis it was built from (OLD) (compare/).
// The recreate's build of the project's stack (the plain-HTML dist/, or an app's own output: React, Next.js, MERN client)
// is served on a throwaway 127.0.0.1 port through the preview handler
// (never the app's active preview, which moves when another project is selected). Only that port is
// reachable on loopback: the SSRF policy of the run allows it as an internal port, and everything
// else keeps the user policy (public addresses; loopback only with SAS_ALLOW_LOCALHOST).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { makeOverallPct, runAnalysis, STEPS as AUDIT_STEPS } from '../audit/index.js';
import { db, projectDir } from '../db/index.js';
import { getEmitter } from '../recreate/emit/index.js';
import { outputPages, outputRoot, reportOutputs, targetStack } from '../recreate/export/fromIr.js';
import { servePreview } from '../recreate/preview.js';
import { recreateDir } from '../recreate/workspace.js';
import { createNetPolicy, userPolicy } from '../security/netGuard.js';
import { compareAudits, loadSide } from './compare/index.js';
import { measureNewMotion, motionItems, readOldMotion } from './motion.js';

/** Thrown when a re-audit cannot run at all; the job is marked failed. */
export class ReauditError extends Error {}

// Analyze steps a re-audit leaves out: the recreate already rendered every page for its fidelity score.
export const SKIPPED_STEPS = ['screenshots'];

export const STEPS = [
  { key: 'serve', label: 'Serving the recreated site', weight: 2 },
  ...AUDIT_STEPS.filter((s) => !SKIPPED_STEPS.includes(s.key)),
  { key: 'motion', label: 'Checking the motion', weight: 5 },
  { key: 'compare', label: 'Comparing with the original', weight: 3 },
];
export const PUBLIC_STEPS = STEPS.map(({ key, label }) => ({ key, label }));
export const overallPct = makeOverallPct(STEPS);

/** Folder of one re-audit's raw results (crawl, axe, Lighthouse), inside its recreate. */
export const reauditDir = (projectId, recreateId, reauditId) => path.join(recreateDir(projectId, recreateId), 'reaudit', reauditId);

const selectRecreate = db.prepare(`SELECT result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`);
const selectAnalysis = db.prepare(`SELECT result_json FROM analyses WHERE id = ? AND project_id = ? AND status = 'done'`);

/** URL path of an emitted page: "about/index.html" → "about/", "index.html" → "". */
export const pagePath = (outPath) => outPath.replace(/(^|\/)index\.html$/, '$1');

/**
 * @param {object} o
 * @param {object} o.project  projects row
 * @param {string} o.reauditId
 * @param {string} o.recreateId  a completed recreate of this project
 * @param {(step:string, fraction:number, message?:string)=>void} o.progress
 * @param {string[]} [o.skip]  Analyze steps to leave out (tests also leave out Lighthouse)
 * @returns {Promise<object>} { recreateId, analysisId, origin, pages, audit, checklist }
 */
export async function runReaudit({ project, reauditId, recreateId, progress, skip = SKIPPED_STEPS }) {
  progress('serve', 0);
  const row = selectRecreate.get(recreateId, project.id);
  if (!row) throw new ReauditError('This recreate is no longer available. Run Recreate again.');
  const report = JSON.parse(row.result_json);
  // What the user sees and downloads: the project's stack when its output is ready, the plain-HTML build otherwise.
  const stack = targetStack(report, project.stack);
  const emitter = getEmitter(stack);
  const root = outputRoot(recreateDir(project.id, recreateId), report, stack);
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ReauditError('The recreated site has no production build to audit. Run Recreate again.');
  }
  const analysis = report.analysisId && selectAnalysis.get(report.analysisId, project.id);
  if (!analysis) {
    throw new ReauditError('The analysis this recreate was built from is no longer available. Run Analyze and Recreate again.');
  }

  // connect-src 'self': Lighthouse fetches robots.txt from inside the page (previewHeaders).
  // An app's own scripts run (Lighthouse measures what its visitors get); the CSP still allows only the build's own.
  // Text is gzipped like on any host, so sizes compare with the original's real transfer sizes.
  const served = await servePreview(root, { connectSelf: true, compress: true, scripts: emitter?.scripts || reportOutputs(report)[stack]?.scripts || false });
  try {
    // Pages at the URL the output serves them (a stack may move some).
    const outputPageList = outputPages(report, stack);
    const pages = outputPageList.map((p) => p.path.replace(/^\//, ''));
    const output = { stack, label: emitter?.label ?? stack, runtimes: emitter?.runtimes ?? [], pages: outputPageList, build: reportOutputs(report)[stack]?.build };
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
      // The recreated robots.txt names the sitemap at the site's future home; read it from the build.
      deployOrigin: report.baseUrl ?? null,
      skip,
      netPolicy,
      progress,
    });
    // The analysis contract carries a sample checklist for the OLD site; it means nothing here.
    delete audit.recreate;

    // Motion (4b.8): the recreated pages measured with the probes the capture ran on the original. Never fails a re-audit.
    progress('motion', 0);
    let motion = null;
    if (!skip.includes('motion')) {
      try {
        const folder = recreateDir(project.id, recreateId);
        const oldMotion = await readOldMotion(folder, report.pages);
        const slugOf = new Map((report.pages ?? []).map((p) => [p.outPath, p.slug]));
        const targets = outputPageList.filter((p) => slugOf.has(p.outPath) && oldMotion.has(slugOf.get(p.outPath)))
          .map((p) => ({ slug: slugOf.get(p.outPath), urlPath: p.path.replace(/^\//, '') }));
        // The time follows the pages measured (≤ 6): long pages take 40–60 s each.
        const measured = await measureNewMotion({ origin: served.origin, pages: targets, deadline: Date.now() + Math.max(150000, Math.min(targets.length, 6) * 75000) });
        motion = { ...motionItems(oldMotion, measured.pages), failed: measured.failed, skipped: measured.skipped };
      } catch (err) {
        motion = { items: [], summary: null, failed: [{ slug: '*', error: String(err?.message ?? err).split('\n')[0] }], skipped: [] };
      }
    }
    progress('motion', 1);

    progress('compare', 0);
    const checklist = compareAudits({
      old: await loadSide(path.join(projectDir(project.id), 'audit', report.analysisId), JSON.parse(analysis.result_json)),
      next: await loadSide(reauditDir(project.id, recreateId, reauditId), audit),
      report,
      newOrigin: served.origin,
      output,
      motion,
    });
    progress('compare', 1);
    return {
      reauditId,
      recreateId,
      analysisId: report.analysisId ?? null,
      // The throwaway origin the audit ran against (URLs in `audit` use it); it is closed now.
      origin: served.origin,
      pages,
      // Which build was audited (the app shows it, and flags the result stale when the project's stack changes).
      stack,
      stackLabel: output.label,
      reauditedAt: new Date().toISOString(),
      audit,
      checklist,
    };
  } finally {
    await served.close();
  }
}
