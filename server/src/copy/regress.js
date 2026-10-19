// Zero regressions and the results summary for "Copy my site" (docs/COPY-MY-SITE.md §4, §5, §7).

/**
 * A change is kept only when it adds no failing check on the page. A check that was already failing and stays failing is
 * not a new problem; a check that fails now and did not before is.
 * @param {{ check: string, width?: number }[]} before  pageProblems() before the change
 * @param {{ check: string, width?: number }[]} after   pageProblems() after the change
 * @returns {{ keep: boolean, newProblems: { check: string, width?: number }[] }}
 */
export function keepChange(before, after) {
  const was = new Set(before.map((p) => `${p.check}|${p.width ?? ''}`));
  const newProblems = after.filter((p) => !was.has(`${p.check}|${p.width ?? ''}`));
  return { keep: newProblems.length === 0, newProblems };
}

/** The items the re-audit reports as got worse. */
export function worseItems(items) {
  return items.filter((i) => i.status === 'regressed');
}

/**
 * The one plain line at the top of the results.
 * @param {object} s
 * @param {string} s.stackLabel
 * @param {number} s.pages
 * @param {number} s.asIs            pages copied as they are
 * @param {number} s.rebuilt         pages rebuilt clean
 * @param {number} s.gotWorse
 * @param {number} s.fixed
 * @param {number} s.stillOpen
 */
export function summaryLine(s) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    `${plural(s.pages, 'page')} copied in ${s.stackLabel}`,
    `${s.asIs} as-is, ${s.rebuilt} rebuilt`,
    `Got worse: ${s.gotWorse}`,
    `Fixed: ${s.fixed}`,
    `Still open: ${s.stillOpen}`,
  ].join(' · ');
}
