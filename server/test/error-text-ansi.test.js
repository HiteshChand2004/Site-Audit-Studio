// Terminal colour codes never reach a user: removed from a job's error before it is kept (server) and from an error text shown
// in the app (client). The same rule on both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi as serverStrip } from '../src/jobs/ansi.js';
import { stripAnsi as clientStrip } from '../../client/src/ansi.js';

const RAW = 'page.goto: net::ERR_CONNECTION_REFUSED\nCall log:\n\u001b[2m  - navigating\u001b[22m\n�[2m  - waiting�[22m';

for (const [side, strip] of [['server', serverStrip], ['client', clientStrip]]) {
  test(`${side}: colour codes are removed, the words stay`, () => {
    const out = strip(RAW);
    assert.doesNotMatch(out, /\[2m|\[22m|\u001b/, 'no colour code is left');
    assert.match(out, /ERR_CONNECTION_REFUSED/);
    assert.match(out, /navigating/);
    assert.equal(strip(undefined), '', 'nothing to strip');
  });
}
