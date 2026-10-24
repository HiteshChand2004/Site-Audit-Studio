// The previews under the app's own address (recreate/previewRoute.js + previewTokens.js), without a browser: the token is the
// only way in, every document is sandboxed by header, a build of ours keeps its strict policy written with the visitor's
// origin, root-relative addresses of pages and stylesheets are moved under the preview's path, and nothing outside the folder
// is served. The browser side (what a copy's script can and cannot reach) is test/preview-sandbox.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { previewRouter, rewriteCssUrls, rewriteHtmlUrls, previewFileHeaders, PREVIEW_PREFIX } from '../src/recreate/previewRoute.js';
import { issuePreviewToken, previewPath, resolvePreviewToken, revokePreviewToken } from '../src/recreate/previewTokens.js';

test('root-relative addresses in CSS move under the prefix; protocol-relative, absolute and relative ones do not', () => {
  const css = 'a{background:url(/img/a.png)} b{background:url("/img/b.png")} c{background:url( \'/c.svg\' )} d{background:url(//cdn.x/d.png)} e{background:url(img/e.png)} f{background:url(https://x/f.png)} @import "/css/g.css"; @import url(/css/h.css);';
  assert.equal(rewriteCssUrls(css, '/preview/t/'),
    'a{background:url(/preview/t/img/a.png)} b{background:url("/preview/t/img/b.png")} c{background:url(\'/preview/t/c.svg\')} d{background:url(//cdn.x/d.png)} e{background:url(img/e.png)} f{background:url(https://x/f.png)} @import "/preview/t/css/g.css"; @import url(/preview/t/css/h.css);');
});

test('root-relative addresses in HTML attributes, srcset, inline styles and <style> move; scripts are left as written', () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/s.css"><style>h1{background:url(/x.png)}</style>'
    + '<script>const p = "/api/x"; fetch(\'/data.json\')</script></head>'
    + '<body><a href="/about/">about</a><a href=\'/\'>home</a><a href="//other/x">o</a><a href="https://x/y">y</a><a href="rel/z">z</a>'
    + '<img src="/a.png" srcset="/a-1x.png 1x, /a-2x.png 2x, //cdn/a.png 3x"><div style="background:url(/b.png)"></div>'
    + '<svg><use xlink:href="/sprite.svg#i"/></svg><form action="/send"></form></body></html>';
  const out = rewriteHtmlUrls(html, '/preview/t/');
  assert.match(out, /href="\/preview\/t\/s\.css"/);
  assert.match(out, /<style>h1\{background:url\(\/preview\/t\/x\.png\)\}<\/style>/);
  assert.match(out, /const p = "\/api\/x"; fetch\('\/data\.json'\)/, 'script text untouched');
  assert.match(out, /href="\/preview\/t\/about\/"/);
  assert.match(out, /href='\/preview\/t\/'/, 'the root itself');
  assert.match(out, /href="\/\/other\/x"/);
  assert.match(out, /href="https:\/\/x\/y"/);
  assert.match(out, /href="rel\/z"/);
  assert.match(out, /src="\/preview\/t\/a\.png" srcset="\/preview\/t\/a-1x\.png 1x, \/preview\/t\/a-2x\.png 2x, \/\/cdn\/a\.png 3x"/);
  assert.match(out, /style="background:url\(\/preview\/t\/b\.png\)"/);
  assert.match(out, /xlink:href="\/preview\/t\/sprite\.svg#i"/);
  assert.match(out, /action="\/preview\/t\/send"/);
});

test('tokens: 24 characters of the base64url alphabet, exact match only, gone when revoked', () => {
  const token = issuePreviewToken({ root: 'C:/x', kind: 'as-is', scripts: true });
  assert.match(token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(previewPath(token), `${PREVIEW_PREFIX}/${token}/`);
  assert.deepEqual({ ...resolvePreviewToken(token), issuedAt: 'x' }, { root: 'C:/x', kind: 'as-is', scripts: true, issuedAt: 'x' });
  assert.equal(resolvePreviewToken(token.slice(0, 23)), null);
  assert.equal(resolvePreviewToken(`${token}x`), null);
  assert.equal(resolvePreviewToken(undefined), null);
  revokePreviewToken(token);
  assert.equal(resolvePreviewToken(token), null);
});

test('headers: every document is sandboxed; a build of ours keeps the strict policy on the visitor\'s origin; an as-is copy has the sandbox and the framing rule only', () => {
  const copy = previewFileHeaders({ kind: 'copy', scripts: false, ext: '.html', origin: 'https://tool.example', frameAncestors: ['https://tool.example'] });
  assert.equal(copy['Content-Security-Policy'], "sandbox allow-scripts; default-src 'none'; img-src https://tool.example data:; media-src https://tool.example; font-src https://tool.example; style-src https://tool.example 'unsafe-inline'; frame-src https:; form-action 'none'; base-uri 'none'; frame-ancestors https://tool.example");
  const css = previewFileHeaders({ kind: 'copy', scripts: false, ext: '.css', origin: 'https://tool.example', frameAncestors: ['https://tool.example'] });
  assert.doesNotMatch(css['Content-Security-Policy'], /sandbox/, 'a stylesheet is no document');
  const app = previewFileHeaders({ kind: 'copy', scripts: 'inline', ext: '.html', origin: 'http://localhost:8080', scriptHashes: ["'sha256-abc'"], frameAncestors: ['http://localhost:8080'] });
  assert.match(app['Content-Security-Policy'], /script-src http:\/\/localhost:8080 'sha256-abc'/);
  const asIs = previewFileHeaders({ kind: 'as-is', scripts: true, ext: '.html', origin: 'http://localhost:8080', frameAncestors: ['http://localhost:8080'] });
  assert.equal(asIs['Content-Security-Policy'], 'sandbox allow-scripts; frame-ancestors http://localhost:8080');
  const svg = previewFileHeaders({ kind: 'as-is', scripts: true, ext: '.svg', origin: null, frameAncestors: ['http://localhost:8080'] });
  assert.match(svg['Content-Security-Policy'], /^sandbox allow-scripts/, 'an SVG opened on its own is a document that can run script');
  for (const h of [copy, asIs]) {
    assert.equal(h['Access-Control-Allow-Origin'], '*', 'a sandboxed document fetches its own files cross-origin');
    assert.equal(h['Cache-Control'], 'no-store');
    assert.equal(h['Referrer-Policy'], 'no-referrer');
  }
});

async function copyFolder() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-preview-route-'));
  await mkdir(path.join(root, 'about'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="/s.css"><title>home</title><a href="/about">about</a>', 'utf8');
  await writeFile(path.join(root, 'about', 'index.html'), '<!doctype html><title>about</title>', 'utf8');
  await writeFile(path.join(root, 'contact.html'), '<!doctype html><title>contact</title>', 'utf8');
  await writeFile(path.join(root, 's.css'), 'body{background:url(/bg.png)}', 'utf8');
  await writeFile(path.join(root, '.git', 'config'), 'secret', 'utf8');
  await writeFile(path.join(path.dirname(root), 'outside.txt'), 'outside', 'utf8').catch(() => {});
  return root;
}

test('the router: token in, folder out; no token or a wrong one is 404; the folder\'s edge is the edge', async (t) => {
  const root = await copyFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = express();
  app.use(PREVIEW_PREFIX, previewRouter({ frameAncestors: ['http://app.example'] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = issuePreviewToken({ root, kind: 'as-is', scripts: true });
  t.after(() => revokePreviewToken(token));
  const p = previewPath(token);

  const home = await fetch(`${base}${p}`, { headers: { host: 'tool.example', 'x-forwarded-proto': 'https' } });
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('content-security-policy'), 'sandbox allow-scripts; frame-ancestors http://app.example');
  const html = await home.text();
  assert.match(html, new RegExp(`href="${p}s\\.css"`), 'the stylesheet address moved under the preview');
  assert.match(html, new RegExp(`href="${p.replace(/\/$/, '')}/about"`));

  const css = await fetch(`${base}${p}s.css`);
  assert.equal(await css.text(), `body{background:url(${p.replace(/\/$/, '')}/bg.png)}`);
  assert.equal(css.headers.get('access-control-allow-origin'), '*');
  assert.doesNotMatch(css.headers.get('content-security-policy'), /sandbox/);

  const folder = await fetch(`${base}${p}about`, { redirect: 'manual' });
  assert.equal(folder.status, 301);
  assert.equal(folder.headers.get('location'), `${p}about/`, 'a folder gets its slash, under the preview');
  assert.match(await (await fetch(`${base}${p}about/`)).text(), /<title>about<\/title>/);
  assert.match(await (await fetch(`${base}${p}contact`)).text(), /<title>contact<\/title>/, 'a clean URL answers from its .html file');

  assert.equal((await fetch(`${base}${p}.git/config`)).status, 404, 'no dotfiles');
  assert.equal((await fetch(`${base}${p}..%2Foutside.txt`)).status, 404, 'nothing above the folder');
  assert.equal((await fetch(`${base}${p}missing.png`)).status, 404);
  assert.equal((await fetch(`${base}${p}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}${PREVIEW_PREFIX}/${token.slice(0, 23)}/`)).status, 404, 'a token one character short');
  assert.equal((await fetch(`${base}${PREVIEW_PREFIX}/`)).status, 404);
  assert.equal((await fetch(`${base}${PREVIEW_PREFIX}`)).status, 404);
  const head = await fetch(`${base}${p}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);

  revokePreviewToken(token);
  assert.equal((await fetch(`${base}${p}`)).status, 404, 'a stopped preview is gone at once');
});
