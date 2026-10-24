// Disk cleanup (jobs/cleanup.js): what a pass removes and what it must never touch, the dry run, the scratch sweep after a job,
// the temp folder, and the measurement. No browser; the data folder is this test's temp one (SAS_DATA_DIR).
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../src/db/index.js';
import { recreateRoot } from '../src/config/paths.js';
import { cleanupDryRun, cleanupHours, folderSize, keepCopiesDays, measureDisk, planCleanup, runCleanup, scratchIn, sweepJobScratch, STRAY_MIN_AGE_MS } from '../src/jobs/cleanup.js';
import { ownJobs } from '../src/jobs/liveness.js';
import { seedProject } from './helpers/projects.js';

const DAY = 86_400_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ENV = ['SAS_KEEP_COPIES_DAYS', 'SAS_CLEANUP_HOURS', 'SAS_CLEANUP_DRY_RUN', 'SAS_JOB_MAX_MINUTES', 'SAS_TEMP_DIR'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const setEnv = (o) => {
  for (const k of ENV) {
    if (o[k] === undefined) delete process.env[k];
    else process.env[k] = String(o[k]);
  }
};
const quiet = () => {};
const projectIds = [];
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'sas-cleanup-test-'));

function project() {
  const id = randomUUID();
  projectIds.push(id);
  seedProject(db, { id, name: 'cleanup', url: 'https://example.com/', stack: 'html', authorized: 1 });
  return id;
}
const insert = db.prepare(`INSERT INTO recreates (id, project_id, status, progress, started_at, finished_at, heartbeat_at, result_json) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`);
/** A recreate row + folder. `ago`: days since it finished. */
function copy(projectId, { ago, status = 'done', tmp = false, heartbeatAgoMs = null, row = true, files = ['dist/index.html', 'assets/a.png'], scratch = [] } = {}) {
  const id = randomUUID();
  const dir = path.join(recreateRoot(projectId), tmp ? `${id}.tmp` : id);
  for (const f of [...files, ...scratch]) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), 'x'.repeat(2048));
  }
  if (row) insert.run(id, projectId, status, iso(now - ago * DAY - 60000), status === 'done' ? iso(now - ago * DAY) : null, heartbeatAgoMs == null ? null : iso(now - heartbeatAgoMs), status === 'done' ? JSON.stringify({ stack: 'html' }) : null);
  return { id, dir };
}
const rowOf = (id) => db.prepare('SELECT status, removed_at FROM recreates WHERE id = ?').get(id);
const paths = (list) => list.map((a) => a.path);

before(() => setEnv({ SAS_KEEP_COPIES_DAYS: 30, SAS_JOB_MAX_MINUTES: 480, SAS_TEMP_DIR: tempRoot }));
afterEach(() => setEnv({ SAS_KEEP_COPIES_DAYS: 30, SAS_JOB_MAX_MINUTES: 480, SAS_TEMP_DIR: tempRoot }));
after(() => {
  setEnv(saved);
  for (const id of projectIds) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  rmSync(tempRoot, { recursive: true, force: true });
});

test('the settings: defaults and bounds', () => {
  assert.equal(keepCopiesDays({}), 30);
  assert.equal(keepCopiesDays({ SAS_KEEP_COPIES_DAYS: '0' }), 0, '0 = never by age');
  assert.equal(keepCopiesDays({ SAS_KEEP_COPIES_DAYS: '5000' }), 30, 'out of range = default');
  assert.equal(cleanupHours({}), 6);
  assert.equal(cleanupHours({ SAS_CLEANUP_HOURS: '0' }), 0);
  assert.equal(cleanupHours({ SAS_CLEANUP_HOURS: '0.5' }), 0.5);
  assert.equal(cleanupDryRun({}), false);
  assert.equal(cleanupDryRun({ SAS_CLEANUP_DRY_RUN: '1' }), true);
});

test('folderSize counts a hard-linked file once (site/ and dist/ link the assets)', async () => {
  const dir = path.join(tempRoot, 'links');
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  mkdirSync(path.join(dir, 'dist'));
  writeFileSync(path.join(dir, 'assets', 'a.bin'), 'x'.repeat(10000));
  linkSync(path.join(dir, 'assets', 'a.bin'), path.join(dir, 'dist', 'a.bin'));
  writeFileSync(path.join(dir, 'dist', 'b.txt'), 'y'.repeat(100));
  const size = await folderSize(dir);
  assert.equal(size.bytes, 10100);
  assert.equal(size.files, 2);
});

test('old copies go, the newest finished copy of a website never does; scratch inside a kept copy goes; rows record the removal', async () => {
  const p = project();
  const old = copy(p, { ago: 60 });
  const older = copy(p, { ago: 100, scratch: ['dist.tmp/x.html'] });
  const newest = copy(p, { ago: 2, scratch: ['dist.tmp/index.html', 'stacks/react-vite.tmp/a.js', 'stacks/react-vite/.lift-tmp/a', 'as-is/copy/.fetch/b', 'as-is/unfixed/c'] });
  const recent = copy(p, { ago: 10 });
  const lonely = project();
  const only = copy(lonely, { ago: 400 });
  // `capture/.network` is part of the capture, not scratch.
  mkdirSync(path.join(newest.dir, 'capture', '.network'), { recursive: true });
  writeFileSync(path.join(newest.dir, 'capture', '.network', 'r.json'), '{}');

  const plan = await planCleanup({ now });
  const removed = paths(plan.actions);
  assert.ok(removed.includes(old.dir), 'the 60-day copy');
  assert.ok(removed.includes(older.dir), 'the 100-day copy');
  assert.ok(!removed.includes(newest.dir) && !removed.includes(recent.dir));
  assert.ok(!removed.includes(only.dir), 'the only copy of a website stays whatever its age');
  assert.ok(plan.kept.some((k) => k.path === only.dir && /newest finished copy/.test(k.reason)), plan.kept.map((k) => k.reason).join(' | '));
  for (const s of ['dist.tmp', 'stacks/react-vite.tmp', 'stacks/react-vite/.lift-tmp', 'as-is/copy/.fetch', 'as-is/unfixed']) {
    assert.ok(removed.includes(path.join(newest.dir, s)), `scratch ${s}`);
  }
  assert.ok(!removed.includes(path.join(newest.dir, 'capture', '.network')));
  assert.ok(!removed.some((x) => x.startsWith(older.dir + path.sep)), 'scratch inside a folder removed whole is not listed twice');
  assert.ok(plan.actions.every((a) => a.bytes > 0 && a.reason));
  assert.ok(plan.actions.find((a) => a.path === old.dir).reason.includes('older than 30 (SAS_KEEP_COPIES_DAYS)'));

  const result = await runCleanup({ now, dryRun: false, log: quiet });
  assert.equal(result.removed.length, plan.actions.length);
  assert.ok(!existsSync(old.dir) && !existsSync(older.dir));
  assert.ok(existsSync(newest.dir) && existsSync(recent.dir) && existsSync(only.dir));
  assert.ok(!existsSync(path.join(newest.dir, 'dist.tmp')) && existsSync(path.join(newest.dir, 'dist', 'index.html')));
  assert.ok(existsSync(path.join(newest.dir, 'capture', '.network', 'r.json')));
  assert.ok(rowOf(old.id).removed_at && rowOf(older.id).removed_at, 'the rows say the folder is gone');
  assert.equal(rowOf(old.id).status, 'done', 'the job itself is still the record of what ran');
  assert.equal(rowOf(newest.id).removed_at, null);
  // A second pass finds nothing more.
  assert.equal((await planCleanup({ now })).actions.filter((a) => a.projectId === p || a.projectId === lonely).length, 0);

  // SAS_KEEP_COPIES_DAYS=0: nothing is removed by age.
  setEnv({ SAS_KEEP_COPIES_DAYS: 0, SAS_JOB_MAX_MINUTES: 480, SAS_TEMP_DIR: tempRoot });
  const ancient = copy(p, { ago: 900 });
  const plan0 = await planCleanup({ now });
  assert.ok(!paths(plan0.actions).includes(ancient.dir));
  assert.ok(plan0.kept.some((k) => k.path === ancient.dir && /never removed by age/.test(k.reason)));
});

test('workspaces: a running or waiting job keeps its folder; one that can be continued is kept 7 days; the rest go', async () => {
  const p = project();
  const resumable = copy(p, { ago: 1, status: 'failed', tmp: true, scratch: ['dist.tmp/a'] });
  writeFileSync(path.join(resumable.dir, 'checkpoint.json'), JSON.stringify({ version: 1, recreateId: resumable.id, discovery: { pages: [{ url: 'https://example.com/', outPath: 'index.html' }] }, pages: {}, steps: {}, updatedAt: iso(now - DAY), stopped: { at: iso(now - DAY), step: 'inspect', reason: 'error', message: 'x' } }));
  const dead = copy(p, { ago: 3, status: 'failed', tmp: true });
  const running = copy(p, { ago: 0, status: 'running', tmp: true, heartbeatAgoMs: 5000 });
  const openStale = copy(p, { ago: 0, status: 'running', tmp: true, heartbeatAgoMs: 10 * 60000 });
  const mine = copy(p, { ago: 0, status: 'queued', tmp: true });
  ownJobs.add(mine.id);
  const unknown = copy(p, { ago: 0, tmp: true, row: false });
  const stray = copy(p, { ago: 0, row: false });
  utimesSync(stray.dir, new Date(now - 2 * DAY), new Date(now - 2 * DAY));
  const fresh = copy(p, { ago: 0, row: false });
  try {
    const plan = await planCleanup({ now });
    const removed = paths(plan.actions);
    assert.ok(!removed.includes(resumable.dir), 'can be continued');
    assert.ok(removed.includes(path.join(resumable.dir, 'dist.tmp')), 'but loses its half-built pieces');
    assert.ok(removed.includes(dead.dir), 'failed, nothing to continue');
    assert.ok(!removed.includes(running.dir), 'alive elsewhere');
    assert.ok(!removed.includes(openStale.dir), 'open row without heartbeat: the job recovery decides');
    assert.ok(!removed.includes(mine.dir), 'this process\'s own');
    assert.ok(removed.includes(unknown.dir), 'no row');
    assert.ok(removed.includes(stray.dir), 'a copy folder no row knows, still for two days');
    assert.ok(!removed.includes(fresh.dir), 'changed within a day: may be a rename in progress');
    const reasons = Object.fromEntries(plan.kept.map((k) => [k.path, k.reason]));
    assert.match(reasons[resumable.dir], /can be continued/);
    assert.match(reasons[running.dir], /running or waiting/);
    assert.match(reasons[openStale.dir], /still open/);
    assert.match(reasons[fresh.dir], /within a day/);
    await runCleanup({ now, dryRun: false, log: quiet });
    assert.ok(existsSync(resumable.dir) && existsSync(path.join(resumable.dir, 'checkpoint.json')) && !existsSync(path.join(resumable.dir, 'dist.tmp')));
    assert.ok(!existsSync(dead.dir) && !existsSync(unknown.dir) && !existsSync(stray.dir));
    assert.ok(existsSync(running.dir) && existsSync(openStale.dir) && existsSync(mine.dir) && existsSync(fresh.dir));
    // Eight days later the stopped copy can no longer be continued: it goes too.
    const later = await planCleanup({ now: now + 8 * DAY });
    assert.ok(paths(later.actions).includes(resumable.dir));
    assert.ok(paths(later.actions).includes(fresh.dir), 'still for 8 days now');
  } finally {
    ownJobs.delete(mine.id);
  }
});

test('the temp folder: a job\'s leftovers older than the hard limit go, newer ones and other folders stay', async () => {
  const oldCache = path.join(tempRoot, 'sas-cache-old');
  const newCache = path.join(tempRoot, 'sas-cache-new');
  const migrate = path.join(tempRoot, 'sas-migrate-old');
  const other = path.join(tempRoot, 'somebody-else');
  for (const d of [oldCache, newCache, migrate, other]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'f'), 'x'.repeat(1000));
  }
  for (const d of [oldCache, migrate, other]) utimesSync(d, new Date(now - 10 * 3_600_000), new Date(now - 10 * 3_600_000));
  const plan = await planCleanup({ now });
  const removed = paths(plan.actions);
  assert.ok(removed.includes(oldCache) && removed.includes(migrate));
  assert.ok(!removed.includes(newCache) && !removed.includes(other));
  assert.equal(plan.settings.tempMaxAgeMs, 480 * 60000);
  // No hard limit: a day.
  setEnv({ SAS_KEEP_COPIES_DAYS: 30, SAS_JOB_MAX_MINUTES: 0, SAS_TEMP_DIR: tempRoot });
  const noLimit = await planCleanup({ now });
  assert.equal(noLimit.settings.tempMaxAgeMs, DAY);
  assert.ok(!paths(noLimit.actions).includes(oldCache), '10 h old is young for a day');
  setEnv({ SAS_KEEP_COPIES_DAYS: 30, SAS_JOB_MAX_MINUTES: 480, SAS_TEMP_DIR: tempRoot });
  await runCleanup({ now, dryRun: false, log: quiet });
  assert.ok(!existsSync(oldCache) && !existsSync(migrate) && existsSync(newCache) && existsSync(other));
});

test('dry run lists everything and removes nothing; SAS_CLEANUP_DRY_RUN makes the server\'s passes dry', async () => {
  const p = project();
  const old = copy(p, { ago: 90, scratch: ['dist.tmp/a'] });
  copy(p, { ago: 1 });
  const lines = [];
  const result = await runCleanup({ now, dryRun: true, log: (l) => lines.push(l) });
  assert.ok(result.dryRun);
  assert.equal(result.removed.length, 0);
  assert.ok(existsSync(old.dir) && existsSync(path.join(old.dir, 'dist.tmp')));
  assert.equal(rowOf(old.id).removed_at, null);
  assert.ok(lines.some((l) => l.includes('would remove old-copy') && l.includes(old.dir)), lines.join('\n'));
  assert.ok(lines.at(-1).includes('dry run'));
  setEnv({ SAS_KEEP_COPIES_DAYS: 30, SAS_JOB_MAX_MINUTES: 480, SAS_TEMP_DIR: tempRoot, SAS_CLEANUP_DRY_RUN: '1' });
  const byEnv = await runCleanup({ now, log: quiet });
  assert.ok(byEnv.dryRun && existsSync(old.dir));
  setEnv({ SAS_KEEP_COPIES_DAYS: 30, SAS_JOB_MAX_MINUTES: 480, SAS_TEMP_DIR: tempRoot });
  await runCleanup({ now, dryRun: false, log: quiet });
  assert.ok(!existsSync(old.dir));
});

test('after a job: the scratch inside its copy and its kept workspace goes, nothing else', async () => {
  const p = project();
  const done = copy(p, { ago: 0, scratch: ['dist.tmp/a', 'stacks/next.html-ref.tmp/b'] });
  const kept = copy(p, { ago: 0, status: 'failed', tmp: true, scratch: ['stacks/react-vite/.complete-tmp/c'] });
  const otherCopy = copy(p, { ago: 0, scratch: ['dist.tmp/z'] });
  assert.equal((await scratchIn(done.dir)).length, 2);
  const removed = await sweepJobScratch(p, done.id, { log: quiet });
  assert.equal(removed.length, 2);
  assert.ok(!existsSync(path.join(done.dir, 'dist.tmp')) && !existsSync(path.join(done.dir, 'stacks', 'next.html-ref.tmp')));
  assert.ok(existsSync(path.join(done.dir, 'dist', 'index.html')));
  assert.ok(existsSync(path.join(otherCopy.dir, 'dist.tmp')), 'another copy is not this job\'s business');
  await sweepJobScratch(p, kept.id, { log: quiet });
  assert.ok(!existsSync(path.join(kept.dir, 'stacks', 'react-vite', '.complete-tmp')) && existsSync(path.join(kept.dir, 'dist', 'index.html')));
});

test('measureDisk: per website the analyses, copies with their scratch, workspaces; the temp folder', async () => {
  const p = project();
  const c = copy(p, { ago: 1, scratch: ['dist.tmp/a'] });
  writeFileSync(path.join(c.dir, 'dist.tmp', 'a'), 'x'.repeat(300 * 1024));
  copy(p, { ago: 0, status: 'failed', tmp: true });
  mkdirSync(path.join(tempRoot, 'sas-cache-measured'), { recursive: true });
  writeFileSync(path.join(tempRoot, 'sas-cache-measured', 'f'), 'x'.repeat(2048));
  const disk = await measureDisk();
  const mine = disk.projects.find((x) => x.projectId === p);
  assert.ok(mine);
  assert.equal(mine.copies.length, 1);
  assert.equal(mine.copies[0].id, c.id);
  assert.equal(mine.copies[0].files, 3);
  assert.ok(mine.copies[0].scratchMb > 0 && mine.copies[0].mb >= mine.copies[0].scratchMb);
  assert.deepEqual(Object.keys(mine.copies[0].parts).sort(), ['assets', 'dist', 'dist.tmp']);
  assert.equal(mine.workspaces.length, 1);
  assert.ok(disk.temp.leftovers.some((l) => l.name === 'sas-cache-measured'));
  assert.ok(disk.totalMb >= mine.mb);
  assert.ok(STRAY_MIN_AGE_MS === DAY);
});
