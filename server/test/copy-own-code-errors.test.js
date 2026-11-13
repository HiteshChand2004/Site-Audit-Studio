// A script error the copy logs from a line the original wrote word for word (copy/ownCodeErrors.js) is "The original's own
// code", not "Our bug": pitchlight.panscience.ai's header slot race, which only the fast local copy loses. An error at a line
// the copy wrote itself stays the copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { errorPlace, ownCodeErrors, sameCode } from '../src/copy/ownCodeErrors.js';
import { explainWorse } from '../src/copy/gotWorse.js';

const SITE = 'https://pitchlight.example.test/';
const COPY = 'http://127.0.0.1:34365';
const RACE = "if (!info || info.mode !== 'accounts') { slot.innerHTML = '<a href=\"/meeting\">Get started</a>'; return; }";
const OURS = "document.querySelector('#sas-added').innerHTML = window.__sasControls.label;";
const exception = (line) => ({ source: 'exception', description: `TypeError: Cannot set properties of null (setting 'innerHTML') at ${COPY}/:${line}:69`, sourceLocation: { url: `${COPY}/`, line: line - 1, column: 68 } });

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-own-code-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = ['<!doctype html><html><body>', '<header></header>', '<script>', "fetch('/auth/me').then((r) => r.json()).then((info) => {", "  const slot = document.getElementById('tester-slot');", `  ${RACE}`, '});', '</script></body></html>'].join('\n');
  const sha = createHash('sha256').update(original).digest('hex');
  const net = path.join(dir, 'capture', '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  await writeFile(path.join(net, 'files', sha), original);
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ entries: [{ url: SITE, kind: 'document', sha, bytes: original.length }] }));
  // The copy: a line of its own first (so the original's lines moved down), then the original's script with the address in it
  // rewritten the way the copy writes addresses ("/meeting" → "/meeting/", as on pitchlight).
  const copy = ['<!doctype html><html><body>', '<script>(function(){ /* address shim */ })();</script>', '<header></header>', '<script>', "fetch('/auth/me').then((r) => r.json()).then((info) => {", "  const slot = document.getElementById('tester-slot');", `  ${RACE.replace('/meeting"', '/meeting/"')}`, `  ${OURS}`, '});', '</script></body></html>'].join('\n');
  const root = path.join(dir, 'copy');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), copy);
  return { root, net };
}

test('the copy\'s address rewrites do not make a line different; other changes do', () => {
  const o = ['https://pitchlight.example.test'];
  assert.equal(sameCode('a.href = "/meeting/";', o), sameCode('a.href = "/meeting";', o));
  assert.equal(sameCode('s.src = "/static/js/nav~5333db55.js";', o), sameCode('s.src = "/static/js/nav.js";', o));
  assert.equal(sameCode('go("https://pitchlight.example.test/login")', o), sameCode('go("/login")', o));
  assert.notEqual(sameCode('slot.innerHTML = x;', o), sameCode('slot.textContent = x;', o));
});

test('the place of a script error is read from the message; a failed request is no script error', () => {
  assert.deepEqual(errorPlace(exception(7)), { url: `${COPY}/`, line: 7, column: 69 });
  assert.equal(errorPlace({ description: 'Failed to load resource: the server responded with a status of 404 (Not Found)', sourceLocation: { url: `${COPY}/x.js` } }), null);
});

test('an error at a line the original wrote is the original\'s own code; one at a line the copy wrote stays our bug', async (t) => {
  const { root, net } = await fixture(t);
  const items = [exception(7), exception(8)];
  const ownCode = await ownCodeErrors({ items, copyRoot: root, networkDir: net, siteUrl: SITE });
  assert.equal(ownCode.get(`${COPY}/:7`).inOriginal, true, 'line 7 of the copy is the original\'s line 6, apart from the rewritten address');
  assert.equal(ownCode.get(`${COPY}/:8`).inOriginal, false, 'line 8 is the copy\'s own');

  const row = (errs) => explainWorse({
    siteUrl: SITE, copyOrigin: COPY, copyPages: ['/'], chosenPages: ['/'], ownCode,
    newLhr: { desktop: { audits: { 'errors-in-console': { details: { items: errs } } } } },
    items: [{ status: 'regressed', key: 'lighthouse.errors-in-console', title: 'Browser errors were logged to the console' }],
  }).items[0];

  const theirs = row([exception(7)]);
  assert.equal(theirs.reason, 'own_code');
  assert.equal(theirs.group, 'own-code');
  assert.match(theirs.evidence, /original's own code/);
  assert.match(theirs.evidence, /line 7 of the copy's index\.html/);

  const ours = row([exception(8)]);
  assert.equal(ours.reason, null);
  assert.equal(ours.group, 'bug', 'an error in a line the copy wrote is still reported as our bug');

  const none = row([exception(7)]);
  const without = explainWorse({ siteUrl: SITE, copyOrigin: COPY, copyPages: ['/'], newLhr: { desktop: { audits: { 'errors-in-console': { details: { items: [exception(7)] } } } } }, items: [{ status: 'regressed', key: 'lighthouse.errors-in-console' }] }).items[0];
  assert.equal(none.reason, 'own_code');
  assert.equal(without.group, 'bug', 'without the evidence nothing is assumed');
});
