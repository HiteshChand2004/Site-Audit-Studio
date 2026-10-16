// Which preview the original opens on, and the words that say why live is not shown.
// Pure on purpose (no window, no React): server/test/compare-framing.test.js imports it.

/** The mode the original opens on: the live site when it can be framed, else the picture taken during the check. */
export function defaultPreviewMode(live) {
  return live.ok ? 'live' : 'screenshot';
}

/** The note shown when live is not available, or null when it is (nothing to explain). */
export function unavailableNote(live, hasScreens) {
  if (live.ok) return null;
  const picture = hasScreens ? 'Showing the picture taken during the check instead.' : 'No picture was taken for this page either.';
  return `Live view is not available here. ${live.why} ${picture}`;
}
