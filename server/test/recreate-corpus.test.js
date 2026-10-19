// Exact mode, phase D: the regression corpus. The rebuilding needs a browser and a quarter of an hour, so what is
// tested here is the part that decides pass or fail - a gate that cannot tell a drop from noise is worse than none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareScores, formatRow, METRICS, pickSource, pinFixture, pinnedDir, REGISTRY, TOLERANCE } from '../scripts/corpus.mjs';

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

test('the eight saved sites are registered, each with a capture to rebuild from', async () => {
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  assert.ok(registry.dataDir, 'the corpus knows where to read from');
  const names = registry.fixtures.map((f) => f.name).sort();
  assert.deepEqual(names, ['botza', 'collateral', 'dreamhire', 'flexibench', 'incredible-dragon', 'nyaayai', 'panscience', 'parchaa']);
  for (const f of registry.fixtures) {
    assert.match(f.projectId, /^[0-9a-f-]{36}$/);
    assert.match(f.recreateId, /^[0-9a-f-]{36}$/);
    // Skipped rather than failed when the machine has no such data: the corpus is this machine's, not the repo's.
    if (!existsSync(registry.dataDir)) continue;
    // The pinned copy, not the project's recreate folder: retention prunes those after two newer runs.
    const dir = pinnedDir(registry.dataDir, f.name);
    assert.ok(existsSync(path.join(dir, 'capture', 'manifest.json')), `${f.name} has a pinned capture (node scripts/corpus.mjs --pin)`);
    assert.ok(existsSync(path.join(dir, 'assets', 'manifest.json')), `${f.name} has its pinned assets`);
  }
});

test('a pinned capture outlives the recreate it was pinned from, and a stale id falls back to the newest finished one', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-corpus-pin-'));
  try {
    const projectId = '00000000-0000-4000-8000-000000000001';
    const make = async (id, page) => {
      const dir = path.join(dataDir, 'projects', projectId, 'recreate', id);
      await mkdir(path.join(dir, 'capture', 'home'), { recursive: true });
      await mkdir(path.join(dir, 'assets'), { recursive: true });
      await writeFile(path.join(dir, 'capture', 'manifest.json'), JSON.stringify({ pages: [{ url: page }] }));
      await writeFile(path.join(dir, 'capture', 'home', 'desktop.json'), '{}');
      await writeFile(path.join(dir, 'assets', 'manifest.json'), '{}');
      await writeFile(path.join(dir, 'report.json'), '{}');
      return dir;
    };
    const older = await make('older', '/a');
    await make('newer', '/b');
    // An unfinished folder (no manifests) is never a source.
    await mkdir(path.join(dataDir, 'projects', projectId, 'recreate', 'broken', 'capture'), { recursive: true });
    const fixture = { name: 'site', projectId, recreateId: 'older' };

    assert.equal(await pinFixture(fixture, { dataDir, finished: ['broken', 'newer', 'older'] }), 'older', 'the registered id wins while it exists');
    // Retention removes the source; the pin keeps working.
    await rm(older, { recursive: true, force: true });
    const pinned = pinnedDir(dataDir, 'site');
    assert.equal(JSON.parse(await readFile(path.join(pinned, 'capture', 'manifest.json'), 'utf8')).pages[0].url, '/a');
    assert.ok(existsSync(path.join(pinned, 'capture', 'home', 'desktop.json')), 'nested capture files are pinned too');
    assert.equal(JSON.parse(await readFile(path.join(pinned, 'pin.json'), 'utf8')).recreateId, 'older');

    // Re-pinning with a stale id takes the newest finished recreate that can be replayed, skipping the broken one.
    assert.equal(pickSource(fixture, { dataDir, finished: ['broken', 'newer', 'older'] }), 'newer');
    // A newer one-page run does not displace a whole-site capture.
    const onePage = await make('one-page', '/c');
    await writeFile(path.join(onePage, 'report.json'), JSON.stringify({ singlePage: { url: '/c' } }));
    assert.equal(pickSource(fixture, { dataDir, finished: ['one-page', 'newer'] }), 'newer');
    assert.equal(pickSource(fixture, { dataDir, finished: ['one-page'] }), 'one-page', 'but it is used when it is all there is');
    assert.equal(await pinFixture(fixture, { dataDir, finished: ['broken', 'newer'] }), 'newer');
    assert.equal(JSON.parse(await readFile(path.join(pinned, 'capture', 'manifest.json'), 'utf8')).pages[0].url, '/b');
    assert.ok(!existsSync(`${pinned}.tmp`), 'no staging folder is left behind');
    assert.equal(await pinFixture({ name: 'none', projectId, recreateId: 'gone' }, { dataDir, finished: ['broken'] }), null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
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
