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

test('the explanation says what each side counts, which record is missing, and when the copy page was measured nearly empty', () => {
  const failing = { original: ['color-contrast'], copy: ['color-contrast'] };
  const base = { category: 'accessibility', mode: 'mobile', failing };
  const missing = sameChecksPart({ ...base, scored: { original: null, copy: { accessibility: [audit('color-contrast', 7)] } } }, '95 → 92 (phone)');
  assert.equal(missing.unexplained, true);
  assert.match(missing.evidence, /not recorded for the original \(/);
  assert.doesNotMatch(missing.evidence, /the copy \(/);
  const many = ['aria-allowed-attr', 'aria-roles', 'list', 'listitem', 'image-alt', 'link-name'].map((id) => audit(id, 10));
  const lost = sameChecksPart({
    ...base,
    scored: { original: { accessibility: [audit('color-contrast', 7), ...many] }, copy: { accessibility: [audit('color-contrast', 7), many[4]] } },
    notApplicable: { original: { accessibility: ['video-caption'] }, copy: { accessibility: ['video-caption', 'aria-roles', 'list'] } },
    elements: { original: 900, copy: 120 },
  }, '95 → 92 (phone)');
  assert.equal(lost.unexplained, true, 'never moved out of the count');
  assert.match(lost.evidence, /5 checks that pass on the original do not apply on the copy/);
  assert.match(lost.evidence, /On the original 7 checks count \(6 pass, 1 fail\), 1 do not apply; on the copy 2 checks count \(1 pass, 1 fail\), 3 do not apply\./);
  assert.match(lost.evidence, /Lighthouse saw 120 elements on the copy's page and 900 on the original's: the page it measured on the copy lacks most/);
  const near = sameChecksPart({ ...base, scored: { original: { accessibility: [audit('color-contrast', 7), many[0]] }, copy: { accessibility: [audit('color-contrast', 7)] } }, elements: { original: 900, copy: 880 } }, '96 → 95 (phone)');
  assert.match(near.evidence, /880 elements on the copy's page and 900 on the original's\.$/);
});

test('a kept run from before the record is completed from its full report; without one it is measured again', async (t) => {
  const { mkdtemp, rm, writeFile: write } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { completedRecord, measureRun } = await import('../src/reaudit/lighthousePages.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-lh-kept-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lhr = {
    categories: { accessibility: { score: 0.95, auditRefs: [{ id: 'color-contrast', weight: 7 }, { id: 'image-alt', weight: 10 }, { id: 'video-caption', weight: 10 }] } },
    audits: {
      'color-contrast': { id: 'color-contrast', title: 'Contrast', score: 0, scoreDisplayMode: 'binary' },
      'image-alt': { id: 'image-alt', title: 'Alt', score: 1, scoreDisplayMode: 'binary' },
      'video-caption': { id: 'video-caption', title: 'Captions', score: null, scoreDisplayMode: 'notApplicable' },
      'dom-size': { id: 'dom-size', numericValue: 812, score: 1, scoreDisplayMode: 'numeric' },
    },
  };
  const file = path.join(dir, 'run.json');
  await write(`${file}.full.json`, JSON.stringify(lhr), 'utf8');
  const old = { scores: { accessibility: 95 }, fetchTime: new Date().toISOString() };
  const done = await completedRecord(old, file);
  assert.deepEqual(done.scoredByCategory.accessibility.map((a) => a.id), ['color-contrast', 'image-alt']);
  assert.deepEqual(done.notApplicableByCategory.accessibility, ['video-caption']);
  assert.equal(done.domElements, 812);
  assert.equal(done.scores, old.scores, 'what the run recorded is kept as it is');
  assert.equal(await completedRecord(old, path.join(dir, 'none.json')), old, 'no full report: returned unchanged');
  // measureRun: an original run with no record and no full report is not reused; it is measured again, and why is listed.
  const p = { path: '/', url: 'https://site.test/', copyUrl: 'http://127.0.0.1:1/' };
  const { runFileOf } = await import('../src/reaudit/lighthousePages.js');
  const kept = runFileOf(dir, 'home', 'mobile', 1);
  await write(kept, JSON.stringify({ ...old, measuredAt: Date.now(), benchmarkIndex: 1000 }), 'utf8');
  const result = { runs: { original: 0, copy: 0, reusedOriginal: 0 }, refreshedOriginal: [] };
  const run = async (_url, _mode, raw) => { await write(raw, JSON.stringify(lhr), 'utf8'); return {}; };
  const fresh = await measureRun({ side: 'original', p, slug: 'home', mode: 'mobile', n: 1, copyRun: { benchmarkIndex: 1000 }, cacheDir: dir, outDir: dir, run, probe: async () => null, result });
  assert.equal(result.runs.reusedOriginal, 0);
  assert.equal(result.runs.original, 1);
  assert.match(result.refreshedOriginal[0].reason, /before the record of which checks count/);
  assert.deepEqual(fresh.notApplicableByCategory.accessibility, ['video-caption']);
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
