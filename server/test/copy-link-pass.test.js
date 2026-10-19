// The link pass (server/src/copy/linkPass.js): the copy's HTML is rewritten only for the safe decisions. A fake checker
// stands in for the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkCounts, linkPass } from '../src/copy/linkPass.js';

const ORIGIN = 'https://www.site.test';

async function copyWith(t, html) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'about'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html, 'utf8');
  await writeFile(path.join(dir, 'about', 'index.html'), '<a href="https://site.test/about">x</a>', 'utf8');
  return dir;
}

/** answers: url -> result; unknown urls answer 200. */
const checkerFor = (answers) => ({ check: async (url) => answers[url] ?? { status: 200 } });
const noSleep = async () => {};

test('safe decisions are written into the copy; everything else is left as it is', async (t) => {
  const html = [
    '<a href="https://site.test/about">About</a>',        // wrong form, the copy has /about/ -> retarget
    '<a href="https://site.test/old">Old</a>',             // redirects -> final address
    '<a href="http://site.test/plain">Plain</a>',           // http works on https -> upgrade
    '<a href="https://dead.example.org/x">Dead</a>',        // external dead -> flagged only
    "<a href='https://login.example.org/'>Login</a>",       // 401 -> couldn't verify
  ].join('\n');
  const dir = await copyWith(t, html);
  const checker = checkerFor({
    'https://site.test/about': { status: 404 },
    'https://site.test/old': { status: 200, redirectedTo: 'https://site.test/new/' },
    'http://site.test/plain': { status: 404 },
    'https://site.test/plain': { status: 200 },
    'https://dead.example.org/x': { status: 404 },
    'https://login.example.org/': { status: 401 },
  });
  const r = await linkPass({ dir, originalUrl: ORIGIN, pages: [{ path: '/' }, { path: '/about/' }], checker, sleep: noSleep });
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(out, /href="\/about\/"/);
  assert.match(out, /href="https:\/\/site\.test\/new\/"/);
  assert.match(out, /href="https:\/\/site\.test\/plain"/);
  assert.match(out, /href="https:\/\/dead\.example\.org\/x"/, 'dead external link is not changed');
  assert.match(out, /href='https:\/\/login\.example\.org\/'/, 'unverified link is not changed, and its quotes are kept');
  const byHref = Object.fromEntries(r.links.map((l) => [l.href, l]));
  assert.equal(byHref['https://site.test/about'].action, 'retarget-page');
  assert.equal(byHref['https://dead.example.org/x'].action, 'flag-external');
  assert.equal(byHref['https://login.example.org/'].action, 'unverified');
  assert.equal(r.skippedForTime, 0);
});

test('a link the pass runs out of time for is reported as not checked, never guessed', async (t) => {
  const dir = await copyWith(t, '<a href="https://site.test/a">A</a>');
  let clock = 0;
  const r = await linkPass({ dir, originalUrl: ORIGIN, pages: [], checker: checkerFor({}), budgetMs: 10, now: () => { clock += 100; return clock; }, sleep: noSleep });
  // Every link of the copy is counted, and each one the pass did not reach is reported as such.
  assert.ok(r.skippedForTime >= 1);
  assert.equal(r.skippedForTime, r.links.length);
  assert.equal(r.links[0].note, 'not checked in time');
  assert.equal(r.links[0].action, 'unverified');
});

test('the counts line up with the decisions', () => {
  const c = linkCounts([
    { action: 'ok', verdict: 'ok' }, { action: 'retarget-page', verdict: 'broken' }, { action: 'flag-external', verdict: 'broken' }, { action: 'unverified', verdict: 'unverified' },
  ]);
  assert.deepEqual(c, { checked: 4, ok: 1, changed: 1, flagged: 1, couldNotVerify: 1, broken: 2 });
});
