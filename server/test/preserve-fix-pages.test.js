// How many pages the as-is copy fixes and checks at once (behavior/preserve/stage.js fixPagesAtOnce): SAS_FIX_PAGES fixes the
// number on a large server, as SAS_CAPTURE_PAGES does for visiting the pages; anything else leaves the memory rule (at most 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixPagesAtOnce } from '../src/recreate/behavior/preserve/stage.js';

test('SAS_FIX_PAGES sets the pages fixed at once (1–8); unset or unreadable keeps the memory rule, at most 2', () => {
  assert.equal(fixPagesAtOnce({ SAS_FIX_PAGES: '5' }), 5);
  assert.equal(fixPagesAtOnce({ SAS_FIX_PAGES: ' 1 ' }), 1);
  for (const v of [undefined, '', '0', '9', '2.5', 'four']) {
    const n = fixPagesAtOnce(v === undefined ? {} : { SAS_FIX_PAGES: v });
    assert.ok(n >= 1 && n <= 2, `${v} → ${n}`);
  }
});
