// Smaller copies of large pictures in an as-is copy (copy/perfAsIs.js planPerf `size`, sizesAttr, fixImageSizes): only a picture
// drawn at every window width, not choosing among files, not moving, gets WebP copies at smaller widths (each with no visible
// difference), a srcset with the file itself as the widest and a `sizes` never smaller than where it is drawn. src is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { fixImageSizes, planPerf, sizesAttr } from '../src/copy/perfAsIs.js';

/** A smooth picture (a gradient) of `w` x `h`, stored as a PNG with no compression: resizing and WebP keep it the same. */
async function gradient(w, h) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = Math.round((x / w) * 200) + 20; raw[i + 1] = Math.round((y / h) * 150) + 40; raw[i + 2] = 120;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

const img = (src, extra = {}) => ({ k: 0, src, total: 1, visible: true, top: 0, left: 0, right: 100, nw: 2400, chooses: false, moves: false, ...extra });
const probe = (images, drawn) => ({
  widths: [
    { width: 375, viewportH: 812, images: images.map((i) => img(i.src, i)) },
    { width: 1440, viewportH: 900, images: images.map((i) => img(i.src, i)), drawn },
  ],
});

test('sizes is never smaller than where the picture is drawn, between the widths read too', () => {
  // A picture that fills the window up to 768 px and stays 700 px wide above it.
  const s = sizesAttr([[1920, 700], [375, 375], [768, 768], [1440, 700]]);
  assert.equal(s, '(max-width: 375px) 375px, (max-width: 768px) 768px, (max-width: 1440px) 1440px, (max-width: 1920px) 934px, 37vw');
  // Between two widths read, the larger of the two growths, so a window of 1000 px never asks for less than it draws.
  assert.ok(Number(s.match(/1440px\) (\d+)px/)[1]) >= 768 * (1440 / 768) - 1);
  assert.equal(sizesAttr([]), null);
});

test('only pictures drawn at every width, not choosing, not moving, with a known width, are planned', () => {
  const drawn = {
    '0|/a.png': [[375, 343], [1440, 600]],
    '0|/srcset.png': [[375, 343], [1440, 600]],
    '0|/moving.png': [[375, 343], [1440, 600]],
    '0|/hidden.png': [[375, 0], [1440, 0]],
  };
  const plan = planPerf(probe([
    { src: '/a.png' }, { src: '/srcset.png', chooses: true }, { src: '/moving.png', moves: true }, { src: '/hidden.png' },
  ], drawn), '/');
  assert.deepEqual([...plan.size.keys()], ['0|/a.png']);
  assert.equal(plan.size.get('0|/a.png').natural, 2400);
  assert.equal(planPerf(probe([{ src: '/a.png' }], null), '/').size.size, 0, 'no drawn widths read: nothing planned');
});

test('a large picture gets smaller WebP copies in a srcset; src, a chosen picture and a small one stay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-sizes-'));
  try {
    await mkdir(path.join(dir, 'media'), { recursive: true });
    await writeFile(path.join(dir, 'media', 'shot.png'), await gradient(1800, 900));
    await writeFile(path.join(dir, 'media', 'small.png'), await gradient(300, 150));
    const html = '<!doctype html><html><body><img src="/media/shot.png" alt="a"><img src="/media/small.png" alt="b"><picture><img src="/media/shot.png" alt="c"></picture></body></html>';
    const $ = load(html);
    const drawn = { '0|/media/shot.png': [[375, 343], [768, 700], [1440, 700]], '0|/media/small.png': [[375, 300], [1440, 300]], '1|/media/shot.png': [[375, 343], [1440, 700]] };
    const images = [{ src: '/media/shot.png', total: 2, nw: 1800 }, { src: '/media/small.png', nw: 300 }, { src: '/media/shot.png', k: 1, total: 2, nw: 1800 }];
    const plan = planPerf(probe(images, drawn), '/');
    const r = await fixImageSizes($, { path: '/', outPath: 'index.html' }, dir, plan);

    const first = $('img').eq(0);
    assert.equal(first.attr('src'), '/media/shot.png', 'src stays');
    const parts = first.attr('srcset').split(', ');
    assert.equal(parts.at(-1), '/media/shot.png 1800w', 'the file itself stays the widest candidate');
    assert.ok(parts.length >= 2);
    for (const p of parts.slice(0, -1)) assert.match(p, /^\/media\/shot\.sas-w\d+-[0-9a-f]{10}\.webp \d+w$/);
    assert.match(first.attr('sizes'), /\(max-width: 375px\) 343px/);
    assert.equal($('img').eq(1).attr('srcset'), undefined, 'a picture never drawn smaller than its file keeps one file');
    assert.equal($('picture img').attr('srcset'), undefined, 'a <picture> already chooses: left alone');

    assert.ok(r.fixed.length >= 1 && r.fixed.every((f) => f.src === '/media/shot.png'));
    for (const f of r.fixed) {
      const meta = await sharp(await readFile(path.join(dir, f.file))).metadata();
      assert.equal(meta.format, 'webp');
      assert.equal(meta.width, f.width);
      assert.ok((await stat(path.join(dir, f.file))).size <= (await readFile(path.join(dir, 'media', 'shot.png'))).length * 0.9);
    }

    // The same picture counted differently in the markup than in the page the browser built: not touched.
    const $2 = load('<img src="/media/shot.png" alt="a">');
    const r2 = await fixImageSizes($2, { path: '/', outPath: 'index.html' }, dir, plan);
    assert.equal(r2.fixed.length, 0);
    assert.equal($2('img').attr('srcset'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
