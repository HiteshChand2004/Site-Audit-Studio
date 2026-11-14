// Re-audit (Phase 5): the Analyze pipeline run again on a recreated site, then the fix checklist:
// the recreated site (NEW) compared with the analysis it was built from (OLD) (compare/).
// The recreate's build of the project's stack (the plain-HTML dist/, or an app's own output: React, Next.js, MERN client)
// is served on a throwaway 127.0.0.1 port through the preview handler
// (never the app's active preview, which moves when another project is selected). Only that port is
// reachable on loopback: the SSRF policy of the run allows it as an internal port, and everything
// else keeps the user policy (public addresses; loopback only with SAS_ALLOW_LOCALHOST).
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeOverallPct, runAnalysis, STEPS as AUDIT_STEPS } from '../audit/index.js';
import { runLighthouse } from '../audit/lighthouse/run.js';
import { db } from '../db/index.js';
import { auditDir, projectDir } from '../config/paths.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { betterThanOriginal, compareLighthousePages, lighthousePageItems, lighthousePagesNote, lighthouseTargets, RUN_TIMEOUT_MS } from './lighthousePages.js';
import { getEmitter } from '../recreate/emit/index.js';
import { outputPages, outputRoot, reportOutputs, targetStack } from '../recreate/export/fromIr.js';
import { servePreview } from '../recreate/preview.js';
import { serveCopy } from '../recreate/behavior/preserve/serve.js';
import { openMeasuredHost, measuredHostDescription } from './measuredHost.js';
import { recreateDir } from '../recreate/workspace.js';
import { adoptCheckpoint, CHECKPOINT_FILE, moveOrigins, saveCheckpoint } from './checkpoint.js';
import { NETWORK_FAILURE_REASONS } from '../recreate/behavior/preserve/pageLift.js';
import { createNetPolicy, userPolicy } from '../security/netGuard.js';
import { compareAudits, loadSide } from './compare/index.js';
import { CATEGORIES } from './compare/rules.js';
import { explainWorse, markOutside } from '../copy/gotWorse.js';
import { ownCodeErrors } from '../copy/ownCodeErrors.js';
import { clickBudgetFor, hoverBudgetFor, hoverFirstFor, jumpTargetsOf, liftedTargets, measureNewMotion, missedHovers, motionItems, motionTimeFor, readOldMotion, useLiftedBefore } from './motion.js';

/** Thrown when a re-audit cannot run at all; the job is marked failed. */
export class ReauditError extends Error {}

// Analyze steps a re-audit leaves out: the recreate already rendered every page for its fidelity score.
export const SKIPPED_STEPS = ['screenshots'];

export const STEPS = [
  { key: 'serve', label: 'Serving the recreated site', weight: 2 },
  ...AUDIT_STEPS.filter((s) => !SKIPPED_STEPS.includes(s.key)),
  { key: 'motion', label: 'Checking the motion', weight: 5 },
  // An as-is copy only: every page of the copy and of the original, phone and computer (lighthousePages.js). Left out, like the
  // homepage runs, when a caller skips Lighthouse.
  { key: 'lighthouse-pages', label: 'Lighthouse on every page, original and copy', weight: 20 },
  { key: 'compare', label: 'Comparing with the original', weight: 3 },
];
export const PUBLIC_STEPS = STEPS.map(({ key, label }) => ({ key, label }));
export const overallPct = makeOverallPct(STEPS);

/** Folder of one re-audit's raw results (crawl, axe, Lighthouse), inside its recreate. */
/** How fast the computer was when the original's Lighthouse runs were made: { mobile, desktop } benchmark index. */
export async function benchmarkOf(auditDir) {
  const out = {};
  for (const formFactor of ['mobile', 'desktop']) {
    const lhr = await readFile(path.join(auditDir, `lighthouse-${formFactor}.json`), 'utf8').then(JSON.parse, () => null);
    const index = lhr?.environment?.benchmarkIndex;
    if (index > 0) out[formFactor] = index;
  }
  return Object.keys(out).length ? out : null;
}

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
/** The file that answers a page's address in a static folder ("/" → index.html, "/about/" → about/index.html, "/about" → about.html). */
async function pageFile(root, urlPath) {
  const rel = String(urlPath || '/').replace(/^\/+/, '');
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) if ((await stat(path.join(root, c)).catch(() => null))?.isFile()) return c;
  return null;
}

/**
 * Why a re-audit of this recreate cannot measure anything, as a sentence for the person; null when it can start. The same answer
 * every time for the same recreate, so a failed re-audit fails once: the route refuses a new one with this reason instead of
 * queuing a job that would fail the same way (reaudit/jobs.js, routes/reaudit.js).
 * @param {{ id: string, stack?: string }} project @param {string} recreateId
 */
export async function reauditBlocker(project, recreateId) {
  const row = selectRecreate.get(recreateId, project.id);
  if (!row) return 'This recreate is no longer available. Run Recreate again.';
  const report = JSON.parse(row.result_json);
  const stack = targetStack(report, project.stack);
  const dir = recreateDir(project.id, recreateId);
  const root = outputRoot(dir, report, stack);
  if (!(await stat(root).catch(() => null))?.isDirectory()) return 'The recreated site has no production build to audit. Run Recreate again.';
  if (!(report.analysisId && selectAnalysis.get(report.analysisId, project.id))) {
    return 'The analysis this recreate was built from is no longer available. Run Analyze and Recreate again.';
  }
  const home = outputPages(report, stack)[0]?.path ?? '/';
  if (!(await pageFile(root, home))) {
    return `The copy has no page at its home address (${home}) in ${path.relative(dir, root) || 'its folder'}, so there is nothing to compare. Make the copy again.`;
  }
  return null;
}

/**
 * `resumeFrom`: the id of a comparison of the same copy that stopped before it finished (reaudit/checkpoint.js). Its folder
 * becomes this one's, and the parts it finished (the analysis, the motion check, each Lighthouse run of the copy) are taken as
 * they are; only the rest is measured.
 */
export async function runReaudit({ project, reauditId, recreateId, progress, skip = SKIPPED_STEPS, signal = null, resumeFrom = null }) {
  progress('serve', 0);
  const blocked = await reauditBlocker(project, recreateId);
  if (blocked) throw new ReauditError(blocked);
  const report = JSON.parse(selectRecreate.get(recreateId, project.id).result_json);
  const analysis = selectAnalysis.get(report.analysisId, project.id); // the OLD side of the comparison (checked above)
  // What the user sees and downloads: the project's stack when its output is ready, the plain-HTML build otherwise.
  const stack = targetStack(report, project.stack);
  const emitter = getEmitter(stack);
  const root = outputRoot(recreateDir(project.id, recreateId), report, stack);

  // connect-src 'self': Lighthouse fetches robots.txt from inside the page (previewHeaders).
  // An app's own scripts run (Lighthouse measures what its visitors get); the CSP still allows only the build's own.
  // Text is gzipped like on any host, so sizes compare with the original's real transfer sizes.
  // An as-is copy runs the original's own scripts (inline ones too), so it is served the way its preview and its checks serve it
  // (behavior/preserve/serve.js: no policy of ours, compressed like a host). Served with the preview's policy, every script of
  // it was blocked and the re-audit measured a copy no visitor gets: no motion, and console errors that were our own.
  const served = reportOutputs(report)[stack]?.mode === 'as-is'
    ? await serveCopy(root).then((c) => ({ ...c, origin: new URL(c.url).origin, port: Number(new URL(c.url).port) }))
    : await servePreview(root, { connectSelf: true, compress: true, scripts: emitter?.scripts || reportOutputs(report)[stack]?.scripts || false });
  // Lighthouse measures the copy through a host like the one it will live on (measuredHost.js: a static host's latency and
  // the visitor's throughput per device), never from the instant loopback server; the crawl, axe, links and motion keep the
  // direct server, and so do the preview and the shipped copy.
  const measured = {
    mobile: await openMeasuredHost(served.origin, 'mobile'),
    desktop: await openMeasuredHost(served.origin, 'desktop'),
  };
  const measuredUrl = (url, device) => (url.startsWith(served.origin) ? measured[device].origin + url.slice(served.origin.length) : url);
  const outDir = reauditDir(project.id, recreateId, reauditId);
  const origins = { served: served.origin, mobile: measured.mobile.origin, desktop: measured.desktop.origin };
  try {
    // Continue where a stopped comparison of this copy left off: its finished parts, their addresses moved to this run's ports.
    let kept = resumeFrom ? await adoptCheckpoint(reauditDir(project.id, recreateId, resumeFrom), outDir) : null;
    if (kept) kept = await moveOrigins(outDir, kept, origins);
    else {
      await mkdir(outDir, { recursive: true });
      await saveCheckpoint(outDir, { origins });
    }
    // Pages at the URL the output serves them (a stack may move some).
    const outputPageList = outputPages(report, stack);
    const pages = outputPageList.map((p) => p.path.replace(/^\//, ''));
    const output = { stack, label: emitter?.label ?? stack, runtimes: emitter?.runtimes ?? [], pages: outputPageList, build: reportOutputs(report)[stack]?.build };
    const netPolicy = createNetPolicy({ allowLoopback: userPolicy().allowLoopback, internalPorts: [served.port, measured.mobile.port, measured.desktop.port] });
    progress('serve', 1);
    const audit = kept?.audit ? reusedAnalysis(kept.audit, skip, progress) : await runAnalysis({
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
      // The link check (mostly the original's outbound links) runs on while Lighthouse measures the loopback build.
      linksBesideLighthouse: true,
      lighthouseOrigin: (device) => measured[device].origin,
      // Measured like the original was: a computer much busier now than then repeats a run with a scaled CPU slowdown.
      lighthouseBaseline: await benchmarkOf(auditDir(project.id, report.analysisId)),
      // The job manager's stop (the app's Stop, the hard time limit): the analysis ends at its next step.
      signal,
    });
    if (signal?.aborted) throw Object.assign(new Error('Stopped before it finished.'), { stopped: true });
    // The analysis contract carries a sample checklist for the OLD site; it means nothing here.
    delete audit.recreate;
    if (!kept?.audit) await saveCheckpoint(outDir, { audit });

    // Motion (4b.8): the recreated pages measured with the probes the capture ran on the original. Never fails a re-audit.
    progress('motion', 0);
    let motion = kept?.motion ?? null;
    if (!motion && !skip.includes('motion')) {
      try {
        const folder = recreateDir(project.id, recreateId);
        const oldMotion = await readOldMotion(folder, report.pages, report.exact?.excluded ?? []);
        const slugOf = new Map((report.pages ?? []).map((p) => [p.outPath, p.slug]));
        const targets = outputPageList.filter((p) => slugOf.has(p.outPath) && oldMotion.has(slugOf.get(p.outPath)))
          .map((p) => {
            const old = oldMotion.get(slugOf.get(p.outPath));
            return { slug: slugOf.get(p.outPath), urlPath: p.path.replace(/^\//, ''), hoverBudgetMs: hoverBudgetFor(old), hoverFirst: hoverFirstFor(old), clickBudgetMs: clickBudgetFor(old), jumpTargets: jumpTargetsOf(old) };
          });
        // The time follows the pages measured (≤ 6): long pages take 40–60 s each.
        const measured = await measureNewMotion({ origin: served.origin, pages: targets, deadline: Date.now() + Math.max(150000, targets.slice(0, 6).reduce((ms, t) => ms + motionTimeFor(t), 0)) });
        // An as-is copy: the original's own files, lifted offline, measured with the same probe for reveals and loops - and for
        // the hovers the copy missed, which the hover row may leave out only when the lifted original misses them too and a
        // request to the site's own backend failed in the copy (motionItems).
        const missed = missedHovers(oldMotion, measured.pages);
        const before = reportOutputs(report)[stack]?.mode === 'as-is' ? await measureLifted(folder, targets, oldMotion, missed) : null;
        const backend = missed.size && before ? await backendPathsOf(folder, report, project.url) : null;
        motion = { ...motionItems(oldMotion, measured.pages, { lifted: before?.measured, backend }), failed: measured.failed, skipped: measured.skipped,
          ...(before && { before: { source: before.source, pages: before.pages, failed: before.failed, ms: before.ms } }) };
        // What the copy's probes measured, kept with the re-check: the comparison rules can be run again later from saved files.
        await saveNewMotion(reauditDir(project.id, recreateId, reauditId), measured, before?.measured).catch(() => {});
      } catch (err) {
        motion = { items: [], summary: null, failed: [{ slug: '*', error: String(err?.message ?? err).split('\n')[0] }], skipped: [] };
      }
      // Kept only when it measured something: a check that failed as a whole is tried again by a continued comparison.
      if (!motion.failed?.some((f) => f.slug === '*')) await saveCheckpoint(outDir, { motion });
    }
    if (signal?.aborted) throw Object.assign(new Error('Stopped before it finished.'), { stopped: true });
    progress('motion', 1);

    // Lighthouse on every page, both sides, both modes (an as-is copy; docs/COPY-MY-SITE.md §4). Original and copy are measured
    // now, on this computer, with the same settings: the original's runs are kept per project and reused next time. Never fails
    // a re-audit: what could not be measured is listed.
    const isAsIs = reportOutputs(report)[stack]?.mode === 'as-is';
    progress('lighthouse-pages', 0);
    let lighthousePages = null;
    if (isAsIs && !skip.some((s) => /^lighthouse/.test(s))) {
      const proxy = await startEgressProxy(netPolicy);
      // The original measured the way the copy is: its own files as the capture lifted them (as-is/lifted), served on this
      // computer through a measurement host of its own with the same latency and throughput. Measured live, the original came
      // from its CDN over HTTP/2 with no host in front, the copy through the throttled HTTP/1.1 host: the two sides differed by
      // the network alone (the same files scored 99 against 94, 86 against 77). A page with no lifted file is measured live.
      const lifted = await openLiftedOriginal(recreateDir(project.id, recreateId)).catch(() => null);
      // The egress proxy lets Lighthouse reach loopback only on the ports the policy names: the lifted original's too.
      const liftedPorts = lifted ? [lifted.origin, lifted.measured.mobile.origin, lifted.measured.desktop.origin].map((o) => Number(new URL(o).port)) : [];
      for (const port of liftedPorts) netPolicy.internalPorts.add(port);
      try {
        // The original's address of each copied page (report.asIs.pages, by output path), else the path on the site.
        const asIsPages = new Map((report.asIs?.pages ?? []).map((p) => [p.outPath, p.url]));
        const pageList = [];
        for (const p of outputPageList) {
          const url = asIsPages.get(p.outPath) ?? new URL(p.path, project.url).href;
          const own = lifted ? await lifted.pathFor(new URL(url).pathname) : null;
          pageList.push({ path: p.path, url, copyUrl: `${served.origin}${p.path}`,
            ...(own && { originalUrl: `${lifted.origin}${own}`, originalFrom: 'lifted', originalCacheDir: path.join(recreateDir(project.id, recreateId), 'as-is', LIFTED_RUNS_DIR) }) });
        }
        const hostOf = (url, mode) => (lifted && url.startsWith(lifted.origin) ? lifted.measured[mode].origin + url.slice(lifted.origin.length) : measuredUrl(url, mode));
        lighthousePages = await compareLighthousePages({
          pages: pageList,
          cacheDir: path.join(projectDir(project.id), 'lighthouse-original'),
          outDir: path.join(reauditDir(project.id, recreateId, reauditId), 'lighthouse-pages'),
          // Every run starts on an idle link: both sides' hosts for this device drop what an earlier run left going (measuredHost reset).
          run: (url, mode, outFile) => {
            measured[mode].reset();
            lifted?.measured[mode].reset();
            return runLighthouse(hostOf(url, mode), mode, { timeout: RUN_TIMEOUT_MS, outFile, proxy: proxy.url, signal });
          },
          progress: (fraction, message) => progress('lighthouse-pages', fraction, message),
          signal,
          // A continued comparison takes the copy's runs the stopped one finished (same copy, same settings).
          reuseCopy: Boolean(kept),
        });
        lighthousePages.network = measuredHostDescription();
      } catch (err) {
        if (err?.stopped) throw err;
        lighthousePages = { pages: [], worse: [], unscored: [], extraRunPages: [], skipped: [], runs: { original: 0, copy: 0, reusedOriginal: 0 }, errors: [{ path: '*', mode: '*', error: String(err?.message ?? err).split('\n')[0].slice(0, 200) }] };
      } finally {
        await proxy.close().catch(() => {});
        await lifted?.close().catch(() => {});
        for (const port of liftedPorts) netPolicy.internalPorts.delete(port);
      }
    }
    progress('lighthouse-pages', 1);

    progress('compare', 0);
    const checklist = await buildChecklist({ project, report, analysis, audit, recreateId, reauditId, origin: served.origin, output, outputPageList, motion, lighthousePages, isAsIs });
    progress('compare', 1);
    // Finished: nothing is left to continue.
    await rm(path.join(outDir, CHECKPOINT_FILE), { force: true }).catch(() => {});
    return {
      ...(kept && { resumedFrom: resumeFrom }),
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
    await Promise.all(Object.values(measured).map((m) => m.close().catch(() => {})));
    await served.close();
  }
}

/** The analysis a stopped comparison finished, taken as it is; its steps are shown as done. */
function reusedAnalysis(audit, skip, progress) {
  for (const s of AUDIT_STEPS) if (!skip.includes(s.key)) progress(s.key, 1, 'Kept from the comparison that stopped');
  return audit;
}

/**
 * The checklist of a re-audit from what it measured (no browser, no network): the comparison with the original's analysis, the
 * per-page Lighthouse rows and, for an as-is copy, the reason of every row that got worse or stays open. Exported so a finished
 * re-audit can be compared again from its saved files when only the comparison rules change.
 */
export async function buildChecklist({ project, report, analysis, audit, recreateId, reauditId, origin, output, outputPageList, motion, lighthousePages, isAsIs }) {
  const old = await loadSide(auditDir(project.id, report.analysisId), JSON.parse(analysis.result_json));
  // The Lighthouse rows hold the copy (measured here, through the measured host) against the original measured the same way:
  // its homepage from its own lifted files. The Check's run came from the live site's CDN over HTTP/2, so a row like
  // "render-blocking resources" read 0 ms → 680 ms for the same five stylesheets (testpilot; measured alike: 890 → 690 ms).
  const liftedHome = isAsIs ? await liftedHomeLhrs(recreateDir(project.id, recreateId)) : null;
  if (liftedHome) old.lighthouse = { ...old.lighthouse, ...liftedHome };
  const checklist = compareAudits({
    old,
    next: await loadSide(reauditDir(project.id, recreateId, reauditId), audit),
    report,
    newOrigin: origin,
    output,
    motion,
  });
  if (liftedHome) {
    checklist.lighthouseBefore = { from: 'lifted', devices: Object.keys(liftedHome) };
    checklist.notes.push(`The original's side of the Lighthouse checks (${Object.keys(liftedHome).map((d) => (d === 'mobile' ? 'phone' : 'computer')).join(' and ')}) is its homepage measured from its own files on this computer, the way the copy is measured; the scores at the top are those of the Check of the live site.`);
  }
  if (lighthousePages) {
    // The per-page score rows join the checklist (a "got worse" row per page, mode and category where the copy's median is
    // lower), the counts follow, and the notes say what was measured and which pages needed extra runs.
    const rows = lighthousePageItems(lighthousePages);
    checklist.items.push(...rows);
    for (const r of rows) {
      checklist.summary[r.status] = (checklist.summary[r.status] ?? 0) + 1;
      checklist.summary.total++;
    }
    checklist.categories = CATEGORIES.filter((c) => checklist.items.some((it) => it.category === c.id));
    checklist.notes.push(lighthousePagesNote(lighthousePages));
    // The "better than the original" rule per device and category (the same medians and noise as the rows above).
    const better = betterThanOriginal(lighthousePages);
    if (better.line) checklist.notes.unshift(better.line);
    checklist.lighthousePages = {
      pages: lighthousePages.pages.map((p) => ({ path: p.path, originalFrom: p.originalFrom ?? 'live', modes: Object.fromEntries(Object.entries(p.modes).map(([m, v]) => [m, v.error ? { error: v.error } : { original: v.original, copy: v.copy, worse: v.worse, noise: v.noise ?? [], unscored: v.unscored, blankRuns: v.blankRuns, copyMissing: v.copyMissing ?? null, brokenRuns: v.brokenRuns ?? null, originalBlank: v.originalBlank ?? null, runs: v.runs, accepted: v.accepted, extra: v.extra, runScores: v.runScores }])) })),
      worse: lighthousePages.worse,
      unscored: lighthousePages.unscored,
      extraRunPages: lighthousePages.extraRunPages,
      skipped: lighthousePages.skipped,
      errors: lighthousePages.errors,
      runs: lighthousePages.runs,
      network: lighthousePages.network ?? null,
      // Kept runs of the original that were measured again, and why (too old, a computer of another speed).
      refreshedOriginal: lighthousePages.refreshedOriginal ?? [],
      // Per page, mode and category: original, copy, 90 reached or not, and what fails under 90 with the reason.
      targets: lighthouseTargets(lighthousePages),
      better,
    };
  }
  if (isAsIs) await explainAsIs({ checklist, project, report, recreateId, reauditId, origin, outputPageList });
  // Fix mode (Step 11): what the user approved and the copy changed on purpose (a text colour, a heading's level). The rows of
  // those checks carry the list, so a difference from the original there reads as the user's choice, not as the copy's.
  const onPurpose = Array.isArray(report.asIs?.changedOnPurpose) ? report.asIs.changedOnPurpose : [];
  if (onPurpose.length) {
    checklist.changedOnPurpose = onPurpose;
    const ruleOf = { contrast: 'color-contrast', 'heading-level': 'heading-order' };
    for (const item of checklist.items) {
      const mine = onPurpose.filter((c) => String(item.key ?? '').endsWith(ruleOf[c.kind]));
      if (mine.length) Object.assign(item, { changedOnPurpose: mine.map((c) => ({ page: c.page, text: c.text })), note: [item.note, `Changed on purpose (approved by you): ${mine.length} element(s).`].filter(Boolean).join(' ') });
    }
  }
  // The other rows that are not a plain pass / fix get their group too: a figure that varies or a link to check again is a
  // matter of measurement; what needs a person needs information only the owner has.
  for (const item of checklist.items) {
    if (item.group) continue;
    if (item.status === 'changed' || item.status === 'recheck') item.group = 'measurement';
    else if (item.status === 'manual') item.group = 'needs-info';
  }
  return checklist;
}

/**
 * Per page of the copy's crawl (its path): { questions, faqSignals } — the question headings / summaries and the FAQ-like parts
 * the crawl read (audit/extract.js). Null when the crawl is missing. The FAQ-schema "still open" rule reads it (copy/gotWorse.js).
 */
export function questionsByPageOf(crawl) {
  const pages = Array.isArray(crawl?.pages) ? crawl.pages : Array.isArray(crawl) ? crawl : null;
  if (!pages) return null;
  const out = {};
  for (const p of pages) {
    if (!p?.url || !p.facts) continue;
    let at;
    try {
      at = decodeURIComponent(new URL(p.url).pathname);
    } catch {
      continue;
    }
    out[at] = { questions: Array.isArray(p.facts.questionHeadings) ? p.facts.questionHeadings.length : NaN, faqSignals: Number(p.facts.faqSignals) || 0 };
  }
  return out;
}

/**
 * The original's homepage as Lighthouse measured it from its lifted files (as-is/lighthouse-lifted, run 1 of the homepage per
 * device, the full report), the way the copy is measured: { mobile?, desktop? }, or null when none was measured (a rebuilt
 * copy, an older one, a re-check whose Lighthouse step was skipped). When the homepage was measured under more than one
 * address, the newest report wins.
 * @param {string} folder  the recreate's folder
 */
export async function liftedHomeLhrs(folder) {
  const dir = path.join(folder, 'as-is', LIFTED_RUNS_DIR);
  const names = await readdir(dir).catch(() => []);
  const out = {};
  for (const mode of ['mobile', 'desktop']) {
    const re = new RegExp(`^index-[0-9a-f]{8}-${mode}-1\\.json\\.full\\.json$`);
    let best = null;
    for (const name of names.filter((n) => re.test(n))) {
      const at = await stat(path.join(dir, name)).then((s) => s.mtimeMs, () => -1);
      if (at >= 0 && (!best || at > best.at)) best = { name, at };
    }
    const lhr = best ? await readFile(path.join(dir, best.name), 'utf8').then((t) => JSON.parse(t)).catch(() => null) : null;
    if (lhr?.audits && lhr.categories) out[mode] = lhr;
  }
  return Object.keys(out).length ? out : null;
}

/** The copy's measured motion of a re-check (its probes: reveal, loops, hover, clicks, feeds, pointer), per page slug. */
export const NEW_MOTION_FILE = 'motion-new.json';

/** Where the lifted original's Lighthouse runs are kept, beside the lifted files (they are this copy's original, not the live site's). */
export const LIFTED_RUNS_DIR = 'lighthouse-lifted';

/**
 * The lifted original (as-is/lifted of a recreate) served for Lighthouse: its own server and one measurement host per device,
 * like the copy's. null when the recreate has no lifted folder (a rebuilt copy, an older one).
 * `pathFor(pathname)` = the address of that page's document in the folder, as its server answers it without a redirect (a
 * folder page with its slash: a redirect would cost the original's side alone a round trip), or null when it has none.
 * @param {string} folder  the recreate's folder
 */
export async function openLiftedOriginal(folder) {
  const dir = path.join(folder, 'as-is', 'lifted');
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return null;
  const served = await serveCopy(dir);
  const origin = new URL(served.url).origin;
  const hosts = [];
  try {
    const measured = { mobile: await openMeasuredHost(origin, 'mobile').then((h) => (hosts.push(h), h)), desktop: await openMeasuredHost(origin, 'desktop').then((h) => (hosts.push(h), h)) };
    const isFile = (f) => stat(f).then((s) => s.isFile(), () => false);
    return {
      dir,
      origin,
      measured,
      async pathFor(pathname) {
        let rel;
        try {
          rel = decodeURIComponent(pathname).replace(/^\/+/, '');
        } catch {
          return null;
        }
        const file = path.resolve(dir, rel);
        if (file !== dir && !file.startsWith(dir + path.sep)) return null;
        if (!rel || rel.endsWith('/')) return (await isFile(path.join(file, 'index.html'))) ? pathname : null;
        if (await isFile(path.join(file, 'index.html'))) return `${pathname}/`;
        if (await isFile(`${file}.html`)) return pathname;
        return /\.html?$/i.test(rel) && (await isFile(file)) ? pathname : null;
      },
      close: async () => {
        await Promise.all(hosts.map((h) => h.close().catch(() => {})));
        await served.close();
      },
    };
  } catch (err) {
    await Promise.all(hosts.map((h) => h.close().catch(() => {})));
    await served.close().catch(() => {});
    throw err;
  }
}

/**
 * The "before" of the reveal and loop rows of an as-is copy (motion.js useLiftedBefore): the lifted original (as-is/lifted)
 * served offline like the copy and measured with the copy's probe. No lifted folder, or nothing measured = the capture's
 * motion.json stays the before (null). Changes `oldMotion` in place. Never throws.
 * @returns {Promise<{ source: 'lifted', pages: string[], failed: object[], ms: number, measured: Map<string, object> } | null>}
 */
export async function measureLifted(folder, targets, oldMotion, missed = null) {
  const dir = path.join(folder, 'as-is', 'lifted');
  if (!targets.length || !(await stat(dir).then((s) => s.isDirectory(), () => false))) return null;
  const started = Date.now();
  let lifted = null;
  try {
    lifted = await serveCopy(dir);
    const list = liftedTargets(targets, missed);
    const measured = await measureNewMotion({ origin: new URL(lifted.url).origin, pages: list, deadline: Date.now() + Math.max(150000, list.slice(0, 6).reduce((ms, t) => ms + motionTimeFor(t), 0)) });
    const pages = useLiftedBefore(oldMotion, measured.pages);
    return pages.length ? { source: 'lifted', pages, failed: measured.failed, ms: Date.now() - started, measured: measured.pages } : null;
  } catch {
    return null;
  } finally {
    await lifted?.close().catch(() => {});
  }
}

/** Saves what measureNewMotion found on the copy (and, for an as-is copy, on the lifted original) into the re-check folder. */
export async function saveNewMotion(dir, measured, lifted = null) {
  await mkdir(dir, { recursive: true });
  const body = { version: 1, savedAt: new Date().toISOString(), pages: Object.fromEntries(measured?.pages ?? []), failed: measured?.failed ?? [], skipped: measured?.skipped ?? [],
    ...(lifted && { lifted: Object.fromEntries(lifted) }) };
  await writeFile(path.join(dir, NEW_MOTION_FILE), `${JSON.stringify(body)}\n`, 'utf8');
}

/** The copy's measured motion saved by a re-check (slug → measured page), or null when it was not saved (an older re-check). */
export async function readNewMotion(dir) {
  const body = await readFile(path.join(dir, NEW_MOTION_FILE), 'utf8').then(JSON.parse, () => null);
  return body?.pages ? new Map(Object.entries(body.pages)) : null;
}

/**
 * The paths the original's pages asked its own servers for data (the capture's network record, capture/.network/index.json:
 * entries of kind `data`), from the site's host or a host excluded by rule (its backend, e.g. an API on another domain). A
 * copy of the site's files has no server to answer them: the copy's request for the same path fails (reason b).
 * @param {{ entries?: object[] } | null} record
 * @param {{ siteUrl: string, hosts?: string[] }} o
 */
export function dataPathsOf(record, { siteUrl, hosts = [] }) {
  const bare = (h) => String(h ?? '').replace(/^www\./, '').toLowerCase();
  let site;
  try {
    site = bare(new URL(siteUrl).hostname);
  } catch {
    return [];
  }
  const own = new Set([site, ...hosts.map(bare)]);
  const out = new Set();
  for (const e of Array.isArray(record?.entries) ? record.entries : []) {
    if (e?.kind !== 'data' || !e.url) continue;
    try {
      const u = new URL(e.url);
      if (/^https?:$/.test(u.protocol) && own.has(bare(u.hostname))) out.add(decodeURIComponent(u.pathname));
    } catch {
      // not an address
    }
  }
  return [...out];
}

/**
 * The site's own backend addresses for a copy: the data addresses it left as the original does (siteDataPaths) and every
 * data address the original's pages asked its own servers for while captured (the capture's network record, dataPathsOf).
 * The same list the "still open" reasons use (explainAsIs `backendPaths`). Never throws.
 * @returns {Promise<Set<string>>}
 */
export async function backendPathsOf(folder, report, siteUrl) {
  const record = await readFile(path.join(folder, 'capture', '.network', 'index.json'), 'utf8').then(JSON.parse, () => null);
  const hosts = Array.isArray(report?.asIs?.excludedByRule) ? report.asIs.excludedByRule : [];
  return new Set([...siteDataPaths(report?.asIs?.sameOrigin?.sameAsOriginal, { siteUrl, hosts }), ...dataPathsOf(record, { siteUrl, hosts })]);
}

/**
 * The site's own data addresses among the paths the copy left as the original does (report.asIs.sameOrigin.sameAsOriginal,
 * preserve/complete.js): its server answered data, not a file (`not-an-asset`), or asked for a sign-in (`http-401` /
 * `http-403`). Only that server can answer them. A reason is one word when one host was asked, else one part per host
 * ("site.com: not-an-asset; fonts.gstatic.com: http-404"): the site's own host's part decides, never another host's.
 */
export function siteDataPaths(sameAsOriginal, { siteUrl, hosts = [] }) {
  const bare = (h) => String(h ?? '').trim().replace(/^www\./, '').toLowerCase();
  let site;
  try {
    site = bare(new URL(siteUrl).hostname);
  } catch {
    return [];
  }
  const own = new Set([site, ...hosts.map(bare)]);
  const isData = (reason) => reason === 'not-an-asset' || reason === 'http-401' || reason === 'http-403';
  const out = new Set();
  for (const r of Array.isArray(sameAsOriginal) ? sameAsOriginal : []) {
    if (!r?.path) continue;
    const parts = String(r.reason ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    const ok = parts.some((part) => {
      const at = part.lastIndexOf(': ');
      return at < 0 ? isData(part) : own.has(bare(part.slice(0, at))) && isData(part.slice(at + 2).trim());
    });
    if (ok) out.add(r.path);
  }
  return [...out];
}

/** The site's files the copy could not download while it was made because the network was down (pageLift.js). */
export function liftNetworkFailures(report) {
  const out = [];
  for (const page of report?.asIs?.lift?.pages ?? []) {
    for (const f of page?.downloads?.failedUrls ?? []) if (f?.url && NETWORK_FAILURE_REASONS.has(f.reason)) out.push({ url: f.url, reason: f.reason });
  }
  return out;
}

/**
 * An as-is copy: every "got worse" row carries one of the five reasons on this run's evidence, or is marked unexplained
 * (copy/gotWorse.js). The rows stay where they are; the reasons are added to them, never put in their place. Reads only the
 * saved files of the original's analysis and of this re-audit, so a finished re-audit can be explained again
 * (scripts/reexplain.js). Changes `checklist` in place.
 */
export async function explainAsIs({ checklist, project, report, recreateId, reauditId, origin, outputPageList }) {
  {
    const lhrs = async (dir) => Object.fromEntries(await Promise.all(['mobile', 'desktop'].map(async (d) => [d, await readFile(path.join(dir, `lighthouse-${d}.json`), 'utf8').then(JSON.parse, () => null)])));
    const newCrawl = await readFile(path.join(reauditDir(project.id, recreateId, reauditId), 'crawl.json'), 'utf8').then(JSON.parse, () => null);
    const captureRoot = path.join(recreateDir(project.id, recreateId), 'capture');
    // The capture's network record (what the original's pages loaded) and the homepage as captured (axe checks the homepage).
    const record = await readFile(path.join(captureRoot, '.network', 'index.json'), 'utf8').then(JSON.parse, () => null);
    const homeSlug = (report.pages ?? []).find((p) => (p.path ?? '/') === '/')?.slug ?? 'index';
    const originalCapture = await readFile(path.join(captureRoot, homeSlug, 'desktop.json'), 'utf8').then(JSON.parse, () => null);
    const excludedHosts = Array.isArray(report.asIs?.excludedByRule) ? report.asIs.excludedByRule : [];
    const newLhr = await lhrs(reauditDir(project.id, recreateId, reauditId));
    // The copy's script errors: the line each was thrown at in the copy, and whether the original wrote that line.
    const ownCode = await ownCodeErrors({
      items: ['mobile', 'desktop'].flatMap((d) => newLhr[d]?.audits?.['errors-in-console']?.details?.items ?? []),
      copyRoot: outputRoot(recreateDir(project.id, recreateId), report, targetStack(report, project.stack)),
      networkDir: path.join(captureRoot, '.network'),
      siteUrl: project.url,
    }).catch(() => null);
    const worse = explainWorse({
      items: checklist.items,
      siteUrl: project.url,
      copyOrigin: origin,
      copyPages: outputPageList.map((p) => p.path),
      chosenPages: (report.asIs?.pages ?? []).map((p) => p.path ?? '/'),
      // The original measured the way the copy is, where it was (buildChecklist says why), else the Check's live run.
      oldLhr: { ...(await lhrs(auditDir(project.id, report.analysisId))), ...(await liftedHomeLhrs(recreateDir(project.id, recreateId))) },
      newLhr,
      oldAxe: await readFile(path.join(auditDir(project.id, report.analysisId), 'axe.json'), 'utf8').then(JSON.parse, () => null),
      newAxe: await readFile(path.join(reauditDir(project.id, recreateId, reauditId), 'axe.json'), 'utf8').then(JSON.parse, () => null),
      // For the "still open" rows: whether a new-site address was written, which pages' fixes were undone, the hosts excluded by rule.
      address: report.asIs?.address ?? null,
      // report.copy.fixes.reverted lists the pages (report.asIs.fixes.reverted is only their count).
      // A page undone because its fixes had no effect (Step 5b) did not change the look: its rows are told by fixOpen (our bug).
      revertedPages: (Array.isArray(report.copy?.fixes?.reverted) ? report.copy.fixes.reverted : []).filter((r) => r.reason !== 'noEffect').map((r) => r.page),
      excludedHosts,
      // What the copy's own fixes left open and why (the page gave no words, the site states no colour).
      fixOpen: Array.isArray(report.asIs?.fixes?.open) ? report.asIs.fixes.open : [],
      // The site's own data addresses (answered by its server while captured): a request to one fails in a copy of files.
      // Also every data address the original's pages asked its own servers for while captured (its network record).
      backendPaths: [
        ...siteDataPaths(report.asIs?.sameOrigin?.sameAsOriginal, { siteUrl: project.url, hosts: excludedHosts }),
        ...dataPathsOf(record, { siteUrl: project.url, hosts: excludedHosts }),
      ],
      // What the copy's crawl read of each page: an FAQ-schema row on pages with not one question is the owner's content.
      questionsByPage: questionsByPageOf(newCrawl),
      // Files the copy lacks because the network was down while it was made, and the original's own colours.
      liftFailures: liftNetworkFailures(report),
      originalCapture,
      // Both crawls (each page's title, headings, whether its server sent an empty shell): duplicate titles a sign-in gate makes.
      crawls: { original: await readFile(path.join(auditDir(project.id, report.analysisId), 'crawl.json'), 'utf8').then(JSON.parse, () => null), copy: newCrawl },
      ownCode,
    });
    const byKey = new Map([...worse.items.map((w) => ['regressed', w]), ...worse.open.map((w) => ['open', w])].map(([status, w]) => [`${status} ${w.key}`, w]));
    for (const item of checklist.items) {
      const w = byKey.get(`${item.status} ${item.key}`);
      if (w) Object.assign(item, { reason: w.reason, reasonEvidence: w.evidence, group: w.group, ...(w.unexplained && { unexplained: true }), ...(w.parts && { reasonParts: w.parts }) });
    }
    checklist.gotWorse = worse.summary;
    // The same for every row still open (failing on both sides): a reason or UNEXPLAINED, and the counts.
    checklist.stillOpen = worse.openSummary;
    // Rows that are not the tool's to change leave "got worse" / "still open" for a section of their own (copy/gotWorse.js).
    markOutside(checklist);
  }
  return checklist;
}
