// The Lighthouse lane (audit/lighthouse/run.js): one run at a time in the server whatever runs beside it, in the order asked, the
// time limit counted from the run's turn, the turn handed on after a failure, and a stop while waiting leaving the line.
// A stub worker stands in for Lighthouse (no Chrome).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lighthouseLane, runLighthouse } from '../src/audit/lighthouse/run.js';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/index.js';
import { JobManager } from '../src/jobs/manager.js';
import { seedProject } from './helpers/projects.js';

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lighthouse-stub-worker.js');
const run = (query, opts = {}) => runLighthouse(`stub://run?${query}`, 'mobile', { worker, timeout: 10000, ...opts });

test('runs started together never overlap and go in the order they were asked', async () => {
  const results = await Promise.all([run('ms=300&n=1'), run('ms=200&n=2'), run('ms=100&n=3')]);
  assert.deepEqual(results.map((r) => new URL(r.url).searchParams.get('n')), ['1', '2', '3']);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].startedAt >= results[i - 1].endedAt, `run ${i + 1} started before run ${i} ended`);
  }
  assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
});

test('the time limit counts from the run\'s turn, not from the wait; the wait is reported', async () => {
  let waited = null;
  const [, second] = await Promise.all([
    run('ms=600'),
    run('ms=100', { timeout: 400, onAcquire: ({ waitedMs }) => (waited = waitedMs) }),
  ]);
  assert.ok(second.endedAt, 'a 400 ms limit was not used up by 600 ms of waiting');
  assert.ok(waited >= 500, `waited ${waited} ms`);
  // A run that is itself too long still times out.
  await assert.rejects(run('ms=2000', { timeout: 300 }), /timed out after/);
  assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
});

test('a failed run hands the lane on', async () => {
  const [failed, next] = await Promise.allSettled([run('ms=50&fail=1'), run('ms=50')]);
  assert.equal(failed.status, 'rejected');
  assert.match(failed.reason.message, /worker exited \(code 3\)/);
  assert.equal(next.status, 'fulfilled');
  assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
});

test('a stop while waiting leaves the line; the run behind it still runs', async () => {
  const stop = new AbortController();
  const first = run('ms=400');
  const stopped = run('ms=100&n=stopped', { signal: stop.signal });
  const last = run('ms=100&n=last');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lighthouseLane(), { running: 1, waiting: 2 });
  stop.abort();
  await assert.rejects(stopped, (e) => e.stopped === true);
  assert.deepEqual(lighthouseLane(), { running: 1, waiting: 1 });
  const [a, b] = await Promise.all([first, last]);
  assert.ok(b.startedAt >= a.endedAt);
  // Already stopped before asking: never waits, never runs.
  await assert.rejects(run('ms=100', { signal: AbortSignal.abort() }), (e) => e.stopped === true);
  assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A job whose run is one Lighthouse run through the lane: its manager, its job, and its final state. */
function laneJob(query) {
  const manager = new JobManager({
    table: 'analyses', noun: 'a job', steps: [{ key: 'one', label: 'One', weight: 1 }], overallPct: () => 0, doneMessage: 'done', heartbeatMs: 50,
    run: ({ signal }) => run(query, { signal }),
  });
  const id = randomUUID();
  seedProject(db, { id, name: 'lane', url: 'https://example.com/', stack: 'html', authorized: 1 });
  const job = manager.start(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  const ended = new Promise((resolve) => manager.on(job.id, (type, snap) => (type === 'done' || type === 'failed') && resolve(snap)));
  return { manager, job, ended };
}
/** The hard limit for the test (and no memory gate: this is about time, not memory), put back afterwards. */
async function withLimit(minutes, fn) {
  const saved = { max: process.env.SAS_JOB_MAX_MINUTES, mem: process.env.SAS_JOB_MIN_FREE_MB };
  process.env.SAS_JOB_MAX_MINUTES = String(minutes);
  process.env.SAS_JOB_MIN_FREE_MB = '0';
  try {
    await fn();
  } finally {
    for (const [k, v] of [['SAS_JOB_MAX_MINUTES', saved.max], ['SAS_JOB_MIN_FREE_MB', saved.mem]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a job whose run waits for the lane is not stopped while waiting, and gets that time back', () =>
  withLimit(0.01, async () => { // 600 ms
    const outside = run('ms=800'); // holds the lane 800 ms, outside any job: longer than the limit
    const { ended } = laneJob('ms=100'); // waits ~800 ms, then runs 100 ms
    const snap = await ended;
    await outside;
    assert.equal(snap.status, 'done', 'not stopped at 600 ms while it was only waiting');
  }));

test('at most the limit itself is given back: a job is never held past twice its limit', () =>
  withLimit(0.01, async () => { // 600 ms, so at most 1200 ms in all
    const outside = run('ms=1500');
    const started = Date.now();
    const { ended } = laneJob('ms=100'); // would need ~1600 ms
    const snap = await ended;
    const took = Date.now() - started;
    await outside;
    assert.equal(snap.status, 'failed');
    assert.match(snap.error, /plus .* spent waiting for Lighthouse/);
    assert.ok(took >= 1100 && took < 1500, `stopped while still waiting, around 1200 ms (took ${took} ms)`);
    assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 }, 'its stop took it out of the lane');
  }));

test('a job stopped from the app while it waits for the lane ends at once and leaves the line', () =>
  withLimit(1, async () => { // a limit far away: this is about the manual stop only
    const outside = run('ms=1500');
    const { manager, job, ended } = laneJob('ms=100');
    await sleep(200);
    assert.deepEqual(lighthouseLane(), { running: 1, waiting: 1 }, 'the job is waiting in the lane');
    const stoppedAt = Date.now();
    manager.stop(job.projectId);
    const snap = await ended;
    assert.equal(snap.status, 'failed');
    assert.ok(Date.now() - stoppedAt < 500, 'ended at once, not after the run ahead of it');
    assert.deepEqual(lighthouseLane(), { running: 1, waiting: 0 }, 'left the line; the run ahead keeps going');
    await outside;
    assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
  }));

test('outside a job a waiting run gives nothing back and nothing breaks', async () => {
  const [, second] = await Promise.all([run('ms=200'), run('ms=50')]);
  assert.ok(second.endedAt);
});
