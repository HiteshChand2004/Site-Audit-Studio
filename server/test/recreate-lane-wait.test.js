// B2c: a Recreate whose step waits for the Lighthouse lane behind another job's run. The waited time is given back to that
// step and to the job (never taken from the sleep/outage allowance), and a stop while waiting leaves the line.
// Stub stages and a stub Lighthouse worker: no browser, no site.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, projectDir } from '../src/db/index.js';
import { runInJob } from '../src/jobs/context.js';
import { lighthouseLane, runLighthouse } from '../src/audit/lighthouse/run.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { extendableTimeout } from '../src/recreate/interrupts.js';
import { seedProject } from './helpers/projects.js';

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lighthouse-stub-worker.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const projectIds = [];
after(async () => {
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});
function makeProject() {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'lane', url: 'http://localhost:4189/', stack: 'html', authorized: 1, analysis: true });
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
const quiet = { pausedBetween: () => 0, pauses: [], stop() {} };
const noOutage = { downBetween: () => 0, outages: [], stop() {} };
// As the job line runs it (jobs/manager.js runInJob), so the lane's wait reaches the Recreate.
const inJob = (fn) => runInJob({}, fn);

test('extendableTimeout: held it never fires; released it fires later by the wait; a grant while held moves the end', async () => {
  let fired = null;
  const t0 = Date.now();
  const t = extendableTimeout(100, () => (fired = Date.now() - t0));
  await sleep(20);
  t.hold();
  t.extend(100); // time given back while held
  await sleep(300);
  assert.equal(fired, null, 'held past its end without firing');
  t.release(300); // the wait lasted 300 ms: the end is now 100 + 100 + 300 = 500 ms
  await sleep(100);
  assert.equal(fired, null, 'not before its moved end');
  await sleep(200);
  assert.ok(fired >= 490 && fired < 650, `fired at ${fired} ms`);
});

test('a Recreate whose step waits for the lane is not stopped by its limit; step and job deadlines move by the wait; the allowance is untouched', async () => {
  const project = makeProject();
  const seen = {};
  const outside = runLighthouse('stub://run?ms=1500', 'desktop', { worker }); // another job's run holds the lane
  const report = await inJob(() => runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    budgetMs: 600,
    interruptOptions: { pauses: quiet, outages: noOutage },
    stages: {
      ...stubs,
      inspect: async (ctx) => {
        seen.step = ctx.stepDeadline;
        seen.job = ctx.jobDeadline;
        const asked = Date.now();
        await runLighthouse('stub://run?ms=50', 'desktop', { worker, signal: ctx.signal });
        seen.waited = Date.now() - asked;
        seen.stepMoved = ctx.stepDeadline - seen.step;
        seen.jobMoved = ctx.jobDeadline - seen.job;
      },
    },
  }));
  await outside;
  assert.ok(report, 'finished: not stopped at 600 ms while it waited');
  assert.ok(seen.waited >= 1300, `waited ${seen.waited} ms behind the run ahead`);
  assert.ok(seen.stepMoved >= 1300 && seen.stepMoved <= seen.waited, `step deadline moved ${seen.stepMoved} ms`);
  assert.ok(seen.jobMoved >= 1300 && seen.jobMoved <= seen.waited, `job deadline moved ${seen.jobMoved} ms`);
  assert.equal(report.interruptions.grantedMs, 0, 'not taken from the sleep/outage allowance');
  assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
});

test('a Recreate stopped while its stage waits for the lane ends at once and leaves the line; the run ahead goes on', async () => {
  const project = makeProject();
  const stop = new AbortController();
  const outside = runLighthouse('stub://run?ms=3000', 'desktop', { worker });
  const settled = inJob(() => runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    budgetMs: 60000,
    signal: stop.signal,
    interruptOptions: { pauses: quiet, outages: noOutage },
    // As the as-is stage does (preserve/stage.js): the job's signal goes with the run.
    stages: { ...stubs, inspect: (ctx) => runLighthouse('stub://run?ms=50', 'desktop', { worker, signal: ctx.signal }) },
  })).then(() => null, (err) => err);
  const giveUp = Date.now() + 10000;
  // Until the run ahead holds the lane and the copy's request waits behind it (the run ahead itself waits for a moment first).
  const copyWaits = () => lighthouseLane().running === 1 && lighthouseLane().waiting === 1;
  while (!copyWaits() && Date.now() < giveUp) await sleep(20);
  assert.deepEqual(lighthouseLane(), { running: 1, waiting: 1 }, 'the copy waits behind the run ahead');
  const stoppedAt = Date.now();
  stop.abort();
  const err = await settled;
  assert.equal(err?.stopped, true, `ended as stopped (${err?.message})`);
  assert.ok(Date.now() - stoppedAt < 500, 'ended at once, not after the run ahead');
  assert.deepEqual(lighthouseLane(), { running: 1, waiting: 0 }, 'left the line; the run ahead keeps going');
  await outside;
  assert.deepEqual(lighthouseLane(), { running: 0, waiting: 0 });
});
