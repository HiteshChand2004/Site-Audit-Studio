// Light 3: the look gate reads each picture once, band by band (verify/exact/pixels.js exactDiffMany), instead of holding all
// of them decoded. Every result must be exactly exactDiff's for the same pair: same bands, same halo, same loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { exactDiff, exactDiffMany } from '../src/recreate/verify/exact/pixels.js';
import { gateVerdict } from '../src/recreate/behavior/preserve/check.js';

// A deterministic picture: stripes, a few soft (antialiased-looking) edges, and some changed pixels by seed.
function picture(width, height, seed, { changes = 0, shift = 0 } = {}) {
  const raw = Buffer.alloc(width * height * 4);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = ((Math.floor((x + shift) / 7) + Math.floor(y / 5)) % 2) ? 230 : 40;
      raw[i] = v;
      raw[i + 1] = (x * 3 + y) % 256;
      raw[i + 2] = x === Math.floor(width / 2) ? 128 : v;
      raw[i + 3] = 255;
    }
  }
  for (let k = 0; k < changes; k++) {
    const i = (Math.floor(rand() * height) * width + Math.floor(rand() * width)) * 4;
    raw[i] = 255 - raw[i];
    raw[i + 1] = 255 - raw[i + 1];
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const plain = (r) => ({ ...r, blocks: { ...r.blocks, counts: [...r.blocks.counts] } });

test('every pair, read once band by band, equals exactDiff for that pair (different widths, heights, bands that do not divide them)', async () => {
  const pics = [
    await picture(97, 233, 1),
    await picture(97, 233, 2, { changes: 400 }),
    await picture(97, 241, 3, { changes: 50, shift: 1 }),
    await picture(90, 233, 4, { changes: 10 }),
    await picture(97, 100, 5),
  ];
  const pairs = [[0, 1], [1, 0], [0, 2], [2, 3], [3, 4], [0, 4], [1, 1]];
  for (const bandRows of [1000, 7, 1, 50]) {
    for (const threshold of [0.05, 0.1]) {
      const many = await exactDiffMany(pics, pairs, { threshold, bandRows });
      for (const [k, [i, j]] of pairs.entries()) {
        const one = await exactDiff(pics[i], pics[j], { threshold, bandRows });
        assert.deepEqual(plain(many[k]), plain(one), `pair ${i}-${j}, bands of ${bandRows}, threshold ${threshold}`);
      }
    }
  }
});

test('the gate\'s verdict is unchanged: same pairs, same arithmetic, three pictures a side and a single saved one', async () => {
  const fixed = [await picture(120, 300, 11, { changes: 30 }), await picture(120, 300, 12, { changes: 30 }), await picture(120, 300, 13, { changes: 30 })];
  const unfixed = [await picture(120, 300, 21, { changes: 30 }), await picture(120, 300, 22), await picture(120, 300, 23)];
  const v = await gateVerdict(fixed, unfixed);
  // The arithmetic before Light 3, written out: exactDiff on each pair, then the same block rules (only the pairs matter here).
  const opts = { threshold: 0.05 };
  const crosses = [];
  for (let i = 0; i < 3; i++) crosses.push(await exactDiff(unfixed[i], fixed[i], opts));
  assert.equal(v.diffPct, crosses[0].commonPct);
  assert.deepEqual(v.heights, crosses[0].heights);
  const one = await gateVerdict(fixed, unfixed[0]);
  assert.equal(one.diffPct, (await exactDiff(unfixed[0], fixed[0], opts)).commonPct);
  const taller = await gateVerdict(fixed, [await picture(120, 320, 31)]);
  assert.equal(taller.sizeChanged, true);
});
