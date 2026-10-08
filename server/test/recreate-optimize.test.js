// optimize-create-copy: the speed-ups of the Create-the-copy pipeline give the same results as the code paths before them
// (which stay behind SAS_COPY_OPTIMIZE=0 / SAS_COPY_OPT_<NAME>=0). Local sites only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { optimized, OPTIMIZATIONS } from '../src/recreate/optimize.js';
import { clearImageCache, imageCacheStats } from '../src/recreate/verify/imageCache.js';
import { visualDiff } from '../src/recreate/verify/visualDiff.js';
import { visualSimilarity } from '../src/recreate/verify/layout.js';
import { compareBuilds, rendersAtOnce } from '../src/recreate/verify/equivalence.js';
import { createSweeper, sweepPagesAtOnce, sweepStageSerial } from '../src/recreate/sweep.js';
import { startSiteServer } from '../src/recreate/verify/server.js';
import { userPolicy, withNetPolicy } from '../src/security/netGuard.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const temps = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-opt-'));
  temps.push(dir);
  return dir;
};
// Runs `fn` with environment variables set, then puts them back.
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A page-like picture: bands of colour with some structure, `shift` moves one band (a different page).
async function picture(width, height, shift = 0) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const band = Math.floor((y + shift) / 120) % 4;
      raw[i] = [240, 30, 200, 90][band];
      raw[i + 1] = (x * 7 + y) % 256;
      raw[i + 2] = band * 60;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

test('switches: every speed-up is on by default; SAS_COPY_OPTIMIZE=0 turns all off, SAS_COPY_OPT_<NAME>=0 one', () => {
  for (const name of OPTIMIZATIONS) {
    assert.equal(optimized(name, {}), true);
    assert.equal(optimized(name, { SAS_COPY_OPTIMIZE: '0' }), false);
    assert.equal(optimized(name, { [`SAS_COPY_OPT_${name}`]: '0' }), false);
  }
  assert.equal(optimized('SWEEP', { SAS_COPY_OPT_IMAGE_CACHE: '0' }), true);
});

test('image cache: an original is decoded once per scale, a file written again is read again, and the scores are the same', async () => {
  const dir = await tempDir();
  const original = path.join(dir, 'desktop-full.webp');
  await (await picture(720, 1800)).webp({ quality: 80 }).toFile(original);
  const generated = await (await picture(720, 1800, 30)).png().toBuffer();

  const before = await withEnv({ SAS_COPY_OPT_IMAGE_CACHE: '0' }, async () => ({
    diff: await visualDiff(original, generated),
    similarity: await visualSimilarity(original, generated),
  }));
  clearImageCache();
  const first = { diff: await visualDiff(original, generated), similarity: await visualSimilarity(original, generated) };
  // Two scales per picture; the similarity thumbnail is the diff's 96 px scale (the same decode) of both pictures.
  assert.deepEqual([imageCacheStats().misses, imageCacheStats().hits], [4, 2]);
  const again = { diff: await visualDiff(original, generated), similarity: await visualSimilarity(original, generated) };
  assert.deepEqual([imageCacheStats().misses, imageCacheStats().hits], [4, 8], 'the second comparison decodes nothing');
  assert.deepEqual(first, before);
  assert.deepEqual(again, before);
  // The copy's screenshot (a buffer) is kept with the buffer, not in the file cache.
  assert.equal(imageCacheStats().entries, 2);
  const other = await (await picture(720, 1800, 60)).png().toBuffer();
  const misses = imageCacheStats().misses;
  assert.deepEqual(await visualDiff(original, other), await withEnv({ SAS_COPY_OPT_IMAGE_CACHE: '0' }, () => visualDiff(original, other)));
  assert.equal(imageCacheStats().misses, misses + 2, 'another buffer is decoded (two scales)');

  // A file written again (another size / time) is decoded again: the new picture decides.
  await (await picture(720, 1800, 30)).webp({ quality: 80 }).toFile(original);
  await utimes(original, new Date(), new Date(Date.now() + 5000));
  const rewritten = await visualDiff(original, generated);
  const fresh = await withEnv({ SAS_COPY_OPT_IMAGE_CACHE: '0' }, () => visualDiff(original, generated));
  assert.deepEqual(rewritten, fresh);
  assert.ok(rewritten.score > before.diff.score);
});

test('pages swept at once: by CPU threads and free memory, capped by SAS_MAX_PARALLEL, 1 when turned off', () => {
  assert.equal(sweepPagesAtOnce({ env: { SAS_COPY_OPT_SWEEP: '0' }, cpus: 16, free: 16000 }), 1);
  assert.equal(sweepPagesAtOnce({ env: { SAS_COPY_OPTIMIZE: '0' }, cpus: 16, free: 16000 }), 1);
  assert.equal(sweepPagesAtOnce({ env: {}, cpus: 12, free: 16000 }), 2);
  assert.equal(sweepPagesAtOnce({ env: {}, cpus: 4, free: 16000 }), 1, 'a 4-thread machine sweeps one page at a time, as before');
  assert.equal(sweepPagesAtOnce({ env: {}, cpus: 12, free: 1000 }), 1, 'short of memory: one page at a time');
  assert.equal(sweepPagesAtOnce({ env: { SAS_MAX_PARALLEL: '4' }, cpus: 12, free: 16000 }), 1);
  assert.equal(sweepPagesAtOnce({ env: { SAS_MAX_PARALLEL: '8' }, cpus: 12, free: 16000 }), 2);
});

const page = (title, blocks) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;font:16px sans-serif}.b{padding:40px 16px;margin:8px;background:#3b5bdb;color:#fff}@media (max-width:600px){.b{padding:20px 8px}}</style></head><body><h1>${title}</h1>${Array.from({ length: blocks }, (_, i) => `<div class="b">Block ${i + 1} of ${title}, some text that wraps when the screen is narrow.</div>`).join('')}<a href="/">Home</a></body></html>`;

async function writeSite(root, pages) {
  for (const [file, html] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), html);
  }
}

test('the sweep: pages side by side, some handed over while the capture runs, shoot exactly what one page at a time does', async () => {
  const site = await tempDir();
  await writeSite(site, { 'index.html': page('Home', 3), 'a/index.html': page('A', 6), 'b/index.html': page('B', 9) });
  const live = await startSiteServer(site);
  try {
    const pages = [
      { url: `${live.origin}/`, path: '/', outPath: 'index.html', slug: 'home' },
      { url: `${live.origin}/a/`, path: '/a/', outPath: 'a/index.html', slug: 'a' },
      { url: `${live.origin}/b/`, path: '/b/', outPath: 'b/index.html', slug: 'b' },
    ];
    const context = async () => {
      const dir = await tempDir();
      await mkdir(path.join(dir, 'capture'), { recursive: true });
      return { dir, netPolicy: userPolicy(), signal: new AbortController().signal, stepDeadline: Date.now() + 120000, progress: () => {}, report: { warnings: [] } };
    };
    const widths = [320, 900];

    const serial = { ...(await context()), pages };
    await withNetPolicy(userPolicy(), () => sweepStageSerial(serial, { widths }));

    // Two pages arrive while the "capture" still runs and may use two idle slots; the step then takes all three.
    const fast = await context();
    const sweeper = createSweeper(fast, { widths });
    await withNetPolicy(userPolicy(), async () => {
      sweeper.setSlots(() => 2);
      sweeper.add(2, pages[2]);
      sweeper.add(1, pages[1]);
      sweeper.setSlots(() => 0);
      fast.pages = pages;
      await sweeper.run({ stepDeadline: Date.now() + 120000, progress: () => {} });
    });

    assert.equal(fast.report.sweep.status, 'done');
    assert.equal(fast.report.sweep.early, 2, 'the two pages handed over were swept before the step ran');
    assert.deepEqual(Object.keys(fast.sweep.pages), ['home', 'a', 'b'], 'page order whatever order they were swept in');
    assert.deepEqual(fast.sweep.notCaptured, serial.sweep.notCaptured);
    const strip = (s) => Object.fromEntries(Object.entries(s.pages).map(([slug, p]) => [slug, Object.fromEntries(Object.entries(p.widths).map(([w, x]) => [w, { height: x.height, scrollWidth: x.scrollWidth, file: x.file }]))]));
    assert.deepEqual(strip(fast.sweep), strip(serial.sweep));
    for (const p of pages) {
      for (const w of widths) {
        const file = path.join('capture', p.slug, 'sweep', `${w}-full.webp`);
        assert.ok((await readFile(path.join(fast.dir, file))).equals(await readFile(path.join(serial.dir, file))), `${file} is the same picture`);
      }
    }

    // The generate step may take the first pages before the sweep ends: the pages swept so far, in page order.
    const partial = await context();
    const s2 = createSweeper(partial, { widths: [320] });
    partial.pages = pages;
    const running = withNetPolicy(userPolicy(), () => s2.run({ stepDeadline: Date.now() + 120000, progress: () => {} }));
    const first = await partial.sweepPending(1, 60000);
    assert.ok(first?.pages.home, 'the homepage is there');
    await running;
    assert.deepEqual(Object.keys((await partial.sweepPending(3, 1000)).pages), ['home', 'a', 'b']);
  } finally {
    await live.close();
  }
});

test('the equivalence check renders side by side and finds exactly what it finds one render at a time', async () => {
  const dir = await tempDir();
  const reference = path.join(dir, 'ref');
  const same = path.join(dir, 'same');
  const changed = path.join(dir, 'changed');
  const files = { 'index.html': page('Home', 3), 'a/index.html': page('A', 4), 'b/index.html': page('B', 5) };
  await writeSite(reference, files);
  await writeSite(same, files);
  await writeSite(changed, { ...files, 'b/index.html': page('B', 5).replace('Block 3 of B', 'Block three of B') });
  const pages = [
    { path: '/', outPath: 'index.html' },
    { path: '/a/', outPath: 'a/index.html' },
    { path: '/b/', outPath: 'b/index.html' },
  ];
  const run = (candidateRoot) => compareBuilds({ referenceRoot: reference, candidateRoot, pages, hydrate: false }).then(({ ms, ...rest }) => rest);

  assert.equal(await withEnv({ SAS_COPY_OPT_EQUIVALENCE: '0' }, () => rendersAtOnce()), 1);
  const oneByOne = await withEnv({ SAS_COPY_OPT_EQUIVALENCE: '0' }, async () => ({ same: await run(same), changed: await run(changed) }));
  const sideBySide = { same: await run(same), changed: await run(changed) };
  assert.deepEqual(sideBySide, oneByOne);
  assert.equal(sideBySide.same.ok, true);
  assert.equal(sideBySide.changed.ok, false);
  assert.equal(sideBySide.changed.pages[2].dom, 'different');
  assert.equal(sideBySide.changed.pages[2].difference.view, 'desktop');
  assert.deepEqual(sideBySide.changed.pages.slice(0, 2).map((p) => p.dom), ['equal', 'equal']);
});
