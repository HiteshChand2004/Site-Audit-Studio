// The as-is preview is served from its own address (its own port), with the plain copy's headers, and it is stopped when its
// project goes, when the app shuts down, and after it has been idle for IDLE_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IDLE_MS, asIsPreviewUrl, startAsIsPreview, stopAllAsIsPreviews, stopAsIsPreview, stopAsIsPreviewsOf, stopIdleAsIsPreviews,
} from '../src/recreate/behavior/preserve/asisPreview.js';

async function copyFolder() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-asis-preview-'));
  await mkdir(path.join(root, 'about'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>home</title>', 'utf8');
  await writeFile(path.join(root, 'about', 'index.html'), '<!doctype html><title>about</title>', 'utf8');
  await writeFile(path.join(root, 'sw.js'), "self.addEventListener('install', () => self.skipWaiting());\n", 'utf8');
  return root;
}

test('the preview is the copy at the root of its own address, with the plain copy\'s headers', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await startAsIsPreview('p1', 'r1', root);
  t.after(() => stopAsIsPreview('p1', 'r1'));
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/?$/, 'its own origin on this machine');
  assert.equal(asIsPreviewUrl('p1', 'r1'), url);
  const home = await fetch(`${url}/`);
  assert.match(await home.text(), /<title>home<\/title>/);
  assert.equal(home.headers.get('cache-control'), 'no-cache', 'pages revalidate');
  const about = await fetch(`${url}/about/`);
  assert.match(await about.text(), /<title>about<\/title>/, 'a page of the copy at its own path');
  const sw = await fetch(`${url}/sw.js`);
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'the service worker revalidates');
});

test('a preview is reused while it runs, and stopped with its project', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await startAsIsPreview('p2', 'r1', root);
  const again = await startAsIsPreview('p2', 'r1', root);
  assert.equal(again, first, 'the same copy is not started twice');
  await stopAsIsPreviewsOf('p2');
  assert.equal(asIsPreviewUrl('p2', 'r1'), null);
  await assert.rejects(() => fetch(`${first}/`), 'stopped: nothing answers');
});

test('the app shutting down stops every preview; idle previews stop after IDLE_MS', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await startAsIsPreview('p3', 'a', root);
  const b = await startAsIsPreview('p4', 'b', root);
  await stopAllAsIsPreviews();
  assert.equal(asIsPreviewUrl('p3', 'a'), null);
  assert.equal(asIsPreviewUrl('p4', 'b'), null);
  await assert.rejects(() => fetch(`${a}/`));
  await assert.rejects(() => fetch(`${b}/`));

  const c = await startAsIsPreview('p5', 'c', root);
  await stopIdleAsIsPreviews(Date.now() + IDLE_MS - 1000);
  assert.equal(asIsPreviewUrl('p5', 'c') !== null, true, 'still within its idle time');
  await stopIdleAsIsPreviews(Date.now() + IDLE_MS + 1000);
  assert.equal(asIsPreviewUrl('p5', 'c'), null, 'stopped after its idle time');
  await assert.rejects(() => fetch(`${c}/`));
});
