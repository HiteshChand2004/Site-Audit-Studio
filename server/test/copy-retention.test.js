// Retention (docs/COPY-MY-SITE.md §9): the newest finished copy of each stack is never removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestPerStack } from '../src/recreate/workspace.js';

test('the newest copy of each stack is kept; older copies of the same stack are not', () => {
  const rows = [
    { id: 'n2', report: { stack: 'nextjs' } },
    { id: 'h1', report: { stack: 'html' } },
    { id: 'n1', report: { stack: 'nextjs' } },
    { id: 'm1', report: { stack: 'mern' } },
    { id: 'h0', report: { stack: 'html' } },
  ];
  assert.deepEqual([...newestPerStack(rows)].sort(), ['h1', 'm1', 'n2']);
});

test('a copy with no stack recorded counts as plain HTML; a row with no report still has its place', () => {
  const kept = newestPerStack([{ id: 'a', report: null }, { id: 'b', report: {} }, { id: 'c', report: { stack: 'html' } }]);
  assert.deepEqual([...kept], ['a']);
  assert.deepEqual([...newestPerStack([])], []);
});
