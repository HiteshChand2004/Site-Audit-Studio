// What the dashboard shows about one website, derived from its check (audit), its latest copy (recreate result) and the
// jobs running for it. Pure helpers: the screens decide how to draw it. Nothing here is specific to one website.
import { isJobActive, useProjects } from './store/useProjects.js';

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
  return `/api/projects/${projectId}/recreate/${result.recreateId}/captures/${page.slug}/${view}-${kind}.webp`;
}

/** The picture of one page of the copy (taken when its match was measured). */
export function copyShot(projectId, result, page = homePage(result), view = 'desktop') {
  if (!result?.recreateId || !page?.slug) return null;
  const fid = result.fidelity?.pages?.find((p) => p.outPath === page.outPath);
  if (!fid?.views?.[view]) return null;
  return `/api/projects/${projectId}/recreate/${result.recreateId}/fidelity/${page.slug}/${view}-full.webp`;
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
    results: isJobActive(reauditJob) ? 'running' : cmp ? (cmp.summary?.regressed > 0 ? 'warn' : 'done') : 'none',
  };
}

export const STAGE_NAMES = { check: 'Checked', copy: 'Copy made', results: 'Compared' };
const STATE_WORDS = { done: 'done', running: 'in progress', failed: 'failed', warn: 'done, some things got worse', none: 'not yet' };

/** "Checked: done · Copy made: not yet · Compared: not yet" (for screen readers and tooltips). */
export const stagesLabel = (stages) =>
  Object.entries(STAGE_NAMES)
    .map(([k, name]) => `${name}: ${STATE_WORDS[stages[k]] ?? 'not yet'}`)
    .join(' · ');

/** Fixed / better, still open, got worse, needs a person: the four counts of the comparison, or null. */
export function outcomeCounts(audit) {
  const s = comparisonOf(audit)?.summary;
  if (!s) return null;
  return { better: (s.fixed ?? 0) + (s.improved ?? 0), open: s.open ?? 0, regressed: s.regressed ?? 0, manual: s.manual ?? 0 };
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
