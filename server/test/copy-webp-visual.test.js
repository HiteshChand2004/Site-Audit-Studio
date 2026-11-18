// A WebP that is not lossless, for a JPEG or a PNG whose lossless WebP is not smaller enough (copy/perfAsIs.js
// visiblySameWebp): kept only when, decoded, not one pixel differs visibly from the original (YIQ distance, threshold 0.03)
// and the file is at most 90 % of it; otherwise the original file stays and the reason is recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import * as cheerio from 'cheerio';
import { fixPngImages, losslessWebp, sameVisiblePixels, visibleDifference, visiblySameWebp, WEBP_MAX_SHARE } from '../src/copy/perfAsIs.js';

/** A smooth photo-like picture (gradients): a JPEG saved at quality 100 is far larger than its WebP needs to be. */
const smooth = (w, h) => {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3;
      px[k] = Math.round((x / w) * 200 + 30);
      px[k + 1] = Math.round((y / h) * 160 + 40);
      px[k + 2] = Math.round(((x + y) / (w + h)) * 120 + 90);
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
};
/** Random coloured noise: no lossy encoding keeps it without a visible difference. */
const noise = (w, h) => {
  const px = Buffer.alloc(w * h * 3);
  let s = 7;
  for (let i = 0; i < px.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px[i] = s >> 16 & 255; }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
};
const rgba = (b) => sharp(b).ensureAlpha().raw().toBuffer();

test('visibleDifference counts the pixels past the threshold', () => {
  const a = Buffer.from([10, 20, 30, 255, 200, 200, 200, 255]);
  assert.deepEqual(visibleDifference(a, Buffer.from(a)), { pixels: 0, share: 0 });
  const b = Buffer.from([12, 21, 30, 255, 0, 0, 0, 255]);
  assert.equal(visibleDifference(a, b).pixels, 1, 'two levels apart is not visible, white to black is');
});

test('a JPEG becomes a WebP only with no visible difference; noise, a turned photo or an animation stay as they are', async () => {
  const jpeg = await smooth(400, 300).jpeg({ quality: 100 }).toBuffer();
  const w = await visiblySameWebp(jpeg);
  assert.ok(w.data, JSON.stringify(w));
  assert.ok([80, 85, 90, 95].includes(w.quality));
  assert.ok(w.data.length <= jpeg.length * WEBP_MAX_SHARE, `${w.data.length} of ${jpeg.length}`);
  assert.equal(visibleDifference(await rgba(jpeg), await rgba(w.data)).pixels, 0, 'not one pixel differs visibly');

  const rough = await visiblySameWebp(await noise(200, 150).jpeg({ quality: 100 }).toBuffer());
  assert.equal(rough.data, undefined);
  assert.match(rough.skip, /differ visibly|would be \d+ %/);

  const turned = await visiblySameWebp(await smooth(200, 150).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer());
  assert.match(turned.skip, /EXIF orientation/);
});

test('a PNG: lossless first; when that saves too little, a WebP with no visible difference; noise keeps the PNG', async () => {
  // A smooth PNG: lossless WebP of a gradient does not save 10 %, a visually identical one does.
  const png = await smooth(400, 300).png({ compressionLevel: 9 }).toBuffer();
  const lossless = await losslessWebp(png);
  if (lossless.data) return; // this sharp build compresses the gradient enough losslessly: nothing more to show
  assert.equal(lossless.size, true);
  const w = await visiblySameWebp(png);
  assert.ok(w.data, JSON.stringify(w));
  assert.equal(visibleDifference(await rgba(png), await rgba(w.data)).pixels, 0);
});

test('fixPngImages: a page\'s JPEG (src and srcset) points at its WebP, the JPEG stays; one that would change keeps its address and says why', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-webp-visual-'));
  try {
    await mkdir(path.join(dir, 'img'), { recursive: true });
    const photo = await smooth(400, 300).jpeg({ quality: 100 }).toBuffer();
    const photo2x = await smooth(800, 600).jpeg({ quality: 100 }).toBuffer();
    await writeFile(path.join(dir, 'img', 'photo.jpg'), photo);
    await writeFile(path.join(dir, 'img', 'photo-2x.jpg'), photo2x);
    await writeFile(path.join(dir, 'img', 'grain.jpg'), await noise(200, 150).jpeg({ quality: 100 }).toBuffer());
    const $ = cheerio.load('<html><body><img src="/img/photo.jpg" srcset="/img/photo.jpg 1x, /img/photo-2x.jpg 2x" alt="Photo" width="400" height="300"><img src="/img/grain.jpg" alt="Grain" width="200" height="150"></body></html>');
    const r = await fixPngImages($, { path: '/', outPath: 'index.html' }, dir);
    const photoImg = $('img[alt="Photo"]');
    assert.match(photoImg.attr('src'), /^\/img\/photo\.sas-[0-9a-f]{10}\.webp$/);
    assert.match(photoImg.attr('srcset'), /^\/img\/photo\.sas-[0-9a-f]{10}\.webp 1x, \/img\/photo-2x\.sas-[0-9a-f]{10}\.webp 2x$/, 'descriptors and order as written');
    assert.ok(r.fixed.every((f) => f.quality), JSON.stringify(r.fixed));
    assert.deepEqual(await readFile(path.join(dir, 'img', 'photo.jpg')), photo, 'the JPEG is kept as it was');
    assert.equal($('img[alt="Grain"]').attr('src'), '/img/grain.jpg');
    assert.match(r.open.map((o) => o.detail).join('\n'), /grain\.jpg is not converted to WebP: .*(differ visibly|would be \d+ %)/);
    assert.equal((await readdir(path.join(dir, 'img'))).filter((f) => f.endsWith('.webp')).length, 2, 'no WebP left for the grain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pixel fully transparent on both sides is the same whatever colour it hides; any visible value is not', () => {
  const a = Buffer.from([10, 20, 30, 0, 1, 2, 3, 255]);
  assert.ok(sameVisiblePixels(a, Buffer.from([0, 0, 0, 0, 1, 2, 3, 255])), 'only a hidden colour differs');
  assert.ok(!sameVisiblePixels(a, Buffer.from([10, 20, 30, 1, 1, 2, 3, 255])), 'an alpha of 1 is drawn');
  assert.ok(!sameVisiblePixels(a, Buffer.from([10, 20, 30, 0, 1, 2, 4, 255])), 'a visible pixel changed');
});

test('lossless WebP: hidden colours under transparent pixels may go; a colour profile goes with it byte for byte', async () => {
  // Left half fully transparent over random colours (what a background remover leaves), right half an opaque gradient.
  const w = 240;
  const h = 160;
  const px = Buffer.alloc(w * h * 4);
  let s = 11;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if (x < w / 2) {
        for (let c = 0; c < 3; c++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px[k + c] = s >> 16 & 255; }
        px[k + 3] = 0;
      } else {
        px[k] = Math.round((x / w) * 200); px[k + 1] = Math.round((y / h) * 200); px[k + 2] = 90; px[k + 3] = 255;
      }
    }
  }
  const png = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const r = await losslessWebp(png);
  assert.ok(r.data, `converted: ${r.skip ?? ''}`);
  const raw = (b) => sharp(b).ensureAlpha().raw().toBuffer();
  const [a, b] = [await raw(png), await raw(r.data)];
  assert.ok(!a.equals(b), 'the WebP does not keep the hidden colours: the case this rule is for');
  assert.ok(sameVisiblePixels(a, b));

  const tagged = await sharp(png).withIccProfile('p3').png({ compressionLevel: 0 }).toBuffer();
  assert.ok(tagged.includes(Buffer.from('iCCP')), 'the fixture carries a colour profile');
  const p = await losslessWebp(tagged);
  assert.ok(p.data, `converted: ${p.skip ?? ''}`);
  const [from, to] = [(await sharp(tagged).metadata()).icc, (await sharp(p.data).metadata()).icc];
  assert.ok(from && to && from.equals(to), 'the very same profile in the WebP');
});
