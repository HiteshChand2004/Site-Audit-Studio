// The capture's full-page picture stops at MAX_HEIGHT (8000 px). Compared against that picture, a copy of a taller page must not
// read as "taller than its original": only the rows the picture has are compared, and the original's height is left unknown, so
// the height rule does not judge it. (Found on makememo: the MERN copy, 8289 px like the original, was reported 3.6 % taller.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { baselineVisual } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import { pageChecksOf } from '../src/copy/checks.js';
import { MAX_HEIGHT } from '../src/audit/screenshots.js';

const page = (height) => `<!doctype html><html><head><meta charset="utf-8"><title>Tall</title>`
  + `<style>html,body{margin:0;background:rgb(40,90,160)}div{height:${height}px}</style></head><body><div></div></body></html>`;

test('a copy taller than the capped capture picture is compared on the rows the picture has, height not judged', { timeout: 5 * 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-capped-'));
  const copyDir = path.join(root, 'copy');
  await mkdir(copyDir, { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), page(MAX_HEIGHT + 289), 'utf8');
  await writeFile(path.join(copyDir, 'short.html'), page(6000), 'utf8');
  const capped = await sharp({ create: { width: 1440, height: MAX_HEIGHT, channels: 3, background: { r: 40, g: 90, b: 160 } } }).webp().toBuffer();
  const short = await sharp({ create: { width: 1440, height: 5000, channels: 3, background: { r: 40, g: 90, b: 160 } } }).webp().toBuffer();
  const served = await serveCopy(copyDir);
  const base = served.url.replace(/\/$/, '');
  const browser = await chromium.launch();
  let tall, shorter;
  try {
    tall = await baselineVisual(browser, base, `${base}/`, capped);
    shorter = await baselineVisual(browser, base, `${base}/short.html`, short);
  } finally {
    await browser.close();
    await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(tall.capped, true);
  assert.equal(tall.copyHeight, MAX_HEIGHT + 289);
  assert.equal(tall.originalHeight, null, 'the original is at least as tall as the picture; its height is unknown');
  assert.equal(tall.comparedHeight, MAX_HEIGHT);
  assert.ok(tall.diffPct < 0.5, `the same pixels where both have rows (${tall.diffPct} %)`);
  const checks = pageChecksOf({ path: '/', visual: [tall] });
  assert.deepEqual(checks.height, {}, 'no height ratio from a capped picture');
  assert.equal(checks.problems.filter((p) => p.check === 'height').length, 0);

  // A picture below the cap is the whole original: a copy taller than it is still judged.
  assert.equal(shorter.capped, undefined);
  assert.equal(shorter.originalHeight, 5000);
  assert.ok(pageChecksOf({ path: '/', visual: [shorter] }).problems.some((p) => p.check === 'height'));
});
