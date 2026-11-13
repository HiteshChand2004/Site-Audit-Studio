// Honest results: "Got worse" / "Still open" count only what the tool can change ("our bug", "fix not built yet", and
// "measurement" until a proof says otherwise); every other row is marked outside, kept, and counted apart. And a console error
// from the page calling the site's own data address (its backend, answered by the original's server while captured) is put
// down to the backend, not to "a page not copied" or "the original's own code".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainWorse, markOutside, OUTSIDE_GROUPS } from '../src/copy/gotWorse.js';

const row = (key, status, group, reason = null) => ({ key, status, group, reason, title: key });

test('markOutside: only the tool\'s own rows stay in the counts; nothing is removed; reading twice changes nothing', () => {
  const items = [
    row('a.bug', 'regressed', 'bug'),
    row('a.owed', 'open', 'missing-fixer'),
    row('a.speed', 'regressed', 'measurement', 'deploy'),
    row('a.backend', 'regressed', 'needs-info', 'backend'),
    row('a.owner', 'open', 'needs-info', 'owner'),
    row('a.look', 'open', 'look', 'look'),
    row('a.code', 'regressed', 'own-code', 'third_party'),
    row('a.never', 'open', 'impossible'),
    row('a.fixed', 'fixed', 'needs-info'),
  ];
  const checklist = { items, summary: { regressed: 4, open: 4, fixed: 1, total: 9 } };
  markOutside(checklist);
  assert.deepEqual(checklist.summary, { regressed: 2, open: 1, fixed: 1, total: 9, outside: 5 });
  assert.deepEqual(checklist.outside, { total: 5, regressed: 2, open: 3, byGroup: { 'needs-info': 2, look: 1, 'own-code': 1, impossible: 1 } });
  assert.equal(items.length, 9, 'every row is kept');
  assert.deepEqual(items.filter((i) => i.outside).map((i) => i.key), ['a.backend', 'a.owner', 'a.look', 'a.code', 'a.never']);
  assert.ok(!items.find((i) => i.key === 'a.speed').outside, 'a measurement row stays in the main list');
  assert.ok(!items.find((i) => i.key === 'a.fixed').outside, 'only got worse / still open rows move');
  for (const i of items.filter((x) => x.outside)) assert.match(i.outsideWhy, /^[A-Z].+\.$/, `one plain sentence for ${i.key}`);
  assert.match(items.find((i) => i.key === 'a.backend').outsideWhy, /server or backend/);
  markOutside(checklist);
  assert.deepEqual(checklist.summary, { regressed: 2, open: 1, fixed: 1, total: 9, outside: 5 }, 'idempotent');
  assert.deepEqual([...OUTSIDE_GROUPS].sort(), ['impossible', 'look', 'needs-info', 'own-code']);
});

test('a console error from the site\'s own data address is the backend (outside), not a page left out or our bug', () => {
  const copyOrigin = 'http://127.0.0.1:50590';
  const errors = (paths) => ({ audits: { 'errors-in-console': { score: 0, details: { items: paths.map((p) => ({ source: 'network', description: 'Failed to load resource: the server responded with a status of 404 (Not Found)', sourceLocation: { url: `${copyOrigin}${p}` } })) } } } });
  const input = (backendPaths) => ({
    items: [{ key: 'lighthouse.errors-in-console', status: 'regressed', title: 'Browser errors were logged to the console', before: { status: 'pass' }, after: { status: 'fail' } }],
    siteUrl: 'https://shop.example.com/',
    copyOrigin,
    copyPages: ['/', '/signin.html', '/app.html'],
    newLhr: { mobile: errors(['/api/me']), desktop: errors(['/api/me', '/api/billing']) },
    backendPaths,
  });
  const [w] = explainWorse(input(['/api/me', '/api/billing'])).items;
  assert.equal(w.reason, 'backend', w.evidence);
  assert.equal(w.group, 'needs-info');
  assert.match(w.evidence, /own server for data \(\/api\/me\)/);
  const checklist = markOutside({ items: [{ ...w, status: 'regressed' }], summary: { regressed: 1 } });
  assert.equal(checklist.items[0].outside, true);
  assert.equal(checklist.summary.regressed, 0);
  // Without the capture's evidence that these addresses answer with data, the same row is not put down to a backend.
  const [plain] = explainWorse(input([])).items;
  assert.notEqual(plain.reason, 'backend');
});
