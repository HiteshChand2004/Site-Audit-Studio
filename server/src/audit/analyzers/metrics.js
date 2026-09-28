const round = (v) => (typeof v === 'number' ? Math.round(v) : null);
const pct = (score) => (typeof score === 'number' ? Math.round(score * 100) : null);

/** Headline metrics from the mobile Lighthouse run. Every value is null when Lighthouse failed. */
export function buildMetrics(mobile) {
  if (!mobile) return { loadTime: null, lcp: null, tbt: null, cls: null, pageSize: null, requests: null, device: 'mobile' };
  const a = mobile.audits;
  return {
    loadTime: round(mobile.metrics?.interactive ?? mobile.metrics?.observedLoad ?? a.interactive?.numericValue),
    lcp: round(a['largest-contentful-paint']?.numericValue),
    tbt: round(a['total-blocking-time']?.numericValue),
    cls: typeof a['cumulative-layout-shift']?.numericValue === 'number' ? Number(a['cumulative-layout-shift'].numericValue.toFixed(2)) : null,
    pageSize: round(a['total-byte-weight']?.numericValue),
    requests: a['network-requests']?.itemCount ?? null,
    device: 'mobile',
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
