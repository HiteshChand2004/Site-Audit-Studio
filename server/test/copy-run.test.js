// The "Copy my site" pipeline (server/src/copy/run.js) with fake steps: stages, the per-page fallback, the time-boxed
// correction, the zero-regressions loop, the server log, and the budget. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORRECTION_MS, REGRESSION_ROUNDS, badness, runCopy } from '../src/copy/run.js';

const GOOD = { visual: { 1440: 95, 390: 93 }, heightRatio: { 1440: 1, 390: 1 } };
const BAD = { visual: { 1440: 40, 390: 93 }, heightRatio: { 1440: 1, 390: 1 } };
const WORSE = { visual: { 1440: 40, 390: 30 }, heightRatio: { 1440: 1, 390: 1 } };

/** A clock that only moves when the test says so. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

/** Fake steps. `measures[path]` is a list of measurements returned in order (the last one repeats). */
function fakeDeps({ measures = {}, repair = false, rebuilt = null, correct = null, reaudit = [], fixRegression = async () => true, problemsOf = async () => [], explain, clk } = {}) {
  const calls = { capture: 0, correct: [], rebuildClean: [], autoRepair: [], fixRegression: [], log: [], package: [] };
  const seen = {};
  const deps = {
    site: 'demo.test',
    capture: async (pages) => { calls.capture++; return pages; },
    asIs: async (captured) => captured,
    fix: async () => [{ id: 'alt', page: '/' }],
    package: async (asIs, stack) => { calls.package.push(stack); return { dir: 'out', stack }; },
    measure: async (page) => {
      const list = measures[page.path] ?? [GOOD];
      const i = seen[page.path] ?? 0;
      seen[page.path] = i + 1;
      return list[Math.min(i, list.length - 1)];
    },
    autoRepair: async (page) => { calls.autoRepair.push(page.path); return repair; },
    rebuildClean: async (page) => { calls.rebuildClean.push(page.path); return rebuilt; },
    correct: async (page, opts) => { calls.correct.push(opts); return correct ? correct(page, opts) : page; },
    reaudit: async () => reaudit,
    fixRegression: async (item, output) => { calls.fixRegression.push(item.key); return fixRegression(item, output); },
    problemsOf,
    log: undefined,
    explain,
  };
  deps.log = undefined;
  return { deps, calls, clk };
}

const run = (pages, deps, extra = {}) => {
  const clk = extra.clk ?? clock();
  const logs = [];
  return runCopy({ pages, stack: 'nextjs', deps: { ...deps, site: 'demo.test' }, now: clk.now, progress: extra.progress, log: (e) => logs.push(e), budgetMs: extra.budgetMs }).then((r) => ({ r, logs }));
};

test('every page passes first time: all as-is, no open items, the stages in order', async () => {
  const stages = [];
  const { deps } = fakeDeps({ measures: { '/': [GOOD], '/about': [GOOD] } });
  const { r, logs } = await run([{ path: '/' }, { path: '/about' }], deps, { progress: (s) => stages.push(s) });
  assert.deepEqual(stages, ['Capturing', 'Copying', 'Fixing', 'Packaging', 'Checking', 'Done']);
  assert.deepEqual(r.stages, ['Capturing', 'Copying', 'Fixing', 'Packaging', 'Checking', 'Done']);
  assert.ok(r.pages.every((p) => p.how === 'as-is' && p.open.length === 0));
  assert.equal(r.counts.pages, 2);
  assert.equal(r.counts.asIs, 2);
  assert.equal(r.counts.rebuilt, 0);
  assert.equal(r.openItems.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(r.summary, '2 pages copied in Next.js · 2 as-is, 0 rebuilt · Got worse: 0 · Fixed: 1 · Still open: 0');
});

test('a failing page that the stack auto-repair fixes is kept as-is and says so', async () => {
  const { deps, calls } = fakeDeps({ measures: { '/x': [BAD, GOOD] }, repair: true });
  const { r } = await run([{ path: '/x' }], deps);
  assert.deepEqual(calls.autoRepair, ['/x']);
  assert.equal(calls.rebuildClean.length, 0, 'no rebuild when the repair is enough');
  assert.equal(r.pages[0].how, 'as-is');
  assert.equal(r.pages[0].open.length, 0);
});

test('a failing page is rebuilt clean and the rebuild is kept when it scores better', async () => {
  const { deps, calls } = fakeDeps({ measures: { '/x': [BAD], 'rebuilt-x': [GOOD] }, rebuilt: { path: 'rebuilt-x' } });
  // The rebuilt page is measured under its own path.
  { const orig = deps.measure; deps.measure = (page) => (page.path === 'rebuilt-x' ? GOOD : orig(page)); }
  const { r } = await run([{ path: '/x' }], deps);
  assert.deepEqual(calls.rebuildClean, ['/x']);
  assert.equal(r.pages[0].how, 'rebuilt');
  assert.equal(r.pages[0].open.length, 0);
  assert.equal(r.counts.rebuilt, 1);
});

test('the better of the two versions is kept: a worse rebuild does not replace the as-is page, and what is left is open with its reason and logged', async () => {
  const { deps } = fakeDeps({ measures: { '/x': [BAD], 'rebuilt-x': [WORSE] }, rebuilt: { path: 'rebuilt-x' }, explain: () => 'd' });
  { const orig = deps.measure; deps.measure = (page) => (page.path === 'rebuilt-x' ? WORSE : orig(page)); }
  const { r, logs } = await run([{ path: '/x' }], deps);
  assert.equal(r.pages[0].how, 'as-is');
  assert.equal(r.pages[0].open.length, 1);
  assert.equal(r.pages[0].open[0].reason, 'd');
  assert.match(r.pages[0].open[0].tried, /clean rebuild, correction 5 min/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].site, 'demo.test');
  assert.equal(logs[0].page, '/x');
  assert.equal(r.openItems[0].page, '/x');
  assert.equal(r.counts.stillOpen, 1);
});

test('the correction runs inside its time box, and not at all when the box has already passed', async () => {
  const clk = clock();
  const { deps, calls } = fakeDeps({ measures: { '/x': [BAD] }, rebuilt: { path: 'r' }, clk });
  await run([{ path: '/x' }], deps, { clk });
  assert.equal(calls.correct.length, 1);
  assert.equal(calls.correct[0].untilMs, clk.now() + CORRECTION_MS);

  // The whole run has less time left than the rebuild takes: no correction is started.
  const clk2 = clock();
  const slow = fakeDeps({ measures: { '/x': [BAD] }, rebuilt: { path: 'r' }, clk: clk2 });
  slow.deps.rebuildClean = async (p) => { clk2.tick(2000); slow.calls.rebuildClean.push(p.path); return { path: 'r' }; };
  await run([{ path: '/x' }], slow.deps, { clk: clk2, budgetMs: 1000 });
  assert.equal(slow.calls.correct.length, 0);
});

test('zero regressions: a got-worse item whose fix adds no failing check is fixed and not reported', async () => {
  const reaudit = [{ key: 'seo.title', status: 'regressed', page: '/' }, { key: 'seo.ok', status: 'fixed', page: '/' }];
  const { deps, calls } = fakeDeps({ reaudit, problemsOf: async () => [] });
  const { r } = await run([{ path: '/' }], deps);
  assert.deepEqual(calls.fixRegression, ['seo.title']);
  assert.equal(r.counts.gotWorse, 0);
  assert.equal(r.openItems.length, 0);
});

test('zero regressions: a fix that adds a failing check is reverted, and the item stays open with its reason', async () => {
  const reaudit = [{ key: 'embed.map', status: 'regressed', page: '/', thirdParty: true }];
  // Each attempt: the reading before is clean, the one after shows a new failing check.
  const state = { pending: [] };
  const { deps, calls } = fakeDeps({
    reaudit,
    fixRegression: async () => { state.pending = [{ check: 'visual', width: 390 }]; return true; },
    problemsOf: async () => { const out = state.pending; state.pending = []; return out; },
  });
  const { r, logs } = await run([{ path: '/' }], deps);
  assert.equal(calls.fixRegression.length, REGRESSION_ROUNDS, 'tried once per round, up to the limit');
  assert.equal(r.counts.gotWorse, 1);
  assert.equal(r.openItems.length, 1);
  // A reverted fix is listed under reason d (docs/COPY-MY-SITE.md §5), even for third-party code.
  assert.equal(r.openItems[0].reason, 'look');
  assert.equal(logs.length, 1);
});

test('zero regressions: an item with no reason of its own is open for the look of the original (reason d)', async () => {
  const reaudit = [{ key: 'seo.title', status: 'regressed', page: '/' }];
  const { deps } = fakeDeps({ reaudit, fixRegression: async () => false });
  const { r } = await run([{ path: '/' }], deps);
  assert.equal(r.counts.gotWorse, 1);
  assert.equal(r.openItems[0].reason, 'look');
});

test('the budget: when no time is left, regressions are not attempted and stay open', async () => {
  const reaudit = [{ key: 'seo.title', status: 'regressed', page: '/' }];
  const { deps, calls } = fakeDeps({ reaudit });
  const { r } = await run([{ path: '/' }], deps, { budgetMs: -1 });
  assert.equal(calls.fixRegression.length, 0);
  assert.equal(r.counts.gotWorse, 1);
});

test('badness: failing checks count most, then the visual shortfall', () => {
  assert.equal(badness([]), 0);
  assert.ok(badness([{ check: 'hover', value: 0.5, min: 0.9 }]) > badness([]));
  assert.ok(badness([{ check: 'visual', value: 40, min: 65 }]) > badness([{ check: 'visual', value: 60, min: 65 }]));
});
