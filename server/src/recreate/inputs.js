// What a Recreate job starts from: the project's latest completed analysis and its settings.
import { db } from '../db/index.js';

export const STALE_ANALYSIS_DAYS = 7;
export const MAX_RECREATE_PAGES = 20;

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

/** Pages besides the homepage (0–20). */
export function parseRecreatePages(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_RECREATE_PAGES ? n : null;
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
