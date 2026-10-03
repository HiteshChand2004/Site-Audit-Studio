// Recreate: sleep and network outages (recreate/interrupts.js). Fixture site only; outages and sleep are simulated.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { mergeDownloads } from '../src/recreate/assets/index.js';
import { capturePage } from '../src/recreate/capture/index.js';
import { progressTracker } from '../src/jobs/manager.js';
import { runRecreate, STAGES, STEPS as RECREATE_STEPS } from '../src/recreate/index.js';
import { createInterrupts, extendableTimeout, recoverFailure, recoverHit } from '../src/recreate/interrupts.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4193;
const origin = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
const projectIds = [];
const dirs = [];

before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
});
after(async () => {
  server.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function makeProject(pages = 0) {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'fixture', ?, 'html', 1, ?, ?, ?)`).run(id, `${origin}/`, pages, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
const stubs = Object.fromEntries(Object.keys(STAGES).map((key) => [key, async () => {}]));
const quiet = { pausedBetween: () => 0, pauses: [], stop() {} };
const noOutage = { downBetween: () => 0, outages: [], stop() {} };

test('extendableTimeout: fires at its end, later when extended, and lets a catch-up move the end first', async () => {
  let fired = 0;
  const t = extendableTimeout(30, () => fired++);
  await sleep(60);
  assert.equal(fired, 1);
  const t2 = extendableTimeout(30, () => fired++);
  t2.extend(80);
  await sleep(60);
  assert.equal(fired, 1, 'not yet: extended');
  await sleep(80);
  assert.equal(fired, 2);
  // The catch-up (the pause watcher after a wake-up) extends the timer when it fires: it waits instead of timing out.
  let caughtUp = false;
  const t3 = extendableTimeout(20, () => fired++, () => {
    if (!caughtUp) t3.extend(60);
    caughtUp = true;
  });
  await sleep(50);
  assert.equal(fired, 2);
  await sleep(60);
  assert.equal(fired, 3);
  t.clear();
});

test('createInterrupts: time given back is capped for the whole job, and decisions are recorded', () => {
  const granted = [];
  const lines = [];
  const it = createInterrupts({ url: `${origin}/`, label: 'test', allowanceMs: 1000, onGrant: (ms) => granted.push(ms), log: (l) => lines.push(l), pauses: quiet, outages: { downBetween: (from) => (from < 100 ? 2500 : 0), outages: [{}], stop() {} } });
  assert.equal(it.grant(600), 600);
  assert.equal(it.grant(600), 400, 'only what is left of the allowance');
  assert.equal(it.grant(600), 0);
  assert.deepEqual(granted, [600, 400]);
  assert.deepEqual(it.hit(0), { cause: 'network', pausedMs: 0, downMs: 2500 });
  assert.equal(it.hit(200), null);
  it.note({ step: 'inspect', what: 'capture of /', cause: 'network', outcome: 'done again' });
  assert.match(lines[0], /^\[recreate test\] inspect: capture of \/ — the network dropped → done again$/);
  assert.deepEqual(it.summary(), { pauses: 0, pausedMs: 0, outages: 1, grantedMs: 1000, allowanceMs: 1000, events: [{ step: 'inspect', what: 'capture of /', cause: 'network', outcome: 'done again' }] });
  it.stop();
});

test('recoverHit / recoverFailure: wait for the network, give the time back, or leave the result as it is', async () => {
  const notes = [];
  const grants = [];
  const fake = (over) => ({ ctx: { interrupts: { url: `${origin}/`, pauses: quiet, outages: noOutage, hit: () => ({ cause: 'network', pausedMs: 0, downMs: 4000 }), waitBack: async () => ({ back: true, waitedMs: 10 }), grant: (ms) => grants.push(ms), note: (e) => notes.push(e), ...over } } });
  assert.deepEqual(await recoverHit(fake().ctx, { step: 'sweep', what: 'widths of /', startedAt: Date.now() - 1000 }), { cause: 'network', pausedMs: 0, downMs: 4000 });
  assert.ok(grants[0] >= 1000, 'the time the page took is given back');
  assert.equal(notes.at(-1).outcome, 'done again');
  assert.equal(await recoverHit(fake({ hit: () => null }).ctx, { step: 'sweep', what: 'x', startedAt: 0 }), null);
  assert.equal(await recoverHit(fake({ waitBack: async () => ({ back: false, waitedMs: 120000 }) }).ctx, { step: 'sweep', what: 'x', startedAt: 0 }), null);
  assert.match(notes.at(-1).outcome, /did not come back/);
  assert.equal(await recoverHit({}, { step: 'x', what: 'x', startedAt: 0 }), null, 'no monitor: nothing to do');
  // Discovery: the homepage fetch timed out while the network was down for a moment; the site answers now: once more.
  const r = await recoverFailure(fake({ outages: { downBetween: () => 3000 } }).ctx, { step: 'inspect', what: 'finding pages', message: 'Could not load the homepage (timeout).', startedAt: Date.now() - 2000, network: true });
  assert.equal(r.retry, true);
  // A timeout with the network up the whole time: the error stands.
  assert.equal(await recoverFailure(fake().ctx, { step: 'inspect', what: 'finding pages', message: 'Discovery timed out after 20s', startedAt: Date.now() - 2000, network: false }), null);
});

test('mergeDownloads: the second round joins the first, same bytes share one file, retried URLs leave the skipped list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-merge-'));
  dirs.push(root);
  await writeFile(path.join(root, 'a-1111.png'), 'A');
  await writeFile(path.join(root, 'b-2222.png'), 'B');
  await writeFile(path.join(root, 'a2-1111.png'), 'A');
  const result = {
    files: [{ file: 'a-1111.png', sha256: '1111', bytes: 1, urls: ['https://x/a.png'] }],
    map: { 'https://x/a.png': 'a-1111.png' },
    skipped: [{ url: 'https://x/b.png', reason: 'timeout' }, { url: 'https://x/a2.png', reason: 'dns' }, { url: 'https://x/c.png', reason: 'too-large' }],
    reused: 0, bytes: 1, fromCache: 0,
  };
  const second = {
    files: [{ file: 'b-2222.png', sha256: '2222', bytes: 1, urls: ['https://x/b.png'] }, { file: 'a2-1111.png', sha256: '1111', bytes: 1, urls: ['https://x/a2.png'] }],
    map: { 'https://x/b.png': 'b-2222.png', 'https://x/a2.png': 'a2-1111.png' },
    skipped: [], reused: 0, bytes: 2, fromCache: 1,
  };
  await mergeDownloads(result, second, root, new Set(['https://x/b.png', 'https://x/a2.png']));
  assert.deepEqual(result.files.map((f) => f.file), ['a-1111.png', 'b-2222.png']);
  assert.deepEqual(result.map, { 'https://x/a.png': 'a-1111.png', 'https://x/b.png': 'b-2222.png', 'https://x/a2.png': 'a-1111.png' });
  assert.deepEqual(result.skipped.map((s) => s.url), ['https://x/c.png'], 'the size limit is not a network failure: still skipped');
  assert.equal(result.bytes, 2);
  assert.deepEqual((await readdir(root)).sort(), ['a-1111.png', 'b-2222.png'], 'the duplicate copy was removed');
});

test('time the computer spent asleep does not count against the step limit (a frozen event loop stands in for sleep)', async () => {
  const project = makeProject();
  // A 3-second job whose first step is "asleep" for 7 s and then needs another half second: without the pause given back
  // it would hit the time limit.
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    budgetMs: 3000,
    // Real sleep counts from 30 s (shorter freezes are an overloaded machine, not sleep); the test uses a shorter sleep.
    interruptOptions: { minPauseMs: 5000 },
    stages: {
      ...stubs,
      inspect: async () => {
        const until = Date.now() + 7000;
        while (Date.now() < until); // the machine "sleeps": no timer runs
        await sleep(500);
      },
    },
  });
  assert.equal(report.interruptions.pauses, 1);
  assert.ok(report.interruptions.grantedMs >= 5000, `given back ${report.interruptions.grantedMs}`);
});

test('time given back after an outage extends the job and the running step', async () => {
  const project = makeProject();
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: () => {},
    budgetMs: 600,
    stages: {
      ...stubs,
      inspect: async (ctx) => {
        const before = ctx.stepDeadline;
        ctx.interrupts.grant(1500);
        assert.equal(ctx.stepDeadline, before + 1500);
        await sleep(1000); // longer than the original 600 ms
      },
    },
  });
  assert.equal(report.interruptions.grantedMs, 1500);
});

test('a step that waits for the background sweep is shown as that step, so the steps between are never ticked early', async () => {
  const project = makeProject();
  const tracker = progressTracker(RECREATE_STEPS);
  const shown = [];
  await runRecreate({
    project,
    recreateId: randomUUID(),
    canOverlap: () => false, // no memory for a second browser: generate waits for the whole sweep
    progress: (step, fraction, message) => shown.push({ ...tracker(step, fraction), message }),
    stages: { ...stubs, sweep: () => sleep(300) },
  });
  const order = RECREATE_STEPS.map((s) => s.key);
  const waiting = shown.find((s) => /^Waiting for “Capturing more widths”/.test(s.message ?? ''));
  assert.ok(waiting, 'the wait is announced');
  assert.equal(waiting.step, 'generate');
  // The step shown only ever moves forward in the list (no tick then untick).
  const indexes = shown.map((s) => order.indexOf(s.step));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

test('inspect: a page captured while the network was down is captured once more; the others once', async () => {
  const project = makeProject(1);
  const calls = [];
  const events = [];
  const report = await runRecreate({
    project,
    recreateId: randomUUID(),
    progress: (step, _f, message) => message && events.push(message),
    stages: {
      ...stubs,
      inspect: (ctx) => {
        // The outage overlapped the homepage capture only (its first attempt).
        let homeHit = true;
        const real = ctx.interrupts;
        ctx.interrupts = { ...real, hit: () => (homeHit ? ((homeHit = false), { cause: 'network', pausedMs: 0, downMs: 3000 }) : null), waitBack: async () => ({ back: true, waitedMs: 0 }) };
        ctx.capturePage = (browser, info, ...rest) => {
          calls.push(info.path);
          return capturePage(browser, info, ...rest);
        };
        return STAGES.inspect(ctx);
      },
    },
  });
  assert.deepEqual(calls, ['/', '/', '/about.html']);
  assert.deepEqual(report.pages.map((p) => p.path), ['/', '/about.html']);
  assert.ok(events.includes('Capturing / again (the network dropped)'), events.join('\n'));
});
