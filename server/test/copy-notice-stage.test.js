// Notice pages through the real as-is stage (Step 7): a repack of a lifted copy whose page links to pages that were not copied.
// The packaged copy holds a notice page for each, its links point at them, the lifted copy is left as it was (a later repack
// starts clean), a link broken on the original keeps its link, and the report and open items say what happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { asIsStage } from '../src/recreate/behavior/preserve/stage.js';

const ORIGINAL = 'http://127.0.0.1:9/';
const exists = (f) => stat(f).then(() => true, () => false);

test('a repack writes notice pages for links to pages that were not copied', { timeout: 15 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-notice-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'as-is', 'copy'), { recursive: true });
  await mkdir(path.join(source, 'as-is', 'baseline'), { recursive: true });
  await writeFile(path.join(source, 'as-is', 'copy', 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title></head>'
    + '<body><h1>Copy</h1><a href="/team.html">Team</a> <a href="http://127.0.0.1:9/login">Sign in</a> <a href="/old.html">Old</a>'
    + ' <a href="/">Home</a></body></html>', 'utf8');
  await sharp({ create: { width: 1440, height: 900, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toFile(path.join(source, 'as-is', 'baseline', 'index.webp'));
  await writeFile(path.join(source, 'as-is', 'pages.json'), JSON.stringify({
    pages: [{ url: ORIGINAL, outPath: 'index.html' }], excludedHosts: [], lift: { files: 1 },
  }), 'utf8');

  const ws = path.join(root, 'repack');
  await mkdir(ws, { recursive: true });
  const ctx = {
    dir: ws, asIs: { stack: 'html', fromDir: source }, discovery: undefined,
    // The analysis found /old.html broken on the original: that link is the owner's to fix, never hidden by a notice page.
    audit: { brokenLinks: { broken: [{ url: `${ORIGINAL}old.html`, status: 404, foundOn: '/' }] } },
    progress: () => {}, report: { outputs: {}, warnings: [] },
  };
  await asIsStage(ctx);

  const asIs = ctx.report.asIs;
  assert.deepEqual(asIs.notices.pages.map((p) => [p.outPath, p.reason, p.from]).sort(), [
    ['login/index.html', 'backend', ['/']],
    ['team.html', 'beyond-limit', ['/']],
  ]);
  assert.deepEqual(asIs.notices.left, [{ url: `${ORIGINAL}old.html`, why: 'broken on the original: the owner fixes or removes the link' }]);

  assert.equal(ctx.report.outputs.html.status, 'ready');
  const dist = path.join(ws, ctx.report.outputs.html.dir, ctx.report.outputs.html.dist ?? '');
  const home = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(home, /href="\/team\.html"/);
  assert.match(home, /href="\/login\/"/, 'the full address of the original now opens the notice page');
  assert.match(home, /href="\/old\.html"/, 'broken on the original: left as it is');
  assert.match(await readFile(path.join(dist, 'login', 'index.html'), 'utf8'), /This page is not part of this copy[\s\S]*needs a server/);
  assert.match(await readFile(path.join(dist, 'team.html'), 'utf8'), /<meta name="robots" content="noindex">/);
  assert.equal(await exists(path.join(ws, 'as-is', 'lifted', 'team.html')), false, 'the lifted copy is left as it was');

  const items = ctx.report.copy.openItems.filter((o) => o.check === 'page not copied');
  assert.deepEqual(items.map((o) => [o.page, o.reason]).sort(), [['/login', 'backend'], ['/team.html', 'owner']]);
  assert.equal(asIs.safety.safe, true, 'a notice page loads nothing from outside the copy');
  const sitemap = await readFile(path.join(dist, 'sitemap.xml'), 'utf8').catch(() => '');
  assert.doesNotMatch(sitemap, /team\.html|login/, 'never listed in the sitemap');
});
