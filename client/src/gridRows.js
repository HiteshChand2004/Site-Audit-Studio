// How many cards a card grid shows before "Show more": always whole rows, whatever the screen width. The grid's columns come
// from its own CSS (auto-fill), so the count is measured from the rendered grid, never fixed.

/** Rows a card grid shows at first, and rows each "Show more" adds. */
export const FIRST_ROWS = 2;
export const ROWS_PER_CLICK = 2;

/**
 * Columns of a rendered CSS grid: the browser resolves `repeat(auto-fill, …)` to one px track per column in the computed style.
 * @param {Element | null} el
 * @param {(el: Element) => { gridTemplateColumns: string }} [style]
 * @returns {number} at least 1
 */
export function columnsOf(el, style = (e) => getComputedStyle(e)) {
  if (!el) return 1;
  const tracks = String(style(el).gridTemplateColumns ?? '').trim();
  if (!tracks || tracks === 'none') return 1;
  return Math.max(1, tracks.split(/\s+/).length);
}

/** Cards shown for `rows` whole rows of `columns` (never more than there are). */
export const shownCount = ({ total, columns, rows }) => Math.max(0, Math.min(total, Math.max(1, columns) * Math.max(1, rows)));

/** Whether cards are left beyond `rows` whole rows. */
export const hasMore = ({ total, columns, rows }) => total > Math.max(1, columns) * Math.max(1, rows);
