// Exact mode, phase D: the regression corpus. The rebuilding needs a browser and a quarter of an hour, so what is
// tested here is the part that decides pass or fail - a gate that cannot tell a drop from noise is worse than none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { compareScores, formatRow, METRICS, REGISTRY, TOLERANCE } from '../scripts/corpus.mjs';

const scores = (o) => ({ fidelity: null, diff: null, responsive: null, pages: null, lowPages: null, ...o });

test('an unchanged rebuild passes, and small movement is noise rather than news', () => {
  const before = scores({ fidelity: 88, diff: 85, responsive: 87, pages: 10, lowPages: 2 });
  const same = compareScores(scores({ fidelity: 88, diff: 85, responsive: 87, pages: 10, lowPages: 2 }), before);
  assert.equal(same.ok, true);
  assert.ok(same.rows.every((r) => r.verdict === 'same'), JSON.stringify(same.rows));

  // Just inside the tolerance: a rebuild is not bit-identical and a gate that fails on that is useless.
  const jitter = compareScores(scores({ fidelity: 88 - (TOLERANCE - 0.01), diff: 85, responsive: 87, pages: 10, lowPages: 2 }), before);
  assert.equal(jitter.ok, true);
  assert.equal(jitter.rows.find((r) => r.key === 'fidelity').verdict, 'same');
});

test('a score that really fell fails the gate, and says which one', () => {
  const before = scores({ fidelity: 88, diff: 85, responsive: 87, pages: 10, lowPages: 2 });
  const worse = compareScores(scores({ fidelity: 84, diff: 85, responsive: 87, pages: 10, lowPages: 2 }), before);
  assert.equal(worse.ok, false);
  const row = worse.rows.find((r) => r.key === 'fidelity');
  assert.equal(row.verdict, 'worse');
  assert.equal(row.delta, -4);
});

test('a rise is reported and never fails the gate', () => {
  const r = compareScores(scores({ fidelity: 93, diff: 85, pages: 10, lowPages: 2 }), scores({ fidelity: 88, diff: 85, pages: 10, lowPages: 2 }));
  assert.equal(r.ok, true);
  assert.equal(r.rows.find((x) => x.key === 'fidelity').verdict, 'better');
});

test('fewer pages rebuilt is a regression, however good the ones that remain look', () => {
  // The trap this metric exists for: dropping the pages a fix cannot handle would raise every average.
  const r = compareScores(scores({ fidelity: 99, diff: 99, pages: 7, lowPages: 0 }), scores({ fidelity: 88, diff: 85, pages: 10, lowPages: 2 }));
  assert.equal(r.ok, false);
  assert.equal(r.rows.find((x) => x.key === 'pages').verdict, 'worse');
  assert.equal(r.rows.find((x) => x.key === 'fidelity').verdict, 'better', 'and the rise is still reported honestly');
});

test('a count where lower is better reads the right way round', () => {
  const fewer = compareScores(scores({ lowPages: 0, pages: 10 }), scores({ lowPages: 3, pages: 10 }));
  assert.equal(fewer.rows.find((r) => r.key === 'lowPages').verdict, 'better');
  assert.equal(fewer.ok, true);
  const more = compareScores(scores({ lowPages: 5, pages: 10 }), scores({ lowPages: 3, pages: 10 }));
  assert.equal(more.rows.find((r) => r.key === 'lowPages').verdict, 'worse');
  assert.equal(more.ok, false);
});

test('a metric that disappeared is a failure, not a pass by omission', () => {
  const r = compareScores(scores({ fidelity: 88, diff: null, pages: 10 }), scores({ fidelity: 88, diff: 85, pages: 10 }));
  assert.equal(r.ok, false);
  assert.equal(r.rows.find((x) => x.key === 'diff').verdict, 'missing');
});

test('a fixture with no baseline yet is new, and does not fail the first run', () => {
  const r = compareScores(scores({ fidelity: 88, diff: 85, pages: 10 }), undefined);
  assert.equal(r.ok, true);
  assert.ok(r.rows.every((x) => x.verdict === 'new'));
});

test('every metric comes from the report the pipeline already writes', () => {
  // A corpus that measures something of its own invention measures the corpus, not the product.
  const report = {
    fidelity: { score: 88, diff: { score: 85 }, lowPages: ['/a', '/b'] },
    responsive: { score: 87 },
    pages: [{}, {}, {}],
  };
  const got = Object.fromEntries(METRICS.map((m) => [m.key, m.of(report)]));
  assert.deepEqual(got, { fidelity: 88, diff: 85, responsive: 87, pages: 3, lowPages: 2 });
  // A report missing a section gives null, not zero: 'not measured' and 'none' are different claims, and
  // compareScores treats a metric that went from a number to null as a failure rather than as a pass.
  assert.deepEqual(Object.fromEntries(METRICS.map((m) => [m.key, m.of({})])), {
    fidelity: null, diff: null, responsive: null, pages: null, lowPages: null,
  });
});

test('the five saved sites are registered, each with a capture to rebuild from', async () => {
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  assert.ok(registry.dataDir, 'the corpus knows where to read from');
  const names = registry.fixtures.map((f) => f.name).sort();
  assert.deepEqual(names, ['botza', 'flexibench', 'nyaayai', 'panscience', 'parchaa']);
  for (const f of registry.fixtures) {
    assert.match(f.projectId, /^[0-9a-f-]{36}$/);
    assert.match(f.recreateId, /^[0-9a-f-]{36}$/);
    // Skipped rather than failed when the machine has no such data: the corpus is this machine's, not the repo's.
    if (!existsSync(registry.dataDir)) continue;
    const dir = path.join(registry.dataDir, 'projects', f.projectId, 'recreate', f.recreateId);
    assert.ok(existsSync(path.join(dir, 'capture', 'manifest.json')), `${f.name} has a capture`);
    assert.ok(existsSync(path.join(dir, 'assets', 'manifest.json')), `${f.name} has its assets`);
  }
});

test('a row reads as a line a person can scan', () => {
  const line = formatRow('match with the original', { key: 'fidelity', now: 84, before: 88, delta: -4, verdict: 'worse' });
  assert.match(line, /!/);
  assert.match(line, /88/);
  assert.match(line, /84/);
  assert.match(line, /-4/);
  assert.match(formatRow('pages rebuilt', { key: 'pages', now: 10, before: 10, delta: 0, verdict: 'same' }), /=/);
});
