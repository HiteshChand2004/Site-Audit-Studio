// Re-audit (reaudit/lighthousePages.js): a stop between Lighthouse runs ends the comparison and no further run is asked for
// (each would take the Lighthouse lane from another job). Without a stop every run is asked for, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareLighthousePages } from '../src/reaudit/lighthousePages.js';

const pages = [
  { path: '/', url: 'https://example.com/', copyUrl: 'http://127.0.0.1:9/' },
  { path: '/about/', url: 'https://example.com/about/', copyUrl: 'http://127.0.0.1:9/about/' },
];
async function compare(run, signal) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-lh-stop-'));
  try {
    return await compareLighthousePages({ pages, cacheDir: path.join(dir, 'cache'), outDir: path.join(dir, 'out'), run, signal });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('without a stop every page and mode is asked for, as before', async () => {
  const calls = [];
  const result = await compare(async (url, mode) => calls.push(`${mode} ${url}`)); // writes no report: each is an error
  assert.ok(calls.length >= pages.length, `${calls.length} runs`);
  assert.equal(result.errors.length, calls.length, 'each failed run recorded, the comparison went on');
});

test('a stop after the first run: no further run is asked for and the comparison ends as stopped', async () => {
  const stop = new AbortController();
  const calls = [];
  await assert.rejects(compare(async (url, mode) => {
    calls.push(`${mode} ${url}`);
    stop.abort();
  }, stop.signal), (e) => e.stopped === true);
  assert.equal(calls.length, 1);
});

test('a run that ended because of the stop (it left the lane) is not recorded as an error: the stop goes up', async () => {
  const calls = [];
  await assert.rejects(compare(async () => {
    calls.push(1);
    throw Object.assign(new Error('Stopped while waiting for Lighthouse.'), { stopped: true });
  }), (e) => e.stopped === true);
  assert.equal(calls.length, 1);
});
