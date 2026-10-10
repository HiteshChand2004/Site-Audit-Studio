// Exact mode, phase A4: the pixel number. Checked on images made here, where the right answer is known exactly,
// including the two things the metric exists for: a real difference counted in full, and a text edge not counted.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  colorDelta, diffRegions, exactDiff, writeDiffMap, BAND_ROWS, BLOCK_PX, MAX_YIQ_DELTA,
} from '../src/recreate/verify/exact/pixels.js';

let dir;
before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sas-pixels-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

/** A plain canvas, and a painter for the rectangles on it. */
function canvas(width, height, fill = [255, 255, 255]) {
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    raw[i * 4] = fill[0];
    raw[i * 4 + 1] = fill[1];
    raw[i * 4 + 2] = fill[2];
    raw[i * 4 + 3] = 255;
  }
  return {
    width,
    height,
    raw,
    rect(x, y, w, h, colour) {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * width + xx) * 4;
          raw[i] = colour[0];
          raw[i + 1] = colour[1];
          raw[i + 2] = colour[2];
          raw[i + 3] = 255;
        }
      }
      return this;
    },
    png() {
      return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    },
  };
}

test('the threshold is pixelmatch\'s: a fraction of the largest possible colour distance', () => {
  assert.equal(MAX_YIQ_DELTA, 35215);
  const black = Buffer.from([0, 0, 0, 255]);
  const white = Buffer.from([255, 255, 255, 255]);
  // The constant is the real maximum of this formula, which is what makes `threshold` mean the same here as in
  // pixelmatch. It is not black against white - that is only the brightness extreme - but a colour against its
  // opposite, where the two colour channels are extreme as well.
  const red = Buffer.from([255, 0, 0, 255]);
  const cyan = Buffer.from([0, 255, 255, 255]);
  assert.equal(Math.round(Math.abs(colorDelta(red, cyan, 0, 0))), MAX_YIQ_DELTA);
  assert.equal(Math.round(Math.abs(colorDelta(white, black, 0, 0))), 32857);
  // And nothing exceeds it: the corners of the colour cube are where a maximum can sit.
  const corners = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
  for (const a of corners) {
    for (const b of corners) {
      const d = Math.abs(colorDelta(Buffer.from([...a, 255]), Buffer.from([...b, 255]), 0, 0));
      assert.ok(d <= MAX_YIQ_DELTA + 0.5, `${a} vs ${b} is ${d}`);
    }
  }
  // Identical pixels are zero, whatever their colour, and the sign says which side is brighter.
  assert.equal(colorDelta(white, white, 0, 0), 0);
  assert.ok(colorDelta(white, black, 0, 0) < 0, 'negative when the first pixel is the brighter one');
  assert.ok(colorDelta(black, white, 0, 0) > 0);
  // Brightness only, which is what the antialias test uses.
  assert.ok(Math.abs(colorDelta(white, black, 0, 0, true) - 255) < 0.5);
});

test('two identical shots differ nowhere', async () => {
  const a = canvas(120, 90).rect(10, 10, 40, 30, [20, 80, 160]);
  const png = await a.png();
  const r = await exactDiff(png, png);
  assert.equal(r.diff, 0);
  assert.equal(r.pct, 0);
  assert.equal(r.heightOnlyOne, 0);
  assert.equal(r.widthMismatch, false);
  assert.equal(r.compared, 120 * 90);
});

test('a block that really changed is counted exactly, and found where it is', async () => {
  const a = canvas(200, 200);
  const b = canvas(200, 200).rect(40, 60, 20, 10, [0, 0, 0]);
  const r = await exactDiff(await a.png(), await b.png());
  // 20 x 10 solid black on white: every pixel of it, and nothing else.
  assert.equal(r.diff, 200, `counted ${r.diff}`);
  assert.equal(r.pct, Math.round((200 / 40000) * 1e6) / 1e4);
  assert.equal(r.antialiased, 0);

  const regions = diffRegions(r);
  assert.equal(regions.length, 1);
  const region = regions[0];
  assert.ok(region.x <= 40 && region.y <= 60, JSON.stringify(region));
  assert.ok(region.x + region.w >= 60 && region.y + region.h >= 70, JSON.stringify(region));
  assert.equal(region.pixels, 200);
});

test('the same shape one pixel to the right is a difference, not a rounding', async () => {
  const a = canvas(200, 200).rect(40, 40, 30, 30, [0, 0, 0]);
  const b = canvas(200, 200).rect(41, 40, 30, 30, [0, 0, 0]);
  const r = await exactDiff(await a.png(), await b.png());
  // Two edges of 30 pixels each, and nothing in the middle, since the shape is solid.
  assert.equal(r.diff, 60, `counted ${r.diff}`);
});

test('a colour a shade off is below the threshold, and a colour clearly off is not', async () => {
  const a = canvas(100, 100).rect(0, 0, 100, 100, [128, 128, 128]);
  const shade = canvas(100, 100).rect(0, 0, 100, 100, [130, 130, 130]);
  const clear = canvas(100, 100).rect(0, 0, 100, 100, [170, 170, 170]);
  const near = await exactDiff(await a.png(), await shade.png());
  assert.equal(near.diff, 0, 'two shades apart is not a difference at threshold 0.1');
  const far = await exactDiff(await a.png(), await clear.png());
  assert.equal(far.diff, 10000, 'a clearly different grey is every pixel');
  // A stricter threshold notices the shade: the knob works the way pixelmatch's does.
  const strict = await exactDiff(await a.png(), await shade.png(), { threshold: 0.002 });
  assert.ok(strict.diff > 0, `strict found ${strict.diff}`);
});

test('a text edge is not a defect: antialiasing is recognised and counted apart', async () => {
  // A diagonal edge, as a letter has, with the second image's edge pixels a shade different - what two browsers
  // rasterising the same glyph produce.
  const a = canvas(80, 80);
  const b = canvas(80, 80);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 80; x++) {
      if (x < y - 1) {
        a.rect(x, y, 1, 1, [0, 0, 0]);
        b.rect(x, y, 1, 1, [0, 0, 0]);
      } else if (x < y) {
        // The edge itself: grey on one side, a different grey on the other.
        a.rect(x, y, 1, 1, [90, 90, 90]);
        b.rect(x, y, 1, 1, [150, 150, 150]);
      }
    }
  }
  const r = await exactDiff(await a.png(), await b.png());
  assert.ok(r.antialiased > 0, 'the edge was recognised as an edge');
  assert.equal(r.diff, 0, `the edge is not counted as a difference (counted ${r.diff}, antialiased ${r.antialiased})`);
  // Asked to count it, it counts it: the suppression is a choice, not a blind spot.
  const strict = await exactDiff(await a.png(), await b.png(), { includeAntialiased: true });
  assert.ok(strict.diff > 0);
  assert.equal(strict.diff, r.antialiased);
});

test('a page taller on one side counts the rows nobody could compare', async () => {
  const a = canvas(100, 100);
  const b = canvas(100, 150);
  const r = await exactDiff(await a.png(), await b.png());
  assert.equal(r.height, 100, 'only the rows both have are compared');
  assert.deepEqual(r.heights, [100, 150]);
  assert.equal(r.heightOnlyOne, 50 * 100);
  assert.equal(r.pct, Math.round((5000 / 15000) * 1e6) / 1e4, 'a third of the page is not comparable');
});

test('a tall page is read in bands, and the bands do not invent differences at their seams', async () => {
  const height = BAND_ROWS * 2 + 50;
  const a = canvas(60, height);
  const b = canvas(60, height);
  // A change sitting exactly on the first seam, where a band's edge row meets the next band.
  for (const c of [a, b]) c.rect(0, 0, 60, height, [240, 240, 240]);
  b.rect(10, BAND_ROWS - 1, 10, 3, [0, 0, 0]);
  const r = await exactDiff(await a.png(), await b.png());
  assert.equal(r.diff, 30, `the change is counted once and in full (${r.diff})`);
  assert.equal(r.antialiased, 0);
  // And nothing else: a seam between two bands is not a difference.
  const same = await exactDiff(await a.png(), await a.png());
  assert.equal(same.diff, 0);
});

test('the block map is written as a small picture, not a full-page image', async () => {
  const a = canvas(400, 1200);
  const b = canvas(400, 1200).rect(100, 800, 60, 40, [0, 0, 0]);
  const r = await exactDiff(await a.png(), await b.png());
  assert.equal(r.blocks.px, BLOCK_PX);
  assert.equal(r.blocks.cols, 50);
  assert.equal(r.blocks.rows, 150);
  const out = path.join(dir, 'map.webp');
  const written = await writeDiffMap(r, out);
  assert.equal(written.cols, 50);
  const size = (await stat(out)).size;
  assert.ok(size > 0 && size < 20000, `the map is small (${size} bytes)`);
});

test('nothing differing means no regions to look at', async () => {
  const a = canvas(100, 100).rect(10, 10, 20, 20, [1, 2, 3]);
  const r = await exactDiff(await a.png(), await a.png());
  assert.deepEqual(diffRegions(r), []);
});
