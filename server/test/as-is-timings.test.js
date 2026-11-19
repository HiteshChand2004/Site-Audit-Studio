import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partClock } from '../src/recreate/behavior/preserve/timings.js';

test('partClock: each part gets its own ms, a part started twice adds up, total runs from the start', () => {
  let t = 1000;
  const clock = partClock(() => t);
  t = 1100; // before any part: counted in total only
  clock.start('lift');
  t = 1600;
  clock.start('fixes');
  t = 2600;
  clock.start('lift');
  t = 2700;
  const out = clock.done();
  assert.deepEqual(out, { lift: 600, fixes: 1000, total: 1700 });
});
