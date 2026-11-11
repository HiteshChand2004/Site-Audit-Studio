// What build mode costs (src/buildmode/spend.js): dollars from an answer's usage at each model's prices, the owner's day kept on
// disk and refused once used up, and the agent stopped by its dollar limit (a build run's cost: buildmode.test.js). Fake
// clients only: no network, no money.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_BUDGET, PRICES, checkDailyBudget, costOf, leftToday, priceOf, recordSpend, roundUsd, spentToday } from '../src/buildmode/spend.js';
import { runAgent } from '../src/buildmode/agent.js';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sas-spend-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('cost: each kind of token at its model\'s price, unknown models at the dearest, cents rounded up', () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 };
  assert.equal(costOf(usage, 'claude-sonnet-5-5'), 2 + 10 + 0.2 + 2.5);
  assert.equal(costOf(usage, 'claude-opus-5-5'), 4 + 20 + 0.2 + 5);
  // The real 14-turn build of 2026-11-02: $0.7647, shown rounded up.
  assert.equal(roundUsd(costOf({ input_tokens: 30, output_tokens: 38617, cache_read_input_tokens: 645478, cache_creation_input_tokens: 97975 }, 'claude-sonnet-5-5')), 0.77);
  assert.equal(priceOf('claude-sonnet-5-5-20260901'), PRICES['claude-sonnet-5-5']);
  assert.equal(priceOf('some-new-model').output, Math.max(...Object.values(PRICES).map((p) => p.output)));
  assert.equal(costOf(null, 'claude-sonnet-5-5'), 0);
  assert.equal(roundUsd(0.0001), 0.01);
  assert.equal(roundUsd(0.5), 0.5);
});

test('the owner\'s day: spending adds up per owner, a used-up day refuses, yesterday is forgotten', async () => {
  const file = path.join(tempDir(), 'spend.json');
  assert.equal(await spentToday('a', file), 0);
  await Promise.all([recordSpend('a', 1.5, file), recordSpend('a', 2, file), recordSpend(null, 4, file), recordSpend('a', 0, file)]);
  assert.equal(await spentToday('a', file), 3.5);
  assert.equal(await spentToday(null, file), 4);
  assert.equal(await leftToday('a', file, 5), 1.5);
  await checkDailyBudget('a', file, 5);
  await assert.rejects(checkDailyBudget('a', file, 3.5), (err) => err.status === 429 && err.code === 'daily-budget' && /\$3\.50/.test(err.message));
  writeFileSync(file, JSON.stringify({ day: '2000-01-01', owners: { a: 99 } }));
  assert.equal(await spentToday('a', file), 0);
  assert.equal(BUILD_BUDGET.perBuildUsd > 0 && BUILD_BUDGET.perOwnerDayUsd > 0, true);
});

let seq = 0;
const PROMPT = { system: [{ type: 'text', text: 'You are the build agent.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'new' }] }] };
/** A Claude stand-in that keeps viewing the folder, each answer costing 100k cache reads + 10k written ($0.12 on Sonnet). */
const endless = {
  beta: {
    messages: {
      stream: () => ({
        finalMessage: async () => ({
          stop_reason: 'tool_use', model: 'claude-sonnet-5-5',
          content: [{ type: 'tool_use', id: `tu_${++seq}`, name: 'str_replace_based_edit_tool', input: { command: 'view', path: '/' } }],
          usage: { input_tokens: 0, output_tokens: 10000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 },
        }),
      }),
    },
  },
};

test('the agent stops at its dollar limit and reports its cost after every answer', async () => {
  const events = [];
  await assert.rejects(
    runAgent({ prompt: PROMPT, siteDir: tempDir(), client: endless, limits: { usd: 0.3 }, onEvent: (e) => e.type === 'usage' && events.push(e) }),
    (err) => err.code === 'agent-budget' && /cost limit \(\$0\.30\)/.test(err.message) && /files written so far are kept/.test(err.message),
  );
  // $0.12 a turn: after the third ($0.36) the limit is reached, so a fourth is never asked.
  assert.deepEqual(events.map((e) => e.costUsd), [0.12, 0.24, 0.36]);
  assert.deepEqual(events.map((e) => e.turns), [1, 2, 3]);
  assert.equal(events.at(-1).usage.output_tokens, 30000);
});
