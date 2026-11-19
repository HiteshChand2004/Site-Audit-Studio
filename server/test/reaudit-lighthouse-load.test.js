// Re-audit (reaudit/lighthousePages.js): each run keeps what else ran on the server; a single pair measured under different
// load does not decide alone (the medians of three do), and the rows and the note say when other jobs ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareLighthousePages, lighthousePageItems, lighthousePagesNote, pageSlug, unevenLoad } from '../src/reaudit/lighthousePages.js';

const page = { path: '/', url: 'https://example.com/', copyUrl: 'http://127.0.0.1:9/' };
// A report where every category scores `score` (0–1): the copy at 0.95 against the original's 0.80 leads by 15 everywhere.
const report = (score) => ({
  categories: Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map((c) => [c, { score }])),
  audits: { 'dom-size': { score: 1, numericValue: 300 } },
  environment: { benchmarkIndex: 1000 },
});
/** A fake run: writes the report and answers with the load it was "measured" under, per side. */
const fakeRun = (load, calls) => async (url, mode, outFile) => {
  const side = url === page.url ? 'original' : 'copy';
  calls.push(`${side} ${mode}`);
  await writeFile(outFile, JSON.stringify(report(side === 'original' ? 0.8 : 0.95)));
  return load[side] == null ? {} : { contention: { otherJobs: load[side], otherKinds: load[side] ? ['recreate'] : [], availableMB: 8000 } };
};
async function compare(run, prepare) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-lh-load-'));
  try {
    const cacheDir = path.join(dir, 'cache');
    await prepare?.(cacheDir);
    return await compareLighthousePages({ pages: [page], cacheDir, outDir: path.join(dir, 'out'), run });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('unevenLoad: different counts of other jobs are uneven; an unknown side decides nothing', () => {
  const at = (n) => ({ contention: { otherJobs: n } });
  assert.equal(unevenLoad(at(0), at(1)), true);
  assert.equal(unevenLoad(at(1), at(1)), false);
  assert.equal(unevenLoad({}, at(1)), false);
  assert.equal(unevenLoad(at(0), { contention: null }), false);
  // The same number of jobs, but the computer itself ran at half speed during one side's run.
  assert.equal(unevenLoad({ ...at(0), benchmarkIndex: 1000 }, { ...at(0), benchmarkIndex: 500 }), true);
  assert.equal(unevenLoad({ ...at(0), benchmarkIndex: 1000 }, { ...at(0), benchmarkIndex: 900 }), false);
  assert.equal(unevenLoad({ benchmarkIndex: 1000 }, {}), false, 'an unknown speed decides nothing');
});

/** A fake run where each side has its own computer speed and category scores (0–100), no other jobs. */
const benchRun = (sides, calls) => async (url, mode, outFile) => {
  const side = url === page.url ? 'original' : 'copy';
  calls.push(`${side} ${mode}`);
  const { bench, scores } = sides[side];
  await writeFile(outFile, JSON.stringify({
    categories: Object.fromEntries(Object.entries(scores).map(([c, s]) => [c, { score: s / 100 }])),
    audits: { 'dom-size': { score: 1, numericValue: 300 } },
    environment: { benchmarkIndex: bench },
  }));
  return { contention: { otherJobs: 0, otherKinds: [], availableMB: 8000 } };
};
const all = (n, over = {}) => ({ performance: n, accessibility: n, 'best-practices': n, seo: n, ...over });

test('copy measured on a computer half as fast: its lower speed score is "measured on a slower computer", other categories still count', async () => {
  const calls = [];
  const result = await compare(benchRun({
    original: { bench: 1000, scores: all(90) },
    copy: { bench: 500, scores: all(90, { performance: 60, accessibility: 80 }) },
  }, calls));
  assert.equal(calls.length, 12, 'different computer speed = uneven: three runs per side');
  for (const m of Object.values(result.pages[0].modes)) {
    assert.deepEqual(m.slower, ['performance']);
    assert.deepEqual(m.worse, ['accessibility'], 'accessibility does not depend on computer speed');
    assert.deepEqual(m.cpu, { original: 1000, copy: 500 });
  }
  const rows = lighthousePageItems(result);
  const slow = rows.filter((r) => r.statusLabel === 'Measured on a slower computer');
  assert.equal(slow.length, 2, 'one per device');
  assert.ok(slow.every((r) => r.status === 'changed' && r.category === 'performance' && /computer speed 500/.test(r.after.detail)));
  assert.ok(rows.some((r) => r.category === 'accessibility' && r.status === 'regressed'), JSON.stringify(rows.map((r) => [r.key, r.status])));
});

test('the same computer speed on both sides: a lower speed score stays worse', async () => {
  const result = await compare(benchRun({
    original: { bench: 1000, scores: all(90) },
    copy: { bench: 950, scores: all(90, { performance: 60 }) },
  }, []));
  for (const m of Object.values(result.pages[0].modes)) {
    assert.deepEqual(m.slower, []);
    assert.ok(m.worse.includes('performance'));
  }
});

test('same load on both sides: a pair where the copy leads everywhere still decides alone, as before', async () => {
  const calls = [];
  const result = await compare(fakeRun({ original: 0, copy: 0 }, calls));
  assert.equal(calls.length, 4, 'one run per side, phone and computer');
  for (const m of Object.values(result.pages[0].modes)) {
    assert.equal(m.uneven, false);
    assert.equal(m.accepted, 'single run');
    assert.deepEqual(m.contention, { original: 0, copy: 0 });
  }
  assert.doesNotMatch(lighthousePagesNote(result), /other jobs ran|different load/);
});

test('different load on the two sides: the same scores take three runs per side, and the rows and the note say so', async () => {
  const calls = [];
  const result = await compare(fakeRun({ original: 0, copy: 1 }, calls));
  assert.equal(calls.length, 12, 'three runs per side, phone and computer');
  for (const m of Object.values(result.pages[0].modes)) {
    assert.equal(m.uneven, true);
    assert.equal(m.accepted, 'median of runs');
    assert.deepEqual(m.contention, { original: 0, copy: 1 });
    assert.deepEqual(m.worse, [], 'the verdict itself is unchanged: the copy is still ahead');
  }
  const rows = lighthousePageItems(result);
  assert.ok(rows.every((r) => r.after.detail.includes('measured while up to 1 other job ran on this server')), JSON.stringify(rows.map((r) => r.after.detail)));
  const note = lighthousePagesNote(result);
  assert.match(note, /measured while other jobs ran on this server: \/ on phone; \/ on computer/);
  assert.match(note, /2 comparisons were measured under different load on the two sides, so three runs per side decided them/);
});

test('a cached run of the original with no load reading: the old rule decides (one pair), nothing is guessed', async () => {
  const calls = [];
  const result = await compare(fakeRun({ original: 0, copy: 1 }, calls), async (cacheDir) => {
    await mkdir(cacheDir, { recursive: true });
    const slug = pageSlug(page.path, page.url);
    for (const mode of ['mobile', 'desktop']) {
      // Fresh and measured on a computer as fast as the copy's run (benchmark 1000): it may stand in (lighthousePages.js
      // staleOriginal); only its load reading is missing, which is what this test is about.
      await writeFile(path.join(cacheDir, `${slug}-${mode}-1.json`), JSON.stringify({ scores: { performance: 80, accessibility: 80, 'best-practices': 80, seo: 80 }, domElements: 300, audits: {}, measuredAt: Date.now(), benchmarkIndex: 1000,
        scoredByCategory: { performance: [], accessibility: [], 'best-practices': [], seo: [] } }));
    }
  });
  assert.deepEqual(calls, ['copy mobile', 'copy desktop'], 'the original came from the cache; one copy run each');
  for (const m of Object.values(result.pages[0].modes)) {
    assert.equal(m.uneven, false);
    assert.equal(m.accepted, 'single run');
    assert.deepEqual(m.contention, { original: null, copy: 1 });
  }
});
