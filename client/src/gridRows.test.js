// Run: node --test client/src/gridRows.test.js (the client has no test runner; this uses node:test only and is never bundled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_ROWS, ROWS_PER_CLICK, columnsOf, hasMore, shownCount } from './gridRows.js';

test('the first view is whole rows, and the button only when cards are left', () => {
  // 4 columns: 2 rows hold 8. The bug: a fixed 6 left the second row half empty with "Show all" for one card.
  assert.equal(shownCount({ total: 7, columns: 4, rows: FIRST_ROWS }), 7);
  assert.equal(hasMore({ total: 7, columns: 4, rows: FIRST_ROWS }), false);
  assert.equal(shownCount({ total: 9, columns: 4, rows: FIRST_ROWS }), 8);
  assert.equal(hasMore({ total: 9, columns: 4, rows: FIRST_ROWS }), true);
  // Exactly full: no button.
  assert.equal(shownCount({ total: 10, columns: 5, rows: FIRST_ROWS }), 10);
  assert.equal(hasMore({ total: 10, columns: 5, rows: FIRST_ROWS }), false);
  // A phone: one column.
  assert.equal(shownCount({ total: 5, columns: 1, rows: FIRST_ROWS }), 2);
  assert.equal(hasMore({ total: 5, columns: 1, rows: FIRST_ROWS }), true);
  assert.equal(shownCount({ total: 0, columns: 3, rows: FIRST_ROWS }), 0);
});

test('each click adds whole rows until every card shows', () => {
  let rows = FIRST_ROWS;
  const total = 23;
  const columns = 3;
  const seen = [];
  while (hasMore({ total, columns, rows })) {
    seen.push(shownCount({ total, columns, rows }));
    rows += ROWS_PER_CLICK;
  }
  seen.push(shownCount({ total, columns, rows }));
  assert.deepEqual(seen, [6, 12, 18, 23]);
  assert.ok(seen.slice(0, -1).every((n) => n % columns === 0), 'every step before the last ends on a full row');
});

test('the same rows give whole rows at any width (resize)', () => {
  for (const columns of [1, 2, 3, 4, 5, 6]) {
    const n = shownCount({ total: 40, columns, rows: FIRST_ROWS });
    assert.equal(n % columns, 0, `${columns} columns`);
  }
});

test('columns are read from the grid\'s computed tracks', () => {
  const el = {};
  assert.equal(columnsOf(el, () => ({ gridTemplateColumns: '250px 250px 250px 250px' })), 4);
  assert.equal(columnsOf(el, () => ({ gridTemplateColumns: '  312.5px  312.5px ' })), 2);
  assert.equal(columnsOf(el, () => ({ gridTemplateColumns: 'none' })), 1);
  assert.equal(columnsOf(el, () => ({ gridTemplateColumns: '' })), 1);
  assert.equal(columnsOf(null), 1);
});
