// The Compare view's original side: which preview it opens on, and the note that says why live is not shown.
// The helpers are pure (no window, no React) so this test imports them directly from the client source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSides, defaultPreviewMode, unavailableNote, withAnswer } from '../../client/src/components/preview/framing.js';

const FRAMEABLE = { ok: true, why: null };
const BLOCKED = { ok: false, why: 'The site blocks framing (X-Frame-Options: SAMEORIGIN).' };
const NO_APP = { ok: false, why: 'This app cannot frame itself.' };

test('the original opens on live when the site can be framed', () => {
  assert.equal(defaultPreviewMode(FRAMEABLE), 'live');
  assert.equal(unavailableNote(FRAMEABLE, true), null);
  assert.equal(unavailableNote(FRAMEABLE, false), null);
});

test('a site that blocks framing opens on the picture, with the reason shown', () => {
  assert.equal(defaultPreviewMode(BLOCKED), 'screenshot');
  const note = unavailableNote(BLOCKED, true);
  assert.ok(note, 'a note is shown instead of a silent fallback');
  assert.match(note, /Live view is not available/);
  assert.ok(note.includes('X-Frame-Options: SAMEORIGIN'), 'the reason is named');
  assert.match(note, /picture taken during the check/);
});

test('without any picture the note says so', () => {
  const note = unavailableNote(BLOCKED, false);
  assert.match(note, /No picture was taken/);
});

test('an app origin opens on the picture with its own reason', () => {
  assert.equal(defaultPreviewMode(NO_APP), 'screenshot');
  assert.ok(unavailableNote(NO_APP, true).includes('This app cannot frame itself.'));
});

test('a site that does not answer right now opens on its picture, with why', () => {
  const down = withAnswer(FRAMEABLE, { answers: false, error: 'timeout', status: 0 });
  assert.equal(down.ok, false);
  assert.equal(down.down, true);
  assert.equal(defaultPreviewMode(down), 'screenshot');
  const note = unavailableNote(down, true);
  assert.match(note, /not answering right now: it did not answer within 8 seconds/);
  assert.match(note, /picture taken during the check/);
  assert.match(withAnswer(FRAMEABLE, { answers: false, error: null, status: 503 }).why, /server error \(HTTP 503\)/);
  assert.match(withAnswer(FRAMEABLE, { answers: false, error: 'dns', status: 0 }).why, /address could not be found/);
});

test('a site that answers, or no answer yet, leaves live as it was', () => {
  assert.equal(withAnswer(FRAMEABLE, { answers: true, error: null, status: 200 }), FRAMEABLE);
  assert.equal(withAnswer(FRAMEABLE, null), FRAMEABLE);
  // A site that blocks framing keeps its own reason, answering or not.
  assert.equal(withAnswer(BLOCKED, { answers: false, error: 'timeout', status: 0 }), BLOCKED);
});

test('Compare shows both sides live, or both as pictures — never one of each', () => {
  // Frameable: both live by default (scrolling together or not: the mode does not depend on it).
  assert.deepEqual(compareSides(defaultPreviewMode(FRAMEABLE), FRAMEABLE, true), { original: 'live', copy: 'live' });
  // Blocked, this app, or down: both pictures.
  for (const live of [BLOCKED, NO_APP, withAnswer(FRAMEABLE, { answers: false, error: 'timeout', status: 0 })]) {
    assert.deepEqual(compareSides(defaultPreviewMode(live), live, true), { original: 'screenshot', copy: 'screenshot' });
    // A Live switch cannot put the copy live next to a picture of the original.
    assert.deepEqual(compareSides('live', live, true), { original: 'screenshot', copy: 'screenshot' });
  }
  // The viewer's Picture switch: both pictures.
  assert.deepEqual(compareSides('screenshot', FRAMEABLE, true), { original: 'screenshot', copy: 'screenshot' });
  // A copy with no picture of its own has only its live view.
  assert.deepEqual(compareSides('screenshot', BLOCKED, false), { original: 'screenshot', copy: 'live' });
});
