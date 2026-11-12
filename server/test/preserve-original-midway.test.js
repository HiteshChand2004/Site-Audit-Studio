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

test('pages checked side by side keep their order in the report, with both widths per page', { timeout: 5 * 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-side-'));
  const copyDir = path.join(root, 'copy');
  const html = (title, form = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${form}</body></html>`;
  await mkdir(path.join(copyDir, 'b'), { recursive: true });
  await mkdir(path.join(copyDir, 'c'), { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), html('A'), 'utf8');
  await writeFile(path.join(copyDir, 'b', 'index.html'), html('B', '<form><input name="q"></form>'), 'utf8');
  await writeFile(path.join(copyDir, 'c', 'index.html'), html('C'), 'utf8');
  const served = await serveCopy(copyDir);
  const browser = await chromium.launch();
  const started = [];
  let report;
  try {
    report = await checkCopy({
      browser,
      base: served.url.replace(/\/$/, ''),
      pages: ['/', '/b/', '/c/'].map((p) => ({ path: p, url: `http://127.0.0.1:47123${p}` })),
      originalReachable: false,
      pagesAtOnce: 2,
      log: (m) => { if (m.startsWith('offline ')) started.push(m.split(' ')[1]); },
    });
  } finally {
    await browser.close();
    await (served.stop ? served.stop() : served.close());
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(report.pages.map((p) => p.path), ['/', '/b/', '/c/'], 'the report keeps the pages\' order');
  assert.deepEqual(started.slice(0, 2).sort(), ['/', '/b/'], 'the first two pages are checked side by side');
  for (const p of report.pages) assert.deepEqual(p.visual.map((v) => v.width), [1440, 390], 'both widths, in width order');
  assert.equal(report.forms, 1, 'forms are counted once, from page B');
});
