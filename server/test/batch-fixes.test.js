// "Apply the latest fixes" to every site at once (recreate/batchFixes.js): as many sites as the account has room for, one slot
// left free for the person, every job started the ordinary way (never `system`), limits and clashes waited out, Stop honoured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, JobLimitError } from '../src/jobs/manager.js';
import { createBatch, freeSlots } from '../src/recreate/batchFixes.js';

/** A fake job world: `limit` jobs per account, `manual` jobs of the person's own, and the batch's jobs until finished. */
function world({ limit = 6, manual = 0, sites = 8, skip = [], conflict = [] } = {}) {
  const w = { limit, manual, running: new Map(), status: new Map(), starts: [], conflict: new Set(conflict), refuseOnce: false };
  const projects = Array.from({ length: sites }, (_, i) => ({ id: `p${i}`, name: `Site ${i}` }));
  let n = 0;
  w.deps = {
    tickMs: 1e9,
    limit: () => w.limit,
    activeCount: () => w.manual + w.running.size,
    project: (id) => projects.find((p) => p.id === id) ?? null,
    jobFor: async (p) => (skip.includes(p.id) ? { skip: 'no as-is copy to fix again' } : { payload: { asIs: { from: `old-${p.id}` } }, warnings: [] }),
    start: (p, payload, o) => {
      w.starts.push({ id: p.id, o });
      if (w.refuseOnce) { w.refuseOnce = false; throw new JobLimitError({ id: 'x' }, w.limit); }
      if (w.conflict.has(p.id)) throw new ConflictError({ id: 'other' }, 'recreate');
      if (w.manual + w.running.size >= w.limit) throw new JobLimitError({ id: 'x' }, w.limit);
      const id = `j${n++}`;
      w.running.set(id, p.id);
      return { id };
    },
    running: (s) => w.running.has(s.jobId),
    statusOf: (jobId) => w.status.get(jobId) ?? null,
  };
  w.finish = (jobId, status = 'done', error = null) => { w.running.delete(jobId); w.status.set(jobId, { status, error }); };
  w.projects = projects;
  return w;
}
const states = (b) => b.sites.map((s) => s.state);
const count = (b, state) => b.sites.filter((s) => s.state === state).length;

test('free slots: one kept for the person, none kept when the limit is one', () => {
  assert.equal(freeSlots(6, 0), 5);
  assert.equal(freeSlots(6, 1), 4);
  assert.equal(freeSlots(6, 6), 0);
  assert.equal(freeSlots(1, 0), 1);
  assert.equal(freeSlots(1, 1), 0);
});

test('five of six slots at once, the next site as soon as one ends, never a system job', async () => {
  const w = world();
  const run = createBatch({ ownerId: 'u1', projects: w.projects, deps: w.deps });
  await run.tick();
  assert.equal(count(run.batch, 'running'), 5, 'one slot left free');
  assert.ok(w.starts.every((s) => !('system' in s.o) || s.o.system !== true), 'started like the button starts it');
  const [first, second] = run.batch.sites;
  w.finish(first.jobId);
  w.finish(second.jobId, 'failed', 'the page could not be packaged');
  await run.tick();
  assert.equal(first.state, 'done');
  assert.equal(second.state, 'failed');
  assert.equal(second.reason, 'the page could not be packaged');
  assert.equal(count(run.batch, 'running'), 5, 'two new sites took their place');
  assert.equal(count(run.batch, 'waiting'), 1);
  for (const s of run.batch.sites) if (s.state === 'running') w.finish(s.jobId);
  await run.tick();
  for (const s of run.batch.sites) if (s.state === 'running') w.finish(s.jobId);
  await run.tick();
  assert.ok(run.batch.finishedAt, 'every site ended');
  assert.equal(count(run.batch, 'done'), 7);
});

test('the person\'s own jobs count: their work is never pushed out', async () => {
  const w = world({ manual: 1 });
  const run = createBatch({ ownerId: 'u1', projects: w.projects, deps: w.deps });
  await run.tick();
  assert.equal(count(run.batch, 'running'), 4);
  w.manual = 2; // the person started one more in the free slot
  w.finish(run.batch.sites[0].jobId);
  await run.tick();
  assert.equal(count(run.batch, 'running'), 3, 'still one slot free beside the person\'s two');
});

test('a limit reached meanwhile or a site already copying waits; nothing is lost', async () => {
  const w = world({ sites: 3, conflict: ['p1'] });
  w.refuseOnce = true;
  const run = createBatch({ ownerId: 'u1', projects: w.projects, deps: w.deps });
  await run.tick();
  assert.deepEqual(states(run.batch), ['waiting', 'waiting', 'waiting'], 'the limit answered first: tried again next time');
  await run.tick();
  assert.deepEqual(states(run.batch), ['running', 'waiting', 'running'], 'the site with its own copy running waits');
  w.conflict.clear();
  await run.tick();
  assert.deepEqual(states(run.batch), ['running', 'running', 'running']);
});

test('a site that cannot be fixed again is skipped with its reason; limit one runs one at a time', async () => {
  const w = world({ limit: 1, sites: 3, skip: ['p0'] });
  const run = createBatch({ ownerId: 'u1', projects: w.projects, deps: w.deps });
  await run.tick();
  assert.deepEqual(states(run.batch), ['skipped', 'running', 'waiting']);
  assert.equal(run.batch.sites[0].reason, 'no as-is copy to fix again');
});

test('Stop starts no more sites; the running ones end on their own', async () => {
  const w = world({ sites: 8 });
  const run = createBatch({ ownerId: 'u1', projects: w.projects, deps: w.deps });
  await run.tick();
  await run.stop();
  assert.equal(count(run.batch, 'not-started'), 3);
  for (const s of run.batch.sites) if (s.state === 'running') w.finish(s.jobId);
  await run.tick();
  assert.equal(count(run.batch, 'done'), 5);
  assert.equal(w.starts.length, 5, 'nothing started after Stop');
  assert.ok(run.batch.finishedAt);
});
