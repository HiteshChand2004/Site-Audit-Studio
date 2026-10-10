// Which elements sit in a box the visual diff flagged (step 1 of the correction loop).
//
// A mismatch region is a rectangle on the page, and a rectangle overlaps every ancestor of whatever is really wrong:
// the <body>, the section, the row, the card, the text inside it. So the answer is never one element but a ranked
// list, and the ranking is what makes it useful. An element is to blame for a region in proportion to
//   coverage - how much of the region its box accounts for,
//   misfit   - how far its rendered box is from the captured one (1 when it did not render at all),
//   leafness - 1 / (1 + the number of its descendants that are themselves misfitting),
// so a parent is not blamed while a child already explains the difference. That is the same discipline planFixes
// uses (widths top-down, min-heights bottom-up), expressed as a score instead of a traversal order.
//
// Boxes are in the capture's page pixels for the view, the coordinate space of node.views[view].rect and of the
// rects measureSite reads back, so a region from visualDiff must be converted with toPageBox() first.
import { isElement } from '../ir/tree.js';
import { stateCopy, visibleIn } from './layout.js';

const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
const round3 = (n) => Math.round(n * 1000) / 1000;

const intersect = (box, r) => {
  const x = Math.max(0, Math.min(box.x + box.w, r[0] + r[2]) - Math.max(box.x, r[0]));
  const y = Math.max(0, Math.min(box.y + box.h, r[1] + r[3]) - Math.max(box.y, r[1]));
  return x * y;
};

function iou(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = x * y;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * The elements a mismatch box covers, worst to blame first.
 * @param {object} root                       page tree root (site.pages[i])
 * @param {string} view
 * @param {Record<string, number[]>} rects    sid -> [x, y, w, h] as rendered (measureSite)
 * @param {{ x: number, y: number, w: number, h: number }} box   in the capture's page pixels
 * @param {{ max?: number, minCoverage?: number }} [opts]
 * @returns {{ sid: number, node: object, cpath: string|null, tag: string, expected: number[], actual: number[]|null,
 *   coverage: number, misfit: number, leafness: number, blame: number }[]}
 */
export function nodesInBox(root, view, rects, box, { max = 40, minCoverage = 0.02 } = {}) {
  if (!(box.w > 0) || !(box.h > 0)) return [];
  const found = [];
  // `chain` holds the candidates on the path to the node being visited, so each new candidate can count itself
  // against its real ancestors. Depth alone would not do: when an element in between fits fine it is not a
  // candidate, and a nephew deeper than a candidate would be mistaken for its descendant.
  const chain = [];
  const walk = (n) => {
    if (!isElement(n) || stateCopy(n)) return;
    let pushed = false;
    if (visibleIn(n, view)) {
      const expected = n.views[view].rect;
      const actual = rects[n.sid];
      const gone = !actual || actual[2] <= 0 || actual[3] <= 0;
      const covered = intersect(box, expected) + (gone ? 0 : intersect(box, actual));
      const coverage = Math.min(1, covered / (box.w * box.h));
      const misfit = gone ? 1 : 1 - iou(actual, expected);
      if (coverage >= minCoverage && misfit > 0) {
        for (const a of chain) found[a].kids++;
        chain.push(found.length);
        pushed = true;
        found.push({ sid: n.sid, node: n, cpath: n.cpath ?? null, tag: n.tag, expected, actual: gone ? null : actual, coverage, misfit, kids: 0 });
      }
    }
    if (n.tag !== 'svg') for (const c of n.children) walk(c);
    if (pushed) chain.pop();
  };
  walk(root);

  for (const f of found) {
    const leafness = 1 / (1 + f.kids);
    f.blame = round3(f.coverage * f.misfit * leafness);
    f.coverage = round3(f.coverage);
    f.misfit = round3(f.misfit);
    f.leafness = round3(leafness);
  }
  return found.sort((a, b) => b.blame - a.blame).slice(0, max).map(({ kids, ...keep }) => keep);
}
