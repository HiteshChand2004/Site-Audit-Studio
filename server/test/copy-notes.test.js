// The notes inside a download (server/src/recreate/export/notes.js): DEPLOY.md always, KNOWN-ISSUES.md when items are open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesEntries } from '../src/recreate/export/notes.js';

test('DEPLOY.md is always in the download, for its stack and address', () => {
  const [deploy] = notesEntries({ report: { baseUrl: 'https://new.test' }, stack: 'nextjs', root: 'demo-nextjs' });
  assert.equal(deploy.name, 'demo-nextjs/DEPLOY.md');
  assert.match(deploy.content, /Next\.js/);
  assert.match(deploy.content, /https:\/\/new\.test/);
});

test('KNOWN-ISSUES.md is only there when something is open, with each item\'s reason letter', () => {
  const quiet = notesEntries({ report: { baseUrl: 'https://new.test', copy: { openItems: [] } }, stack: 'html', root: 'r' });
  assert.equal(quiet.length, 1, 'no open items: DEPLOY.md only');

  const report = { baseUrl: 'https://new.test', copy: { openItems: [{ page: '/menu', check: 'visual 390px', values: '58 (min 65)', tried: 'auto-repair, clean rebuild', reason: 'look' }] } };
  const [, known] = notesEntries({ report, stack: 'html', root: 'r' });
  assert.equal(known.name, 'r/KNOWN-ISSUES.md');
  assert.match(known.content, /## \/menu/);
  assert.match(known.content, /Reason: d — /);
});

test('the site name comes from the address when the report has none', () => {
  const [deploy] = notesEntries({ report: { baseUrl: 'https://www.acme.test/' }, stack: 'html', root: 'r' });
  assert.match(deploy.content, /# Deploy acme\.test/);
});
