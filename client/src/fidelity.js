// How closely each copied page matches the original, in one shape for Compare: a rebuilt copy measures it as `fidelity`
// (scores and pictures per screen size); an as-is copy measures it in its final check (asIs.checks: the share of pixels
// that differ at 1440 and 390 wide, server/src/recreate/behavior/preserve/check.js). Pure: server/test imports it.

// The final check's widths → the screen sizes Compare shows (components/preview/PreviewFrame.jsx VIEWPORTS).
const VIEW_OF_WIDTH = { 1440: 'desktop', 390: 'mobile' };

const normPath = (p) => `${String(p ?? '').replace(/\/index\.html?$/i, '/').replace(/\/+$/, '')}/`;

/**
 * Per copied page: { outPath, score, views: { [view]: { score, height: { generated } } }, asIs? }.
 * An as-is page's score is the share of the page that looks the same (100 − % of pixels that differ), the lower of its
 * two widths; it has no pictures of its own (`asIs: true`), only the heights the check measured.
 * @param {object|null} result  the copy's result
 * @returns {object[]}
 */
export function fidelityPages(result) {
  if (result?.fidelity?.pages?.length) return result.fidelity.pages;
  const checked = result?.asIs?.checks?.pages ?? [];
  if (!checked.length) return [];
  const outPathOf = new Map((result.pages ?? []).map((p) => [normPath(p.path), p.outPath]));
  const out = [];
  for (const page of checked) {
    const outPath = outPathOf.get(normPath(page.path));
    if (!outPath) continue;
    const views = {};
    for (const v of page.visual ?? []) {
      const view = VIEW_OF_WIDTH[v.width];
      if (!view || !Number.isFinite(v.diffPct)) continue;
      views[view] = {
        score: Math.max(0, Math.min(100, Math.round(100 - v.diffPct))),
        ...(v.copyHeight > 0 && { height: { generated: v.copyHeight } }),
      };
    }
    const scores = Object.values(views).map((v) => v.score);
    if (!scores.length) continue;
    out.push({ outPath, score: Math.min(...scores), views, asIs: true });
  }
  return out;
}
