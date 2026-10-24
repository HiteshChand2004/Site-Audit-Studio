// One server per data folder, and jobs judged alive by their heartbeat (config/dataLock.js, jobs/liveness.js):
//   - a second process pointed at the same data folder refuses to start and says who holds it; a lock a crashed process left
//     behind is taken over; a lock from another host is held while fresh and taken over when stale;
//   - at startup only a job whose heartbeat stopped is marked failed and (a recreate) continued; a job alive in another
//     process is never marked, and its workspace is never adopted or renamed;
//   - a script that only imports the database module from another process touches no job row and takes no lock.
// Two real servers are started on one scratch data folder (no browser is launched by starting the server).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from '../src/db/index.js';
import { acquireDataLock, INSTANCE_ID, lockAge, lockFile, lockHeld, LOCK_STALE_MS, readLock } from '../src/config/dataLock.js';
import { adoptStaleJobs, heartbeat, HEARTBEAT_MS, isStale, openJobs, ownJobs, STALE_MS, STOPPED_MESSAGE } from '../src/jobs/liveness.js';
import { JobManager } from '../src/jobs/manager.js';
import * as recreateModule from '../src/recreate/jobs.js';
const { recoverStaleJobs } = recreateModule;
import { tmpDir } from '../src/recreate/workspace.js';
import { seedProject } from './helpers/projects.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.SAS_DATA_DIR;
const scratch = (name) => path.join(DATA_DIR, 'lock-tests', name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
// Children get a clean job environment: never production, never accounts, never the keep-awake or the DNS watcher.
const childEnv = (extra) => {
  const env = { ...process.env, SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0', ...extra };
  delete env.NODE_ENV;
  delete env.SAS_ACCOUNTS;
  delete env.NODE_TEST_CONTEXT;
  return env;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Runs a child until it prints `ready` (resolve) or exits (resolve with the exit code and its output). */
function startChild(args, { env, ready, cwd = serverDir, timeoutMs = 60000 }) {
  const child = spawn(NODE[0], [NODE[1], ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const started = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ child, timedOut: true, out, err }), timeoutMs);
    const check = () => {
      if (ready && out.includes(ready)) {
        clearTimeout(timer);
        resolve({ child, ready: true, out, err });
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ child, code, out, err });
    });
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, started, exited, output: () => ({ out, err }) };
}

/** Kills a child the way a crash would: no signal handler runs, no cleanup (TerminateProcess on Windows, SIGKILL elsewhere). */
async function crash(c) {
  c.child.kill('SIGKILL');
  await c.exited;
}

const projectIds = [];
function makeProject() {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'lock', url: 'https://example.com/', stack: 'html', authorized: 1 });
  return id;
}
const insertRecreate = db.prepare(
  `INSERT INTO recreates (id, project_id, status, progress, started_at, heartbeat_at) VALUES (?, ?, ?, 0, ?, ?)`,
);
const rowOf = (id) => db.prepare('SELECT status, error, heartbeat_at FROM recreates WHERE id = ?').get(id);

before(async () => {
  await mkdir(scratch(''), { recursive: true });
});
after(async () => {
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
});

// ---------------------------------------------------------------------------------------------------------------------- lock

test('the lock is taken, refused while its process lives, and recovered when that process is gone', async () => {
  const dir = scratch('held');
  // A separate process takes the lock and keeps it (as a server would).
  const holder = startChild(
    ['-e', `import('${pathToFileURL(path.join(serverDir, 'src/config/dataLock.js')).href}').then((m) => { const l = m.acquireDataLock({ dir: process.argv[1] }); console.log(l.ok ? 'held ' + process.pid : 'refused'); setInterval(() => {}, 1000); })`, dir],
    { env: childEnv(), ready: 'held' },
  );
  const first = await holder.started;
  assert.ok(first.ready, `the holder did not start: ${first.out} ${first.err}`);
  const info = readLock(lockFile(dir));
  assert.equal(info.pid, holder.child.pid, 'the lock names the holder');
  assert.equal(info.host, os.hostname());

  const refused = acquireDataLock({ dir });
  assert.equal(refused.ok, false, 'a second process is refused while the first lives');
  assert.match(refused.message, /already using the data folder/);
  assert.ok(refused.message.includes(String(holder.child.pid)), 'the message names the process');
  assert.ok(refused.message.includes(lockFile(dir)), 'the message says what to delete if no server runs');
  assert.ok(existsSync(lockFile(dir)), 'a refusal never removes the holder\'s lock');

  await crash(holder);
  assert.ok(existsSync(lockFile(dir)), 'a crashed process leaves its lock behind');
  const taken = acquireDataLock({ dir });
  assert.equal(taken.ok, true, 'the lock of a process that is gone is taken over');
  assert.equal(readLock(lockFile(dir)).pid, process.pid);
  taken.release();
  assert.ok(!existsSync(lockFile(dir)), 'release removes our own lock');
});

test('a lock from another host is held while fresh and taken over once stale; garbage is taken over', async () => {
  const dir = scratch('foreign');
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  const now = Date.now();
  const foreign = { pid: 4242, host: 'another-machine', startedAt: new Date(now - 60000).toISOString(), port: 4000 };
  writeFileSync(file, JSON.stringify(foreign));
  assert.equal(lockHeld(foreign, file, { now }), true);
  const refused = acquireDataLock({ dir, now });
  assert.equal(refused.ok, false, 'fresh: held by a server on another host');
  assert.match(refused.message, /another-machine/);

  const old = new Date(now - LOCK_STALE_MS - 1000);
  utimesSync(file, old, old);
  assert.equal(lockHeld(foreign, file, { now }), false);
  const taken = acquireDataLock({ dir, now });
  assert.equal(taken.ok, true, 'stale: a dead server\'s lock on a shared disk is taken over');
  taken.release();

  writeFileSync(file, 'not a lock');
  const again = acquireDataLock({ dir, now });
  assert.equal(again.ok, true, 'an unreadable lock file is nobody\'s');
  assert.equal(readLock(file).pid, process.pid);
  // release leaves a lock that is no longer ours alone.
  writeFileSync(file, JSON.stringify({ ...foreign, startedAt: new Date().toISOString() }));
  again.release();
  assert.equal(readLock(file).pid, 4242, 'release never removes another process\'s lock');
  await rm(file, { force: true });
});

test('a lock naming our own pid cannot be ours and is taken over at once (a restarted container gets its pid again)', () => {
  const dir = scratch('own-pid');
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  const now = Date.now();
  // Same host, our pid, touched a moment ago: the pid-alive test would say "held" (we are alive), the rule says it is not ours.
  writeFileSync(file, JSON.stringify({ instance: 'gone-' + randomUUID(), pid: process.pid, host: os.hostname(), startedAt: new Date(now - 5000).toISOString() }));
  assert.equal(lockHeld(readLock(file), file, { now }), false);
  const taken = acquireDataLock({ dir, now });
  assert.equal(taken.ok, true, 'taken over without waiting');
  assert.equal(readLock(file).instance, INSTANCE_ID, 'the new lock carries this process\'s instance id');
  assert.equal(readLock(file).pid, process.pid);
  taken.release();

  // Another hostname (a replaced container), our pid, fresh: still ours by pid, so not a live process; taken over at once too.
  writeFileSync(file, JSON.stringify({ instance: 'gone-' + randomUUID(), pid: process.pid, host: 'container-old', startedAt: new Date(now - 5000).toISOString() }));
  assert.equal(lockHeld(readLock(file), file, { now }), false);
  const again = acquireDataLock({ dir, now });
  assert.equal(again.ok, true);
  again.release();
  assert.ok(!existsSync(file));
});

test('the instance id, not the pid, says whether the lock is ours when it is touched or released', async () => {
  const dir = scratch('instance');
  const file = lockFile(dir);
  const held = acquireDataLock({ dir });
  assert.equal(held.ok, true);
  assert.equal(readLock(file).instance, INSTANCE_ID);
  assert.equal(held.refresh(), true, 'our own lock is touched');

  // Someone deleted our lock and another server took the folder: same pid and host are possible (a container's pid 1), only
  // the instance id tells them apart.
  const other = { instance: 'other-' + randomUUID(), pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(other));
  const before = new Date(Date.now() - 600000);
  utimesSync(file, before, before);
  assert.equal(held.refresh(), false, 'a lock another instance holds is not touched');
  assert.equal(Math.round(lockAge(file, Date.now()) / 1000), 600, 'its time stamp is untouched');
  assert.equal(held.release(), false, 'and not removed');
  assert.equal(readLock(file).instance, other.instance);

  // Our lock gone with nothing in its place: refresh writes it again.
  await rm(file, { force: true });
  assert.equal(held.refresh(), true);
  assert.equal(readLock(file).instance, INSTANCE_ID);
  assert.equal(held.release(), true);
  assert.ok(!existsSync(file));
});

test('a replaced container: the old host\'s fresh lock blocks at most LOCK_STALE_MS, and the message says so', () => {
  const dir = scratch('container');
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  const now = Date.now();
  // The predecessor had another hostname and another pid (so neither rule above applies) and touched its lock 100 s ago.
  const old = { instance: 'old-' + randomUUID(), pid: process.pid + 1, host: 'container-old', startedAt: new Date(now - 3600000).toISOString(), port: 4000 };
  writeFileSync(file, JSON.stringify(old));
  const touched = new Date(now - 100000);
  utimesSync(file, touched, touched);
  const refused = acquireDataLock({ dir, now, hostname: 'container-new' });
  assert.equal(refused.ok, false, 'fresh: it may still run on the other host');
  assert.match(refused.message, /cannot be checked here/);
  assert.match(refused.message, /a container that was replaced/);
  assert.match(refused.message, /expires 20 s from now \(120 s after it was last touched\)/);
  assert.ok(refused.message.includes(file), 'and names the file to delete to start now');

  // 20 s later the lock has gone untouched for LOCK_STALE_MS: the restarted container gets through.
  const taken = acquireDataLock({ dir, now: now + 20000, hostname: 'container-new' });
  assert.equal(taken.ok, true);
  assert.equal(readLock(file).host, 'container-new');
  taken.release();
  assert.ok(LOCK_STALE_MS <= 120000, 'the wait a restart policy has to cover');
});

test('two servers on one data folder: the second refuses to start, a crashed first is recovered from', { timeout: 180000 }, async () => {
  const dir = scratch('servers');
  const [portA, portB, portC] = [await freePort(), await freePort(), await freePort()];
  const env = (port) => childEnv({ SAS_DATA_DIR: dir, PORT: String(port) });

  const a = startChild(['src/index.js'], { env: env(portA), ready: 'API ready' });
  const startedA = await a.started;
  assert.ok(startedA.ready, `server A did not start: ${startedA.out}\n${startedA.err}`);
  const lock = readLock(lockFile(dir));
  assert.equal(lock?.pid, a.child.pid, 'the running server holds the lock');
  assert.equal(lock?.port, portA);

  const b = startChild(['src/index.js'], { env: env(portB), ready: 'API ready' });
  const endedB = await b.started;
  assert.equal(endedB.ready, undefined, 'server B must not come up');
  assert.equal(endedB.code, 1, `server B must exit with 1: ${endedB.out}\n${endedB.err}`);
  assert.match(endedB.err, /Not starting: Another server is already using the data folder/);
  assert.ok(endedB.err.includes(String(a.child.pid)), 'B names A');
  assert.ok((await fetch(`http://127.0.0.1:${portA}/api/health`).then((r) => r.json())).ok, 'A still answers');
  assert.equal(readLock(lockFile(dir))?.pid, a.child.pid, 'B left A\'s lock alone');

  await crash(a);
  assert.ok(existsSync(lockFile(dir)), 'the crash left the lock behind');
  const c = startChild(['src/index.js'], { env: env(portC), ready: 'API ready' });
  const startedC = await c.started;
  assert.ok(startedC.ready, `server C did not start after the crash: ${startedC.out}\n${startedC.err}`);
  assert.equal(readLock(lockFile(dir))?.pid, c.child.pid, 'C took the dead server\'s lock over');
  await crash(c);
});

// ------------------------------------------------------------------------------------------------------------------- liveness

test('a job writes its heartbeat while queued and running, and a live heartbeat is never stale', async () => {
  const projectId = makeProject();
  let finish;
  const gate = new Promise((r) => (finish = r));
  const manager = new JobManager({
    table: 'recreates',
    noun: 'a recreate',
    steps: [{ key: 'one', label: 'One', weight: 1 }],
    overallPct: () => 0,
    doneMessage: 'done',
    heartbeatMs: 40,
    run: async () => {
      await gate;
      return { ok: true };
    },
  });
  const job = manager.start({ id: projectId, owner_id: null });
  const first = rowOf(job.id);
  assert.ok(first.heartbeat_at, 'the row has a heartbeat from the start');
  assert.ok(ownJobs.has(job.id), 'the job is registered as this process\'s');
  await sleep(150);
  const later = rowOf(job.id);
  assert.ok(Date.parse(later.heartbeat_at) > Date.parse(first.heartbeat_at), 'the heartbeat moves on while the job runs');
  assert.equal(isStale(later.heartbeat_at, Date.now()), false);
  assert.equal(isStale(later.heartbeat_at, Date.now() + STALE_MS + 1), true, 'and would be stale STALE_MS later');
  assert.equal(isStale(null, Date.now()), true, 'a row with no heartbeat (an older server wrote it) is stale');

  // Seen from another process (own = none of ours): alive, not stale, left alone.
  const view = openJobs({ own: new Set() });
  assert.ok(view.alive.some((j) => j.id === job.id), 'another process sees it alive');
  assert.ok(!view.stale.some((j) => j.id === job.id));
  const result = adoptStaleJobs({ own: new Set() });
  assert.ok(!result.marked.some((j) => j.id === job.id), 'a live job is never marked failed from outside');
  assert.ok(['queued', 'running'].includes(rowOf(job.id).status), 'still open (the row says running only once the job reports progress)');
  // Our own job is never judged by its heartbeat, however far the clock is moved.
  assert.equal(adoptStaleJobs({ now: Date.now() + 10 * STALE_MS }).marked.some((j) => j.id === job.id), false);

  finish();
  await new Promise((resolve) => manager.on(job.id, (type) => type === 'done' && resolve()));
  assert.equal(rowOf(job.id).status, 'done');
  assert.ok(!ownJobs.has(job.id), 'a finished job leaves the registry');
  const beat = rowOf(job.id).heartbeat_at;
  await sleep(120);
  assert.equal(rowOf(job.id).heartbeat_at, beat, 'the heartbeat stops with the job');
  assert.ok(HEARTBEAT_MS < STALE_MS / 4, 'several beats fit into the stale window');
});

test('startup recovery marks only the jobs whose heartbeat stopped, and never touches a live job or its workspace', async () => {
  const projectId = makeProject();
  const now = Date.now();
  const stale = randomUUID();
  const old = randomUUID();
  const alive = randomUUID();
  const queuedAlive = randomUUID();
  insertRecreate.run(stale, projectId, 'running', new Date(now - 3600000).toISOString(), new Date(now - STALE_MS - 5000).toISOString());
  insertRecreate.run(old, projectId, 'running', new Date(now - 3600000).toISOString(), null);
  insertRecreate.run(alive, projectId, 'running', new Date(now - 600000).toISOString(), new Date(now - 2000).toISOString());
  insertRecreate.run(queuedAlive, projectId, 'queued', new Date(now - 1000).toISOString(), new Date(now - 1000).toISOString());
  // The live job's workspace, with a checkpoint a resume would adopt (rename) if it were wrongly treated as interrupted.
  const liveWork = tmpDir(projectId, alive);
  await mkdir(liveWork, { recursive: true });
  await writeFile(path.join(liveWork, 'checkpoint.json'), JSON.stringify({ version: 1, recreateId: alive, discovery: { pages: [{ url: 'https://example.com/' }] }, pages: {} }));

  const result = await recoverStaleJobs({ now });
  assert.deepEqual(result.marked.map((j) => j.id).sort(), [old, stale].sort(), 'the stale and the heartbeat-less rows');
  assert.equal(result.alive.length, 2, 'the two live rows are counted, nothing more');
  for (const id of [stale, old]) {
    const row = rowOf(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error, STOPPED_MESSAGE);
  }
  assert.equal(rowOf(alive).status, 'running', 'a job alive in another process keeps running');
  assert.equal(rowOf(alive).error, null);
  assert.equal(rowOf(queuedAlive).status, 'queued', 'a queued job of a live process stays queued');
  assert.ok(existsSync(liveWork), 'the live job\'s workspace is still there under its own name');
  assert.ok(existsSync(path.join(liveWork, 'checkpoint.json')));
  assert.equal(result.resumed.length, 0, 'no stale job had work to continue (no workspace), so nothing was started');

  // Later the live process dies: its heartbeat ages past STALE_MS and the watch pass takes the job over.
  const second = await recoverStaleJobs({ now: now + STALE_MS + 10000 });
  assert.deepEqual(second.marked.map((j) => j.id).sort(), [alive, queuedAlive].sort());
  assert.equal(rowOf(alive).status, 'failed');
  // Only now is its workspace continued: the one stale job with a usable checkpoint is started again (it fails at once here,
  // the project has no analysis, which is the pipeline's own first check and not this test's concern).
  assert.equal(second.resumed.length, 1, 'the job whose process died is continued where it stopped');
  assert.equal(second.resumed[0].projectId, projectId);
  await new Promise((resolve) => {
    const { recreateJobs } = recreateModule;
    recreateJobs.on(second.resumed[0].id, (type) => (type === 'done' || type === 'failed') && resolve());
    const current = recreateJobs.get(second.resumed[0].id);
    if (current && current.status !== 'queued' && current.status !== 'running') resolve();
  });
  await rm(liveWork, { recursive: true, force: true });
});

test('a heartbeat written between the read and the write keeps the job', () => {
  const projectId = makeProject();
  const id = randomUUID();
  const now = Date.now();
  insertRecreate.run(id, projectId, 'running', new Date(now).toISOString(), new Date(now - STALE_MS - 1000).toISOString());
  const { stale } = openJobs({ now, own: new Set() });
  assert.ok(stale.some((j) => j.id === id));
  // The other process beats now, after our read.
  heartbeat('recreates', id, now);
  const result = adoptStaleJobs({ now, own: new Set() });
  assert.ok(!result.marked.some((j) => j.id === id), 'the conditional write misses a row that just beat');
  assert.equal(rowOf(id).status, 'running');
});

test('importing the database module from another process marks nothing and takes no lock', async () => {
  const projectId = makeProject();
  const running = randomUUID();
  const noBeat = randomUUID();
  const now = Date.now();
  insertRecreate.run(running, projectId, 'running', new Date(now).toISOString(), new Date(now).toISOString());
  // The row an older server would have marked at import time (no heartbeat at all): a reading script must not either.
  insertRecreate.run(noBeat, projectId, 'running', new Date(now).toISOString(), null);
  const reader = startChild(
    ['-e', `import('${pathToFileURL(path.join(serverDir, 'src/db/index.js')).href}').then((m) => { console.log('rows ' + m.db.prepare("SELECT COUNT(*) AS n FROM recreates WHERE status = 'running'").get().n); })`],
    { env: childEnv({ SAS_DATA_DIR: DATA_DIR }) },
  );
  const ended = await reader.started;
  assert.equal(ended.code, 0, `the reader failed: ${ended.err}`);
  assert.match(ended.out, /rows \d+/);
  assert.equal(rowOf(running).status, 'running');
  assert.equal(rowOf(noBeat).status, 'running', 'a reader never marks a job, not even a heartbeat-less one');
  assert.ok(!existsSync(lockFile(DATA_DIR)), 'a reader takes no lock');
  // The test's own data folder is never locked by the test either (only src/index.js does).
  assert.equal(readLock(lockFile(DATA_DIR)), null);
});
