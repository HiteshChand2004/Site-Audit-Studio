// holdableTimer (audit/util.js): the step timer of Analyze that stops counting while the step waits for the Lighthouse lane.
// Not held it behaves like a plain setTimeout; held it never fires; released after a wait it fires that much later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdableTimer } from '../src/audit/util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('never held: fires at its time, like a plain setTimeout', async () => {
  let at = null;
  const t0 = Date.now();
  holdableTimer(100, () => (at = Date.now() - t0));
  await sleep(250);
  assert.ok(at >= 95 && at < 200, `fired at ${at} ms`);
});

test('held: does not fire past its end; released after a wait, it fires that much later', async () => {
  let fired = null;
  const t0 = Date.now();
  const t = holdableTimer(100, () => (fired = Date.now() - t0));
  await sleep(20);
  t.hold();
  await sleep(200);
  assert.equal(fired, null, 'held past its original end without firing');
  t.release(200); // the wait lasted 200 ms
  await sleep(200);
  assert.ok(fired >= 290 && fired < 400, `fired at ${fired} ms (100 + 200 waited)`);
});

test('holds nest: it counts again only after the last release; clear stops it; no limit arms nothing', async () => {
  let fired = false;
  const t = holdableTimer(50, () => (fired = true));
  t.hold();
  t.hold();
  t.release(0);
  await sleep(120);
  assert.equal(fired, false, 'still held once');
  t.release(0);
  await sleep(30);
  assert.equal(fired, true);
  let cleared = false;
  const c = holdableTimer(50, () => (cleared = true));
  c.clear();
  let endless = false;
  holdableTimer(Infinity, () => (endless = true));
  await sleep(100);
  assert.equal(cleared, false);
  assert.equal(endless, false);
});
