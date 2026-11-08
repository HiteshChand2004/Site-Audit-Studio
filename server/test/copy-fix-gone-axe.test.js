// Step 5c: "is the problem gone?" for the fixes that answer axe rules, read by the look gate in the visit it makes anyway
// (preserve/check.js fixGate axeRules), with the width rule: a group is judged only where axe saw the problem on the lifted page,
// and is undone only on positive evidence (copy/fixGone.js judgeAxe, mergeVerdicts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AXE_WATCH, UNATTRIBUTED, axeRulesFor, judgeAxe, mergeVerdicts } from '../src/copy/fixGone.js';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';

const view = (width, before, after) => ({ width, invisible: true, axe: { width, before, after } });

test('the rules read: none for a page whose fixes answer no axe rule; else every fix kind\'s rules and the ARIA rules an attribute can break', () => {
  assert.deepEqual(axeRulesFor([{ kind: 'head', field: 'title' }, { kind: 'lcp' }]), []);
  const rules = axeRulesFor([{ kind: 'prohibited' }]);
  for (const r of ['aria-prohibited-attr', 'scrollable-region-focusable', 'image-alt', 'heading-order', ...AXE_WATCH]) assert.ok(rules.includes(r), r);
  assert.equal(new Set(rules).size, rules.length);
});

test('width rule: judged only where axe saw the problem on the lifted page; elsewhere "confirm at re-check", never undone', () => {
  const fixes = [{ kind: 'scrollable', widths: [375] }];
  // Seen at 375 only: gone there.
  let v = judgeAxe({ fixes, views: [view(375, { 'scrollable-region-focusable': 1 }, { 'scrollable-region-focusable': 0 }), view(1440, { 'scrollable-region-focusable': 0 }, { 'scrollable-region-focusable': 0 })] });
  assert.equal(v.scrollable.result, 'gone');
  assert.deepEqual(v.scrollable.keys, ['axe.scrollable-region-focusable']);
  // Still there at the width it was seen.
  v = judgeAxe({ fixes, views: [view(375, { 'scrollable-region-focusable': 1 }, { 'scrollable-region-focusable': 1 })] });
  assert.equal(v.scrollable.result, 'still');
  assert.match(v.scrollable.why, /scrollable-region-focusable at 375 px 1 → 1/);
  // Not seen by axe at any width the gate read: not judged.
  v = judgeAxe({ fixes, views: [view(375, { 'scrollable-region-focusable': 0 }, { 'scrollable-region-focusable': 0 }), view(1440, { 'scrollable-region-focusable': 0 }, { 'scrollable-region-focusable': 0 })] });
  assert.equal(v.scrollable.result, 'unjudged');
  assert.match(v.scrollable.why, /did not see the problem at 375 or 1440 px.*confirm at re-check/);
  // The 1440 view was never made (the gate stopped at 375) and 375 did not see it: not judged.
  v = judgeAxe({ fixes, views: [view(375, { 'scrollable-region-focusable': 0 }, { 'scrollable-region-focusable': 0 })] });
  assert.equal(v.scrollable.result, 'unjudged');
  // axe could not read: not judged, with the reason.
  v = judgeAxe({ fixes, views: [{ width: 375, axe: { width: 375, error: 'axe did not finish in 30 s' } }] });
  assert.equal(v.scrollable.result, 'unjudged');
  assert.match(v.scrollable.why, /could not read the page.*30 s.*confirm at re-check/);
  // Fewer, not none: improved (kept).
  v = judgeAxe({ fixes: [{ kind: 'prohibited' }], views: [view(375, { 'aria-prohibited-attr': 3 }, { 'aria-prohibited-attr': 1 })] });
  assert.equal(v.prohibited.result, 'improved');
  // A group with no axe target gets no axe verdict.
  assert.equal(judgeAxe({ fixes: [{ kind: 'head', field: 'title' }], views: [view(375, {}, {})] })['head:title'], undefined);
});

test('a new failure in another rule: charged to the only group, or to the group a look alone shows; otherwise nothing undone', () => {
  const grew = view(1440, { 'aria-prohibited-attr': 1, 'aria-allowed-role': 0 }, { 'aria-prohibited-attr': 0, 'aria-allowed-role': 1 });
  // One group: it is the cause.
  let v = judgeAxe({ fixes: [{ kind: 'prohibited' }], views: [grew] });
  assert.equal(v.prohibited.result, 'worse');
  assert.match(v.prohibited.why, /aria-allowed-role at 1440 px 0 → 1/);
  // Two groups, no look at either alone: not attributed.
  const two = [{ kind: 'prohibited' }, { kind: 'headings' }];
  v = judgeAxe({ fixes: two, views: [grew] });
  assert.equal(v.prohibited.result, 'gone', 'its own problem is gone; the new failure is not charged to it');
  assert.equal(v[UNATTRIBUTED].result, 'unjudged');
  assert.match(v[UNATTRIBUTED].why, /aria-allowed-role.*no single group of fixes is shown to cause it: nothing was undone/);
  // Two groups, the gate looked at each alone: only the one whose look shows the new failure is worse.
  const alone = new Map([
    ['prohibited', [view(1440, { 'aria-allowed-role': 0 }, { 'aria-allowed-role': 0 })]],
    ['headings', [view(1440, { 'aria-allowed-role': 0 }, { 'aria-allowed-role': 1 })]],
  ]);
  v = judgeAxe({ fixes: two, views: [grew], alone });
  assert.equal(v.headings.result, 'worse');
  assert.equal(v.prohibited.result, 'gone');
  assert.equal(v[UNATTRIBUTED], undefined);
});

test('markup and axe verdicts of one group, as one', () => {
  const u = { result: 'unjudged', keys: [], why: 'axe did not see it: confirm at re-check' };
  assert.equal(mergeVerdicts({ result: 'gone', keys: ['seo.image-alt-text'] }, u).result, 'gone');
  assert.equal(mergeVerdicts({ result: 'gone', keys: ['a'] }, { result: 'still', keys: ['b'], why: 'x' }).result, 'improved', 'one check better: kept');
  assert.equal(mergeVerdicts({ result: 'still', keys: ['a'], why: 'x' }, u).result, 'still');
  assert.equal(mergeVerdicts({ result: 'gone', keys: ['a'] }, { result: 'worse', keys: ['b'], why: 'y' }).result, 'worse');
  const both = mergeVerdicts({ result: 'unjudged', keys: [] }, u);
  assert.equal(both.result, 'unjudged');
  assert.match(both.why, /confirm at re-check/);
  assert.equal(mergeVerdicts(undefined, u), u);
});

test('in a real browser: the gate reads axe on both sides in its own visit, at both widths; both attribute fixes are shown gone and kept', { timeout: 5 * 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-gone-axe-'));
  const browser = await chromium.launch();
  try {
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Axe gone check page</title><meta name="description" content="A page made to test that the gate reads axe and finds the attribute fixes effective.">
<meta name="theme-color" content="#c2410c"><link rel="icon" href="data:,">
<style>body{margin:0;font:16px sans-serif}.log{height:120px;overflow:auto;border:1px solid #ccc}.log p{margin:0;height:40px}
.star{display:inline-block;width:20px;height:20px;background:#c2410c}</style></head>
<body><h1>Axe gone</h1><span class="star" aria-label="Rated 5 stars"></span>
<div class="log"><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p><p>six</p></div></body></html>`);
    const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: [{ path: '/', outPath: 'index.html', url: 'https://example-original.test/' }], siteUrl: 'https://example-original.test/', newSiteUrl: null, speed: true });
    const page = r.pages[0];
    assert.equal(page.reverted, undefined, JSON.stringify(r.gate));
    assert.deepEqual(page.dropped ?? [], [], JSON.stringify(r.gone));
    assert.equal(r.noEffect, 0);
    const first = r.gate.find((g) => g.path === '/' && !g.groups);
    assert.deepEqual(first.views.map((v) => v.axe?.width), [375, 1440], 'axe read in the gate\'s visit at both widths');
    for (const v of first.views) {
      assert.equal(v.axe.error, undefined, JSON.stringify(v.axe));
      assert.equal(v.axe.before['aria-prohibited-attr'], 1, `${v.width}: the lifted page fails it`);
      assert.equal(v.axe.after['aria-prohibited-attr'], 0, `${v.width}: the fixed page does not`);
    }
    const verdict = (group) => r.gone.find((g) => g.path === '/' && g.group === group);
    assert.equal(verdict('prohibited')?.result, 'gone', JSON.stringify(r.gone));
    assert.ok(['gone', 'unjudged'].includes(verdict('scrollable')?.result ?? 'unjudged'), JSON.stringify(r.gone));
    if (verdict('scrollable')?.result === 'unjudged') assert.match(verdict('scrollable').why, /confirm at re-check/);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-unfixed`, { recursive: true, force: true });
  }
});
