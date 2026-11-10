// Step 5a: the fix registry (copy/fixRegistry.js) is the one place that says which kind of as-is fix answers which check. These
// pin it to the tables it replaced (copy/fixAsIs.js counts and the markup pass, reaudit/compare/rules.js AS_IS / AS_IS_FIELDS,
// copy/gotWorse.js ATTR_FIXES), so moving them changed nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXES, FIELDS, KINDS_BY_KEY, MARKUP_PASS, emptyCounts, fixGroup, fixOf, goneBy } from '../src/copy/fixRegistry.js';

test('counts and the markup pass keep their kinds and their order', () => {
  assert.deepEqual(Object.keys(emptyCounts()), ['alt', 'names', 'aria', 'head', 'data', 'address', 'lang', 'anchors', 'linktext', 'headings', 'prohibited', 'scrollable', 'lcp', 'lazy', 'webp']);
  assert.ok(Object.values(emptyCounts()).every((v) => v === 0));
  assert.deepEqual(MARKUP_PASS.map((f) => f.kind), ['anchors', 'linktext', 'headings', 'prohibited', 'scrollable']);
  assert.deepEqual(MARKUP_PASS.filter((f) => f.needs === 'perf').map((f) => f.kind), ['scrollable']);
});

test('the checks each kind answers are the ones the re-check used before', () => {
  const asIs = Object.fromEntries(FIXES.filter((f) => f.targets.length).map((f) => [f.kind, f.targets]));
  assert.deepEqual(Object.keys(asIs), ['alt', 'names', 'aria', 'data', 'lang', 'viewport', 'linktext', 'headings', 'prohibited', 'scrollable', 'lcp', 'lazy', 'webp', 'css']);
  assert.deepEqual(KINDS_BY_KEY.get('axe.link-name'), ['names', 'linktext']);
  assert.deepEqual(KINDS_BY_KEY.get('crawl.meta-tags'), ['viewport', 'field:themeColor', 'field:icon']);
  assert.deepEqual(KINDS_BY_KEY.get('lighthouse.total-byte-weight'), ['webp', 'css']);
  assert.deepEqual(KINDS_BY_KEY.get('seo.title-tag.length'), ['field:title']);
  assert.deepEqual(Object.keys(FIELDS), ['title', 'description', 'canonical', 'og', 'themeColor', 'icon']);
  assert.equal(fixOf('prohibited').what, 'role="img" on a named element with no text');
  assert.equal(fixOf('scrollable').what, 'tabindex="0" on a box that scrolls');
  assert.equal(fixOf('nothing'), null);
});

test('fixGroup splits the head three ways, as before', () => {
  assert.equal(fixGroup({ kind: 'head', field: 'title' }), 'head:title');
  assert.equal(fixGroup({ kind: 'head', field: 'description' }), 'head:description');
  for (const field of ['canonical', 'og:url', 'og:title', 'og:description', 'theme-color', 'icon']) assert.equal(fixGroup({ kind: 'head', field }), 'head:meta', field);
  assert.equal(fixGroup({ kind: 'address', field: 'og:url' }), 'head:meta');
  assert.equal(fixGroup({ kind: 'address', field: 'other' }), 'address');
  assert.equal(fixGroup({ kind: 'alt' }), 'alt');
});

test('how a problem is shown gone follows its check key', () => {
  assert.equal(goneBy('seo.title-tag.length'), 'markup');
  assert.equal(goneBy('aeo.json-ld-schema'), 'markup');
  assert.equal(goneBy('crawl.meta-tags'), 'markup');
  assert.equal(goneBy('axe.aria-prohibited-attr'), 'axe');
  assert.equal(goneBy('lighthouse.offscreen-images'), 'recheck');
});
