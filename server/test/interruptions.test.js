import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { explainFailure, networkFailure, resolverAnswers, retryableFailure, waitForNetwork, watchNetwork, watchPauses } from '../src/audit/interruptions.js';
import { interruptionNote, runAnalysis } from '../src/audit/index.js';
import { createNetPolicy } from '../src/security/netGuard.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test('which failures an interruption can explain', () => {
  for (const m of ['Rendering + accessibility timed out after 175s', 'page.goto: Timeout 67500ms exceeded.', 'net::ERR_INTERNET_DISCONNECTED at https://x/', 'net::ERR_NETWORK_CHANGED', 'getaddrinfo EAI_AGAIN x.com']) {
    assert.equal(retryableFailure(m), true, m);
  }
  for (const m of ['Accessibility scan failed: Cannot read properties of undefined', 'Blocked: private address', 'Unexpected token < in JSON']) {
    assert.equal(retryableFailure(m), false, m);
  }
  assert.equal(networkFailure('net::ERR_NAME_NOT_RESOLVED'), true);
  assert.equal(networkFailure('Checking links timed out after 64s'), false);
});

test('a timer that fires far too late is a pause (sleep / standby)', async () => {
  let offset = 0;
  const watch = watchPauses({ tickMs: 20, minPauseMs: 5000, now: () => Date.now() + offset });
  const before = Date.now();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(watch.pausedBetween(before), 0);
  offset = 30000; // the clock jumps: the machine slept for 30 s
  await new Promise((r) => setTimeout(r, 60));
  watch.stop();
  const paused = watch.pausedBetween(before, Date.now() + offset);
  assert.ok(paused >= 29000 && paused <= 30100, `paused ${paused}`);
  assert.equal(watch.pausedBetween(Date.now() + offset + 1000), 0, 'a step that started after the pause was not paused');
});

test('explainFailure: retry after sleep or a network outage, never for a real timeout or a hanging site', async () => {
  const url = 'https://example.test/';
  const noPause = { pausedBetween: () => 0 };
  const slept = { pausedBetween: () => 42000 };
  const up = async () => true;
  const down = async () => false;
  const base = { url, startedAt: 0, until: Date.now() + 1000 };
  // Not a timeout or network error: the step's own error stands.
  assert.equal(await explainFailure('Accessibility scan failed: x', { ...base, pauses: slept, probe: up }), null);
  // A timeout on a working network with no sleep: a real timeout (a slow site or machine), no retry.
  assert.equal(await explainFailure('Render timed out after 110s', { ...base, pauses: noPause, probe: up }), null);
  // The site does not answer but DNS does: the site hangs, this computer's network is fine: no waiting, no retry.
  let dnsAsked = 0;
  const started = Date.now();
  assert.equal(await explainFailure('Render timed out after 110s', { ...base, pauses: noPause, probe: down, dnsUp: async () => (dnsAsked++, true) }), null);
  assert.equal(dnsAsked, 1);
  assert.ok(Date.now() - started < 500);
  // The computer slept during the step and the network is back: retry at once.
  assert.deepEqual(await explainFailure("Render timed out after 110s", { ...base, pauses: slept, probe: up }), { retry: true, cause: "sleep", pausedMs: 42000, downMs: 0, waitedMs: 0 });
  // A network error that is gone now: retry.
  assert.equal((await explainFailure('net::ERR_NETWORK_CHANGED', { ...base, pauses: noPause, probe: up })).retry, true);
  // The network is down (DNS gets no answer): wait until the site answers again, then retry.
  let calls = 0;
  const comesBack = async () => ++calls >= 3;
  const r = await explainFailure('Render timed out after 110s', { url, startedAt: 0, until: Date.now() + 5000, pauses: noPause, probe: comesBack, dnsUp: down, everyMs: 10 });
  assert.equal(r.retry, true);
  assert.equal(r.cause, 'network');
  // ...and gives up when it does not come back before `until`.
  const never = await explainFailure('Render timed out after 110s', { url, startedAt: 0, until: Date.now() + 50, pauses: noPause, probe: down, dnsUp: down });
  assert.equal(never.retry, false);
  assert.match(interruptionNote(never), /did not come back/);
  assert.match(interruptionNote({ cause: 'sleep', pausedMs: 42000, waitedMs: 0, retry: true }), /asleep for 42 s; tried again once/);
});

test('watchNetwork records an outage from the last answered check to the next one', async () => {
  let up = true;
  const watch = watchNetwork('example.test', { everyMs: 15, check: async () => up });
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(watch.downBetween(start), 0);
  up = false; // Wi-Fi off
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(watch.downBetween(start) > 0, 'down while it lasts');
  up = true; // Wi-Fi back
  await new Promise((r) => setTimeout(r, 60));
  watch.stop();
  const down = watch.downBetween(start);
  assert.equal(watch.outages.length, 1);
  assert.ok(down >= 60 && down < 250, `down ${down}`);
  assert.equal(watch.downBetween(Date.now()), 0, 'a step that started after the outage was not hit');
});

test('a step hit by a short outage is retried although the network is back when its timeout fires (the Wi-Fi off/on case)', async () => {
  const base = { url: 'https://example.test/', startedAt: 0, until: Date.now() + 1000, pauses: { pausedBetween: () => 0 }, probe: async () => true };
  // The page.goto timeout fired after the network came back: before, this was taken for a real timeout.
  const r = await explainFailure('page.goto: Timeout 67500ms exceeded.', { ...base, outages: { downBetween: () => 25000 } });
  assert.deepEqual(r, { retry: true, cause: 'network', pausedMs: 0, downMs: 25000, waitedMs: 0 });
  // No outage during the step: still a real timeout.
  assert.equal(await explainFailure('page.goto: Timeout 67500ms exceeded.', { ...base, outages: { downBetween: () => 0 } }), null);
});

test('waitForNetwork probes until the site answers or the time is up', async () => {
  let n = 0;
  const back = await waitForNetwork('https://x.test/', { until: Date.now() + 2000, everyMs: 10, probe: async () => ++n === 4 });
  assert.equal(back.back, true);
  assert.equal(n, 4);
  const gone = await waitForNetwork('https://x.test/', { until: Date.now() + 30, everyMs: 10, probe: async () => false });
  assert.equal(gone.back, false);
});

test('resolverAnswers: an IP address (a local preview) needs no network', async () => {
  assert.equal(await resolverAnswers('127.0.0.1'), true);
  assert.equal(await resolverAnswers('[::1]'), true);
});

test('an analysis whose homepage was unreachable at first (network down) waits for it and goes on', async () => {
  // A port that refuses connections at first, like a dropped network; the site comes up 1.5 s later.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Back again</title></head><body><main><h1>Back again</h1><p>The network came back.</p></main></body></html>');
  });
  const up = setTimeout(() => site.listen(port, '127.0.0.1'), 1500);
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'sas-interrupt-'));
  dirs.push(outDir);
  const messages = [];
  try {
    const audit = await runAnalysis({
      project: { id: 'interrupt', url: `http://127.0.0.1:${port}/`, name: 'interrupt' },
      analysisId: 'a1',
      maxPages: 1,
      outDir,
      skip: ['lighthouse-mobile', 'lighthouse-desktop', 'screenshots', 'links'],
      netPolicy: createNetPolicy({ internalPorts: [port] }),
      progress: (step, _f, message) => message && messages.push(`${step}: ${message}`),
    });
    assert.ok(messages.some((m) => /^fetch: Fetching .* again \(the network dropped\)/.test(m)), messages.join('\n'));
    assert.equal(audit.errors.filter((e) => e.step === 'fetch').length, 0);
    assert.ok(audit.seo.length > 0);
  } finally {
    clearTimeout(up);
    await new Promise((r) => site.close(r));
  }
});
