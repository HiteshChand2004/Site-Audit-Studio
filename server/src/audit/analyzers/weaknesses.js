import { confident } from '../../detection/engine.js';

const KB = 1024;
const fmtKb = (b) => (b >= 1024 * KB ? `${(b / 1024 / KB).toFixed(1)} MB` : `${Math.round(b / KB)} KB`);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

// Lighthouse audits turned into weaknesses: [audit ids (first present wins), title, how to grade].
const CHECKS = [
  {
    ids: ['render-blocking-resources', 'render-blocking-insight'],
    title: 'Render-blocking resources',
    grade: (a) => a.savingsMs && (a.savingsMs >= 1000 ? 'high' : a.savingsMs >= 300 ? 'medium' : null),
    detail: (a) => `CSS/JS in <head> delays first paint; potential savings of ${fmtMs(a.savingsMs)}.`,
  },
  {
    ids: ['unused-javascript'],
    title: 'Unused JavaScript',
    grade: (a) => a.savingsBytes && (a.savingsBytes >= 500 * KB ? 'high' : a.savingsBytes >= 100 * KB ? 'medium' : null),
    detail: (a) => `About ${fmtKb(a.savingsBytes)} of downloaded JavaScript is never used on this page.`,
  },
  {
    ids: ['unused-css-rules'],
    title: 'Unused CSS',
    grade: (a) => a.savingsBytes && (a.savingsBytes >= 150 * KB ? 'medium' : a.savingsBytes >= 50 * KB ? 'low' : null),
    detail: (a) => `About ${fmtKb(a.savingsBytes)} of CSS is never used on this page.`,
  },
  {
    ids: ['modern-image-formats', 'uses-optimized-images', 'uses-responsive-images', 'image-delivery-insight'],
    combine: true,
    title: 'Unoptimised images',
    grade: (a) => a.savingsBytes && (a.savingsBytes >= 1024 * KB ? 'high' : a.savingsBytes >= 200 * KB ? 'medium' : null),
    detail: (a) => `Images could be about ${fmtKb(a.savingsBytes)} smaller with WebP/AVIF, compression and correct sizing.`,
  },
  {
    ids: ['total-byte-weight'],
    title: 'Heavy page weight',
    grade: (a) => a.numericValue && (a.numericValue >= 4 * 1024 * KB ? 'high' : a.numericValue >= 2.5 * 1024 * KB ? 'medium' : null),
    detail: (a) => `The homepage downloads ${fmtKb(a.numericValue)} in total.`,
  },
  {
    ids: ['third-party-summary'],
    title: 'Third-party script cost',
    grade: (a) => {
      const ms = a.summary?.wastedMs;
      return ms && (ms >= 1000 ? 'high' : ms >= 250 ? 'medium' : null);
    },
    detail: (a) => `Third-party code blocked the main thread for ${fmtMs(a.summary.wastedMs)}.`,
  },
  {
    ids: ['mainthread-work-breakdown'],
    title: 'Main-thread work',
    grade: (a) => a.numericValue && (a.numericValue >= 8000 ? 'high' : a.numericValue >= 4000 ? 'medium' : null),
    detail: (a) => `${fmtMs(a.numericValue)} of main-thread work while the page loads.`,
  },
];

function fromLighthouse(run) {
  if (!run) return [];
  const out = [];
  for (const check of CHECKS) {
    const present = check.ids.map((id) => run.audits[id]).filter(Boolean);
    if (!present.length) continue;
    const audit = check.combine
      ? { savingsBytes: present.reduce((n, a) => n + (a.savingsBytes || 0), 0) }
      : present[0];
    const severity = check.grade(audit);
    if (severity) out.push({ severity, title: check.title, detail: check.detail(audit), source: 'lighthouse' });
  }
  return out;
}

const ORDER = { high: 0, medium: 1, low: 2 };

/** Platform limitations of confidently-detected techs, plus measured problems from a Lighthouse run (desktop for now). */
export function buildWeaknesses(detections, mobile) {
  const platform = confident(detections).flatMap((t) =>
    (t.rule.limitations ?? []).map((l) => ({ ...l, source: t.id })),
  );
  const measured = fromLighthouse(mobile);
  const seen = new Set();
  return [...measured, ...platform]
    .filter((w) => (seen.has(w.title) ? false : seen.add(w.title)))
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
