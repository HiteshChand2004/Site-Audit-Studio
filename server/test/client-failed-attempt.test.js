// The Create step shows a failed copy with its reason (and a "Try again"), and shows nothing while a copy runs or after one
// that finished. The rule is a pure function (client/src/components/recreate/failedAttempt.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedAttempt } from '../../client/src/components/recreate/failedAttempt.js';

test('a failed latest attempt shows its reason', () => {
  const got = failedAttempt({ last: { id: 'r1', status: 'failed', error: 'next build failed: public _next folder' } }, false);
  assert.deepEqual(got, { id: 'r1', reason: 'next build failed: public _next folder' });
});

test('a failed attempt with no recorded reason still says why nothing is shown', () => {
  const got = failedAttempt({ last: { id: 'r2', status: 'failed', error: null } }, false);
  assert.match(got.reason, /did not record|stopped before it finished/);
});

test('nothing is shown while a copy runs, after a finished copy, or with no attempt', () => {
  assert.equal(failedAttempt({ last: { id: 'r3', status: 'failed', error: 'x' } }, true), null, 'running now');
  assert.equal(failedAttempt({ last: { id: 'r4', status: 'done', error: null } }, false), null, 'the latest finished');
  assert.equal(failedAttempt({ last: null }, false), null, 'no attempt yet');
  assert.equal(failedAttempt(undefined, false), null);
});
