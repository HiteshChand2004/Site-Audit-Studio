import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { awakeHeld, awakeHelper, holdAwake, keepAwakeCommand, keepAwakeEnabled, releaseAwake } from '../src/jobs/keepAwake.js';
import { exclusive } from '../src/jobs/manager.js';

test('keep-awake: one helper per platform, ends with the server process, can be turned off', () => {
  const win = keepAwakeCommand('win32', 1234);
  assert.equal(win.cmd, 'powershell.exe');
  const script = Buffer.from(win.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483651\)/); // ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
  assert.match(script, /Get-Process -Id 1234/);
  assert.deepEqual(keepAwakeCommand('darwin', 1234), { cmd: 'caffeinate', args: ['-di', '-w', '1234'] });
  assert.equal(keepAwakeCommand('linux').cmd, 'systemd-inhibit');
  assert.equal(keepAwakeCommand('aix'), null);
  assert.equal(keepAwakeEnabled({}), true);
  assert.equal(keepAwakeEnabled({ SAS_KEEP_AWAKE: '0' }), false);
  // Turned off: nothing is started.
  holdAwake({ SAS_KEEP_AWAKE: '0' });
  assert.equal(awakeHelper(), null);
});

test('keep-awake: held while a job runs, released after the last one (real helper)', { skip: process.platform !== 'win32' && 'the helper is tested on Windows' }, async () => {
  process.env.SAS_KEEP_AWAKE = '1';
  try {
    let helper;
    await exclusive(async () => {
      helper = awakeHelper();
      assert.ok(helper, 'a helper is started with the job');
      // The helper prints "awake" only after Windows accepted the request.
      const [line] = await Promise.race([once(helper.stdout, 'data'), once(helper, 'exit').then(([code]) => [`exit ${code}`])]);
      assert.equal(String(line).trim(), 'awake');
      assert.equal(awakeHeld(), true);
    });
    // Still held right after the job (a follow-up job may start), released after the delay.
    assert.equal(awakeHelper(), helper);
    releaseAwake({ delayMs: 10 });
    await once(helper, 'exit');
    assert.equal(awakeHeld(), false);
  } finally {
    process.env.SAS_KEEP_AWAKE = '0';
  }
});
