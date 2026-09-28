const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/** Groups axe-core violations into the contract's { impact, title, count } rows (+ id, helpUrl). */
export function analyzeA11y(axe) {
  if (!axe) return [];
  return axe.violations
    .map((v) => ({ id: v.id, impact: v.impact || 'minor', title: v.help, count: v.nodes.length, helpUrl: v.helpUrl }))
    .sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] || b.count - a.count);
}
