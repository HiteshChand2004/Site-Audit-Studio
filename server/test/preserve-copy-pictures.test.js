// An as-is copy's final check keeps no picture of the copy; the app's side-by-side views ask for one, and it is made then
// (copyPictures.js): served from the copy's folder, pictured like a checked site, saved where a rebuilt copy's pictures are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { makeCopyPicture, restoreOriginalPicture } from '../src/recreate/behavior/preserve/copyPictures.js';

test('a missing picture of an as-is copy page is made once, at the asked width; other views are not made', { timeout: 5 * 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-copy-pictures-'));
  try {
    const copy = path.join(dir, 'as-is', 'copy', 'about');
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(copy, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#c45a1c}'
      + 'section{height:1400px}</style></head><body><section><h1>About</h1></section></body></html>', 'utf8');
    const ask = () => makeCopyPicture({ dir, slug: 'about', pagePath: '/about/', view: 'desktop' });
    const [a, b] = await Promise.all([ask(), ask()]);
    assert.equal(a, true);
    assert.equal(b, true, 'the same picture asked twice at once is made once and given to both');
    const file = path.join(dir, 'fidelity', 'about', 'desktop-full.webp');
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, 1440, 'pictured at the computer width');
    assert.ok(meta.height >= 1400, 'the whole page, not only the first screen');
    const made = (await stat(file)).mtimeMs;
    assert.equal(await ask(), true);
    assert.equal((await stat(file)).mtimeMs, made, 'an existing picture is kept, not made again');
    assert.equal(await makeCopyPicture({ dir, slug: 'about', pagePath: '/about/', view: 'tablet' }), false, 'only the computer and the phone are made');
    assert.equal(await makeCopyPicture({ dir: path.join(dir, 'gone'), slug: 'about', pagePath: '/about/', view: 'desktop' }), false, 'no copy folder, no picture');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a copy rebuilt from the last visit gets the original\'s pictures back from its baseline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-original-pictures-'));
  try {
    const baseline = path.join(dir, 'as-is', 'baseline');
    await mkdir(baseline, { recursive: true });
    const solid = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 80, b: 40 } } });
    await solid(1440, 3000).webp().toFile(path.join(baseline, 'index.webp'));
    await solid(390, 2400).png().toFile(path.join(baseline, 'index@390.png'));
    assert.equal(await restoreOriginalPicture(dir, 'index', 'desktop-fold.webp'), true);
    assert.equal(await restoreOriginalPicture(dir, 'index', 'desktop-full.webp'), true);
    assert.equal(await restoreOriginalPicture(dir, 'index', 'mobile-fold.webp'), true);
    const fold = await sharp(path.join(dir, 'capture', 'index', 'desktop-fold.webp')).metadata();
    assert.deepEqual([fold.width, fold.height], [1440, 900], 'the first screen of a computer');
    const full = await sharp(path.join(dir, 'capture', 'index', 'desktop-full.webp')).metadata();
    assert.equal(full.height, 3000, 'the whole page');
    const phone = await sharp(path.join(dir, 'capture', 'index', 'mobile-fold.webp')).metadata();
    assert.deepEqual([phone.width, phone.height], [390, 844], 'the first screen of a phone, at the picture\'s width');
    assert.equal(await restoreOriginalPicture(dir, 'about', 'desktop-fold.webp'), false, 'no baseline of the page, no picture');
    assert.equal(await restoreOriginalPicture(dir, 'index', 'tablet-fold.webp'), false, 'no tablet baseline is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
