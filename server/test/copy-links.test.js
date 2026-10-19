// Link re-checks for "Copy my site" (docs/COPY-MY-SITE.md §3): several checks with a pause, one verdict, one safe action.
// The checker is a fake here; the real browser checker is exercised only when the machine is free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_MS, linkSummary, recheckAll, recheckLink } from '../src/copy/linkCheck.js';
import { decideLink, outcomeOf } from '../src/copy/links.js';

/** A checker that answers the given list in order (the last answer repeats). */
function answers(list) {
  let i = 0;
  const calls = [];
  const check = async (url) => { calls.push(url); const a = list[Math.min(i, list.length - 1)]; i++; return a; };
  return { check, calls };
}
const pauses = () => { const ms = []; return { ms, sleep: async (n) => { ms.push(n); } }; };

test('a link answering 401 every time is "couldn\'t verify": never changed', async () => {
  const { check } = answers([{ status: 401 }]);
  const r = await recheckLink({ kind: 'internal', href: 'https://s.test/private' }, { check, sleep: async () => {} });
  assert.equal(r.verdict, 'unverified');
  assert.equal(r.action, 'unverified');
  assert.equal(r.checks, 3);
});

test('timeouts are "couldn\'t verify", not broken', async () => {
  const { check } = answers([{ timeout: true }]);
  const r = await recheckLink({ kind: 'external', href: 'https://slow.test/' }, { check, sleep: async () => {} });
  assert.equal(r.action, 'unverified');
});

test('a wrong internal path that 404s everywhere is retargeted to the copy\'s page', async () => {
  const { check } = answers([{ status: 404 }]);
  const r = await recheckLink({ kind: 'internal', href: 'https://s.test/about' }, {
    check, sleep: async () => {}, facts: async () => ({ copyPage: 'https://s.test/about/' }),
  });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.action, 'retarget-page');
  assert.equal(r.url, 'https://s.test/about/');
});

test('a dead internal page that is a 404 on the original too becomes the copy\'s 404 page', async () => {
  const { check } = answers([{ status: 404 }]);
  const r = await recheckLink({ kind: 'internal', href: 'https://s.test/gone' }, { check, sleep: async () => {}, facts: async () => ({ originalStatus: 404 }) });
  assert.equal(r.action, 'copy-404');
});

test('a dead external link is flagged with a suggestion and not changed', async () => {
  const { check } = answers([{ status: 404 }]);
  const r = await recheckLink({ kind: 'external', href: 'https://dead.test/x' }, { check, sleep: async () => {}, facts: async () => ({ suggestion: 'https://new.test/x' }) });
  assert.equal(r.action, 'flag-external');
  assert.equal(r.suggestion, 'https://new.test/x');
  assert.equal(r.url, undefined);
});

test('a redirect that ends somewhere else is followed to its final address', async () => {
  const { check } = answers([{ status: 200, redirectedTo: 'https://s.test/new' }]);
  const r = await recheckLink({ kind: 'internal', href: 'https://s.test/old' }, { check, sleep: async () => {} });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.action, 'redirect-final');
  assert.equal(r.url, 'https://s.test/new');
});

test('one clear success settles the link, so the rest of the checks are skipped', async () => {
  const { check, calls } = answers([{ status: 500 }, { status: 200 }, { status: 500 }]);
  const r = await recheckLink({ kind: 'internal', href: 'https://s.test/flaky' }, { check, sleep: async () => {} });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.action, 'ok');
  assert.equal(calls.length, 2);
});

test('the checks are spaced by the pause, never back to back', async () => {
  const { check } = answers([{ status: 404 }]);
  const p = pauses();
  await recheckLink({ kind: 'external', href: 'https://dead.test/' }, { check, sleep: p.sleep });
  assert.deepEqual(p.ms, [GAP_MS, GAP_MS]);
});

test('a batch is checked link by link and summarised per action', async () => {
  const seen = [];
  const check = async (url) => { seen.push(url); return url.includes('dead') ? { status: 404 } : { status: 200 }; };
  const results = await recheckAll([{ kind: 'external', href: 'https://ok.test/' }, { kind: 'external', href: 'https://dead.test/' }], { check, sleep: async () => {} });
  assert.equal(results.length, 2);
  assert.equal(seen[0], 'https://ok.test/');
  assert.deepEqual(linkSummary(results), { ok: 1, 'flag-external': 1 });
});

test('a redirect to another site (a login wall) is not followed: the link is left as it is', () => {
  const d = decideLink({ kind: 'external', href: 'https://www.linkedin.com/company/x/posts/' }, 'ok', { redirectedTo: 'https://www.linkedin.com/uas/login?session_redirect=x' });
  assert.equal(d.action, 'ok');
  assert.equal(d.url, undefined);
});

test('a redirect to a sign-in page on the same site is not followed either', () => {
  const d = decideLink({ kind: 'external', href: 'https://www.linkedin.com/company/x/' }, 'ok', { redirectedTo: 'https://www.linkedin.com/checkpoint/challenge' });
  assert.equal(d.action, 'ok');
});

test('a redirect within the same site is followed', () => {
  const d = decideLink({ kind: 'internal', href: 'https://site.test/old' }, 'ok', { redirectedTo: 'https://www.site.test/new/' });
  assert.equal(d.action, 'redirect-final');
});

test("a 999 answer (a site that blocks automated checks) is couldn't verify, never broken", () => {
  assert.equal(outcomeOf({ status: 999 }), 'unverified');
});
