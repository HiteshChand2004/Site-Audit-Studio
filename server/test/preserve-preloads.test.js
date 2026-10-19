// A copy does not keep a preload of a file it does not hold (a request that fails on every visit); a preload of a file it
// holds, or of another host, is kept as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dropMissingPreloads } from '../src/recreate/behavior/preserve/preloads.js';

test('preloads: a missing local file is dropped, a present one and an external one are kept', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-preloads-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'img'), { recursive: true });
  await writeFile(path.join(dir, 'img', 'hero.webp'), 'x');
  const html = [
    '<!doctype html><html><head>',
    '<link rel="preload" as="image" imagesrcset="/_next/image?url=%2Flogo.png&amp;w=96&amp;q=75 1x, /_next/image?url=%2Flogo.png&amp;w=256&amp;q=75 2x">',
    '<link rel="preload" as="image" href="/img/hero.webp">',
    '<link rel="preload" as="image" href="/img/gone.webp">',
    '<link rel="preload" as="font" href="https://fonts.example.com/a.woff2" crossorigin>',
    '<link rel="stylesheet" href="/site.css">',
    '</head><body></body></html>',
  ].join('\n');
  await writeFile(path.join(dir, 'index.html'), html, 'utf8');

  const removed = await dropMissingPreloads(dir);
  const out = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.equal(removed.length, 2, 'the two preloads of missing files are reported');
  assert.doesNotMatch(out, /_next\/image/, 'the optimiser preload is gone');
  assert.doesNotMatch(out, /gone\.webp/, 'the preload of a missing file is gone');
  assert.match(out, /img\/hero\.webp/, 'a preload of a file the copy holds stays');
  assert.match(out, /fonts\.example\.com/, 'an external preload is left as it was');
  assert.match(out, /site\.css/, 'other links are untouched');
});
