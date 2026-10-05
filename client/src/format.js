// Small display helpers shared by the screens.

/** "just now", "5 min ago", "3 h ago", or the date. */
export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Days since a date (0 when missing). */
export const ageDays = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0);

/** "1 page" / "3 pages". */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
