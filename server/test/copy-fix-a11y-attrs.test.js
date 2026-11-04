// Step 4: the attribute-only accessibility fixes of an as-is copy (copy/seoA11yAsIs.js): role="img" on a named element with no
// text that may not carry a name (axe aria-prohibited-attr), tabindex="0" on a box that scrolls and the keyboard cannot reach
// (axe scrollable-region-focusable, measured by the probe's existing visit), and how the re-check reads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { fixProhibitedNames, fixScrollableRegions, MAX_SCROLLERS } from '../src/copy/seoA11yAsIs.js';
import { planPerf } from '../src/copy/perfAsIs.js';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';
import { asIsEvidence } from '../src/reaudit/compare/rules.js';
import { explainWorse } from '../src/copy/gotWorse.js';

const PAGE = { path: '/', url: 'https://example-original.test/' };

test('prohibited names: only a named element with no text whose tag may not carry a name becomes role="img" (review)', () => {
  const $ = cheerio.load(`<body>
    <span class="icon-star" aria-label="Rated 5 stars"></span>
    <i aria-labelledby="lbl"><svg width="10" height="10"></svg></i><b id="lbl">Close</b>
    <span aria-label="Has text">Visible words</span>
    <div aria-label="Image inside"><img src="a.png" alt="A chart"></div>
    <button><span aria-label="Inside a button"></span></button>
    <a href="/x"><span aria-label="Inside a link"></span></a>
    <nav aria-label="Main"></nav>
    <section aria-label="Allowed on a section"></section>
    <my-widget aria-label="Custom element"></my-widget>
    <p role="paragraph" aria-label="Own role"></p>
    <div aria-label="Holds a link"><a href="/y"></a></div>
    <span aria-label="   "></span>
  </body>`);
  const r = fixProhibitedNames($, PAGE);
  assert.deepEqual(r.fixed.map((f) => [f.tag, f.text, f.value, f.review]), [['span', 'Rated 5 stars', 'img', true], ['i', 'lbl', 'img', true]]);
  assert.equal($('.icon-star').attr('role'), 'img');
  assert.equal($('[aria-label="Has text"]').attr('role'), undefined, 'with text axe only asks for a review: left');
  assert.equal($('[aria-label="Image inside"]').attr('role'), undefined, 'an image with alt is text to axe');
  for (const label of ['Inside a button', 'Inside a link', 'Main', 'Allowed on a section', 'Custom element']) {
    assert.equal($(`[aria-label="${label}"]`).attr('role'), undefined, label);
  }
  assert.deepEqual(r.open.map((o) => [o.reason, /role="paragraph"|holds a link/.test(o.detail)]), [['d', true], ['d', true]]);
  assert.equal($('[aria-label="Own role"]').attr('role'), 'paragraph', 'the author\'s role is never replaced');
});

test('prohibited names (4b): plain visible text, a named or role-bearing part inside, and missing labelledby ids are never made an image', () => {
  const $ = cheerio.load(`<body>
    <div aria-label="Plain text div">Some visible words</div>
    <span aria-label="Holds a named svg"><svg role="img" aria-label="x" width="10" height="10"></svg></span>
    <span aria-label="Holds a role button"><div role="button"></div></span>
    <span aria-labelledby="no-such-id"></span>
    <span aria-labelledby="missing-a missing-b"></span>
    <span aria-labelledby="missing-a here"></span><b id="here">Name</b>
  </body>`);
  const r = fixProhibitedNames($, PAGE);
  assert.equal($('[aria-label="Plain text div"]').attr('role'), undefined, 'a div with visible text is left');
  assert.equal($('[aria-label="Holds a named svg"]').attr('role'), undefined);
  assert.equal($('svg').attr('role'), 'img', 'the inner image keeps its own role');
  assert.equal($('[aria-label="Holds a role button"]').attr('role'), undefined);
  assert.equal($('[aria-labelledby="no-such-id"]').attr('role'), undefined);
  assert.equal($('[aria-labelledby="missing-a missing-b"]').attr('role'), undefined);
  assert.equal($('[aria-labelledby="missing-a here"]').attr('role'), 'img', 'one id that exists is enough for a name');
  assert.deepEqual(r.fixed.map((f) => [f.tag, f.value, f.review]), [['span', 'img', true]]);
  const why = r.open.map((o) => [o.reason, /own role or name/.test(o.detail) ? 'named-inside' : /no element on the page has that id/.test(o.detail) ? 'missing-id' : 'other']);
  assert.deepEqual(why, [['d', 'named-inside'], ['d', 'named-inside'], ['d', 'missing-id'], ['d', 'missing-id']], JSON.stringify(r.open));
  assert.ok(!r.open.some((o) => /Plain text div/.test(o.detail)), 'text is not a failure for axe: nothing reported for it');
});

test('scrollable regions: the probe\'s boxes are found at the same place and get tabindex="0" (review); others are reported', () => {
  const html = `<body><main><div class="list" id="l1">a</div><div class="other">b</div><div class="own" tabindex="-1">c</div></main></body>`;
  const plan = planPerf({ widths: [
    { width: 375, viewportH: 812, lcp: null, images: [], scrollers: [
      { path: [['main', 0], ['div', 0]], id: 'l1', cls: 'list', text: 'a' },
      { path: [['main', 0], ['div', 1]], id: null, cls: 'moved-by-script', text: 'b' },
      { path: [['main', 0], ['div', 2]], id: null, cls: 'own', text: 'c' },
    ] },
    { width: 1440, viewportH: 900, lcp: null, images: [], scrollers: [{ path: [['main', 0], ['div', 0]], id: 'l1', cls: 'list', text: 'a' }] },
  ] }, '/');
  assert.deepEqual(plan.scrollers.map((s) => s.widths), [[375, 1440], [375], [375]], 'one entry per box, with the widths it scrolls at');
  const $ = cheerio.load(html);
  const r = fixScrollableRegions($, PAGE, plan);
  assert.deepEqual(r.fixed.map((f) => [f.tag, f.value, f.review, f.widths]), [['div', '0', true, [375, 1440]]]);
  assert.equal($('#l1').attr('tabindex'), '0');
  assert.equal($('.other').attr('tabindex'), undefined, 'not the same class: the page\'s scripts changed it, so it is not guessed');
  assert.equal($('.own').attr('tabindex'), '-1', 'its own tabindex stays');
  assert.deepEqual(r.open.map((o) => o.reason), ['d', 'd']);

  // At most MAX_SCROLLERS per page.
  const many = cheerio.load(`<body>${'<div></div>'.repeat(MAX_SCROLLERS + 2)}</body>`);
  const rows = Array.from({ length: MAX_SCROLLERS + 2 }, (_, i) => ({ path: [['div', i]], id: null, cls: null, text: '' }));
  const capped = fixScrollableRegions(many, PAGE, planPerf({ widths: [{ width: 375, viewportH: 812, lcp: null, images: [], scrollers: rows }] }, '/'));
  assert.equal(capped.fixed.length, MAX_SCROLLERS);
  assert.deepEqual(capped.open.map((o) => o.reason), ['c', 'c']);
});

test('the re-check: both rows ask for review when fixed; an open row gives the fix\'s own reason; nothing recorded is a bug', () => {
  const report = { asIs: { fixes: { pages: [{ path: '/', fixes: [{ kind: 'prohibited', field: 'role', value: 'img', review: true }, { kind: 'scrollable', field: 'tabindex', value: '0', review: true }] }], counts: { prohibited: 1, scrollable: 1 }, open: [] } } };
  for (const key of ['axe.aria-prohibited-attr', 'axe.scrollable-region-focusable']) {
    const [e] = asIsEvidence(key, report);
    assert.equal(e.status, 'fixed', key);
    assert.equal(e.review, true, key);
  }
  const row = (key) => ({ key, status: 'open', category: 'accessibility', title: key, before: { status: 'fail', detail: '1 element' }, after: { status: 'fail', detail: '1 element' } });
  const ctx = { siteUrl: 'https://example-original.test/', copyOrigin: 'http://127.0.0.1:5101', copyPages: ['/'] };
  const leftOpen = explainWorse({ ...ctx, items: [row('axe.aria-prohibited-attr')], fixOpen: [{ kind: 'prohibited', page: '/', reason: 'd', detail: 'A div named "x" holds a link…' }] }).open[0];
  assert.equal(leftOpen.group, 'look', JSON.stringify(leftOpen));
  const capped = explainWorse({ ...ctx, items: [row('axe.scrollable-region-focusable')], fixOpen: [{ kind: 'scrollable', page: '/', reason: 'c', detail: 'only the first 8' }] }).open[0];
  assert.equal(capped.group, 'needs-info', JSON.stringify(capped));
  const missed = explainWorse({ ...ctx, items: [row('axe.scrollable-region-focusable')] }).open[0];
  assert.equal(missed.group, 'bug', 'the fix exists: still failing with no reason recorded is a bug');
  assert.match(missed.evidence, /tabindex="0".*a bug to report/);
});

test('in a real browser: the probe finds the box that scrolls, both fixes are written, and the look gate keeps them (identical at 375 and 1440 px)', { timeout: 5 * 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-a11yattrs-'));
  const browser = await chromium.launch();
  try {
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Attribute fixes test page</title><meta name="description" content="A page made to test the attribute-only accessibility fixes of an as-is copy, nothing else.">
<meta name="theme-color" content="#c2410c"><link rel="icon" href="data:,">
<style>body{margin:0;font:16px sans-serif}.log{height:120px;overflow:auto;border:1px solid #ccc}.log p{margin:0;height:40px}
.star{display:inline-block;width:20px;height:20px;background:#c2410c}.short{height:200px;overflow:auto}</style></head>
<body><h1>Attribute fixes</h1><span class="star" aria-label="Rated 5 stars"></span>
<div class="log"><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p><p>six</p></div>
<div class="short"><p>does not overflow</p></div></body></html>`);
    const r = await fixAndProve({ browser, copyDir: dir, gateDir: `${dir}-unfixed`, pages: [{ path: '/', outPath: 'index.html', url: 'https://example-original.test/' }], siteUrl: 'https://example-original.test/', newSiteUrl: null, speed: true });
    const page = r.pages[0];
    assert.equal(page.reverted, undefined, JSON.stringify(r.gate));
    assert.deepEqual(page.dropped ?? [], [], JSON.stringify(r.gate));
    const kinds = page.fixes.map((f) => f.kind);
    assert.ok(kinds.includes('prohibited') && kinds.includes('scrollable'), JSON.stringify(page.fixes));
    assert.equal(page.fixes.filter((f) => f.kind === 'scrollable').length, 1, 'only the box that overflows');
    const out = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.match(out, /<span class="star" aria-label="Rated 5 stars" role="img">/);
    assert.match(out, /<div class="log" tabindex="0">/);
    assert.match(out, /<div class="short">/, 'a box that does not overflow gets nothing');
    const gate = r.gate.filter((g) => g.path === '/');
    assert.ok(gate.length && gate.every((g) => g.invisible), JSON.stringify(gate));
    assert.deepEqual([...new Set(gate.flatMap((g) => g.views.map((v) => v.width)))].sort((a, b) => a - b), [375, 1440], 'looked at both widths');
    assert.ok(gate.every((g) => g.views.every((v) => v.changedPx === 0)), 'not one pixel changed at rest');
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-unfixed`, { recursive: true, force: true });
  }
});
