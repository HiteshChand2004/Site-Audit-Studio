// Recreate 4b.6: responsive sweep (widths between the three captured ones), breakpoint refinement and fluid
// type, against local sites only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { captureSweep, SWEEP_WIDTHS, sweepView } from '../src/recreate/capture/sweep.js';
import { applyFluidType, fluidValue } from '../src/recreate/ir/fluid.js';
import { responsiveStage } from '../src/recreate/responsive.js';
import { sweepStage } from '../src/recreate/sweep.js';
import { compareWidth, summarizeSweep } from '../src/recreate/verify/responsive.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';
import { launchBrowser } from '../src/audit/render.js';
import { startSiteServer } from '../src/recreate/verify/server.js';
import { startFixtureServer } from './serve-fixture.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PORT = 4197;
const origin = `http://localhost:${PORT}`;
const exists = (p) => access(p).then(() => true, () => false);
const temps = [];
let server;

before(async () => {
  server = await startFixtureServer(PORT, { site: 'recreate' });
});
after(async () => {
  server.close();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-sweep-'));
  temps.push(dir);
  return dir;
};

test('the sweep covers the widths around the three captured ones', () => {
  assert.deepEqual(SWEEP_WIDTHS, [320, 480, 600, 900, 1024, 1280, 1920]);
  for (const captured of [375, 768, 1440]) assert.ok(!SWEEP_WIDTHS.includes(captured));
  assert.deepEqual([sweepView(320).mobile, sweepView(480).mobile, sweepView(600).mobile], [true, true, false]);
});

test('a width scores by visual similarity and page height, and flags new overflow and height drift', () => {
  const same = compareWidth(900, { height: 3000, scrollWidth: 900 }, { height: 3010, scrollWidth: 900 }, 0.97);
  assert.equal(same.low, false);
  assert.deepEqual(same.flags, []);
  assert.ok(same.score >= 95);

  const tall = compareWidth(900, { height: 3000, scrollWidth: 900 }, { height: 4200, scrollWidth: 900 }, 0.9);
  assert.ok(tall.flags.includes('taller'));
  assert.equal(tall.low, true);

  const overflow = compareWidth(320, { height: 2000, scrollWidth: 320 }, { height: 2000, scrollWidth: 410 }, 0.99);
  assert.ok(overflow.flags.includes('overflow'));
  assert.equal(overflow.low, true);
  // Overflow the original has too is not the recreate's mistake.
  const both = compareWidth(320, { height: 2000, scrollWidth: 410 }, { height: 2000, scrollWidth: 410 }, 0.99);
  assert.deepEqual(both.flags, []);

  const noShot = compareWidth(900, { height: 3000, scrollWidth: 900 }, { height: 3000, scrollWidth: 900 }, null);
  assert.equal(noShot.score, 100);
});

test('the summary lists the worst widths and warns about drift and skipped pages', () => {
  const ok = (w) => ({ ...compareWidth(w, { height: 1000, scrollWidth: w }, { height: 1000, scrollWidth: w }, 0.98) });
  const bad = (w) => ({ ...compareWidth(w, { height: 1000, scrollWidth: w }, { height: 1500, scrollWidth: w }, 0.5) });
  const pages = [
    { path: '/', outPath: 'index.html', slug: 'home', widths: { 320: ok(320), 900: bad(900) } },
    { path: '/a', outPath: 'a.html', slug: 'a', widths: { 320: ok(320), 900: { width: 900, error: 'x' } } },
  ];
  const { responsive, warnings } = summarizeSweep(pages, [320, 900], { skipped: ['/b'] });
  assert.equal(responsive.status, 'done');
  assert.equal(responsive.measured, 3);
  assert.equal(responsive.driftCount, 1);
  assert.deepEqual(responsive.worst.map((w) => [w.path, w.width]), [['/', 900]]);
  assert.deepEqual(responsive.pages[0].drift, [900]);
  assert.equal(responsive.byWidth[320] >= 95, true);
  assert.match(warnings.join('\n'), /drifts from the original at 1 of 3 measured page widths.*\/ at 900px/);
  assert.match(warnings.join('\n'), /not run for 1 page \(time limit\): \/b/);
});

test('captureSweep screenshots the original at every width and keeps the others when one fails', async () => {
  const dir = await tempDir();
  await withNetPolicy(userPolicy(), async () => {
    const browser = await launchBrowser();
    try {
      const page = { url: `${origin}/about.html`, slug: 'about' };
      const result = await captureSweep(browser, page, dir, { widths: [320, 900] });
      assert.deepEqual(result.errors, []);
      for (const width of [320, 900]) {
        const w = result.widths[width];
        assert.equal(w.width, width);
        assert.ok(w.height > 200);
        assert.ok(await exists(path.join(dir, 'capture', 'about', w.file)));
      }
      assert.ok(result.widths[320].height > result.widths[900].height * 0.8);
    } finally {
      await browser.close();
    }
  });
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title><link rel="stylesheet" href="/s.css"></head><body><main class="wrap"><h1>Responsive page</h1><p>Some text that wraps over several lines when the screen is narrow enough to need it.</p><div class="row"><div class="box">One</div><div class="box">Two</div><div class="box">Three</div></div></main></body></html>`;
const CSS = (wrap) => `body{margin:0;font:16px sans-serif}.wrap{${wrap}}.row{display:flex;flex-wrap:wrap;gap:12px}.box{flex:1 1 140px;background:#4F46E5;color:#fff;padding:60px 12px}`;

test('the step compares the original with the recreated build at each width and never fails the job', async () => {
  const dir = await tempDir();
  const original = path.join(dir, 'original');
  const faithful = path.join(dir, 'dist');
  await mkdir(original, { recursive: true });
  await writeFile(path.join(original, 'index.html'), PAGE);
  await writeFile(path.join(original, 's.css'), CSS('max-width:900px;margin:0 auto;padding:16px'));
  await cp(original, faithful, { recursive: true });
  const live = await startSiteServer(original);
  try {
    const progress = [];
    const ctx = {
      dir,
      netPolicy: userPolicy(),
      signal: new AbortController().signal,
      stepDeadline: Date.now() + 120000,
      progress: (f, message) => progress.push(message),
      pages: [{ url: `${live.origin}/`, path: '/', outPath: 'index.html', slug: 'home' }],
      report: { outputs: { html: { status: 'ready', dir: 'dist' } }, warnings: [] },
    };
    await withNetPolicy(userPolicy(), () => sweepStage(ctx, { widths: [320, 900] }));
    await responsiveStage(ctx);
    const r = ctx.report.responsive;
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.deepEqual(r.widths, [320, 900]);
    assert.equal(r.measured, 2);
    assert.ok(r.score >= 95, `a faithful copy scores ${r.score}`);
    assert.equal(r.driftCount, 0);
    assert.deepEqual(ctx.report.warnings, []);
    assert.ok(await exists(path.join(dir, r.pages[0].widths[900].generatedFile)));
    assert.ok(await exists(path.join(dir, 'capture', 'home', r.pages[0].widths[320].original)));

    // A fixed-width container (what a desktop-only layout does) overflows on a phone: drift is flagged.
    await writeFile(path.join(faithful, 's.css'), CSS('width:700px;margin:0 auto;padding:16px'));
    const drift = { ...ctx, sweep: ctx.sweep, report: { outputs: { html: { status: 'ready' } }, warnings: [] } };
    await responsiveStage(drift);
    const d = drift.report.responsive;
    assert.ok(d.driftCount >= 1);
    assert.deepEqual(d.worst[0].path, '/');
    assert.equal(d.worst[0].width, 320);
    assert.ok(d.worst[0].flags.includes('overflow'));
    assert.match(drift.report.warnings.join('\n'), /drifts from the original at \d+ of 2 measured page widths.*\/ at 320px/);

    // Without time the step skips itself with a warning.
    const late = { ...ctx, sweep: null, stepDeadline: Date.now() + 5000, report: { outputs: { html: {} }, warnings: [] } };
    await sweepStage(late, { widths: [320] });
    assert.equal(late.report.sweep.status, 'skipped');
    assert.match(late.report.warnings[0], /skipped/);
    await responsiveStage(late);
    assert.equal(late.report.responsive.status, 'skipped');

    // A build that is missing the page is a note per width, not an error.
    await rm(path.join(faithful, 'index.html'));
    const missing = { ...ctx, sweep: ctx.sweep, report: { outputs: { html: {} }, warnings: [] } };
    await responsiveStage(missing);
    assert.equal(missing.report.responsive.status, 'failed');
    assert.match(missing.report.responsive.error, /recreated page could not be rendered.*HTTP 404/);
  } finally {
    await live.close();
  }
});

test('fluid type: three values on one line become one clamp(); stepped values stay as they are', () => {
  const line = fluidValue({ d: '64px', t: '43.8px', m: '32px' });
  assert.match(line.value, /^clamp\(32px, calc\(20\.7\d*px \+ 3\.00\d*vw\), 64px\)$/);
  // The formula gives the captured sizes back at 375 / 768 / 1440.
  const [, a, b] = line.value.match(/calc\(([\d.]+)px \+ ([\d.]+)vw\)/).map(Number);
  for (const [w, px] of [[375, 32], [768, 43.8], [1440, 64]]) assert.ok(Math.abs(a + (b * w) / 100 - px) < 0.2, `${w}px`);
  // Falling sizes work the other way round.
  assert.match(fluidValue({ d: '16px', t: '21.05px', m: '24px' }).value, /^clamp\(16px, calc\(.*\), 24px\)$/);
  // A design that steps at a breakpoint, a tiny change, and non-px values are left alone.
  assert.equal(fluidValue({ d: '64px', t: '48px', m: '32px' }), null);
  assert.equal(fluidValue({ d: '17px', t: '16px', m: '16px' }), null);
  assert.equal(fluidValue({ d: '64px', t: 'inherit', m: '32px' }), null);
  assert.equal(fluidValue({ d: undefined, t: undefined, m: undefined }), null);
});

test('fluid type is applied per rule and removes the stepped overrides it replaces', () => {
  const rules = [
    { selector: '.title', parts: { base: { 'font-size': '64px', 'line-height': '76px', color: '#111' }, tablet: { 'font-size': '43.8px', 'line-height': '52px' }, mobile: { 'font-size': '32px', 'line-height': '38px', 'text-align': 'left' } } },
    { selector: '.step', parts: { base: { 'font-size': '40px' }, tablet: { 'font-size': '32px' }, mobile: { 'font-size': '20px' } } },
    { selector: '.plain', parts: { base: { color: '#000' } } },
  ];
  const copy = structuredClone(rules);
  const { rules: out, changed, properties } = applyFluidType(rules);
  assert.deepEqual(rules, copy, 'the input is not modified');
  assert.equal(changed, 1);
  assert.deepEqual(properties, { 'font-size': 1, 'line-height': 1 });
  assert.match(out[0].parts.base['font-size'], /^clamp\(32px,/);
  assert.match(out[0].parts.base['line-height'], /^clamp\(38px,/);
  assert.equal(out[0].parts.base.color, '#111');
  assert.equal(out[0].parts.tablet, undefined, 'nothing else changed at tablet width: the override is gone');
  assert.deepEqual(out[0].parts.mobile, { 'text-align': 'left' });
  assert.equal(out[1], rules[1]);
  assert.equal(out[2], rules[2]);
});


test('the recreated page is rendered with its lazy images loaded (no flat holes below the fold)', async () => {
  const sharp = (await import('sharp')).default;
  const { openSweepRenderer, renderSweepPage } = await import('../src/recreate/verify/responsive.js');
  const dir = await tempDir();
  await writeFile(path.join(dir, 'red.png'), await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toBuffer());
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body style="margin:0"><div style="height:3000px;background:#fff"></div><img src="red.png" width="300" height="200" loading="lazy" alt=""></body></html>');
  const renderer = await openSweepRenderer(dir, [600]);
  try {
    const { png, height } = await renderSweepPage(renderer, 'index.html', 600);
    assert.ok(height >= 3200);
    const { data, info } = await sharp(png).extract({ left: 10, top: 3050, width: 100, height: 100 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 3);
    assert.ok(data[0] > 180 && data[1] < 80, `the image is drawn (rgb ${data[0]},${data[1]},${data[2]})`);
  } finally {
    await renderer.close();
  }
});

test('overflow costs by how far it sticks out, so a partial fix shows in the score', () => {
  const orig = { height: 2000, scrollWidth: 320 };
  const small = compareWidth(320, orig, { height: 2000, scrollWidth: 344 }, 0.99);
  const big = compareWidth(320, orig, { height: 2000, scrollWidth: 440 }, 0.99);
  const none = compareWidth(320, orig, { height: 2000, scrollWidth: 320 }, 0.99);
  assert.equal(small.overflowPx, 22);
  assert.equal(big.overflowPx, 118);
  assert.ok(none.score > small.score && small.score > big.score, `${none.score} > ${small.score} > ${big.score}`);
  assert.ok(none.score - small.score >= 1);
  assert.ok(none.score - big.score <= 15, 'the penalty has a ceiling');
  for (const m of [small, big]) {
    assert.ok(m.flags.includes('overflow'));
    assert.equal(m.low, true);
  }
  // Overflow the original has too is not charged; only the part beyond it is.
  const both = compareWidth(320, { height: 2000, scrollWidth: 400 }, { height: 2000, scrollWidth: 430 }, 0.99);
  assert.equal(both.overflowPx, 30);
});

test('fluid type with the laptop view: all four captured values must be on the line', () => {
  const on = { d: '64px', l: '51.5px', t: '43.8px', m: '32px' };
  assert.match(fluidValue(on, { laptop: true }).value, /^clamp\(32px,/);
  // A stepped laptop value breaks it; without the laptop view the value is not looked at.
  assert.equal(fluidValue({ ...on, l: '64px' }, { laptop: true }), null);
  assert.match(fluidValue({ ...on, l: '64px' }).value, /^clamp\(32px,/);
  const rules = [{ selector: '.t', parts: { base: { 'font-size': '64px' }, laptop: { 'font-size': '51.5px' }, tablet: { 'font-size': '43.8px' }, mobile: { 'font-size': '32px' } } }];
  const out = applyFluidType(rules, { laptop: true });
  assert.equal(out.changed, 1);
  assert.deepEqual(Object.keys(out.rules[0].parts), ['base'], 'every stepped override it replaces is gone');
});
