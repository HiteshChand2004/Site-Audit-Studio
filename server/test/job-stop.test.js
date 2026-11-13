// Stop on one click: the stop is accepted at once, says "Stopping…" until the job has ended, and a second click is harmless.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/index.js';
import { JobManager } from '../src/jobs/manager.js';
import { seedProject } from './helpers/projects.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
};

const projectIds = [];
function makeProject() {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'stop', url: 'https://example.com/', stack: 'html', authorized: 1 });
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
after(() => {
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
});

/**
 * A run that, like a real pipeline, does not end the moment it is asked to: a step in flight still reports progress after the
 * abort, and the run ends only when `finish()` is called.
 */
function slowToStopManager() {
  let report = null;
  let finish = null;
  let aborts = 0;
  const manager = new JobManager({
    table: 'recreates',
    noun: 'a copy',
    steps: [{ key: 'one', label: 'One', weight: 1 }],
    overallPct: () => 0,
    doneMessage: 'done',
    heartbeatMs: 50,
    run: ({ progress, signal }) =>
      new Promise((resolve, reject) => {
        report = progress;
        progress('one', 0.2, 'Capturing page 1 of 5');
        signal.addEventListener('abort', () => aborts++);
        finish = () => reject(Object.assign(new Error('Stopped before it finished.'), { stopped: true }));
      }),
  });
  return { manager, report: (...a) => report(...a), finish: () => finish(), aborts: () => aborts };
}

test('a stop is accepted at once and keeps saying "Stopping…" while the job winds down, in every snapshot', async () => {
  const { manager, report, finish } = slowToStopManager();
  const project = makeProject();
  const job = manager.start(project);
  await until(() => manager.get(job.id)?.status === 'running');
  const events = [];
  manager.on(job.id, (type, snap) => events.push([type, snap]));

  const t0 = Date.now();
  const stopped = manager.stop(project.id);
  assert.ok(Date.now() - t0 < 50, 'the stop answers without waiting for the job to end');
  assert.equal(stopped.stopping, true);
  assert.equal(stopped.message, 'Stopping…');

  // The step in flight reports once more after the abort: the job still reads as stopping, not as "Capturing page 2".
  report('one', 0.4, 'Capturing page 2 of 5');
  const now = manager.get(job.id);
  assert.equal(now.stopping, true);
  assert.equal(now.message, 'Stopping…');
  assert.ok(events.every(([, s]) => s.stopping === true && s.message === 'Stopping…'), 'every event after the stop says so');

  finish();
  await until(() => manager.get(job.id)?.status === 'failed');
});

test('a second stop is harmless: same job, no second abort, no extra event', async () => {
  const { manager, finish, aborts } = slowToStopManager();
  const project = makeProject();
  const job = manager.start(project);
  await until(() => manager.get(job.id)?.status === 'running');
  assert.equal(manager.get(job.id).stopping, false, 'a running job that was not asked to stop says so');

  manager.stop(project.id);
  const events = [];
  manager.on(job.id, (type) => events.push(type));
  const again = manager.stop(project.id);
  assert.equal(again.id, job.id);
  assert.equal(again.stopping, true);
  assert.equal(aborts(), 1, 'the run is asked to stop once');
  assert.deepEqual(events, [], 'the second click changes nothing');

  finish();
  await until(() => manager.get(job.id)?.status === 'failed');
  assert.equal(manager.stop(project.id), null, 'nothing left to stop');
});
