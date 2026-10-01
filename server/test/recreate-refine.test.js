// Recreate 4b.6.2: breakpoint refinement and fluid type decided by the responsive sweep, against local sites only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/audit/render.js';
import { captureSweep, SWEEP_WIDTHS } from '../src/recreate/capture/sweep.js';
import { applyPhoneShrink } from '../src/recreate/ir/fluid.js';
import { refineResponsive } from '../src/recreate/verify/refine.js';
import { startSiteServer } from '../src/recreate/verify/server.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const temps = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-refine-'));
  temps.push(dir);
  return dir;
};

const HTML = (css, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title><link rel="stylesheet" href="${css}"></head><body>${body}</body></html>`;
const irFor = (rules, breakpoints = { tablet: 1023.98, mobile: 767.98, source: 'default' }) => ({
  siteName: 'Test', tokens: {}, fontFaces: [], keyframes: [], boxSizingReset: true, rules, breakpoints,
  pages: [{ slug: 'home', outPath: 'index.html' }],
});

async function sweepOf(pageUrl) {
  const dir = await tempDir();
  const result = await withNetPolicy(userPolicy(), async () => {
    const browser = await launchBrowser();
    try {
      return await captureSweep(browser, { url: pageUrl, slug: 'home' }, dir);
    } finally {
      await browser.close();
    }
  });
  assert.deepEqual(result.errors, []);
  return { dir, sweep: { widths: SWEEP_WIDTHS, pages: { home: result } } };
}

async function setup(originalCss, body) {
  const dir = await tempDir();
  const original = path.join(dir, 'original');
  const site = path.join(dir, 'site');
  await mkdir(path.join(site, 'css'), { recursive: true });
  await mkdir(original, { recursive: true });
  await writeFile(path.join(original, 'index.html'), HTML('s.css', body));
  await writeFile(path.join(original, 's.css'), originalCss);
  await writeFile(path.join(site, 'index.html'), HTML('css/site.css', body));
  await writeFile(path.join(site, 'css', 'site.css'), '/* replaced by the variants */');
  return { original, site };
}

test('the sweep moves the tablet breakpoint to where the original switches layout', async () => {
  const body = '<div class="row"><div class="box">One</div><div class="box">Two</div><div class="box">Three</div></div>';
  // The original stacks its boxes up to 1200 px; the recreate was built with the default tablet breakpoint (1023.98).
  const { original, site } = await setup(
    '*{box-sizing:border-box}body{margin:0;font:16px sans-serif}.row{display:flex}.box{flex:1 1 0%;background:#4F46E5;color:#fff;padding:90px 12px}@media (max-width:1200px){.row{flex-direction:column}}',
    body,
  );
  const rules = [
    { selector: '.row', parts: { base: { display: 'flex' }, tablet: { 'flex-direction': 'column' } } },
    { selector: '.box', parts: { base: { flex: '1 1 0%', 'background-color': '#4f46e5', color: '#ffffff', 'padding-top': '90px', 'padding-bottom': '90px', 'padding-left': '12px', 'padding-right': '12px' } } },
  ];
  const live = await startSiteServer(original);
  try {
    const { dir, sweep } = await sweepOf(`${live.origin}/`);
    const ir = irFor(rules);
    const refined = await refineResponsive({ ir, siteDir: site, workspace: dir, sweep });
    assert.equal(refined.summary.status, 'done');
    assert.equal(refined.breakpoints.source, 'sweep');
    assert.equal(refined.breakpoints.tablet, 1279.98);
    assert.equal(refined.breakpoints.mobile, 767.98, 'a breakpoint the sweep has no reason to change stays');
    const t = refined.summary.breakpoints.tablet;
    assert.equal(t.changed, true);
    assert.ok(t.tried.find((x) => x.value === 1279.98).score >= t.baseline + 3);
    assert.equal(ir.breakpoints.tablet, 1023.98, 'the IR is not modified');

    // A recreate that already switches where the original does is left alone.
    const right = await refineResponsive({ ir: irFor(rules, { tablet: 1199.98, mobile: 767.98, source: 'site' }), siteDir: site, workspace: dir, sweep });
    assert.equal(right.breakpoints.tablet, 1199.98);
    assert.equal(right.breakpoints.source, 'site');
    assert.equal(right.summary.breakpoints.tablet.changed, false);
  } finally {
    await live.close();
  }
});

test('the sweep takes fluid type only when it matches the original better', async () => {
  const text = 'Fluid type scales smoothly with the width of the screen and wraps differently at every size. '.repeat(30);
  const body = `<h1 class="title">${text}</h1>`;
  // The original's size is exactly linear in the width: 31.25 px at 375, 43.04 px at 768, 63.2 px at 1440.
  const { original, site } = await setup('body{margin:0;font-family:sans-serif}h1{margin:0;font-size:calc(20px + 3vw);font-weight:400;line-height:1.2}', body);
  const rules = [{
    selector: '.title',
    parts: {
      base: { margin: '0', 'font-weight': '400', 'font-size': '63.2px', 'line-height': `${63.2 * 1.2}px` },
      tablet: { 'font-size': '43.04px', 'line-height': `${43.04 * 1.2}px` },
      mobile: { 'font-size': '31.25px', 'line-height': `${31.25 * 1.2}px` },
    },
  }];
  const live = await startSiteServer(original);
  try {
    const first = await sweepOf(`${live.origin}/`);
    const refined = await refineResponsive({ ir: irFor(rules), siteDir: site, workspace: first.dir, sweep: first.sweep });
    assert.equal(refined.summary.fluid.rules, 1);
    assert.equal(refined.summary.fluid.adopted, true, JSON.stringify(refined.summary.fluid));
    assert.equal(refined.fluid, true);
    assert.match(refined.rules[0].parts.base['font-size'], /^clamp\(/);

    // Against an original that steps (a fixed size per breakpoint), the same stylesheet keeps its px values.
    await writeFile(path.join(original, 's.css'), 'body{margin:0;font-family:sans-serif}h1{margin:0;font-size:63.2px;font-weight:400;line-height:1.2}@media (max-width:1023px){h1{font-size:43.04px}}@media (max-width:767px){h1{font-size:31.25px}}');
    const second = await sweepOf(`${live.origin}/`);
    const kept = await refineResponsive({ ir: irFor(rules), siteDir: site, workspace: second.dir, sweep: second.sweep });
    assert.equal(kept.fluid, false, JSON.stringify(kept.summary.fluid));
    assert.equal(kept.rules[0].parts.base['font-size'], '63.2px');
  } finally {
    await live.close();
  }
});

test('refinement stops at its deadline and leaves the IR choices as they were', async () => {
  const dir = await tempDir();
  const site = path.join(dir, 'site');
  await mkdir(site, { recursive: true });
  const ir = irFor([{ selector: '.a', parts: { base: { color: '#000' } } }]);
  const sweep = { widths: SWEEP_WIDTHS, pages: { home: { widths: { 900: { width: 900, height: 900, scrollWidth: 900, file: 'sweep/900-full.webp' } }, errors: [] } } };
  await writeFile(path.join(site, 'index.html'), HTML('css/site.css', '<p class="a">x</p>'));
  const refined = await refineResponsive({ ir, siteDir: site, workspace: dir, sweep, deadline: Date.now() - 1 });
  assert.equal(refined.summary.stopped, 'time-limit');
  assert.equal(refined.breakpoints, ir.breakpoints);
  assert.equal(refined.fluid, false);
  const none = await refineResponsive({ ir, siteDir: site, workspace: dir, sweep: { widths: SWEEP_WIDTHS, pages: {} } });
  assert.equal(none.summary.status, 'skipped');
});

// Absolute / fixed boxes (Phase 4b.6.2): a px width taken from the 375 px capture overflows on a 320 px screen.
test('absolutely positioned boxes: stretched by their insets, or as wide as their containing block, stay fluid', async () => {
  const { normalizeView } = await import('../src/recreate/ir/styles.js');
  const node = (tag, rect, style, children = []) => ({ tag, attrs: {}, children, views: { mobile: { rect, hidden: false, style } } });
  const html = node('html', [0, 0, 375, 2000], { display: 'block' });
  const section = node('div', [0, 100, 375, 600], { display: 'block', position: 'relative' });
  const chain = [html, section];
  const opts = { assetFile: () => null, boxSizingReset: false };
  const run = (n, ch = chain) => normalizeView(n, 'mobile', ch, opts);

  // A fixed header with 16 px on each side: 375 − 16 − 15.5 = 343.5 wide, no width of its own.
  const header = node('header', [16, 0, 343.5, 60], { display: 'block', position: 'fixed', left: '16px', right: '15.5px', top: '0px' });
  const fixed = run(header, [html]);
  assert.equal(fixed.width, undefined);
  assert.equal(fixed.left, '16px');
  assert.equal(fixed.right, '15.5px');

  // An absolute box as wide as its positioned parent keeps filling it.
  const full = run(node('div', [0, 100, 375, 200], { display: 'block', position: 'absolute', left: '0px', top: '0px' }));
  assert.equal(full.width, '100%');

  // A box narrower than its parent, or fixed in size, keeps its px width.
  const badge = run(node('div', [20, 120, 120, 40], { display: 'block', position: 'absolute', left: '20px', top: '20px' }));
  assert.equal(badge.width, '120px');
  assert.equal(badge.left, '20px');
  // Stretched (inset 0 on both sides) was already free of a width.
  const inset = run(node('div', [0, 100, 375, 200], { display: 'block', position: 'absolute', left: '0px', right: '0px', top: '0px' }));
  assert.equal(inset.width, undefined);
});

test('phone shrink scales large phone-view type down below 375 px, and only large type', () => {
  const rules = [
    { selector: '.hero', parts: { base: { 'font-size': '64px' }, mobile: { 'font-size': '38px' } } },
    { selector: '.body', parts: { base: { 'font-size': '18px' }, mobile: { 'font-size': '16px' } } },
    { selector: '.inherits', parts: { base: { 'font-size': '40px' }, mobile: { 'font-size': 'inherit' } } },
    { selector: '.keeps', parts: { base: { 'font-size': '30px' } } },
  ];
  const copy = structuredClone(rules);
  const { rules: out, changed } = applyPhoneShrink(rules);
  assert.deepEqual(rules, copy, 'the input is not modified');
  assert.equal(changed, 2);
  assert.equal(out[0].parts.mobile['font-size'], 'min(38px, 10.133vw)');
  assert.equal(out[1], rules[1]);
  assert.equal(out[2], rules[2]);
  // Without a phone override the size that applies there is the base one.
  assert.equal(out[3].parts.mobile['font-size'], 'min(30px, 8vw)');
});

test('the sweep takes phone shrink when a one-line heading runs out of a 320 px screen', async () => {
  const body = '<h1 class="hero">artificial intelligence.</h1><p>Short text.</p>';
  // The original's heading scales with the screen (10.133vw = 38 px at 375 px) and does not wrap.
  const { original, site } = await setup('body{margin:0;font-family:sans-serif}h1{margin:0;white-space:nowrap;font-weight:400;font-size:10.133vw}@media (min-width:768px){h1{font-size:64px}}p{margin:0;font-size:16px}', body);
  const rules = [
    { selector: '.hero', parts: { base: { margin: '0', 'white-space': 'nowrap', 'font-weight': '400', 'font-size': '64px' }, mobile: { 'font-size': '38px' } } },
    { selector: 'p', parts: { base: { margin: '0', 'font-size': '16px' } } },
  ];
  const live = await startSiteServer(original);
  try {
    const { dir, sweep } = await sweepOf(`${live.origin}/`);
    const refined = await refineResponsive({ ir: irFor(rules, { tablet: 1023.98, mobile: 767.98, source: 'default' }), siteDir: site, workspace: dir, sweep });
    assert.equal(refined.summary.shrink?.adopted, true, JSON.stringify(refined.summary.shrink));
    assert.equal(refined.shrink, true);
    assert.match(refined.rules[0].parts.mobile['font-size'], /^min\(38px, /);
  } finally {
    await live.close();
  }
});

test('fields and buttons with a px width never grow past their parent', async () => {
  const { resolveHints } = await import('../src/recreate/ir/styles.js');
  for (const tag of ['button', 'input', 'select', 'textarea', 'img']) {
    const decls = { desktop: { '@rw': { px: 200, ratio: 0.5 } }, mobile: { '@rw': { px: 312.4, ratio: 0.9 } } };
    resolveHints(decls, ['desktop', 'mobile'], tag);
    assert.equal(decls.mobile.width, '312px', tag);
    assert.equal(decls.mobile['max-width'], '100%', tag);
  }
  // One that fills its parent is 100% wide and needs no cap; other elements are not touched.
  const full = { desktop: { '@rw': { px: 300, ratio: 1 } } };
  resolveHints(full, ['desktop'], 'button');
  assert.deepEqual(full.desktop, { width: '100%' });
  const div = { desktop: { '@rw': { px: 200, ratio: 0.5 } } };
  resolveHints(div, ['desktop'], 'div');
  assert.equal(div.desktop['max-width'], undefined);
});
