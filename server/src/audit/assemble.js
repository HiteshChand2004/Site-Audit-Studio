import { buildDummyAudit } from '../dummy/audit.js';

/**
 * Shapes the analysis into the audit JSON contract the UI renders (same keys as buildDummyAudit).
 * Fields beyond the dummy's are additive: analysisId, pagesCrawled, brokenLinks.total/unverified,
 * errors, and techStack[].category. Phase 3 added screenshots, metricsByDevice, blockedHosts and
 * frame.confidence/notes/appOrigin/checkedAt.
 */
export function assembleAudit({
  project,
  analysisId,
  url,
  frame,
  screenshots,
  metrics,
  metricsByDevice,
  scores,
  techStack,
  weaknesses,
  seo,
  aeo,
  crawl,
  links,
  accessibility,
  manualRebuild,
  pagesCrawled,
  pageVariants = 0,
  blockedHosts = [],
  errors,
}) {
  return {
    isDummy: false,
    analysisId,
    url,
    analyzedAt: new Date().toISOString(),
    pagesCrawled,
    pageVariants,
    frame,
    screenshots,
    metrics,
    metricsByDevice,
    scores,
    techStack,
    weaknesses,
    seo,
    aeo,
    crawl,
    brokenLinks: {
      checked: links.checked,
      total: links.total ?? links.checked,
      broken: links.broken,
      unverified: links.unverified ?? [],
    },
    accessibility,
    manualRebuild,
    blockedHosts,
    errors,
    // The fix checklist is produced by re-auditing the recreated site (Phase 5). Until then it stays a sample.
    recreate: { ...buildDummyAudit(project).recreate, isDummy: true },
  };
}
