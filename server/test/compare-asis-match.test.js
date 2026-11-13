// Compare's match per page for an as-is copy: taken from its final check (asIs.checks), since such a copy has no `fidelity`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fidelityPages } from '../../client/src/fidelity.js';

const asIsResult = {
  pages: [
    { path: '/', outPath: 'index.html' },
    { path: '/employers/', outPath: 'employers/index.html' },
  ],
  asIs: {
    checks: {
      pages: [
        { path: '/', visual: [{ width: 1440, diffPct: 7.3742, copyHeight: 900 }, { width: 390, diffPct: 27.14, copyHeight: 844 }] },
        { path: '/employers', visual: [{ width: 1440, diffPct: 0.0044, copyHeight: 6952, originalHeight: 6960 }, { width: 390, diffPct: 0.0111, copyHeight: 8686 }] },
        { path: '/not-copied/', visual: [{ width: 1440, diffPct: 0 }] },
      ],
    },
  },
};

test('an as-is copy gets a match per page from its final check: the lower of its two widths', () => {
  const pages = fidelityPages(asIsResult);
  assert.deepEqual(pages.map((p) => p.outPath), ['index.html', 'employers/index.html'], 'a checked page the copy does not hold is left out');
  const [home, employers] = pages;
  assert.equal(home.score, 73);
  assert.equal(home.views.desktop.score, 93);
  assert.equal(home.views.mobile.score, 73);
  assert.equal(employers.score, 100);
  assert.equal(home.asIs, true, 'marked: it has no pictures of the copy');
  assert.equal(home.views.desktop.height.generated, 900, 'the measured height lets both sides scroll together');
  // The original's height lets a live original scroll together with the copy; none measured = none given.
  assert.equal(employers.views.desktop.height.original, 6960);
  assert.equal(home.views.desktop.height.original, undefined);
});

test('a rebuilt copy keeps its own fidelity; a copy with neither has none', () => {
  const fidelity = { pages: [{ outPath: 'index.html', score: 88, views: {} }] };
  assert.equal(fidelityPages({ fidelity, asIs: asIsResult.asIs }), fidelity.pages);
  assert.deepEqual(fidelityPages({ pages: [] }), []);
  assert.deepEqual(fidelityPages(null), []);
});
