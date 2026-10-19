// The as-is copy's checks as the thresholds judge them (server/src/copy/checks.js). No browser: the input is the shape
// that recreate/behavior/preserve/check.js writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageChecksOf, visualScoreOf } from '../src/copy/checks.js';

test('the visual score: 100 minus ten times the percent of pixels that differ, clamped', () => {
  assert.equal(visualScoreOf(0), 100);
  assert.equal(visualScoreOf(1), 90);
  assert.equal(visualScoreOf(5), 50);
  assert.equal(visualScoreOf(20), 0);
  assert.equal(visualScoreOf(null), null);
});

test('a clean as-is page passes every check', () => {
  const page = {
    path: '/', offline: { errors: [], failed: [], external: [] },
    visual: [{ width: 1440, copyHeight: 900, originalHeight: 900, diffPct: 0 }, { width: 390, copyHeight: 2000, originalHeight: 2000, diffPct: 0.2 }],
    controls: { original: { visible: 4 }, copy: { visible: 4 }, mismatch: [], missing: [] },
    hovers: { original: { visible: 10 }, copy: { visible: 10 }, mismatch: [] },
  };
  const r = pageChecksOf(page);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.controls, { same: 4, total: 4 });
  assert.deepEqual(r.hovers, { matched: 10, total: 10 });
  assert.equal(r.visual[1440], 100);
});

test('a page that differs, misses controls and has console errors is named by each failing check', () => {
  const page = {
    path: '/menu', offline: { errors: ['console: boom'] },
    visual: [{ width: 1440, copyHeight: 900, originalHeight: 900, diffPct: 6 }, { width: 390, copyHeight: 1000, originalHeight: 2000, diffPct: 0 }],
    controls: { original: { visible: 4 }, mismatch: [{ i: 0 }], missing: [{ label: 'Menu' }] },
    hovers: { original: { visible: 10 }, mismatch: [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }, { i: 6 }, { i: 7 }, { i: 8 }, { i: 9 }] },
  };
  const r = pageChecksOf(page);
  const names = r.problems.map((p) => p.check);
  for (const n of ['visual', 'height', 'controls', 'hover', 'console']) assert.ok(names.includes(n), n);
  assert.equal(r.problems.find((p) => p.check === 'visual').width, 1440);
  assert.equal(r.controls.same, 2);
  assert.equal(r.hovers.matched, 1);
});

test('when the original did not answer there is no control or hover judgement, and the note says why', () => {
  const r = pageChecksOf({ path: '/x', visual: [{ width: 1440, note: 'original not reachable', diffPct: null }], controls: { original: null }, hovers: { original: null } });
  assert.equal(r.controls, null);
  assert.equal(r.hovers, null);
  assert.equal(r.visual[1440], null);
  assert.deepEqual(r.problems, []);
});
