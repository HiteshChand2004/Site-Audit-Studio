// SAS_COPY_MAX_PAGES (recreate/pageCap.js): a busy server keeps every copy to a few pages, "All pages" and the as-is page choice
// included; unset, nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyPageCap } from '../src/recreate/pageCap.js';
import { asIsPagesOf } from '../src/recreate/behavior/preserve/asis.js';

test('the cap is read from SAS_COPY_MAX_PAGES, and anything unreadable is no cap', () => {
  assert.equal(copyPageCap({}), null);
  assert.equal(copyPageCap({ SAS_COPY_MAX_PAGES: '' }), null);
  assert.equal(copyPageCap({ SAS_COPY_MAX_PAGES: '10' }), 10);
  assert.equal(copyPageCap({ SAS_COPY_MAX_PAGES: ' 1 ' }), 1);
  for (const bad of ['0', '-3', '2.5', 'ten', '301']) assert.equal(copyPageCap({ SAS_COPY_MAX_PAGES: bad }), null, bad);
});

test('an as-is copy takes at most the cap, homepage first', (t) => {
  const project = { url: 'https://site.test/' };
  const asked = Array.from({ length: 30 }, (_, i) => `/p${i}/`);
  const before = process.env.SAS_COPY_MAX_PAGES;
  t.after(() => (before == null ? delete process.env.SAS_COPY_MAX_PAGES : (process.env.SAS_COPY_MAX_PAGES = before)));
  delete process.env.SAS_COPY_MAX_PAGES;
  assert.equal(asIsPagesOf(project, asked).length, 31, 'no cap: every page asked for');
  process.env.SAS_COPY_MAX_PAGES = '10';
  const pages = asIsPagesOf(project, asked);
  assert.equal(pages.length, 10);
  assert.equal(pages[0], 'https://site.test/');
  assert.equal(pages[9], 'https://site.test/p8/');
});
