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

// "Try again" never sends what the server refuses a non-owner (the 403 "Only the owner can use a clean rebuild"): the client rule
// (client/src/components/recreate/failedAttempt.js retryOf) agrees with the server's (routes/recreate.js ownerOnlyOptions).
test('Try again: a non-owner never sends an owner-only request; without one, "Copy my site" opens', async () => {
  const { retryOf } = await import('../../client/src/components/recreate/failedAttempt.js');
  const { ownerOnlyOptions } = await import('../src/routes/recreate.js');
  const asIs = { mode: 'as-is', confirmed: true, stack: 'html', pages: [] };
  const cases = [null, undefined, {}, { mode: 'clean' }, { exact: true }, { noLimit: true }, { reuseCapture: true },
    { preserve: true }, asIs, { ...asIs, preserve: true }, { mode: 'as-is', confirmed: true, stack: 'nextjs', reuseAsIs: true },
    { resume: true }, { ...asIs, exact: true }];
  for (const options of cases) {
    const got = retryOf(options, false);
    const allowed = ownerOnlyOptions(options).length === 0;
    assert.equal(got.start, allowed, `non-owner, ${JSON.stringify(options)}`);
    if (got.start) assert.equal(got.options, options, 'the same request is sent again');
  }
  // After a reload nothing is remembered: the panel opens instead of an empty request (the clean rebuild a non-owner is refused).
  assert.deepEqual(retryOf(null, false), { start: false });
  // The owner keeps the earlier behaviour: the same request again, an empty one = a clean rebuild.
  assert.deepEqual(retryOf(null, true), { start: true, options: null });
  assert.deepEqual(retryOf({ exact: true }, true), { start: true, options: { exact: true } });
});
