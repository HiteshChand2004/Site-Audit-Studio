import { buildDummyAudit } from '../dummy/audit.js';

/**
 * Shapes the analysis into the audit JSON contract the UI renders (same keys as buildDummyAudit).
 * Fields beyond the dummy's are additive: analysisId, pagesCrawled, brokenLinks.total/unverified,
 * errors, and techStack[].category.
 */
export function assembleAudit({
  project,
  analysisId,
  url,
  frame,
  metrics,
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
  errors,
}) {
  return {
    isDummy: false,
    analysisId,
    url,
    analyzedAt: new Date().toISOString(),
    pagesCrawled,
    frame,
    metrics,
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
    errors,
    // The fix checklist is produced by re-auditing the recreated site (Phase 5). Until then it stays a sample.
    recreate: { ...buildDummyAudit(project).recreate, isDummy: true },
  };
}
