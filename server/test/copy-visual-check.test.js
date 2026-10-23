// The as-is visual check (preserve/check.js visualCheck) with the gate's own arithmetic: several pictures per side and a noise
// map (gateVerdict, one implementation for the fix gate and this check). The proof the spec asks for: on a page about 10 000 px
// tall, a solid 38 x 38 px block, a 120 x 120 px block and a colour change of fewer than 24 levels (#e8e8e8 against white, 23)
// must all be flagged, and an identical page must read 0. Beside each verdict the test measures what the two earlier rulers
// would have said about the same pictures: the gate before b491402 (`pixelDiffPct`: a channel off by more than 24 levels,
// rounded to 0.01 % of the whole page) and the one-pair check with the scoring threshold 0.1 (the as-is visual check until
// 2026-10-23). Related tests only: run with SAS_TEST_BROWSER_CONCURRENCY=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { visualCheck, baselineVisual, NOISE_SHOTS } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { exactDiff } from '../src/recreate/verify/exact/pixels.js';
import { pageChecksOf } from '../src/copy/checks.js';

const HEIGHT = 10000;
const TEXT = 'A line of the page, so the picture is not one blank sheet: words a visitor reads, placed every thousand pixels down the page.';
/** A still page HEIGHT px tall with text every 1000 px and one block `mark` far down it. */
const page = ({ w = 0, h = 0, color = '#000', top = 7000, left = 500 } = {}) => `<!doctype html><html><head><meta charset="utf-8"><title>Visual check proof page</title>
<style>body{margin:0;height:${HEIGHT}px;overflow:hidden;background:#fff;font:16px/1.4 sans-serif;color:#222}
p{position:absolute;left:120px;width:900px;margin:0}i{position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:${color}}</style></head>
<body>${Array.from({ length: 10 }, (_, i) => `<p style="top:${i * 1000 + 40}px">${i + 1}. ${TEXT}</p>`).join('')}${w ? '<i></i>' : ''}</body></html>`;

/** The gate before b491402 (preserve/render.js pixelDiffPct, 2026-10-10 to 10-23): raw RGB, a channel off by > 24, to 0.01 %. */
function oldPixelDiffPct(a, b) {
  const pixels = Math.min(a.length, b.length) / 3;
  let diff = 0;
  for (let i = 0; i < pixels * 3; i += 3) {
    if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24) diff++;
  }
  return Math.round((diff / pixels) * 10000) / 100;
}

let browser;
const servers = [];
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await browser.close();
});

async function serve(t, html) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-visual-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), html);
  const s = await serveCopy(dir);
  servers.push(s);
  return s.url.replace(/\/$/, '');
}

/** One plain picture of each side (no freeze, no warm-up): what the older rulers are given. */
async function plainShots(urls) {
  const out = [];
  for (const url of urls) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    out.push(await p.screenshot({ fullPage: true, type: 'png' }));
    await ctx.close();
  }
  return out;
}

test(`on a ${HEIGHT} px page: a 38 x 38 block, a 120 x 120 block and a 23-level colour change are all flagged; the same page reads 0`, { timeout: 15 * 60000 }, async (t) => {
  const original = await serve(t, page());
  const cases = [
    { name: '38 x 38 px solid block at 7000 px', copy: page({ w: 38, h: 38, color: '#000' }), area: 38 * 38 },
    { name: '120 x 120 px solid block at 7000 px', copy: page({ w: 120, h: 120, color: '#1d4ed8' }), area: 120 * 120 },
    // The original draws the same box in white (invisible on white); the copy's is #e8e8e8: 23 levels on every channel.
    { name: '400 x 80 px area 23 levels off white (#e8e8e8)', copy: page({ w: 400, h: 80, color: '#e8e8e8' }), area: 400 * 80, originalHtml: page({ w: 400, h: 80, color: '#fff' }) },
  ];
  const said = [];
  for (const c of cases) {
    const originalUrl = c.originalHtml ? await serve(t, c.originalHtml) : original;
    const copyBase = await serve(t, c.copy);
    const v = await visualCheck(browser, copyBase, `${copyBase}/`, `${originalUrl}/`, 1440);
    // What the earlier rulers say of the same change, from one plain picture per side.
    const [o, k] = await plainShots([`${originalUrl}/`, `${copyBase}/`]);
    const raw = async (png) => sharp(png).removeAlpha().raw().toBuffer();
    const old = oldPixelDiffPct(await raw(o), await raw(k));
    const onePair = await exactDiff(o, k); // threshold 0.1, the scoring default
    said.push({ change: c.name, now: { changedPx: v.changedPx, diffPct: v.diffPct }, oldGate: `${old} %`, onePairAt0_1: `${onePair.commonPct} % (${onePair.diff} px)` });
    assert.equal(v.shots, NOISE_SHOTS);
    assert.equal(v.originalHeight, HEIGHT);
    assert.equal(v.copyHeight, HEIGHT);
    // The ruler sets antialiased-looking edge pixels aside, so a block counts a little under its area; the body of it is seen.
    assert.ok(v.changedPx >= c.area * 0.8 && v.changedPx <= c.area, `${c.name}: seen (${JSON.stringify(v)})`);
    assert.ok(v.diffPct > 0, `${c.name}: the share is not rounded to 0 (${v.diffPct})`);
    assert.equal(v.inNoisePx, 0, `${c.name}: a still page has no noise (${JSON.stringify(v)})`);
    // The thresholds see it as a difference of this size, and the noise detail travels with the page.
    const judged = pageChecksOf({ path: '/', visual: [v], offline: { errors: [] } });
    assert.ok(judged.visual[1440] < 100, `${c.name}: the score is below 100 (${judged.visual[1440]})`);
    assert.deepEqual(judged.noise[1440], { raw: v.rawDiffPct, inNoise: 0, share: 0, shots: NOISE_SHOTS });
  }
  // The colour change of 23 levels: both earlier rulers read it as no change at all.
  const colour = said[2];
  assert.equal(colour.oldGate, '0 %', `the old gate ignored a change of 24 levels or less: ${JSON.stringify(colour)}`);
  assert.match(colour.onePairAt0_1, /^0 % \(0 px\)/, `one pair at threshold 0.1 saw nothing either: ${JSON.stringify(colour)}`);
  // The 38 x 38 block: 1444 of 14.4 million pixels is 0.01 % — the old gate's whole resolution.
  assert.ok(Number.parseFloat(said[0].oldGate) <= 0.01, JSON.stringify(said[0]));
  t.diagnostic(`what each ruler said: ${JSON.stringify(said)}`);

  const twin = await serve(t, page());
  const same = await visualCheck(browser, twin, `${twin}/`, `${original}/`, 1440);
  assert.equal(same.changedPx, 0, JSON.stringify(same));
  assert.equal(same.diffPct, 0);
  assert.equal(same.inNoisePx, 0);
});

test('a part that moves by itself is mapped as noise, not read as a difference, and a real change beside it is still seen', { timeout: 10 * 60000 }, async (t) => {
  // A 300 x 300 canvas of random pixels at 1000 px, different on every load, on both sides; the copy also has a 60 x 60 block at 5000 px.
  const noisy = (extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Noisy page</title>
<style>body{margin:0;height:6000px;overflow:hidden;background:#fff}canvas{position:absolute;left:200px;top:1000px}i{position:absolute;left:800px;top:5000px;width:60px;height:60px;background:#c00}</style></head>
<body><canvas id="c" width="300" height="300"></canvas>${extra}
<script>var c=document.getElementById('c').getContext('2d'),d=c.createImageData(300,300);
for(var i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*255;d.data[i+1]=Math.random()*255;d.data[i+2]=Math.random()*255;d.data[i+3]=255;}
c.putImageData(d,0,0);</script></body></html>`;
  const original = await serve(t, noisy());
  const sameCopy = await serve(t, noisy());
  const v = await visualCheck(browser, sameCopy, `${sameCopy}/`, `${original}/`, 1440);
  assert.equal(v.changedPx, 0, `the canvas is noise, not a change (${JSON.stringify(v)})`);
  assert.ok(v.inNoisePx > 10000 && v.noiseShare > 0.3, `and it is counted and reported (${JSON.stringify(v)})`);
  assert.ok(v.rawDiffPct > 0.5, `a one-pair check would have called the page different (${v.rawDiffPct} %)`);
  assert.equal(v.diffPct, 0, 'the score sees no difference');

  const changed = await serve(t, noisy('<i></i>'));
  const w = await visualCheck(browser, changed, `${changed}/`, `${original}/`, 1440);
  assert.ok(w.changedPx >= 60 * 60 * 0.8 && w.changedPx <= 3600, `the block beside the noise is seen (${JSON.stringify(w)})`);

  // The same arithmetic when the original is not asked: the copy against saved pictures of it (here its three pictures).
  const kept = await visualCheck(browser, changed, `${changed}/`, `${original}/`, 1440, { keepOriginal: true });
  assert.equal(kept.originalShots.length, NOISE_SHOTS);
  const b = await baselineVisual(browser, changed, `${changed}/`, kept.originalShots, { width: 1440, kind: 'original' });
  assert.equal(b.savedShots, NOISE_SHOTS);
  assert.ok(b.changedPx >= 60 * 60 * 0.8, JSON.stringify(b));
  assert.equal(b.source, 'saved original picture');
});
