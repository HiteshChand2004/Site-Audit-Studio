// What a Recreate job starts from: the project's latest completed analysis and its settings.
import { db } from '../db/index.js';

export const STALE_ANALYSIS_DAYS = 7;
// projects.recreate_pages: pages besides the homepage, or ALL_PAGES (every page of the site, the default for new projects).
export const ALL_PAGES = -1;
// The most pages one recreate takes, also in "All pages" mode: a safety cap for sites with thousands of URLs. Links to pages
// beyond it get a local notice page, never the live site.
export const SITE_PAGE_CAP = 300;
export const MAX_RECREATE_PAGES = SITE_PAGE_CAP;

const latestDone = db.prepare(`
  SELECT id, finished_at, result_json FROM analyses
  WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL
  ORDER BY started_at DESC LIMIT 1
`);

/** @returns {{ id: string, finishedAt: string, audit: object } | null} */
export function latestAnalysis(projectId) {
  const row = latestDone.get(projectId);
  if (!row) return null;
  return { id: row.id, finishedAt: row.finished_at, audit: JSON.parse(row.result_json) };
}

/** Warnings shown before and during a recreate. */
export function analysisWarnings(analysis, now = Date.now()) {
  const warnings = [];
  const ageDays = (now - new Date(analysis.audit.analyzedAt ?? analysis.finishedAt).getTime()) / 86400000;
  if (ageDays > STALE_ANALYSIS_DAYS) {
    warnings.push(
      `The latest analysis is ${Math.floor(ageDays)} days old. Run Analyze again if the site has changed since then.`,
    );
  }
  return warnings;
}

/** Pages besides the homepage (0–300), or 'all' / -1 = every page of the site. */
export function parseRecreatePages(value) {
  if (value === 'all') return ALL_PAGES;
  const n = Number(value);
  if (n === ALL_PAGES) return ALL_PAGES;
  return Number.isInteger(n) && n >= 0 && n <= MAX_RECREATE_PAGES ? n : null;
}

/** The discovery limit (pages besides the homepage) for a project setting; "All pages" = up to the safety cap. */
export const pageLimitOf = (recreatePages) => (recreatePages == null || recreatePages === ALL_PAGES ? SITE_PAGE_CAP - 1 : recreatePages);
export const isAllPages = (recreatePages) => recreatePages == null || recreatePages === ALL_PAGES;

/**
 * Optional origin used for canonical, sitemap and Open Graph URLs. Empty clears it.
 * @returns {{ ok: true, value: string|null } | { ok: false }}
 */
export function parseTargetDomain(value) {
  if (value === null || (typeof value === 'string' && !value.trim())) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  let raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    const validHost = url.hostname.includes('.') || url.hostname === 'localhost';
    if (!['http:', 'https:'].includes(url.protocol) || !validHost || url.username || url.password) return { ok: false };
    return { ok: true, value: url.origin };
  } catch {
    return { ok: false };
  }
}

/** Origin the generated site treats as its own (canonical, sitemap.xml, og:url). */
export const baseUrlOf = (project, audit) => project.target_domain || new URL(audit.url ?? project.url).origin;
