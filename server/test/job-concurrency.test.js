// Jobs side by side (jobs/manager.js + jobs/capacity.js): how many run is decided by the machine (no fixed number), two jobs can
// never be admitted on the same free memory, the line is fair between accounts without starving a large job, jobs of one
// website take turns, exports wait like jobs, reservations are always given back, and the work inside a job sizes itself from its
// own share. No browser: stub runs on a fake machine (`capacity.read`).
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/index.js';
import { capacity } from '../src/jobs/capacity.js';
import { capacityState, exclusive, JobLimitError, JobManager, lockBusy, queueState, TIMING } from '../src/jobs/manager.js';
import { workCpus, workMemoryMB } from '../src/audit/resources.js';
import { seedProject } from './helpers/projects.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLighthouse } from '../src/audit/lighthouse/run.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
};
const ENV = ['SAS_MAX_JOBS', 'SAS_JOBS_PER_USER', 'SAS_JOB_MAX_MINUTES', 'SAS_JOB_MIN_FREE_MB', 'SAS_JOB_CPUS'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const setEnv = (o) => {
  for (const k of ENV) {
    if (o[k] === undefined) delete process.env[k];
    else process.env[k] = String(o[k]);
  }
};
const realRead = capacity.read;
const realTiming = { ...TIMING };
/** A fake machine; `m` can be changed while jobs run (what a fresh reading would say). */
const machine = (m) => {
  capacity.read = () => ({ cpus: m.cpus, totalMB: m.budgetMB + 1024, budgetMB: m.budgetMB, availableMB: m.availableMB, source: 'host' });
  return m;
};

const projectIds = [];
function makeProject(ownerId = null) {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'concurrency', url: 'https://example.com/', stack: 'html', authorized: 1 });
  if (ownerId) db.prepare('UPDATE projects SET owner_id = ? WHERE id = ?').run(ownerId, id);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const ended = (manager, id) =>
  new Promise((resolve) => {
    const now = manager.get(id);
    if (now && now.status !== 'queued' && now.status !== 'running') return resolve(now);
    manager.on(id, (type, snap) => (type === 'done' || type === 'failed') && resolve(snap));
  });

/** A manager whose run waits on a gate per project; records the order of starts and what each job saw as its share. */
function gatedManager(table = 'analyses', { fail = false } = {}) {
  const gates = new Map();
  const started = [];
  const shares = new Map();
  const manager = new JobManager({
    table,
    noun: 'a job',
    steps: [{ key: 'one', label: 'One', weight: 1 }],
    overallPct: () => 0,
    doneMessage: 'done',
    heartbeatMs: 50,
    run: ({ job, signal }) =>
      new Promise((resolve, reject) => {
        started.push(job.projectId);
        shares.set(job.projectId, { memoryMB: workMemoryMB(), cpus: workCpus() });
        gates.set(job.projectId, () => (fail ? reject(new Error('it broke')) : resolve({ ok: true })));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped before it finished.'), { stopped: true })), { once: true });
      }),
  });
  const release = (projectId) => gates.get(projectId)?.();
  // Lets every job finish, including the ones that start only as the earlier ones end (a release before a start does nothing).
  const drain = async (jobs) => {
    const open = () => jobs.filter((j) => ['queued', 'running'].includes(manager.get(j.id)?.status));
    while (open().length) {
      for (const j of open()) release(j.projectId);
      await sleep(5);
    }
  };
  return { manager, started, shares, release, drain };
}
const running = (manager, jobs) => jobs.filter((j) => manager.get(j.id)?.status === 'running').length;
// A job's reservation is given back a moment after its "done" event (when its turn in the line ends): wait for the line to empty.
const settle = () => until(() => !lockBusy() && capacityState().reservedMB === 0);

before(() => {
  const cols = db.prepare('PRAGMA table_info(projects)').all();
  if (!cols.some((c) => c.name === 'owner_id')) db.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT');
});
afterEach(async () => {
  // Every test ends with the line empty and nothing reserved; a test that leaves work behind fails here, not the next one.
  await settle();
  setEnv(saved);
  capacity.read = realRead;
  Object.assign(TIMING, realTiming);
});
after(() => {
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
});

test('no fixed number: with SAS_MAX_JOBS=auto as many jobs run as the machine holds (CPUs, memory budget)', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  for (const [m, expected] of [
    [{ cpus: 4, budgetMB: 30000, availableMB: 30000 }, 2], // 4 threads / 2 per job
    [{ cpus: 12, budgetMB: 14000, availableMB: 14000 }, 6], // 12 / 2
    [{ cpus: 32, budgetMB: 7000, availableMB: 7000 }, 4], // memory: 7000 / 1500 per Analyze
    [{ cpus: 32, budgetMB: 64000, availableMB: 64000 }, 16], // a big machine: only the misread-machine guard is left
  ]) {
    machine(m);
    const { manager, drain } = gatedManager();
    const jobs = Array.from({ length: 18 }, () => manager.start(makeProject()));
    await until(() => running(manager, jobs) === expected);
    await sleep(30);
    assert.equal(running(manager, jobs), expected, `${JSON.stringify(m)} → ${expected} at once`);
    assert.equal(queueState().waiting, jobs.length - expected);
    await drain(jobs);
  }
  // A number set by the admin is a ceiling on top: SAS_MAX_JOBS=1 (production) is one at a time on any machine.
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 32, budgetMB: 64000, availableMB: 64000 });
  const one = gatedManager();
  const jobs = [one.manager.start(makeProject()), one.manager.start(makeProject())];
  await until(() => running(one.manager, jobs) === 1);
  await sleep(30);
  assert.equal(running(one.manager, jobs), 1);
  await one.drain(jobs);
});

test('the memory race: jobs queued in the same moment are never admitted on one free-memory reading', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 2048 });
  TIMING.memoryPollMs = 20;
  // 3500 MB really free: room for one Analyze (1500) above the 2048 gate, not two. The old gate read 3500 three times.
  const m = machine({ cpus: 16, budgetMB: 30000, availableMB: 3500 });
  const { manager, started, release } = gatedManager();
  const [a, b, c] = [makeProject(), makeProject(), makeProject()];
  const ja = manager.start(a);
  const jb = manager.start(b);
  const jc = manager.start(c);
  await until(() => started.length === 1);
  await sleep(80); // several polls of the same reading
  assert.deepEqual(started, [a.id], 'one admitted; the reading has not yet seen it, its reservation is taken off');
  assert.equal(manager.get(jb.id).message, 'Waiting for memory: 2000 MB free, 3548 MB needed to start next to the job running now (1500 MB for this job, 2048 MB kept free). Looked at again in a few seconds.');
  assert.deepEqual(manager.get(jb.id).queue.memory, { freeMB: 2000, neededMB: 3548 });
  assert.equal(capacityState().reservedMB, 1500, 'booked the moment it started');
  // Its browsers are open now: the reading shows the use, and the ramp no longer counts it twice.
  TIMING.rampMs = 0;
  m.availableMB = 2000;
  await sleep(80);
  assert.deepEqual(started, [a.id], 'still no room');
  // It ends: the memory comes back, one more starts, and again only one on that reading.
  TIMING.rampMs = realTiming.rampMs;
  m.availableMB = 3500;
  release(a.id);
  await ended(manager, ja.id);
  await until(() => started.length === 2);
  await sleep(80);
  assert.deepEqual(started, [a.id, b.id]);
  assert.equal(manager.get(jc.id).status, 'queued');
  release(b.id);
  await ended(manager, jb.id);
  await until(() => started.length === 3);
  release(c.id);
  await ended(manager, jc.id);
  await settle();
});

test('next to a running job, the next one needs its own reservation free on top of the minimum; alone, the minimum only', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 2048 });
  TIMING.memoryPollMs = 20;
  // The fixture check of 2026-11-01: ~3956 MB free let two Analyze jobs start (3956 − 1500 = 2456 ≥ 2048), which left 956 MB
  // counted free once both had opened their browsers. 4000 here: the first starts alone (≥ 2048), the second does not.
  const m = machine({ cpus: 16, budgetMB: 30000, availableMB: 4000 });
  const { manager, started, release } = gatedManager();
  const [a, b] = [makeProject(), makeProject()];
  const ja = manager.start(a);
  const jb = manager.start(b);
  await until(() => started.length === 1);
  await sleep(80);
  assert.deepEqual(started, [a.id], 'the old rule would have started both on this reading');
  assert.deepEqual(manager.get(jb.id).queue.memory, { freeMB: 2500, neededMB: 3548 });
  // Enough for the second next to the first: 5600 − 1500 (the first, still ramping) = 4100 ≥ 1500 + 2048.
  m.availableMB = 5600;
  await until(() => started.length === 2);
  assert.deepEqual(started, [a.id, b.id]);
  release(a.id);
  release(b.id);
  await ended(manager, ja.id);
  await ended(manager, jb.id);
  // Alone again: a job needs the minimum only, as before (a small machine still runs one job; SAS_MAX_JOBS=1 is unchanged).
  m.availableMB = 2100;
  const c = makeProject();
  const jc = manager.start(c);
  await until(() => started.length === 3);
  release(c.id);
  await ended(manager, jc.id);
  await settle();
});

test('room: running reservations plus the next one must fit the budget; it waits, says so, and starts when one ends', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 16, budgetMB: 4000, availableMB: 64000 }); // a stale "lots free" reading cannot let the third in
  const { manager, started, release } = gatedManager();
  const jobs = [makeProject(), makeProject(), makeProject()].map((p) => manager.start(p));
  await until(() => started.length === 2);
  await sleep(30);
  assert.equal(started.length, 2);
  assert.equal(manager.get(jobs[2].id).message, 'Waiting for room: the 2 jobs running now use what this server can hold. Starts when one of them finishes.');
  assert.deepEqual(manager.get(jobs[2].id).queue.room, { reservedMB: 3000, neededMB: 1500, budgetMB: 4000, reservedCpus: 4, cpus: 16 });
  release(started[0]);
  await until(() => started.length === 3);
  for (const j of jobs) release(j.projectId);
  await Promise.all(jobs.map((j) => ended(manager, j.id)));
  await settle();
  // A machine too small for even one job by the ledger still runs one at a time (nothing else would ever run).
  machine({ cpus: 1, budgetMB: 500, availableMB: 64000 });
  const tiny = gatedManager();
  const [t1, t2] = [tiny.manager.start(makeProject()), tiny.manager.start(makeProject())];
  await until(() => tiny.started.length === 1);
  await sleep(30);
  assert.equal(tiny.started.length, 1);
  tiny.release(tiny.started[0]);
  await until(() => tiny.started.length === 2);
  tiny.release(tiny.started[1]);
  await Promise.all([ended(tiny.manager, t1.id), ended(tiny.manager, t2.id)]);
});

test('two accounts run side by side; one account still cannot start a second job; the line is fair between accounts', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 1, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 16, budgetMB: 30000, availableMB: 30000 });
  const { manager, started, release } = gatedManager();
  const a = manager.start(makeProject('user-a'));
  const b = manager.start(makeProject('user-b'));
  await until(() => started.length === 2);
  assert.equal(manager.get(a.id).status, 'running');
  assert.equal(manager.get(b.id).status, 'running', 'the second person does not wait behind the first');
  assert.throws(() => manager.start(makeProject('user-a')), JobLimitError, 'the account limit holds whatever the machine allows');
  release(started[0]);
  release(started[1]);
  await Promise.all([ended(manager, a.id), ended(manager, b.id)]);
  await settle();

  // Fairness: room for two. A queues three, then B queues one. When a slot frees, B (none running) goes before A's third.
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 5, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 4, budgetMB: 30000, availableMB: 30000 });
  const fair = gatedManager();
  const [a1, a2, a3] = [makeProject('user-a'), makeProject('user-a'), makeProject('user-a')];
  const b1 = makeProject('user-b');
  const jobs = [a1, a2, a3, b1].map((p) => fair.manager.start(p));
  await until(() => fair.started.length === 2);
  assert.deepEqual(fair.started, [a1.id, a2.id]);
  fair.release(a1.id);
  await until(() => fair.started.length === 3);
  assert.deepEqual(fair.started, [a1.id, a2.id, b1.id], 'B before A\'s third, though A queued first');
  for (const p of [a2, a3, b1]) fair.release(p.id);
  await until(() => fair.started.length === 4);
  fair.release(a3.id);
  await Promise.all(jobs.map((j) => ended(fair.manager, j.id)));
});

test('no starving a large job: when the next one does not fit, a smaller one behind it does not jump ahead', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 16, budgetMB: 3500, availableMB: 30000 });
  const small = gatedManager('analyses');
  const large = gatedManager('recreates');
  const first = small.manager.start(makeProject('x'));
  await until(() => small.started.length === 1);
  const copy = large.manager.start(makeProject('y')); // 2500 + 1500 > 3500: waits for room
  const later = small.manager.start(makeProject('z')); // 1500 + 1500 would fit, but it is behind the copy
  await sleep(60);
  assert.equal(large.manager.get(copy.id).status, 'queued');
  assert.equal(small.manager.get(later.id).status, 'queued', 'did not jump the copy');
  small.release(small.started[0]);
  await until(() => large.started.length === 1);
  assert.equal(small.manager.get(later.id).status, 'queued', 'the copy went first');
  large.release(large.started[0]);
  await until(() => small.started.length === 2);
  small.release(small.started[1]);
  await Promise.all([ended(small.manager, first.id), ended(large.manager, copy.id), ended(small.manager, later.id)]);
});

test('jobs of one website take turns; other websites go meanwhile', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 16, budgetMB: 30000, availableMB: 30000 });
  const analyses = gatedManager('analyses');
  const reaudits = gatedManager('reaudits');
  const site = makeProject('u1');
  const other = makeProject('u2');
  const check = analyses.manager.start(site);
  await until(() => analyses.started.length === 1);
  // The server's own follow-up job on the same website (a re-audit) waits for it; another website does not.
  const follow = reaudits.manager.start(site, {}, { system: true });
  const elsewhere = analyses.manager.start(other);
  await until(() => analyses.started.length === 2);
  assert.equal(reaudits.manager.get(follow.id).status, 'queued');
  assert.equal(reaudits.manager.get(follow.id).message, 'Waiting for the other job on this website to finish.');
  analyses.release(site.id);
  await ended(analyses.manager, check.id);
  await until(() => reaudits.started.length === 1);
  reaudits.release(site.id);
  analyses.release(other.id);
  await Promise.all([ended(reaudits.manager, follow.id), ended(analyses.manager, elsewhere.id)]);
});

test('an export waits like a job (room, memory, its website) and reserves while it runs; plain work only needs a turn', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 2048 });
  TIMING.memoryPollMs = 20;
  const m = machine({ cpus: 16, budgetMB: 30000, availableMB: 1000 });
  const site = makeProject();
  let exported = false;
  let inside = null;
  const done = exclusive(async () => {
    exported = true;
    inside = capacityState().reservedMB;
  }, { kind: 'export', projectId: site.id });
  await sleep(60);
  assert.equal(exported, false, 'held for memory');
  // Plain work (no kind) behind it waits its turn (nothing jumps the line), and is never held for memory itself.
  const order = [];
  const plainDone = exclusive(async () => order.push('plain'));
  await sleep(40);
  assert.deepEqual(order, []);
  m.availableMB = 8000;
  await done;
  await plainDone;
  assert.equal(exported, true);
  assert.deepEqual(order, ['plain']);
  assert.equal(inside, 800, 'an export is counted with SAS_JOB_MB_EXPORT while it runs');
  await settle();
  // Plain work alone, with no memory at all: it only needs a turn.
  m.availableMB = 0;
  await exclusive(async () => order.push('plain again'));
  assert.deepEqual(order, ['plain', 'plain again']);
  await settle();
});

test('a reservation is always given back: done, failed, stopped, and a run abandoned at the hard limit', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 16, budgetMB: 30000, availableMB: 30000 });
  const ok = gatedManager();
  const broken = gatedManager('analyses', { fail: true });
  const j1 = ok.manager.start(makeProject());
  const j2 = broken.manager.start(makeProject());
  const j3 = ok.manager.start(makeProject());
  await until(() => ok.started.length === 2 && broken.started.length === 1);
  assert.equal(capacityState().reservedMB, 4500);
  ok.release(ok.started[0]);
  broken.release(broken.started[0]);
  ok.manager.stop(j3.projectId);
  assert.equal((await ended(ok.manager, j1.id)).status, 'done');
  assert.equal((await ended(broken.manager, j2.id)).status, 'failed');
  assert.equal((await ended(ok.manager, j3.id)).status, 'failed');
  await until(() => capacityState().reservedMB === 0);

  // A run that ignores its stop: the slot and its reservation move on after the grace period.
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0, SAS_JOB_MAX_MINUTES: 0.002 });
  TIMING.hardStopGraceMs = 40;
  const stubborn = new JobManager({
    table: 'analyses', noun: 'a job', steps: [{ key: 'one', label: 'One', weight: 1 }], overallPct: () => 0, doneMessage: 'done', heartbeatMs: 50,
    run: () => new Promise(() => {}), // never ends, never listens
  });
  const hung = stubborn.start(makeProject());
  assert.equal((await ended(stubborn, hung.id)).status, 'failed');
  await until(() => capacityState().reservedMB === 0);
});

test('inside a job, work sizes itself from that job\'s share: its own reservation, minus what others just started will take', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 12, budgetMB: 30000, availableMB: 10000 });
  const analyses = gatedManager('analyses');
  const copies = gatedManager('recreates');
  const p1 = makeProject();
  const p2 = makeProject();
  const j1 = analyses.manager.start(p1);
  await until(() => analyses.started.length === 1);
  assert.deepEqual(analyses.shares.get(p1.id), { memoryMB: 1500, cpus: 12 }, 'alone: its reservation and every thread');
  const j2 = copies.manager.start(p2);
  await until(() => copies.started.length === 1);
  // 10000 available − the Analyze that just started (1500) = 8500, capped at the copy's own 2500; 12 threads / 2 jobs.
  assert.deepEqual(copies.shares.get(p2.id), { memoryMB: 2500, cpus: 6 });
  // Outside any job nothing changes: the whole machine, as before.
  assert.notEqual(workMemoryMB(), 1500);
  analyses.release(p1.id);
  copies.release(p2.id);
  await Promise.all([ended(analyses.manager, j1.id), ended(copies.manager, j2.id)]);
});

test('a Lighthouse run records what else the line ran when it got its turn: other jobs, their kinds, the memory', async () => {
  setEnv({ SAS_MAX_JOBS: 'auto', SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  machine({ cpus: 12, budgetMB: 30000, availableMB: 10000 });
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lighthouse-stub-worker.js');
  const results = new Map();
  const measuring = new JobManager({
    table: 'analyses', noun: 'a job', steps: [{ key: 'one', label: 'One', weight: 1 }], overallPct: () => 0, doneMessage: 'done', heartbeatMs: 50,
    run: async ({ job }) => {
      results.set(job.projectId, await runLighthouse('stub://run?ms=50', 'mobile', { worker }));
      return { ok: true };
    },
  });
  // Alone: nothing else runs.
  const p0 = makeProject();
  await ended(measuring, measuring.start(p0).id);
  assert.deepEqual(results.get(p0.id).contention, { otherJobs: 0, otherKinds: [], availableMB: 10000 });
  await settle();
  // Beside a copy that is running: counted, by kind; its own job is never counted.
  const copies = gatedManager('recreates');
  const pc = makeProject();
  const jc = copies.manager.start(pc);
  await until(() => copies.started.length === 1);
  const p1 = makeProject();
  await ended(measuring, measuring.start(p1).id);
  assert.deepEqual(results.get(p1.id).contention, { otherJobs: 1, otherKinds: ['recreate'], availableMB: 10000 });
  copies.release(pc.id);
  await ended(copies.manager, jc.id);
});
