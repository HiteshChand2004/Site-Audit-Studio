// "Copy my site" building blocks (docs/COPY-MY-SITE.md): thresholds, broken links, open-item reasons, zero regressions,
// the results line, DEPLOY.md / KNOWN-ISSUES.md and the progress stages. Pure functions only: no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VISUAL_MIN, pageProblems } from '../src/copy/thresholds.js';
import { ATTEMPTS, consensus, decideLink, outcomeOf } from '../src/copy/links.js';
import { REASONS, reasonFor, unexplained } from '../src/copy/openItems.js';
import { STACK_FACTS, deployMd, issueRecord, knownIssuesMd } from '../src/copy/deploy.js';
import { keepChange, summaryLine, worseItems } from '../src/copy/regress.js';
import { COPY_STAGES, stageIndex, stageOf } from '../src/copy/stages.js';

test('thresholds: a page that matches the original fails no check', () => {
  assert.deepEqual(pageProblems({
    visual: { 1440: 96, 390: 92 }, heightRatio: { 1440: 1.01, 390: 0.99 },
    hover: { matched: 19, total: 20 }, controls: { same: 5, total: 5 }, newConsoleErrors: 0,
    lighthouse: { performance: 88, categories: { seo: 100, accessibility: 95, 'best-practices': 100 } },
    original: { categories: { seo: 100, accessibility: 92, 'best-practices': 96 } },
  }), []);
});

test('thresholds: each failing check is named with its value and its limit', () => {
  const p = pageProblems({ visual: { 390: VISUAL_MIN - 1 }, heightRatio: { 1440: 1.2 }, hover: { matched: 1, total: 10 }, controls: { same: 2, total: 4 }, newConsoleErrors: 2, lighthouse: { performance: 40, categories: { seo: 80 } }, original: { categories: { seo: 90 } } });
  const names = p.map((x) => x.check);
  for (const n of ['visual', 'height', 'hover', 'controls', 'console', 'lighthouse-performance', 'lighthouse-seo']) assert.ok(names.includes(n), n);
  assert.equal(p.find((x) => x.check === 'visual').width, 390);
});

test('thresholds: a measurement that was not taken is not a failure', () => {
  assert.deepEqual(pageProblems({ hover: { matched: 0, total: 0 }, controls: { same: 0, total: 0 } }), []);
});

test('broken links: a check that answers 401, 403, 429 or times out is "couldn\'t verify", never broken', () => {
  for (const status of [401, 403, 429]) assert.equal(outcomeOf({ status }), 'unverified');
  assert.equal(outcomeOf({ timeout: true }), 'unverified');
  assert.equal(outcomeOf({ status: 404 }), 'broken');
  assert.equal(outcomeOf({ status: 200 }), 'ok');
  assert.equal(outcomeOf({ status: 301 }), 'ok');
});

test('broken links: called broken only when every attempt says so', () => {
  assert.equal(consensus(Array(ATTEMPTS).fill('broken')), 'broken');
  assert.equal(consensus(['broken', 'ok', 'broken']), 'ok');
  assert.equal(consensus(['broken', 'unverified', 'broken']), 'unverified');
  assert.equal(consensus(['broken', 'broken']), 'unverified', 'fewer checks than the retries is not a verdict');
});

test('broken links: safe internal fixes, in order', () => {
  const link = (href) => ({ kind: 'internal', href });
  assert.deepEqual(decideLink(link('http://site.test/a'), 'broken', { httpsWorks: true, copyPage: '/a/' }), { action: 'https-upgrade', url: 'https://site.test/a' });
  assert.deepEqual(decideLink(link('/a'), 'broken', { copyPage: '/a/' }), { action: 'retarget-page', url: '/a/' });
  assert.deepEqual(decideLink(link('/gone'), 'broken', { originalStatus: 404 }), { action: 'copy-404' });
  assert.equal(decideLink(link('/unknown'), 'broken', {}).action, 'flag-internal', 'not confirmed as missing: unchanged');
});

test('broken links: a redirect is followed to its final address; a working link is left alone', () => {
  assert.deepEqual(decideLink({ kind: 'internal', href: '/old' }, 'ok', { redirectedTo: '/new' }), { action: 'redirect-final', url: '/new' });
  assert.equal(decideLink({ kind: 'external', href: 'https://x.test/' }, 'ok', {}).action, 'ok');
});

test('broken links: dead external links are flagged with a suggestion, never changed; unverified links are noted', () => {
  const d = decideLink({ kind: 'external', href: 'https://dead.test/' }, 'broken', { suggestion: 'https://new.test/' });
  assert.equal(d.action, 'flag-external');
  assert.equal(d.suggestion, 'https://new.test/');
  assert.equal(d.url, undefined, 'the link itself is not changed');
  assert.equal(decideLink({ kind: 'external', href: 'https://login.test/' }, 'unverified').note, "couldn't verify");
});

test('open items: every reason is one of the five, and an item with none is still owed', () => {
  assert.equal(reasonFor({ key: 'links.external-dead' }), 'owner');
  assert.equal(reasonFor({ key: 'forms.submit' }), 'backend');
  assert.equal(reasonFor({ key: 'hsts' }), 'deploy');
  assert.equal(reasonFor({ key: 'seo.title', reverted: true }), 'look');
  assert.equal(reasonFor({ key: 'embed.map', thirdParty: true }), 'third_party');
  assert.equal(reasonFor({ key: 'seo.title' }), null);
  const owed = unexplained([{ key: 'seo.title', open: true }, { key: 'hsts', open: true }, { key: 'alt', open: false }]);
  assert.deepEqual(owed.map((i) => i.key), ['seo.title'], 'an item with a reason, or not open, is not owed');
  assert.equal(Object.keys(REASONS).length, 5);
});

test('zero regressions: a change that adds a failing check is not kept; one that only keeps old failures is', () => {
  const before = [{ check: 'visual', width: 390 }];
  assert.equal(keepChange(before, [{ check: 'visual', width: 390 }]).keep, true, 'an old failure stays old');
  const bad = keepChange(before, [{ check: 'visual', width: 390 }, { check: 'hover' }]);
  assert.equal(bad.keep, false);
  assert.deepEqual(bad.newProblems, [{ check: 'hover' }]);
  assert.equal(keepChange([], [{ check: 'console' }]).keep, false);
  assert.deepEqual(worseItems([{ status: 'regressed' }, { status: 'fixed' }]), [{ status: 'regressed' }]);
});

test('the results line reads as the spec example', () => {
  assert.equal(summaryLine({ stackLabel: 'Next.js', pages: 12, asIs: 11, rebuilt: 1, gotWorse: 0, fixed: 9, stillOpen: 2 }),
    '12 pages copied in Next.js · 11 as-is, 1 rebuilt · Got worse: 0 · Fixed: 9 · Still open: 2');
  assert.match(summaryLine({ stackLabel: 'Plain HTML', pages: 1, asIs: 1, rebuilt: 0, gotWorse: 0, fixed: 0, stillOpen: 0 }), /^1 page copied/);
});

test('DEPLOY.md: each stack has its run steps, two hosts and the settings to set', () => {
  for (const stack of Object.keys(STACK_FACTS)) {
    const md = deployMd({ stack, siteName: 'Demo', address: 'https://new.test' });
    assert.match(md, /^# Deploy Demo/);
    assert.match(md, /## Run it on your computer/);
    assert.match(md, /## Put it on the web/);
    assert.match(md, /https:\/\/new\.test/);
    assert.match(md, /HTTPS is needed/);
    assert.equal(STACK_FACTS[stack].hosts.length, 2);
  }
  assert.match(deployMd({ stack: 'html', siteName: 'Demo' }), /npx serve/);
  assert.match(deployMd({ stack: 'html', siteName: 'Demo' }), /Do not double-click index\.html/);
  assert.match(deployMd({ stack: 'mern', siteName: 'Demo', formEndpoint: 'https://f.test' }), /FORM_ENDPOINT=https:\/\/f\.test/);
  assert.throws(() => deployMd({ stack: 'nope', siteName: 'x' }));
});

test('KNOWN-ISSUES.md: only when something is open, and each item names what was tried and why', () => {
  assert.equal(knownIssuesMd({ siteName: 'Demo', stack: 'html', pages: [] }), null);
  const md = knownIssuesMd({ siteName: 'Demo', stack: 'html', pages: [{ page: '/menu', check: 'visual 390', values: '58 (min 65)', tried: 'auto-repair, clean rebuild, exact correction', reason: 'd' }] });
  assert.match(md, /# Known issues — Demo \(Plain HTML\)/);
  assert.match(md, /## \/menu/);
  assert.match(md, /- Tried: auto-repair, clean rebuild, exact correction/);
  assert.match(md, /- Reason: d/);
});

test('server log: one JSON line per open item, with the time', () => {
  const line = issueRecord({ site: 'makememo.ai', stack: 'nextjs', page: '/', check: 'console', values: '2 errors', tried: 'none', reason: 'a' });
  const rec = JSON.parse(line);
  assert.equal(rec.site, 'makememo.ai');
  assert.ok(!Number.isNaN(Date.parse(rec.at)));
});

test('progress: the six stages in order, and job steps map onto them', () => {
  assert.deepEqual(COPY_STAGES, ['Capturing', 'Copying', 'Fixing', 'Packaging', 'Checking', 'Done']);
  assert.equal(stageOf('inspect'), 'Capturing');
  assert.equal(stageOf('assets'), 'Copying');
  assert.equal(stageOf('generate'), 'Fixing');
  assert.equal(stageOf('build'), 'Packaging');
  assert.equal(stageOf('responsive'), 'Checking');
  assert.equal(stageOf('unknown-step', 'Fixing'), 'Fixing', 'an unknown step keeps the stage it came after');
  assert.equal(stageIndex('Done'), 5);
  assert.equal(stageIndex('nope'), -1);
});
