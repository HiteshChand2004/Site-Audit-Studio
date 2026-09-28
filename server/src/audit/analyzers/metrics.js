const round = (v) => (typeof v === 'number' ? Math.round(v) : null);
const pct = (score) => (typeof score === 'number' ? Math.round(score * 100) : null);

/**
 * Headline metrics from one Lighthouse run. Every value is null when that run failed.
 * `loadTime` is Time to Interactive.
 */
export function buildMetrics(run, device = 'mobile') {
  if (!run) return { loadTime: null, lcp: null, tbt: null, cls: null, pageSize: null, requests: null, device };
  const a = run.audits;
  return {
    loadTime: round(run.metrics?.interactive ?? run.metrics?.observedLoad ?? a.interactive?.numericValue),
    lcp: round(a['largest-contentful-paint']?.numericValue),
    tbt: round(a['total-blocking-time']?.numericValue),
    cls: typeof a['cumulative-layout-shift']?.numericValue === 'number' ? Number(a['cumulative-layout-shift'].numericValue.toFixed(2)) : null,
    pageSize: round(a['total-byte-weight']?.numericValue),
    requests: a['network-requests']?.itemCount ?? null,
    device,
  };
}

export function buildScores(mobile, desktop) {
  const pick = (run) =>
    run && {
      performance: pct(run.categories.performance),
      seo: pct(run.categories.seo),
      accessibility: pct(run.categories.accessibility),
      bestPractices: pct(run.categories['best-practices']),
    };
  return { mobile: pick(mobile) ?? null, desktop: pick(desktop) ?? null };
}
