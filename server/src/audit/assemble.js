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
  crawlLimit = null,
  blockedHosts = [],
  errors,
  siteType = null,
  lighthouseContention = null,
}) {
  return {
    isDummy: false,
    analysisId,
    url,
    analyzedAt: new Date().toISOString(),
    pagesCrawled,
    pageVariants,
    // The crawl was cut (the page limit or its time): { found, read, notRead, cutBy: 'pages' | 'time', urls[≤ 500] }, else null.
    crawlLimit,
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
    // standard | canvas-rendered (detection/siteType.js), with the reason and the evidence. Recreate stops on canvas-rendered.
    ...(siteType && { siteType }),
    // Other jobs running on this server while Lighthouse measured (audit/lighthouse/run.js). Absent when nothing was recorded.
    ...(lighthouseContention && { lighthouseContention }),
    // The fix checklist is produced by re-auditing the recreated site (Phase 5). Until then it stays a sample.
    recreate: { ...buildDummyAudit(project).recreate, isDummy: true },
  };
}
