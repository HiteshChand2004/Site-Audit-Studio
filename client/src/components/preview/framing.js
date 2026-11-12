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

// How a site that does not answer failed, in plain words (server/src/audit/http.js errorCode).
const DOWN_WORDS = {
  timeout: 'it did not answer within 8 seconds',
  dns: 'its address could not be found',
  refused: 'it refused the connection',
  ssl: 'its security certificate could not be checked',
};

/**
 * The live availability once the server has said whether the site answers right now (GET /projects/:id/live): a site
 * that does not answer would draw a blank frame, so it is not shown live. No answer yet (null) changes nothing.
 * @param {{ ok: boolean, why: string|null }} live
 * @param {{ answers: boolean, error: string|null, status: number } | null} answer
 */
export function withAnswer(live, answer) {
  if (!live.ok || !answer || answer.answers) return live;
  const how = DOWN_WORDS[answer.error] ?? (answer.status >= 500 ? `it answered with a server error (HTTP ${answer.status})` : 'it could not be reached');
  return { ok: false, why: `The site is not answering right now: ${how}.`, down: true };
}
