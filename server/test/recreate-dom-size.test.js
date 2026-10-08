// The copy's remaining speed problems (fix-all, parchaa round): unused hidden icon sheets, layouts of other window sizes
// kept in the page, an entrance fade on the main image, @font-face subsets the page never draws, slow fades not rebuilt,
// and failing Lighthouse audits that clearly moved. Small trees and pure functions; one real browser for the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixLoading, markLayouts, pruneSprites } from '../src/recreate/fixers/perf.js';
import { pageFontFaces } from '../src/recreate/emit/css.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';
import { scriptLoop } from '../src/recreate/ir/motion.js';
import { analyzeSeries } from '../src/recreate/capture/loops.js';
import { summarize } from '../src/reaudit/motion.js';
import { lighthouseTrend } from '../src/reaudit/compare/index.js';

test('page size: unused hidden icon sheets go, used ones (and what they reference) stay', () => {
  const v = (rect, style = {}) => ({ desktop: { rect, style, hidden: false } });
  const svg = (id, markup) => ({ tag: 'svg', attrs: { id }, svg: markup, views: v([0, 0, 20, 20]), children: [] });
  const sheet = { tag: 'div', attrs: {}, views: v([0, 0, 0, 0], { overflow: 'hidden' }), children: [
    svg('a', '<svg id="a"><path/></svg>'),
    svg('b', '<svg id="b"><path fill="url(#g)"/></svg>'),
    svg('g-host', '<svg id="g-host"><linearGradient id="g"/></svg>'),
    svg('c', '<svg id="c"><path/></svg>'),
  ] };
  const shown = { tag: 'svg', attrs: {}, svg: '<svg><use href="#b"/></svg>', views: v([0, 0, 20, 20]), children: [] };
  const visibleWithId = { tag: 'svg', attrs: { id: 'logo' }, svg: '<svg id="logo"><path/></svg>', views: v([0, 0, 90, 30]), children: [] };
  const root = { tag: 'body', attrs: {}, views: v([0, 0, 1440, 900]), children: [sheet, shown, visibleWithId] };
  assert.equal(pruneSprites({ root }), 2);
  assert.deepEqual(sheet.children.map((n) => n.attrs.id), ['b', 'g-host']);
  assert.equal(root.children.length, 3, 'a visible SVG with an id is never removed');
});

test('the main first-screen image never waits for an entrance fade', () => {
  const img = { tag: 'img', attrs: {}, motionTokens: ['rv', 'r1', 'd70', 'h2'], views: { desktop: { rect: [0, 0, 1000, 500] }, mobile: { rect: [0, 0, 375, 300] } }, children: [] };
  const box = { tag: 'div', attrs: {}, motionTokens: ['rl', 'r3'], views: { desktop: { rect: [0, 0, 1000, 500] } }, children: [img] };
  const other = { tag: 'p', attrs: {}, motionTokens: ['rv', 'r1'], views: { desktop: { rect: [0, 600, 300, 40] } }, children: [] };
  const root = { tag: 'body', attrs: {}, views: { desktop: { rect: [0, 0, 1440, 900] } }, children: [box, other] };
  const out = fixLoading({ root, info: { path: '/' } });
  assert.equal(out.unfaded, 2);
  assert.deepEqual(img.motionTokens, ['h2']);
  assert.equal(box.motionTokens, undefined);
  assert.deepEqual(other.motionTokens, ['rv', 'r1'], 'other elements keep their reveal');
});

test("per-page @font-face: only subsets holding the page's characters and the weights it uses (browser fallback kept)", () => {
  const latin = 'U+0000-00FF, U+0131';
  const cyr = 'U+0400-045F';
  const face = (weight, unicodeRange, style = 'normal') => ({ family: 'Inter', weight, style, unicodeRange, src: [{ asset: `fonts/i-${weight}.woff2` }] });
  const faces = [face('300', latin), face('400', latin), face('400', cyr), face('600', latin), face('700', latin), face('800', latin), face('400', latin, 'italic')];
  const page = { body: { tag: 'body', attrs: {}, children: [{ text: 'Hello world' }] } };
  const kept = pageFontFaces(faces, page, '.a { font-family: "Inter"; font-weight: 500; } .b { font-family: "Inter"; font-weight: 200; }');
  const ids = kept.map((f) => `${f.weight}${f.style === 'italic' ? 'i' : ''}:${f.unicodeRange === cyr ? 'cyr' : 'lat'}`);
  // 500 → 400 (no 500 face); 200 → nothing lighter, so the lightest above (300); 400 always; 600 / 700 / 800 unused
  // (the copy's reset makes headings inherit); no Cyrillic text; no italic text.
  assert.deepEqual(ids.sort(), ['300:lat', '400:lat']);
  const cyrillic = pageFontFaces(faces, { body: { tag: 'body', attrs: {}, children: [{ text: 'Привет' }] } }, '.a { font-family: "Inter"; }');
  assert.ok(cyrillic.some((f) => f.unicodeRange === cyr));
  // A heading whose weight is reverted gets the browser's bold back: 700 stays.
  const heading = { body: { tag: 'body', attrs: {}, children: [{ tag: 'h2', attrs: {}, children: [{ text: 'Hi there' }] }] } };
  assert.ok(pageFontFaces(faces, heading, '.a { font-family: "Inter"; font-weight: revert; }').some((f) => f.weight === '700'));
  // Inline styles count too.
  const inline = { body: { tag: 'body', attrs: {}, children: [{ tag: 'p', attrs: { style: 'font-weight: 800' }, children: [{ text: 'x' }] }] } };
  assert.ok(pageFontFaces(faces, inline, '.a { font-family: "Inter"; }').some((f) => f.weight === '800'));
});

test('per-page motion CSS: only the effects the page carries (also inside inline SVG)', async () => {
  const { pageMotion } = await import('../src/recreate/emit/css.js');
  const motion = { hover: [{ token: 'h1' }, { token: 'h2' }], focus: [{ token: 'f1' }], reveal: [{ token: 'r1' }, { token: 'r2' }], loops: [{ token: 'l1' }, { token: 'l2' }], delays: [70, 120], widgets: [{ token: 'w1' }] };
  const page = { body: { tag: 'body', attrs: {}, children: [
    { tag: 'a', attrs: { 'data-motion': 'h2 rv r1 d70' }, children: [] },
    { tag: 'svg', attrs: {}, raw: '<svg><g data-motion="l2"></g></svg>', children: [] },
  ] } };
  const m = pageMotion(motion, page);
  assert.deepEqual([m.hover, m.focus, m.reveal, m.loops].map((l) => l.map((e) => e.token)), [['h2'], [], ['r1'], ['l2']]);
  assert.deepEqual(m.delays, [70]);
  assert.equal(m.widgets.length, 1, 'widgets kept as they are');
});

test('layout parts other window sizes show are marked; the script parks them and brings them back on resize', async () => {
  const views = (desktop, mobile) => ({ desktop: { rect: [0, 0, 100, 20], hidden: !desktop }, mobile: { rect: [0, 0, 100, 20], hidden: !mobile } });
  const leaf = (d, m) => ({ tag: 'span', attrs: {}, views: views(d, m), children: [] });
  const desktopRow = { tag: 'div', attrs: {}, views: views(true, false), children: [leaf(true, false), leaf(true, false)] };
  const state = { tag: 'div', attrs: { 'data-w-set': 's1' }, views: views(true, false), children: [leaf(true, false), leaf(true, false)] };
  const both = { tag: 'div', attrs: {}, views: views(true, true), children: [leaf(true, true), leaf(true, true)] };
  const root = { tag: 'body', attrs: {}, views: views(true, true), children: [desktopRow, state, both] };
  assert.equal(markLayouts({ root }), 1);
  assert.ok('data-w-lay' in desktopRow.attrs);
  assert.ok(!('data-w-lay' in state.attrs) && !('data-w-lay' in both.attrs));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.setContent(`<style>@media (max-width: 600px) { .wide { display: none } } @media (min-width: 601px) { .narrow { display: none } }</style>
      <main><div class="wide" data-w-lay><b>1</b><b>2</b></div><div class="narrow" data-w-lay><i>3</i><i>4</i></div><p>always</p></main>`);
    await page.addScriptTag({ content: MOTION_JS });
    const count = () => page.evaluate(() => [document.querySelectorAll('.wide').length, document.querySelectorAll('.narrow').length]);
    assert.deepEqual(await count(), [1, 0], 'the phone part is out of the page on a wide window');
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForFunction(() => document.querySelectorAll('.narrow').length === 1);
    assert.deepEqual(await count(), [0, 1]);
    assert.equal(await page.evaluate(() => document.querySelector('main').textContent.replace(/\s+/g, '')), '34always', 'order kept');
    // A checker that compares the rendered app opts out.
    const plain = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await plain.setContent('<style>.narrow { display: none }</style><div class="narrow" data-w-lay><i>1</i><i>2</i></div>');
    await plain.evaluate(() => { window.__sasKeepLayouts = true; });
    await plain.addScriptTag({ content: MOTION_JS });
    assert.equal(await plain.evaluate(() => document.querySelectorAll('.narrow').length), 1);
  } finally {
    await browser.close();
  }
});

test("slow fades: an opacity oscillation is rebuilt as a CSS animation and paired with the original's loop", () => {
  const series = Array.from({ length: 120 }, (_, i) => {
    const t = i * 50;
    return [t, 'none', String(0.6 + 0.08 * Math.sin((2 * Math.PI * t) / 3000)), 'none', 'none', 'none'];
  });
  const a = analyzeSeries(series);
  assert.equal(a.pattern, 'oscillate');
  assert.equal(a.channel, 'opacity');
  const built = scriptLoop({ pattern: 'oscillate', params: a });
  assert.ok(built, 'rebuilt');
  assert.equal(built.keyframes[0].props.opacity, String(Math.round(a.min * 1000) / 1000));
  assert.equal(built.timing.direction, 'alternate');
  const before = summarize({ loops: { loops: [{ pattern: 'oscillate', params: { channel: 'opacity' } }] } });
  const after = summarize({ loops: { loops: [{ pattern: 'other', params: { properties: ['opacity'] } }] } });
  assert.deepEqual(before.loops.keys, after.loops.keys);
});

test('checklist: a failing Lighthouse audit that clearly moved is improved / regressed, small moves stay open', () => {
  const side = (m, d, unit = 'element') => ({ values: { mobile: { value: m, unit }, desktop: { value: d, unit } } });
  assert.equal(lighthouseTrend(side(926, 1011), side(1100, 1100)), 'worse');
  assert.equal(lighthouseTrend(side(926, 1011), side(890, 975)), 'better', 'element counts are exact: a smaller margin');
  assert.equal(lighthouseTrend(side(926, 1011), side(920, 1005)), null);
  assert.equal(lighthouseTrend(side(5500, 4000, 'millisecond'), side(5300, 3900, 'millisecond')), null);
  assert.equal(lighthouseTrend(side(5500, 4000, 'millisecond'), side(4100, 3000, 'millisecond')), 'better');
});
