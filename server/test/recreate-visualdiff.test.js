// Recreate 4b.7: perceptual visual diff (SSIM-style, two scales, bands, heatmap) on synthetic pages.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { flagDiff } from '../src/recreate/verify/fidelity.js';
import { toPageBox, visualDiff } from '../src/recreate/verify/visualDiff.js';

const temps = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

const W = 800;
const H = 2000;

/** A page-like image: white background, text-like stripes, and coloured blocks. `mutate(x, y, rgb)` can change a pixel. */
async function page({ height = H, shiftY = 0, block = [30, 60, 200], mutate } = {}) {
  const data = Buffer.alloc(W * height * 3, 255);
  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= height) return;
    const i = (y * W + x) * 3;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  for (let y = 0; y < height; y++) {
    const yy = y - shiftY;
    for (let x = 0; x < W; x++) {
      // Text lines: 6 px dark bars every 24 px, each a few words long (gaps in x).
      if (yy % 24 < 6 && ((x >> 4) % 7) !== 3 && x > 40 && x < 700 && yy > 100) set(x, y, [40, 40, 50]);
      // A hero image block and a footer band.
      if (yy >= 300 && yy < 700 && x >= 100 && x < 700) set(x, y, block);
      if (yy >= 1700 && yy < 1900) set(x, y, [20, 24, 40]);
    }
  }
  if (mutate) for (let y = 0; y < height; y++) for (let x = 0; x < W; x++) mutate(x, y, set);
  return sharp(data, { raw: { width: W, height, channels: 3 } }).png().toBuffer();
}

test('identical pages score 1, in every band', async () => {
  const a = await page();
  const d = await visualDiff(a, a);
  assert.ok(d.score >= 0.999, `${d.score}`);
  assert.equal(d.bands.length, 10);
  assert.ok(d.bands.every((b) => b.score >= 0.99));
  assert.deepEqual(d.worst, []);
  assert.equal(d.heightOnlyOne, 0);
});

test('a small shift costs a little, a wrong block colour costs where it is', async () => {
  const a = await page();
  const shifted = await visualDiff(a, await page({ shiftY: 2 }));
  assert.ok(shifted.score < 0.999 && shifted.score > 0.85, `shifted ${shifted.score}`);

  // The hero block (y 300–700 of 2000: bands 1–3) in another hue of the same brightness.
  const hue = await visualDiff(a, await page({ block: [120, 40, 160] }));
  assert.ok(hue.score < 0.97, `hue ${hue.score}`);
  const worstBand = [...hue.bands].sort((x, y) => x.score - y.score)[0];
  assert.ok(worstBand.from >= 0.1 && worstBand.to <= 0.4, JSON.stringify(worstBand));
  assert.ok(hue.bands[0].score > 0.95 && hue.bands[9].score > 0.95, 'the bands away from it agree');
  // A visibly wrong block is worse than a small shift.
  assert.ok(hue.score < shifted.score + 0.2);
  const missing = await visualDiff(a, await page({ block: [255, 255, 255] }));
  assert.ok(missing.score < hue.score, `missing ${missing.score} hue ${hue.score}`);
  assert.ok(missing.worst.length >= 1 && missing.worst[0].score < 0.7);
});

test('rows only one page has count as different, so a wrong page height costs score', async () => {
  const a = await page();
  const tall = await visualDiff(a, await page({ height: 2600 }));
  assert.ok(tall.heightOnlyOne > 0.2, `${tall.heightOnlyOne}`);
  assert.ok(tall.score < 0.8, `${tall.score}`);
  const last = tall.bands[9];
  assert.ok(last.score < 0.2, 'the extra rows are the last band');
});

test('a completely different page scores low, a heatmap shows where', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-vdiff-'));
  temps.push(dir);
  const a = await page();
  const other = await page({ mutate: (x, y, set) => { if ((x >> 5) % 2 === (y >> 5) % 2) set(x, y, [200, 30, 30]); } });
  const heatmap = path.join(dir, 'diff.webp');
  const d = await visualDiff(a, other, { heatmap });
  assert.ok(d.score < 0.6, `${d.score}`);
  await access(heatmap);
  const meta = await sharp(await readFile(heatmap)).metadata();
  assert.equal(meta.width, 384);
  assert.ok(meta.height > 800);
  // Not written unless asked for.
  await assert.rejects(access(path.join(dir, 'none.webp')));
});

test('files and buffers both work, and a different screenshot width is scaled to the same width', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-vdiff-'));
  temps.push(dir);
  const a = await page();
  const file = path.join(dir, 'a.webp');
  await sharp(a).webp({ quality: 90 }).toFile(file);
  // The same page at half the pixel density (a DPR 2 capture against a DPR 1 render).
  const half = await sharp(a).resize({ width: W / 2 }).png().toBuffer();
  const d = await visualDiff(file, half);
  assert.ok(d.score > 0.9, `${d.score}`);
});

test('diff flags: pages and views under the threshold are marked, with warnings', () => {
  const view = (score) => ({ diff: { score } });
  const fidelity = {
    diff: { score: 62 },
    pages: [
      { path: '/', diff: { score: 80 }, views: { desktop: view(90), mobile: view(70) } },
      { path: '/a', diff: { score: 50 }, views: { desktop: view(45), mobile: view(55) } },
      { path: '/b', views: {} },
    ],
  };
  const warnings = flagDiff(fidelity, 65);
  assert.equal(fidelity.diff.low, true);
  assert.equal(fidelity.diff.status, 'low');
  assert.deepEqual(fidelity.diff.lowPages, ['/a']);
  assert.deepEqual(fidelity.pages[1].diff.lowViews, ['desktop', 'mobile']);
  assert.equal(fidelity.pages[0].diff.low, false);
  assert.match(warnings[0], /visual difference score is 62\/100, below 65/);

  const ok = { diff: { score: 80 }, pages: [{ path: '/', diff: { score: 80 }, views: { desktop: view(80) } }, { path: '/x', diff: { score: 60 }, views: { desktop: view(60) } }] };
  const w2 = flagDiff(ok, 65);
  assert.equal(ok.diff.status, 'mixed');
  assert.match(w2[0], /below 65 on 1 page: \/x \(60\)/);
});

// --- Per-block maps and mismatch regions (the correction loop's localization). ---

test('the block scores and the regions are off unless asked for', async () => {
  const a = await page();
  const plain = await visualDiff(a, await page({ block: [255, 255, 255] }));
  assert.equal(plain.regions, undefined, 'the existing callers get exactly what they got before');
  assert.equal(plain.blocks, undefined);

  const d = await visualDiff(a, a, { regions: true, blocks: true });
  assert.deepEqual(d.regions, [], 'identical pages differ nowhere');
  // 800 px wide scaled to 384 with 8 px blocks, 2000 px tall; the layout scale is 96 wide with 4 px blocks.
  assert.deepEqual([d.blocks.detail.cols, d.blocks.detail.rows], [48, 120]);
  assert.deepEqual([d.blocks.layout.cols, d.blocks.layout.rows], [24, 60]);
  assert.equal(d.blocks.detail.scores.length, 48 * 120);
  assert.equal(d.blocks.detail.both, 120, 'both pages have every row');
});

test('a missing hero is one coarse region, where the hero is', async () => {
  const a = await page();
  const d = await visualDiff(a, await page({ block: [255, 255, 255] }), { regions: true });
  assert.equal(d.regions.length, 1, JSON.stringify(d.regions));
  const [r] = d.regions;
  assert.equal(r.coarse, true, 'a block that is not there is a difference of geometry, not of anti-aliasing');
  assert.equal(r.onlyOne, false);
  assert.ok(r.score < 0.3, `${r.score}`);
  // The hero is y 300–700 of 2000 (0.15–0.35) and x 100–700 of 800 (0.125–0.875).
  assert.ok(r.fy >= 0.1 && r.fy <= 0.2, `fy ${r.fy}`);
  assert.ok(r.fy + r.fh >= 0.3 && r.fy + r.fh <= 0.4, `fy+fh ${r.fy + r.fh}`);
  assert.ok(r.fx >= 0.05 && r.fx <= 0.15, `fx ${r.fx}`);
  assert.ok(r.fx + r.fw >= 0.8 && r.fx + r.fw <= 0.95, `fx+fw ${r.fx + r.fw}`);

  // Back in the page's own pixels, which is where the element boxes live.
  const box = toPageBox(r, { width: W, height: H });
  assert.ok(box.y >= 250 && box.y <= 320, `y ${box.y}`);
  assert.ok(box.h >= 380 && box.h <= 480, `h ${box.h}`);
  assert.ok(box.x >= 50 && box.x <= 130, `x ${box.x}`);
});

test('text shifted by 2 px is never a coarse region (nothing to correct)', async () => {
  // The guard that keeps the loop from chasing font rendering: thin structure a couple of pixels out ruins the detail
  // scale and leaves the layout scale alone, so no corrector may act on it.
  const a = await page();
  const d = await visualDiff(a, await page({ shiftY: 2 }), { regions: true });
  assert.ok(d.scales.detail < d.scales.layout, `detail ${d.scales.detail} layout ${d.scales.layout}`);
  assert.equal(d.regions.filter((r) => r.coarse).length, 0, JSON.stringify(d.regions));
});

test('a wrong page height is reported as one region, marked onlyOne', async () => {
  const a = await page();
  const d = await visualDiff(a, await page({ height: 2600 }), { regions: true });
  const tail = d.regions.filter((r) => r.onlyOne);
  assert.equal(tail.length, 1);
  // 2000 of 2600 is 0.769 down the longer page.
  assert.ok(tail[0].fy >= 0.73 && tail[0].fy <= 0.8, `fy ${tail[0].fy}`);
  assert.ok(tail[0].fy + tail[0].fh >= 0.99);
  assert.equal(tail[0].fw, 1, 'the whole width is missing, not a part of it');
});
