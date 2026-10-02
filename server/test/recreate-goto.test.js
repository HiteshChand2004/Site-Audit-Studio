// A stalled load of one of our own local pages gets one more try; other errors are not hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gotoLocal } from '../src/recreate/verify/goto.js';

const fakePage = (results) => {
  const calls = [];
  return { calls, goto: async (url, options) => { calls.push(options.timeout); const next = results.shift(); if (next instanceof Error) throw next; return next; } };
};

test('a timeout is retried once with twice the time', async () => {
  const page = fakePage([new Error('page.goto: Timeout 15000ms exceeded.'), { ok: true }]);
  assert.deepEqual(await gotoLocal(page, 'http://127.0.0.1:1/', 15000), { ok: true });
  assert.deepEqual(page.calls, [15000, 30000]);
});

test('two timeouts fail, and an error that is not a timeout is thrown at once', async () => {
  const stalled = fakePage([new Error('Timeout 1ms exceeded'), new Error('Timeout 2ms exceeded')]);
  await assert.rejects(() => gotoLocal(stalled, 'http://127.0.0.1:1/', 1), /Timeout 2ms/);
  const refused = fakePage([new Error('net::ERR_CONNECTION_REFUSED')]);
  await assert.rejects(() => gotoLocal(refused, 'http://127.0.0.1:1/'), /ERR_CONNECTION_REFUSED/);
  assert.equal(refused.calls.length, 1);
});
