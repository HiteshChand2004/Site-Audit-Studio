import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  linuxSample, meterEnabled, meterIntervalMs, meterJob, meterRunning, newRecording, parseRss, parseStat, parseWindowsLine, windowsHelperCommand,
} from '../src/jobs/meter.js';
import { DATA_DIR } from '../src/config/paths.js';

test('meter: off by default, on only with SAS_METER=1; interval bounded', () => {
  assert.equal(meterEnabled({}), false);
  assert.equal(meterEnabled({ SAS_METER: '0' }), false);
  assert.equal(meterEnabled({ SAS_METER: '1' }), true);
  assert.equal(meterJob({ id: 'x', step: null }, 'recreates', {}), null, 'nothing starts when off');
  assert.equal(meterRunning(), false);
  assert.equal(meterIntervalMs({}), 1000);
  assert.equal(meterIntervalMs({ SAS_METER_MS: '50' }), 1000, 'out of range falls back');
  assert.equal(meterIntervalMs({ SAS_METER_MS: '500' }), 500);
});

test('meter (Linux): the process tree under the server, CPU per process, an ended process does not subtract', () => {
  // A fake /proc: 10 = server, 11 = Chromium (child), 12 = renderer (grandchild), 20 = unrelated, 13 = the meter's own helper.
  const stat = (pid, name, ppid, utime, stime) => `${pid} (${name}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0`;
  let table = {
    10: [stat(10, 'node', 1, 100, 50), 'VmRSS:\t  102400 kB'],
    11: [stat(11, 'chrome with spaces) x', 10, 200, 0), 'VmRSS:\t  204800 kB'],
    12: [stat(12, 'chrome', 11, 10, 0), 'VmRSS:\t   51200 kB'],
    13: [stat(13, 'helper', 10, 999, 0), 'VmRSS:\t  999999 kB'],
    20: [stat(20, 'other', 1, 5000, 0), 'VmRSS:\t 9999999 kB'],
  };
  const io = {
    list: () => Object.keys(table),
    read: (f) => {
      const [, pid, kind] = /\/proc\/(\d+)\/(status|stat)$/.exec(f) ?? [];
      return table[pid]?.[kind === 'stat' ? 0 : 1] ?? null;
    },
    skip: new Set([13]),
  };
  assert.deepEqual(parseStat(stat(5, 'a (b) c', 4, 7, 3)), { ppid: 4, ticks: 10 });
  assert.equal(parseRss('Name:\tx\nVmRSS:\t  2048 kB\n'), 2048 * 1024);
  assert.equal(parseRss('Name:\tkthread\n'), 0);

  const first = linuxSample(10, new Map(), io);
  assert.equal(first.procs, 3, 'server + chromium + renderer; the helper and the unrelated process are left out');
  assert.equal(first.rssBytes, (102400 + 204800 + 51200) * 1024);
  assert.equal(first.cpuSec, 0, 'the first sample is the baseline');

  // One second later: node +1 s, chromium +2 s; the renderer ended; a new renderer 14 appeared with 0.3 s.
  table = { ...table, 10: [stat(10, 'node', 1, 200, 50), table[10][1]], 11: [stat(11, 'chrome', 10, 400, 0), table[11][1]], 14: [stat(14, 'chrome', 11, 30, 0), 'VmRSS:\t 1024 kB'] };
  delete table[12];
  const second = linuxSample(10, first.cpu, io);
  assert.equal(second.procs, 3);
  assert.equal(Math.round(second.cpuSec * 10) / 10, 3.3, '1 + 2 + 0.3 s: the ended renderer subtracts nothing');
});

test('meter (Windows): the helper prints one line per sample and leaves itself out', () => {
  const { cmd, args } = windowsHelperCommand(4321, 750);
  assert.equal(cmd, 'powershell.exe');
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /\[SasMeter\]::Tick\(4321, \$PID\)/);
  assert.match(script, /Start-Sleep -Milliseconds 750/);
  assert.match(script, /while \(Get-Process -Id 4321/, 'ends when the server ends');
  assert.deepEqual(parseWindowsLine('104857600 25000000 7\r'), { rssBytes: 104857600, cpuSec: 2.5, procs: 7 });
  assert.equal(parseWindowsLine('Add-Type warning'), null);
});

test('meter: peak, mean and CPU per job and per step, from the step the job line shows', () => {
  const job = { step: 'inspect' };
  const rec = newRecording({ id: 'j', table: 'recreates', stepOf: () => job.step, intervalMs: 1000, method: 'test', startedAt: 0 });
  const mb = (n) => n * 1024 * 1024;
  rec.add({ rssBytes: mb(500), cpuSec: 1, at: 1000 });
  rec.add({ rssBytes: mb(900), cpuSec: 2, at: 2000 });
  job.step = 'build';
  rec.add({ rssBytes: mb(700), cpuSec: 0.5, at: 3000 });
  const s = rec.summary({ status: 'done', endedAt: 3000 });
  assert.equal(s.peakMB, 900);
  assert.equal(s.peakStep, 'inspect');
  assert.equal(s.meanMB, 700);
  assert.equal(s.cpuSec, 3.5);
  assert.equal(s.samples, 3);
  assert.deepEqual(s.byStep.inspect, { ms: 2000, peakMB: 900, cpuSec: 3, samples: 2 });
  assert.deepEqual(s.byStep.build, { ms: 1000, peakMB: 700, cpuSec: 0.5, samples: 1 });
  assert.equal(s.shared, false);
});

test('meter: a real job on this machine sees a child process that holds memory', { skip: !['win32', 'linux'].includes(process.platform) && 'Windows and Linux only' }, async () => {
  const job = { id: `meter-test-${process.pid}`, step: 'idle' };
  const meter = meterJob(job, 'test', { SAS_METER: '1', SAS_METER_MS: '250' });
  assert.ok(meter);
  assert.equal(meterRunning(), true);
  await new Promise((r) => setTimeout(r, 2500)); // Windows: the helper compiles its loop once (~1-2 s)
  job.step = 'busy';
  // A child process (like a browser) that holds ~300 MB and keeps a CPU busy for ~2 s.
  const child = spawn(process.execPath, ['-e', 'const b = Buffer.alloc(300*1024*1024, 1); const t = Date.now(); while (Date.now() - t < 2000) {} setTimeout(() => process.exit(0), 1000); b[0]']);
  await new Promise((r) => child.on('exit', r));
  const s = meter.stop({ status: 'done' });
  assert.equal(meterRunning(), false, 'the sampler stops with the last metered job');
  assert.ok(s.samples >= 4, `samples: ${s.samples}`);
  assert.ok(s.byStep.busy, 'samples during the child are attributed to its step');
  assert.ok(s.byStep.busy.peakMB - s.byStep.idle.peakMB >= 200, `child memory seen: idle ${s.byStep.idle.peakMB} MB, busy ${s.byStep.busy.peakMB} MB`);
  assert.ok(s.byStep.busy.cpuSec >= 1, `child CPU seen: ${s.byStep.busy.cpuSec} s`);
  const file = path.join(DATA_DIR, 'meter', `test-${job.id}.json`);
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).peakMB, s.peakMB);
});
