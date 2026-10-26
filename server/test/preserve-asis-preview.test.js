// The as-is preview is served by the app itself under /preview/<token>/ (recreate/previewRoute.js), each document sandboxed
// by header; it is stopped when its project goes, when the app shuts down, and after it has been idle for IDLE_MS — and a
// stopped preview's address answers nothing at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  IDLE_MS, asIsPreviewUrl, startAsIsPreview, stopAllAsIsPreviews, stopAsIsPreview, stopAsIsPreviewsOf, stopIdleAsIsPreviews,
} from '../src/recreate/behavior/preserve/asisPreview.js';
import { previewRouter, PREVIEW_PREFIX } from '../src/recreate/previewRoute.js';

async function copyFolder() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-asis-preview-'));
  await mkdir(path.join(root, 'about'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>home</title>', 'utf8');
  await writeFile(path.join(root, 'about', 'index.html'), '<!doctype html><title>about</title>', 'utf8');
  await writeFile(path.join(root, 'sw.js'), "self.addEventListener('install', () => self.skipWaiting());\n", 'utf8');
  return root;
}

// The app's own address with the preview route mounted, as src/index.js mounts it.
const app = express();
app.use(PREVIEW_PREFIX, previewRouter({ frameAncestors: ['http://app.example'] }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((r) => server.close(r)));

test('the preview is the copy under the app\'s own address, every document sandboxed', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await startAsIsPreview('p1', 'r1', root);
  t.after(() => stopAsIsPreview('p1', 'r1'));
  assert.match(url, /^\/preview\/[A-Za-z0-9_-]{24}\/$/, 'a path under the app, with an unguessable token');
  assert.equal(asIsPreviewUrl('p1', 'r1'), url);
  const home = await fetch(`${base}${url}`);
  assert.match(await home.text(), /<title>home<\/title>/);
  assert.equal(home.headers.get('content-security-policy'), 'sandbox allow-scripts; frame-ancestors http://app.example');
  assert.equal(home.headers.get('cache-control'), 'no-store');
  const about = await fetch(`${base}${url}about/`);
  assert.match(await about.text(), /<title>about<\/title>/, 'a page of the copy at its own path');
  const sw = await fetch(`${base}${url}sw.js`);
  assert.equal(sw.status, 200);
  assert.doesNotMatch(sw.headers.get('content-security-policy'), /sandbox/, 'a script file is no document');
});

test('a preview is reused while it runs, and stopped with its project', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await startAsIsPreview('p2', 'r1', root);
  const again = await startAsIsPreview('p2', 'r1', root);
  assert.equal(again, first, 'the same copy is not started twice');
  assert.equal((await fetch(`${base}${first}`)).status, 200);
  await stopAsIsPreviewsOf('p2');
  assert.equal(asIsPreviewUrl('p2', 'r1'), null);
  assert.equal((await fetch(`${base}${first}`)).status, 404, 'stopped: the address answers nothing');
});

test('the app shutting down stops every preview; idle previews stop after IDLE_MS', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await startAsIsPreview('p3', 'a', root);
  const b = await startAsIsPreview('p4', 'b', root);
  await stopAllAsIsPreviews();
  assert.equal(asIsPreviewUrl('p3', 'a'), null);
  assert.equal(asIsPreviewUrl('p4', 'b'), null);
  assert.equal((await fetch(`${base}${a}`)).status, 404);
  assert.equal((await fetch(`${base}${b}`)).status, 404);

  const c = await startAsIsPreview('p5', 'c', root);
  await stopIdleAsIsPreviews(Date.now() + IDLE_MS - 1000);
  assert.equal(asIsPreviewUrl('p5', 'c') !== null, true, 'still within its idle time');
  await stopIdleAsIsPreviews(Date.now() + IDLE_MS + 1000);
  assert.equal(asIsPreviewUrl('p5', 'c'), null, 'stopped after its idle time');
  assert.equal((await fetch(`${base}${c}`)).status, 404);
});
