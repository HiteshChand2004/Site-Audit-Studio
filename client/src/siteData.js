// What the dashboard shows about one website, derived from its check (audit), its latest copy (recreate result) and the
// jobs running for it. Pure helpers: the screens decide how to draw it. Nothing here is specific to one website.
import { isJobActive, useProjects } from './store/useProjects.js';
import { apiUrl } from './api/base.js';

export const isReal = (audit) => Boolean(audit && !audit.isDummy);

/** The real before / after comparison of the copy (the fix checklist), or null. */
export const comparisonOf = (audit) => (isReal(audit) && audit.recreate && !audit.recreate.isDummy ? audit.recreate : null);

const homePage = (result) => result?.pages?.find((p) => p.path === '/') ?? result?.pages?.[0] ?? null;

/** A picture of the original site's first screen: from the check, else from the copy step's visit. */
export function originalShot(projectId, audit, result, kind = 'fold') {
  const fromCheck = isReal(audit) ? audit.screenshots?.views?.desktop?.[kind]?.url : null;
  if (fromCheck) return fromCheck;
  return captureShot(projectId, result, homePage(result), 'desktop', kind);
}

/** The copy step's picture of one original page (`kind`: fold | full). */
export function captureShot(projectId, result, page, view = 'desktop', kind = 'full') {
  if (!result?.recreateId || !page?.slug || !(page.views ?? []).includes(view)) return null;
  return apiUrl(`/projects/${projectId}/recreate/${result.recreateId}/captures/${page.slug}/${view}-${kind}.webp`);
}

/** The picture of one page of the copy (taken when its match was measured). */
export function copyShot(projectId, result, page = homePage(result), view = 'desktop') {
  if (!result?.recreateId || !page?.slug) return null;
  const fid = result.fidelity?.pages?.find((p) => p.outPath === page.outPath);
  if (!fid?.views?.[view]) return null;
  return apiUrl(`/projects/${projectId}/recreate/${result.recreateId}/fidelity/${page.slug}/${view}-full.webp`);
}

/** Scores of the original and of the copy on one device ({ performance, seo, accessibility, bestPractices }). */
export function scoresOf(audit, device) {
  const cmp = comparisonOf(audit);
  return {
    before: (isReal(audit) ? audit.scores?.[device] : null) ?? cmp?.scores?.before?.[device] ?? null,
    after: cmp?.scores?.after?.[device] ?? null,
  };
}

/** The main platform the original is built with (Framer, Next.js…), or null. */
export const platformOf = (audit) => (isReal(audit) ? audit.techStack?.find((t) => t.id !== 'custom' && t.confidence != null) ?? null : null);

/**
 * Where the website's work stands, per stage: 'done' | 'running' | 'failed' | 'warn' | 'none'.
 * check = the original was checked, copy = a copy exists, results = the copy was compared with the original.
 */
export function stagesOf({ audit, result, analysis, job, reauditJob }) {
  const cmp = comparisonOf(audit);
  return {
    check: isJobActive(analysis) ? 'running' : analysis?.status === 'failed' ? 'failed' : isReal(audit) ? 'done' : 'none',
    copy: isJobActive(job) ? 'running' : job?.status === 'failed' ? 'failed' : result ? 'done' : 'none',
    results: isJobActive(reauditJob) ? 'running' : cmp ? (worseSplit(cmp).realCount > 0 ? 'warn' : 'done') : 'none',
  };
}

export const STAGE_NAMES = { check: 'Checked', copy: 'Copy made', results: 'Compared' };
const STATE_WORDS = { done: 'done', running: 'in progress', failed: 'failed', warn: 'done, some things got worse', none: 'not yet' };

/** "Checked: done · Copy made: not yet · Compared: not yet" (for screen readers and tooltips). */
export const stagesLabel = (stages) =>
  Object.entries(STAGE_NAMES)
    .map(([k, name]) => `${name}: ${STATE_WORDS[stages[k]] ?? 'not yet'}`)
    .join(' · ');

/**
 * Why a "got worse" row of an as-is copy reads worse when the copy is not the cause: the groups the server's evidence puts it
 * in (server/src/copy/gotWorse.js GROUPS), in the user's words. "bug" and "missing-fixer" are not here: those are the copy's own.
 */
export const WORSE_CAUSES = {
  measurement: {
    title: 'Only measured slower here',
    text: 'The copy has the original’s own files and is no heavier. Its score is lower because it was measured on this computer, while the original was measured on its own fast host. Measure again once the copy is online.',
  },
  'needs-info': { title: 'Needs information from you', text: 'Something only you can give, such as the new site’s address (the sitemap and full links need it).' },
  look: { title: 'Kept as the original', text: 'Changing it would change how the original looks, so the copy keeps it as it is.' },
  'own-code': { title: 'From the original’s own code', text: 'Comes from the original’s scripts or embeds, kept as they are so the site works the same.' },
  impossible: { title: 'Not possible in a copy', text: 'No copy can do this.' },
};

/**
 * The "got worse" rows split by cause: `real` = the copy may really be worse (no reason found, or a fix still owed; every row
 * of a rebuilt copy, which carries no reasons), `byReason` = rows that only read worse, keyed as WORSE_CAUSES.
 * @param {any} comparison  audit.recreate
 */
export function worseSplit(comparison) {
  // Rows outside what the tool can change (server copy/gotWorse.js markOutside) are neither: they have their own section.
  const rows = (comparison?.items ?? []).filter((i) => i.status === 'regressed' && !i.outside);
  const real = [];
  const byReason = {};
  for (const row of rows) {
    if (WORSE_CAUSES[row.group]) (byReason[row.group] ??= []).push(row);
    else real.push(row);
  }
  // Only the summary arrived (an older comparison without its rows): its count, as before.
  const realCount = rows.length ? real.length : comparison?.summary?.regressed ?? 0;
  return { real, realCount, byReason, explained: rows.length - real.length };
}

/** Fixed / better, still open, got worse, needs a person: the four counts of the comparison, or null. */
export function outcomeCounts(audit) {
  const cmp = comparisonOf(audit);
  const s = cmp?.summary;
  if (!s) return null;
  return { better: (s.fixed ?? 0) + (s.improved ?? 0), open: s.open ?? 0, regressed: worseSplit(cmp).realCount, manual: s.manual ?? 0 };
}

/** Everything the app knows about one website right now: the open website's live state, else its overview. */
export function useSiteData(projectId) {
  const open = useProjects((s) => s.selectedId === projectId && s.audit != null);
  const audit = useProjects((s) => (open ? s.audit : s.overviews[projectId]?.audit ?? null));
  const latest = useProjects((s) => s.recreateResults[projectId] ?? s.overviews[projectId]?.recreate ?? null);
  const analysis = useProjects((s) => s.analyses[projectId]);
  const job = useProjects((s) => s.recreates[projectId]);
  const reauditJob = useProjects((s) => s.reaudits[projectId]);
  const loaded = useProjects((s) => open || Boolean(s.overviews[projectId]?.loaded));
  const result = latest?.result ?? null;
  return { audit, result, analysis, job, reauditJob, loaded, stages: stagesOf({ audit, result, analysis, job, reauditJob }) };
}
