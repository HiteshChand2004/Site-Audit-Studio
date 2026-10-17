// An "Original as-is" copy has a time budget that follows its size (20 minutes per page, 10 per stack), and a copy that never
// finishes ends with a clear time-limit error and frees the worker: the next job runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/index.js';
import { asIsBudgetMs, runRecreate } from '../src/recreate/index.js';
import { seedProject } from './helpers/projects.js';

const MIN = 60000;

test('the as-is budget: 20 minutes per page and 10 per stack; SAS_RECREATE_MINUTES still wins', () => {
  assert.equal(asIsBudgetMs(1, 1, {}), 30 * MIN);
  assert.equal(asIsBudgetMs(2, 1, {}), 50 * MIN);
  assert.equal(asIsBudgetMs(3, 4, {}), 100 * MIN);
  assert.equal(asIsBudgetMs(2, 1, { SAS_RECREATE_MINUTES: '7' }), 7 * MIN);
  assert.ok(Number.isFinite(asIsBudgetMs(40, 4, {})), 'never unlimited');
});

test('a copy that never finishes ends with a time-limit error, and the next job still runs', async () => {
  const id = randomUUID();
  seedProject(db, { id, name: 'stuck', url: 'https://stuck.test/', stack: 'html', authorized: 1, recreatePages: 0, analysis: true });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const started = Date.now();
  // The as-is stage that never finishes (stages.asIsStage replaces the real one in this test only).
  const stuck = { inspect: async () => {}, asIsStage: () => new Promise(() => {}) };
  await assert.rejects(
    () => runRecreate({
      project, recreateId: randomUUID(), progress: () => {}, stages: stuck, budgetMs: 1500,
      asIs: { stack: 'html', pages: ['https://stuck.test/'] },
    }),
    (err) => {
      assert.equal(err.timeLimit, true, `a time-limit error, got: ${err.message}`);
      assert.match(err.message, /time limit/i, 'a message the user can read');
      return true;
    },
  );
  assert.ok(Date.now() - started < 30000, 'it ended at its budget, not later');

  // The worker is free: a second copy of the same project runs to the end.
  const done = { inspect: async () => {}, asIsStage: async () => {} };
  await runRecreate({
    project, recreateId: randomUUID(), progress: () => {}, stages: done, budgetMs: 60000,
    asIs: { stack: 'html', pages: ['https://stuck.test/'] },
  });
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
});
