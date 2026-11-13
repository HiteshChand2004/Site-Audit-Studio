// The unfixed page is pictured once per page and width and its pictures reused by the later looks at that page (user,
// 2026-11-13: it was pictured again for every look). A look with kept pictures that finds a change is made again with both pages
// opened now, so kept pictures never decide a change on their own; a real change is still caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { beforePictures, fixGate } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

const page = (extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Gate</title><style>body{margin:0;font:18px sans-serif;background:#fff}</style></head><body><h1>Before pictures</h1><p>Text.</p>${extra}</body></html>`;

test('kept before pictures: reused by an unchanged look, retaken by a look that finds a change, which is still caught', { timeout: 10 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-before-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = { unfixed: path.join(root, 'unfixed'), same: path.join(root, 'same'), changed: path.join(root, 'changed') };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await writeFile(path.join(dirs.unfixed, 'index.html'), page());
  await writeFile(path.join(dirs.same, 'index.html'), page('<!-- a fix nothing draws -->'));
  await writeFile(path.join(dirs.changed, 'index.html'), page('<p style="color:red">A visible change.</p>'));
  const browser = await chromium.launch();
  const servers = {};
  t.after(async () => { for (const s of Object.values(servers)) await s.close(); await browser.close(); });
  for (const [k, d] of Object.entries(dirs)) servers[k] = await serveCopy(d);
  const base = (k) => servers[k].url.replace(/\/$/, '');
  const before = beforePictures(path.join(root, 'kept'));

  const first = await fixGate(browser, base('same'), base('unfixed'), '/', { before, parallel: true });
  assert.ok(first.invisible, JSON.stringify(first.views));
  assert.ok(first.views.every((v) => !v.beforeReused), 'the first look pictures both pages');
  assert.equal(before.size, 2, 'its unfixed pictures are kept, one entry per width');

  const second = await fixGate(browser, base('same'), base('unfixed'), '/', { before, parallel: true });
  assert.ok(second.invisible);
  assert.ok(second.views.every((v) => v.beforeReused), 'the next look reuses them');

  const changed = await fixGate(browser, base('changed'), base('unfixed'), '/', { before, parallel: true });
  assert.ok(!changed.invisible, 'a visible change is caught');
  assert.ok(changed.views.some((v) => !v.beforeReused), 'decided on pictures taken now, both pages opened again');

  await before.clear();
  assert.equal(before.size, 0);
});
