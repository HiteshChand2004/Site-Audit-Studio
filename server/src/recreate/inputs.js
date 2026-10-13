// What a Recreate job starts from: the project's latest completed analysis and its settings.
import { db } from '../db/index.js';
import { sameSite } from '../audit/util.js';

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
 * Exact mode: the copy is measured against the original at every viewport until it matches, the run has no time limit, and
 * everything that would change pixels on purpose (contrast rewriting, image re-encoding) is switched off, so the copy is the
 * site "as it is" rather than an improved version of it.
 */
export const isExactMode = (project) => Boolean(project?.exact_mode);

/**
 * One page of the site from a PATCH body: an http(s) address on the project's own site (a bare path counts from the
 * site), without its #fragment. Empty / null = the whole site.
 * @returns {{ ok: boolean, value: string|null }}
 */
export function parsePageUrl(value, projectUrl) {
  if (value == null || (typeof value === 'string' && !value.trim())) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, value: null };
  let raw = value.trim();
  if (raw.startsWith('/')) raw = new URL(raw, projectUrl).href;
  else if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.href, projectUrl)) return { ok: false, value: null };
    u.hash = '';
    return { ok: true, value: u.href };
  } catch {
    return { ok: false, value: null };
  }
}

/** The one page a project is limited to, or null for the whole site. */
export const pageUrlOf = (project) => project?.page_url || null;

/** Exact mode from a PATCH body: a boolean, or 0/1 from a form. @returns {0|1|null} null = not a usable value */
export function parseExactMode(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return null;
}

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
