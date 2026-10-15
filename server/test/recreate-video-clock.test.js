// The video tier pauses the page's clock just ahead of the page's own time. On a busy machine the page can pass that
// target before the pause arrives ("Cannot fast-forward to the past"), which made a recording fail at random under load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseClock } from '../src/recreate/capture/videotier.js';

/** A page whose clock moves on by `lag` ms between reading the time and pausing it. */
function fakePage(lags) {
  let t = 1_000_000;
  const calls = [];
  return {
    calls,
    evaluate: async () => t,
    clock: {
      pauseAt: async (target) => {
        t += lags.shift() ?? 0;
        calls.push(target);
        if (target < t) throw new Error('clock.pauseAt: Error: Cannot fast-forward to the past');
      },
    },
  };
}

test('a page that ran past the target is paused again with a wider margin', async () => {
  const page = fakePage([120, 120]);
  assert.equal(await pauseClock(page), 500);
  assert.equal(page.calls.length, 2);
});

test('a quiet page is paused at once', async () => {
  const page = fakePage([10]);
  assert.equal(await pauseClock(page), 50);
  assert.equal(page.calls.length, 1);
});

test('any other error is not retried, and a page always past the target still fails', async () => {
  const broken = { evaluate: async () => 0, clock: { pauseAt: async () => { throw new Error('Target closed'); } } };
  await assert.rejects(pauseClock(broken), /Target closed/);
  const lagging = fakePage([5000, 5000, 5000]);
  await assert.rejects(pauseClock(lagging), /past/);
  assert.equal(lagging.calls.length, 3);
});
