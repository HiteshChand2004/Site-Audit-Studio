// A copy packaged as Next.js holds a Next.js site's own /_next files in public/next-assets (pack.js), reached through the
// rewrites of its next.config.mjs, which only next start applies. The app's own servers served public/ as plain files, so every
// /_next/… file of such a copy answered 404 there (prod, panscience.xyz 2026-11-13: the comparison measured the copy with no
// stylesheet and no scripts, 56 rows "got worse"). They now answer it from next-assets/, as next start does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { nextAssetFile, NEXT_ASSETS_DIR } from '../src/recreate/behavior/preserve/nextAssets.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';
import express from 'express';
import { servePreview } from '../src/recreate/preview.js';
import { previewRouter } from '../src/recreate/previewRoute.js';
import { issuePreviewToken, PREVIEW_PREFIX, previewPath, revokePreviewToken } from '../src/recreate/previewTokens.js';

/** public/ of a packaged Next.js copy: a page, the site's chunk under next-assets/, and Next's own name for another file. */
async function packagedPublic(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-next-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pub = path.join(root, 'public');
  await mkdir(path.join(pub, NEXT_ASSETS_DIR, 'static', 'chunks'), { recursive: true });
  await writeFile(path.join(pub, 'index.html'), '<!doctype html><link rel="stylesheet" href="/_next/static/chunks/site.css"><h1>Home</h1>', 'utf8');
  await writeFile(path.join(pub, NEXT_ASSETS_DIR, 'static', 'chunks', 'site.css'), 'h1{color:red}', 'utf8');
  await writeFile(path.join(pub, NEXT_ASSETS_DIR, 'image~a911d90b.webp'), 'webp-bytes', 'utf8');
  return pub;
}

/** GET with a chosen Host header (the preview server answers only its own host names). */
function get(url, host = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers: { ...(host && { host }), 'accept-encoding': 'identity' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

test('nextAssetFile: only /_next/ addresses, never outside next-assets/', () => {
  const root = path.resolve('/srv/copy/public');
  assert.equal(nextAssetFile(root, '/_next/static/chunks/a.css'), path.join(root, 'next-assets', 'static', 'chunks', 'a.css'));
  assert.equal(nextAssetFile(root, '/_next/image~a911d90b.webp'), path.join(root, 'next-assets', 'image~a911d90b.webp'));
  assert.equal(nextAssetFile(root, '/static/a.css'), null, 'any other address is not touched');
  assert.equal(nextAssetFile(root, '/_next/../../etc/passwd'), null, 'a path that climbs out is refused');
  assert.equal(nextAssetFile(root, '/_next/'), null);
});

test('serveCopy (the comparison, pictures, checks): /_next/… of a packaged Next.js copy is answered from next-assets/', async (t) => {
  const pub = await packagedPublic(t);
  const served = await serveCopy(pub);
  t.after(() => served.close());
  const css = await get(`${served.url}_next/static/chunks/site.css`);
  assert.equal(css.status, 200);
  assert.equal(css.body, 'h1{color:red}');
  assert.match(css.type, /text\/css/, 'typed by the file it is answered from');
  assert.equal((await get(`${served.url}_next/image~a911d90b.webp`)).body, 'webp-bytes');
  assert.equal((await get(`${served.url}_next/static/chunks/missing.css`)).status, 404, 'a file the copy does not hold is still a 404');
  assert.equal((await get(`${served.url}`)).status, 200, 'pages as before');
  // A real public/_next file (any copy that is not a packaged Next.js one) is served from its own path, first.
  await mkdir(path.join(pub, '_next', 'static', 'chunks'), { recursive: true });
  await writeFile(path.join(pub, '_next', 'static', 'chunks', 'own.css'), 'own', 'utf8');
  await writeFile(path.join(pub, NEXT_ASSETS_DIR, 'static', 'chunks', 'own.css'), 'held', 'utf8');
  assert.equal((await get(`${served.url}_next/static/chunks/own.css`)).body, 'own');
});

test('servePreview (the preview server): the same mapping', async (t) => {
  const pub = await packagedPublic(t);
  const preview = await servePreview(pub);
  t.after(() => preview.close());
  const url = `http://127.0.0.1:${preview.port}/_next/static/chunks/site.css`;
  const css = await get(url, `localhost:${preview.port}`);
  assert.equal(css.status, 200);
  assert.equal(css.body, 'h1{color:red}');
  assert.equal((await get(`http://127.0.0.1:${preview.port}/_next/static/chunks/missing.css`, `localhost:${preview.port}`)).status, 404);
});

test('the /preview/… route (the Compare tab\'s live view): the same mapping', async (t) => {
  const pub = await packagedPublic(t);
  const app = express();
  app.use(PREVIEW_PREFIX, previewRouter({ frameAncestors: ['http://app.example'] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const token = issuePreviewToken({ root: pub, kind: 'copy', scripts: true });
  t.after(() => revokePreviewToken(token));
  const base = `http://127.0.0.1:${server.address().port}${previewPath(token)}`;
  const css = await fetch(`${base}_next/static/chunks/site.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /h1\{color:red\}/);
  assert.equal((await fetch(`${base}_next/static/chunks/missing.css`)).status, 404);
  assert.equal((await fetch(base)).status, 200, 'the page as before');
});
