// Rows of the comparison that read "got worse" with no truth behind them (found on a real as-is copy):
//  - the original's accessibility scan timed out, its empty list read as "No violations", and every rule failing on the copy
//    became a regression (reaudit/compare/index.js axeScanned / axeItems);
//  - a Lighthouse score one point lower with the same failing checks was "Our bug" (copy/gotWorse.js sameChecksPart);
//  - a part of the page that changes by itself read as a bare 0 on the copy, with no word on why (reaudit/motion.js compareFeeds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axeItems, axeScanned } from '../src/reaudit/compare/index.js';
import { sameChecksPart } from '../src/copy/gotWorse.js';
import { compareFeeds } from '../src/reaudit/motion.js';

const contrast = { id: 'color-contrast', title: 'Elements must meet minimum color contrast ratio thresholds', count: 16, impact: 'serious' };

test('a side whose accessibility scan did not finish is "not checked", never "No violations"', () => {
  const timedOut = { accessibility: [], errors: [{ step: 'render', message: 'Rendering + accessibility timed out after 120s' }] };
  const failed = { accessibility: [], errors: [{ step: 'render', message: 'Accessibility scan failed: Target closed' }] };
  const clean = { accessibility: [], errors: [{ step: 'screenshots', message: 'desktop: Not captured' }] };
  assert.equal(axeScanned(timedOut), false);
  assert.equal(axeScanned(failed), false);
  assert.equal(axeScanned(clean), true, 'a clean scan with nothing to report was scanned');
  assert.equal(axeScanned({ accessibility: [contrast], errors: timedOut.errors }), true, 'violations listed = scanned');

  const [row] = axeItems([], [contrast], { oldScanned: false, newScanned: true });
  assert.equal(row.preset, 'recheck');
  assert.equal(row.statusLabel, 'Not checked on the original');
  assert.match(row.before.detail, /Not checked/);
  assert.equal(row.after.detail, '16 elements (serious)', 'the copy\'s number stays on the row');
  // The other way round: the copy not scanned must not read as "fixed".
  const [back] = axeItems([contrast], [], { oldScanned: true, newScanned: false });
  assert.equal(back.preset, 'recheck');
  assert.equal(back.statusLabel, 'Not checked on the copy');
  // Both scanned: unchanged behaviour (no preset, compared as before).
  const [both] = axeItems([], [contrast]);
  assert.equal(both.preset, undefined);
  assert.equal(both.before.detail, 'No violations');
});

const audit = (id, weight = 1) => ({ id, weight, title: `Check ${id}` });

test('a lower score with the same failing checks says which check stopped counting, or that only one run differed', () => {
  const failing = { original: ['color-contrast'], copy: ['color-contrast'] };
  const base = { category: 'accessibility', mode: 'mobile', failing };
  // No record of what counted (an older row): unexplained, as before.
  assert.equal(sameChecksPart(base, '96 → 95 (phone)').unexplained, true);
  // A passing check of the original does not apply on the copy: named.
  const lost = sameChecksPart({ ...base, scored: {
    original: { accessibility: [audit('color-contrast', 7), audit('video-caption', 10), audit('image-alt', 10)] },
    copy: { accessibility: [audit('color-contrast', 7), audit('image-alt', 10)] },
  } }, '96 → 95 (phone)');
  assert.equal(lost.unexplained, true, 'a real difference of the copy stays a got-worse');
  assert.match(lost.evidence, /does not apply on the copy.*"Check video-caption"/);
  // Same checks counted and failed: the first runs score the same; the medians differ by another run.
  const noise = sameChecksPart({ ...base, scored: {
    original: { accessibility: [audit('color-contrast', 7), audit('image-alt', 10)] },
    copy: { accessibility: [audit('color-contrast', 7), audit('image-alt', 10)] },
  }, runScores: { original: [{ accessibility: 96 }, { accessibility: 96 }, { accessibility: 95 }], copy: [{ accessibility: 95 }, { accessibility: 96 }, { accessibility: 95 }] } }, '96 → 95 (phone)');
  assert.equal(noise.group, 'noise');
  assert.match(noise.evidence, /runs of the original: 96, 96, 95; of the copy: 95, 96, 95/);
});

test('a part that changes by itself: another pace at the same place is kept; no steady pace or no change says why', () => {
  const old = new Map([['home', { feeds: { areas: [
    { path: 'body>ul:1', ms: 2400 }, { path: 'body>p:1', ms: 3000 }, { path: 'body>div:4', ms: 1500 }, { path: 'body>h1:1', ms: 2000 },
  ] } }]]);
  const now = new Map([['home', { feeds: [
    { path: 'body>ul:1', ms: 2450, changes: 5 },
    { path: 'body>p:1', ms: 4500, changes: 3 },
    { path: 'body>div:4', reason: 'changes at no steady pace', changes: 4 },
  ] }]]);
  const r = compareFeeds(['home'], old, now);
  assert.equal(r.before, 4);
  assert.equal(r.kept, 2);
  assert.match(r.paces.join(' '), /4500 ms \(original 3000 ms: another pace\)/);
  assert.deepEqual(r.differences.map((d) => d.element), ['body>div:4', 'body>h1:1']);
  assert.match(r.differences[0].diff[0], /4 updates while watched\) but changes at no steady pace/);
  assert.match(r.differences[1].diff[0], /does not change on the copy; the original changes every 2000 ms/);
});
