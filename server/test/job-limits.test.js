// Job limits (jobs/limits.js, jobs/manager.js): how many jobs run at once, one line for every kind told in plain words, one
// account's cap, the memory gate before a start, the hard time limit, and queued jobs of a dead server put back in line in
// order by the next server. No browser: the managers under test run stub functions.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/index.js';
import { describeLimits, jobMaxMs, jobsPerUser, maxJobs, memory, minFreeMB } from '../src/jobs/limits.js';
import { activeJobsOfUser, JobLimitError, JobManager, lockBusy, queueState, requeueJobs, TIMING } from '../src/jobs/manager.js';
import { adoptStaleJobs, ownJobs, STALE_MS } from '../src/jobs/liveness.js';
import { recoverStaleJobs } from '../src/recreate/jobs.js';
import { seedProject } from './helpers/projects.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
};
const ENV = ['SAS_MAX_JOBS', 'SAS_JOBS_PER_USER', 'SAS_JOB_MAX_MINUTES', 'SAS_JOB_MIN_FREE_MB'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const setEnv = (o) => {
  for (const k of ENV) {
    if (o[k] === undefined) delete process.env[k];
    else process.env[k] = String(o[k]);
  }
};
const realFree = memory.free;
const realTiming = { ...TIMING };

const projectIds = [];
function makeProject(ownerId = null) {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'limits', url: 'https://example.com/', stack: 'html', authorized: 1 });
  if (ownerId) db.prepare('UPDATE projects SET owner_id = ? WHERE id = ?').run(ownerId, id);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const rowOf = (table, id) => db.prepare(`SELECT status, error, heartbeat_at, payload_json FROM ${table} WHERE id = ?`).get(id);
const ended = (manager, id) =>
  new Promise((resolve) => {
    const now = manager.get(id);
    if (now && now.status !== 'queued' && now.status !== 'running') return resolve(now);
    manager.on(id, (type, snap) => (type === 'done' || type === 'failed') && resolve(snap));
  });

/** A manager whose run waits on a gate per project (release(projectId) lets it finish) and records the order jobs started. */
function gatedManager(table = 'analyses', { honourStop = true, heartbeatMs = 50 } = {}) {
  const gates = new Map();
  const started = [];
  const manager = new JobManager({
    table,
    noun: 'an analysis',
    steps: [{ key: 'one', label: 'One', weight: 1 }],
    overallPct: () => 0,
    doneMessage: 'done',
    heartbeatMs,
    run: ({ job, progress, signal }) =>
      new Promise((resolve, reject) => {
        started.push(job.projectId);
        progress('one', 0.5, 'half way');
        gates.set(job.projectId, () => resolve({ ok: true }));
        if (honourStop) signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped before it finished.'), { stopped: true })), { once: true });
      }),
  });
  return { manager, started, release: (projectId) => gates.get(projectId)?.() };
}

before(() => {
  // The owner_id column exists only with the accounts migration; the per-account tests need it.
  const cols = db.prepare('PRAGMA table_info(projects)').all();
  if (!cols.some((c) => c.name === 'owner_id')) db.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT');
});
afterEach(() => {
  setEnv(saved);
  memory.free = realFree;
  Object.assign(TIMING, realTiming);
});
after(() => {
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
});

test('the settings: defaults, bounds, and what the health line reports', () => {
  setEnv({});
  assert.equal(maxJobs(), 1);
  assert.equal(jobsPerUser(), 1);
  assert.equal(jobMaxMs(), 240 * 60000);
  assert.equal(minFreeMB(), 2048);
  assert.equal(maxJobs({ SAS_MAX_JOBS: '3' }), 3);
  assert.equal(maxJobs({ SAS_MAX_JOBS: '0' }), 1, 'out of range = default');
  assert.equal(maxJobs({ SAS_MAX_JOBS: '9' }), 1);
  assert.equal(maxJobs({ SAS_MAX_JOBS: '2.5' }), 1, 'a whole number');
  assert.equal(jobsPerUser({ SAS_JOBS_PER_USER: '20' }), 20);
  assert.equal(jobMaxMs({ SAS_JOB_MAX_MINUTES: '0' }), 0, '0 = no hard limit');
  assert.equal(jobMaxMs({ SAS_JOB_MAX_MINUTES: '0.5' }), 30000, 'fractions of a minute are allowed');
  assert.equal(jobMaxMs({ SAS_JOB_MAX_MINUTES: '2000' }), 240 * 60000);
  assert.equal(minFreeMB({ SAS_JOB_MIN_FREE_MB: '0' }), 0, '0 = no memory check');
  assert.equal(minFreeMB({ SAS_JOB_MIN_FREE_MB: 'lots' }), 2048);
  assert.deepEqual(describeLimits({ SAS_JOB_MAX_MINUTES: '0', SAS_JOB_MIN_FREE_MB: '0', SAS_MAX_JOBS: '2', SAS_JOBS_PER_USER: '3' }), { maxJobs: 2, jobsPerUser: 3, jobMaxMinutes: null, minFreeMB: null });
});

test('one line for every job: SAS_MAX_JOBS run at once, the rest wait in order and are told their place', async () => {
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  const { manager, started, release } = gatedManager();
  const [a, b, c] = [makeProject(), makeProject(), makeProject()];
  const ja = manager.start(a);
  const jb = manager.start(b);
  const jc = manager.start(c);
  await until(() => manager.get(ja.id).status === 'running');
  assert.deepEqual(started, [a.id], 'only one runs');
  assert.equal(manager.get(jb.id).status, 'queued');
  assert.equal(manager.get(jb.id).message, 'Next in line: starts when the job before it finishes.');
  assert.deepEqual(manager.get(jb.id).queue, { ahead: 1, position: 1 });
  assert.equal(manager.get(jc.id).message, 'Waiting in line: 2 jobs run or wait before this one.');
  assert.deepEqual(manager.get(jc.id).queue, { ahead: 2, position: 2 });
  assert.equal(manager.get(ja.id).queue, undefined, 'a running job has no place in line');
  assert.deepEqual(queueState(), { running: 1, waiting: 2, max: 1 });
  assert.ok(lockBusy());
  for (const id of [ja.id, jb.id, jc.id]) assert.ok(rowOf('analyses', id).heartbeat_at, 'queued jobs have a heartbeat too');

  // The place is pushed to subscribers when it changes.
  const seen = [];
  manager.on(jc.id, (type, snap) => seen.push(`${type}:${snap.message}`));
  release(a.id);
  await ended(manager, ja.id);
  await until(() => manager.get(jb.id).status === 'running');
  assert.deepEqual(started, [a.id, b.id], 'first come, first served');
  assert.equal(manager.get(jc.id).message, 'Next in line: starts when the job before it finishes.');
  assert.ok(seen.includes('progress:Next in line: starts when the job before it finishes.'), seen.join(' | '));
  release(b.id);
  await ended(manager, jb.id);
  await until(() => manager.get(jc.id).status === 'running');
  assert.equal(manager.get(jc.id).queue, undefined);
  release(c.id);
  await ended(manager, jc.id);
  assert.deepEqual(started, [a.id, b.id, c.id]);
  await until(() => !lockBusy());
  assert.equal(queueState().running + queueState().waiting, 0);

  // With two slots, two run side by side and the third waits behind both.
  setEnv({ SAS_MAX_JOBS: 2, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  const two = gatedManager();
  const [d, e, f] = [makeProject(), makeProject(), makeProject()];
  const [jd, je, jf] = [two.manager.start(d), two.manager.start(e), two.manager.start(f)];
  await until(() => two.started.length === 2);
  assert.deepEqual(two.started, [d.id, e.id]);
  assert.equal(two.manager.get(jf.id).message, 'Waiting in line: 2 jobs run or wait before this one.');
  two.release(d.id);
  two.release(e.id);
  await Promise.all([ended(two.manager, jd.id), ended(two.manager, je.id)]);
  await until(() => two.started.length === 3);
  two.release(f.id);
  await ended(two.manager, jf.id);
});

test('one account has at most SAS_JOBS_PER_USER jobs running or waiting; the server\'s own follow-up jobs are not counted', async () => {
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 1, SAS_JOB_MIN_FREE_MB: 0 });
  const { manager, release } = gatedManager();
  const p1 = makeProject('user-1');
  const p2 = makeProject('user-1');
  const p3 = makeProject('user-2');
  const first = manager.start(p1);
  await until(() => manager.get(first.id).status === 'running');
  assert.throws(() => manager.start(p2), (err) => {
    assert.ok(err instanceof JobLimitError);
    assert.match(err.message, /already have a job running or waiting/);
    assert.match(err.message, /one job per account at a time/);
    assert.equal(err.job.id, first.id, 'names the job that is in the way');
    assert.equal(err.job.kind, 'analyses');
    return true;
  });
  assert.equal(activeJobsOfUser('user-1').length, 1, 'no second job was made');
  const other = manager.start(p3);
  assert.equal(manager.get(other.id).status, 'queued', 'another account is not held back by the first');
  // A job the server starts for itself (a resume, the re-audit after a copy) is not the account's own.
  const p4 = makeProject('user-1');
  const system = manager.start(p4, {}, { system: true });
  assert.equal(manager.get(system.id).status, 'queued');
  assert.equal(activeJobsOfUser('user-1').length, 2);
  assert.throws(() => manager.start(makeProject('user-1')), JobLimitError, 'the person\'s own job still counts');
  release(p1.id);
  await ended(manager, first.id);
  // The person's job is done; the system job alone does not block a new one of theirs.
  const again = manager.start(makeProject('user-1'));
  assert.equal(manager.get(again.id).status, 'queued');
  await until(() => manager.get(other.id).status === 'running');
  release(p3.id);
  await ended(manager, other.id);
  await until(() => manager.get(system.id).status === 'running');
  release(p4.id);
  await ended(manager, system.id);
  await until(() => manager.get(again.id).status === 'running');
  release(again.projectId);
  await ended(manager, again.id);
  // Accounts off: every job belongs to the one local user (owner null), so the same cap applies to them.
  const local = manager.start(makeProject());
  assert.throws(() => manager.start(makeProject()), JobLimitError);
  await until(() => manager.get(local.id).status === 'running');
  release(local.projectId);
  await ended(manager, local.id);
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 2, SAS_JOB_MIN_FREE_MB: 0 });
  const l1 = manager.start(makeProject());
  const l2 = manager.start(makeProject());
  assert.throws(() => manager.start(makeProject()), JobLimitError, 'two allowed, the third refused');
  await until(() => manager.get(l1.id).status === 'running');
  release(l1.projectId);
  await ended(manager, l1.id);
  await until(() => manager.get(l2.id).status === 'running');
  release(l2.projectId);
  await ended(manager, l2.id);
});

test('a job starts only when enough memory is free; it waits in line and says why, and gives up after the hard limit', async () => {
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 1000 });
  TIMING.memoryPollMs = 20;
  memory.free = () => 500;
  const { manager, started, release } = gatedManager();
  const p = makeProject();
  const job = manager.start(p);
  await sleep(80);
  assert.equal(manager.get(job.id).status, 'queued', 'held back');
  assert.deepEqual(started, []);
  assert.equal(manager.get(job.id).message, 'Waiting for memory: 500 MB free, 1000 MB needed before a job may start. Looked at again in a few seconds.');
  assert.deepEqual(manager.get(job.id).queue, { ahead: 0, position: 1, memory: { freeMB: 500, neededMB: 1000 } });
  assert.equal(queueState().freeMB, 500);
  assert.ok(rowOf('analyses', job.id).heartbeat_at, 'alive while it waits');
  memory.free = () => 4000;
  await until(() => manager.get(job.id).status === 'running');
  release(p.id);
  await ended(manager, job.id);
  assert.equal(rowOf('analyses', job.id).status, 'done');

  // Memory that never comes back: the job leaves the line after the hard limit with the reason, and the next one is looked at.
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 1000, SAS_JOB_MAX_MINUTES: 0.002 });
  memory.free = () => 100;
  const starved = manager.start(makeProject());
  const snap = await ended(manager, starved.id);
  assert.equal(snap.status, 'failed');
  assert.match(snap.error, /Not started: the server had less than 1000 MB of memory free for \d+ seconds \(100 MB free now; SAS_JOB_MIN_FREE_MB\)/);
  assert.equal(rowOf('analyses', starved.id).status, 'failed');
  assert.ok(!ownJobs.has(starved.id));
  assert.equal(queueState().waiting, 0);

  // No check configured: starts whatever the reading says.
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  const free = manager.start(makeProject());
  await until(() => manager.get(free.id).status === 'running');
  release(free.projectId);
  await ended(manager, free.id);
});

test('the hard time limit stops a running job; one that does not end by itself loses its slot after the grace period', async () => {
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0, SAS_JOB_MAX_MINUTES: 0.003 }); // 180 ms
  const polite = gatedManager('analyses', { honourStop: true });
  const p = makeProject();
  const job = polite.manager.start(p);
  const messages = [];
  polite.manager.on(job.id, (_type, snap) => messages.push(snap.message));
  const snap = await ended(polite.manager, job.id);
  assert.equal(snap.status, 'failed');
  assert.equal(snap.error, 'Stopped after 0 seconds: the time limit for one job (SAS_JOB_MAX_MINUTES). What was finished is kept.');
  assert.ok(messages.includes('Stopping: the time limit for one job (0 seconds) was reached.'), messages.join(' | '));
  assert.equal(rowOf('analyses', job.id).error, snap.error);
  assert.ok(!ownJobs.has(job.id), 'the heartbeat stopped');

  // A run that ignores the stop: after the grace period the row is closed with the same reason and the next job starts.
  TIMING.hardStopGraceMs = 60;
  const stubborn = gatedManager('analyses', { honourStop: false });
  const q1 = makeProject();
  const q2 = makeProject();
  const j1 = stubborn.manager.start(q1);
  const j2 = stubborn.manager.start(q2);
  const end1 = await ended(stubborn.manager, j1.id);
  assert.equal(end1.status, 'failed');
  assert.match(end1.error, /^Stopped after 0 seconds: the time limit for one job/);
  await until(() => stubborn.manager.get(j2.id).status === 'running');
  assert.deepEqual(stubborn.started, [q1.id, q2.id], 'the slot moved on while the first run was still pending');
  // The first run ends much later: logged, the row untouched.
  stubborn.release(q1.id);
  await sleep(30);
  assert.equal(rowOf('analyses', j1.id).status, 'failed');
  // The second job, left alone, hits the same limit and is closed after the grace period too.
  const end2 = await ended(stubborn.manager, j2.id);
  assert.equal(end2.status, 'failed', 'the second job hit the (tiny) limit too');
  stubborn.release(q2.id);

  // 0 = no limit: a job runs as long as it needs.
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0, SAS_JOB_MAX_MINUTES: 0 });
  const free = gatedManager();
  const r = makeProject();
  const jr = free.manager.start(r);
  await until(() => free.manager.get(jr.id).status === 'running');
  await sleep(250);
  assert.equal(free.manager.get(jr.id).status, 'running');
  free.release(r.id);
  assert.equal((await ended(free.manager, jr.id)).status, 'done');
});

test('a restart puts the dead server\'s queued jobs back in line, in order, same rows, and nothing starts twice', async () => {
  setEnv({ SAS_MAX_JOBS: 1, SAS_JOBS_PER_USER: 20, SAS_JOB_MIN_FREE_MB: 0 });
  const { manager, started, release } = gatedManager();
  const now = Date.now();
  const stale = new Date(now - STALE_MS - 5000).toISOString();
  const insert = db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, heartbeat_at, payload_json) VALUES (?, ?, ?, 0, ?, ?, ?)`);
  const [p1, p2, p3, p4] = [makeProject(), makeProject(), makeProject(), makeProject()];
  const second = randomUUID();
  const first = randomUUID();
  const noPayload = randomUUID();
  const wasRunning = randomUUID();
  const payload = JSON.stringify({ payload: { maxPages: 3 }, warnings: ['kept'], system: false });
  insert.run(second, p2.id, 'queued', new Date(now - 60000).toISOString(), stale, payload);
  insert.run(first, p1.id, 'queued', new Date(now - 120000).toISOString(), stale, payload);
  insert.run(noPayload, p3.id, 'queued', new Date(now - 30000).toISOString(), stale, null);
  insert.run(wasRunning, p4.id, 'running', new Date(now - 300000).toISOString(), stale, payload);

  const result = await recoverStaleJobs({ now });
  assert.deepEqual(result.requeued.map((j) => j.id), [first, second], 'oldest first, the same ids');
  assert.deepEqual(result.marked.map((j) => j.id).sort(), [noPayload, wasRunning].sort(), 'a running row and a payload-less queued row are failed');
  assert.equal(rowOf('analyses', wasRunning).status, 'failed');
  assert.equal(rowOf('analyses', noPayload).status, 'failed');
  // The first may already run (one slot); the second is still in line. Both are the same rows, now this process's.
  assert.ok(['queued', 'running'].includes(rowOf('analyses', first).status));
  assert.equal(rowOf('analyses', second).status, 'queued', 'still the same queued row');
  for (const id of [first, second]) {
    assert.ok(Date.parse(rowOf('analyses', id).heartbeat_at) > now - 1000, 'claimed: its heartbeat is ours now');
    assert.ok(ownJobs.has(id));
  }
  assert.deepEqual(manager.get(first).warnings, ['kept'], 'the job keeps what it was started with');
  await until(() => started.length === 1);
  assert.deepEqual(started, [p1.id]);
  assert.equal(manager.get(second).message, 'Next in line: starts when the job before it finishes.');

  // A second recovery pass (the watch) sees them as this process's own: nothing starts twice.
  const again = await recoverStaleJobs({ now: now + STALE_MS * 3 });
  assert.equal(again.requeued.length, 0);
  assert.equal(again.marked.length, 0);
  assert.equal(started.length, 1);

  // One manager cannot claim a row another server took meanwhile (the heartbeat moved): the claim fails.
  const taken = randomUUID();
  insert.run(taken, makeProject().id, 'queued', new Date(now - 10000).toISOString(), stale, payload);
  db.prepare('UPDATE analyses SET heartbeat_at = ? WHERE id = ?').run(new Date(now).toISOString(), taken);
  const { requeued, left } = requeueJobs([{ table: 'analyses', id: taken, project_id: manager.get(first).projectId, started_at: 'x', heartbeat_at: stale, payload_json: payload }]);
  assert.equal(requeued.length, 0);
  assert.equal(left.length, 1);
  db.prepare("UPDATE analyses SET status = 'failed' WHERE id = ?").run(taken);

  release(p1.id);
  await ended(manager, first);
  await until(() => started.length === 2);
  release(p2.id);
  await ended(manager, second);
  assert.equal(rowOf('analyses', first).status, 'done');
  assert.equal(rowOf('analyses', second).status, 'done');
  assert.equal(adoptStaleJobs({ now: now + STALE_MS * 3 }).requeue.length, 0);
});
