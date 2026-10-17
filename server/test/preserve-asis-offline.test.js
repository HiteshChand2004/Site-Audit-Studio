// A repack does not depend on the live original. The original is not reachable here (a closed address stands in for it): the
// repack still finishes and downloads; the checks that compare with the original say "original not reachable"; the visual check
// uses the capture's own saved picture of the page. The copy's own checks (offline, forms, its clicks) still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { asIsStage } from '../src/recreate/behavior/preserve/stage.js';

test('a repack finishes while the original does not answer: the copy is complete, the comparisons with the original say so', { timeout: 15 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-asis-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The lifted copy of an earlier job: its page set, its copy and its saved baseline picture (the capture's own picture).
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'as-is', 'copy'), { recursive: true });
  await mkdir(path.join(source, 'as-is', 'baseline'), { recursive: true });
  await writeFile(path.join(source, 'as-is', 'copy', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>'
    + '<body><h1>Copy</h1><a href="/about/">About</a><button type="button">Menu</button></body></html>', 'utf8');
  await sharp({ create: { width: 1440, height: 900, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toFile(path.join(source, 'as-is', 'baseline', 'index.webp'));
  // A closed address: the original does not answer, as if it were down or refusing requests.
  await writeFile(path.join(source, 'as-is', 'pages.json'), JSON.stringify({
    pages: [{ url: 'http://127.0.0.1:9/', outPath: 'index.html' }], excludedHosts: [], lift: { files: 1 },
  }), 'utf8');

  const ws = path.join(root, 'repack');
  await mkdir(ws, { recursive: true });
  const ctx = {
    dir: ws, asIs: { stack: 'html', fromDir: source }, discovery: undefined, audit: null,
    progress: () => {}, report: { outputs: {}, warnings: [] },
  };
  await asIsStage(ctx);

  const asIs = ctx.report.asIs;
  assert.ok(asIs, 'the repack has its as-is report');
  assert.equal(asIs.checks.originalReachable, false, 'the original was asked and did not answer');
  const page = asIs.checks.pages[0];
  assert.equal(typeof page.visual[0].diffPct, 'number', 'the 1440 check uses the saved capture');
  assert.equal(page.visual[0].source, 'saved capture');
  assert.match(page.visual[1].note, /original not reachable/);
  assert.equal(page.controls.original, null, 'nothing is compared with the original');
  assert.match(page.controls.note, /original not reachable/);
  assert.equal(ctx.report.outputs.html.status, 'ready', 'the copy is packaged and downloadable');
  assert.equal(asIs.safety.safe, true, 'nothing left the copy');
  assert.ok(ctx.report.warnings.some((w) => /original did not answer/.test(w)), 'the report says why');
});
