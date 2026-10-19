// Full-site D.5: images shrunk to what the pages show (×2) and re-encoded as WebP when that is clearly smaller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { optimizeImages } from '../src/recreate/assets/optimize.js';

// A photo-like picture (noise compresses badly as PNG, well as WebP).
async function photo(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + (i >> 7) * 11) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } }).blur(3).png().toBuffer();
}

test('a large PNG shown small is shrunk to twice its shown width and becomes WebP; the URL map follows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-img-'));
  try {
    await writeFile(path.join(root, 'hero-0123456789.png'), await photo(1600, 800));
    await writeFile(path.join(root, 'bg-aaaaaaaaaa.png'), await photo(1200, 600));
    const gif = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#2563eb' } }).gif().toBuffer();
    await writeFile(path.join(root, 'dot-bbbbbbbbbb.gif'), gif);
    const result = {
      files: [
        { file: 'hero-0123456789.png', kind: 'image', mime: 'image/png', bytes: 0, urls: ['https://x.test/hero.png', 'https://x.test/hero.png?w=2'] },
        { file: 'bg-aaaaaaaaaa.png', kind: 'image', mime: 'image/png', bytes: 0, urls: ['https://x.test/bg.png'] },
        { file: 'dot-bbbbbbbbbb.gif', kind: 'image', mime: 'image/gif', bytes: 0, urls: ['https://x.test/dot.gif'] },
      ],
      map: { 'https://x.test/hero.png': 'hero-0123456789.png', 'https://x.test/hero.png?w=2': 'hero-0123456789.png', 'https://x.test/bg.png': 'bg-aaaaaaaaaa.png', 'https://x.test/dot.gif': 'dot-bbbbbbbbbb.gif' },
    };
    const uses = new Map([
      ['https://x.test/hero.png', { maxWidth: 300 }],
      ['https://x.test/hero.png?w=2', { maxWidth: 250 }],
      ['https://x.test/bg.png', { unsized: true }], // a CSS background: size unknown
      ['https://x.test/dot.gif', { maxWidth: 8 }],
    ]);
    const out = await optimizeImages(root, result, uses);

    const hero = result.files[0];
    assert.match(hero.file, /^hero-[0-9a-f]{10}\.webp$/);
    assert.equal(result.map['https://x.test/hero.png'], hero.file);
    assert.equal(result.map['https://x.test/hero.png?w=2'], hero.file);
    assert.equal((await sharp(await readFile(path.join(root, hero.file))).metadata()).width, 600, 'twice the widest shown width');

    const bg = result.files[1];
    assert.match(bg.file, /\.webp$/);
    assert.equal((await sharp(await readFile(path.join(root, bg.file))).metadata()).width, 1200, 'unknown display size: never shrunk');

    assert.equal(result.files[2].file, 'dot-bbbbbbbbbb.gif', 'a GIF (it may be animated) is left as it is');
    const left = await readdir(root);
    assert.ok(!left.includes('hero-0123456789.png') && !left.includes('bg-aaaaaaaaaa.png'), 'replaced files are removed');
    assert.equal(out.converted, 2);
    assert.equal(out.resized, 1);
    assert.ok(out.bytesAfter < out.bytesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
