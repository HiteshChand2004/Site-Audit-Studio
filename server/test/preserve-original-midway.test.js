// The original answered the probe, but its page then fails to load (a timeout while the checks run): the check of that page is
// "not compared" with the reason, the copy's own checks still run, the 1440 picture falls back to the saved capture, and nothing
// throws. A repack must not fail because the live original stopped answering in the middle of its checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { checkCopy } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

test('a page of the original that fails to load mid-check is recorded as not compared; the copy still checks', { timeout: 10 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-midway-'));
  const copyDir = path.join(root, 'copy');
  await mkdir(copyDir, { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + '<body><h1>Copy</h1><button type="button">Menu</button></body></html>', 'utf8');
  const baseline = path.join(root, 'baseline.webp');
  await sharp({ create: { width: 1440, height: 900, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toFile(baseline);
  const served = await serveCopy(copyDir);
  const browser = await chromium.launch();
  let report;
  try {
  report = await checkCopy({
    browser,
    base: served.url.replace(/\/$/, ''),
    // A refused address (nothing listens there): the original's page does not load, although the probe was answered.
    pages: [{ path: '/', url: 'http://127.0.0.1:47123/' }],
    originalReachable: true,
    baselines: { '/': baseline },
  });
  } finally {
    await browser.close();
    await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }

  const page = report.pages[0];
  assert.equal(page.visual[0].source, 'saved capture', 'the 1440 check falls back to the saved capture');
  assert.equal(typeof page.visual[0].diffPct, 'number');
  assert.match(page.visual[1].note, /original not reachable: .*did not load/, 'the 390 check says why');
  assert.equal(page.controls.original, null, 'the controls of the original are not compared');
  assert.match(page.controls.note, /did not load/);
  assert.match(page.hovers.note, /did not load/);
  assert.ok(page.controls.copy, 'the copy\'s own controls are still checked');
  assert.ok(page.offline, 'the copy\'s offline check still ran');
});
